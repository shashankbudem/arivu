import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebContents, WebFrameMain } from "electron";
import type { BrowserTaskModelConfig, BrowserToolResult } from "../../src/tools/browserControl.js";
import {
  getBrowserTaskProxyDiagnostics,
  registerBrowserTaskProxyEntry,
  unregisterBrowserTaskProxyEntry,
  type BrowserTaskProxyDiagnostic
} from "./browserTaskProxy.js";
import {
  ANNOTATE_CUSTOM_CONTROLS_SNIPPET,
  ARIVU_PAGE_AGENT_SYSTEM_INSTRUCTIONS,
  BACKFILL_REFLECTION_SNIPPET,
  BUILD_TRACE_SNIPPET,
  CAP_PAGE_CONTENT_SNIPPET,
  INSTALL_AGENT_VISUAL_THEME_SNIPPET,
  INSTALL_SERVICE_NOW_VARIABLE_TYPE_GUARD_SNIPPET,
  INSTALL_UNRELATED_CHECKBOX_LABEL_GUARD_SNIPPET
} from "./pageAgentInPageSnippets.js";

/**
 * Drives a single `browser_task` call: injects a standing page-agent instance into the
 * target tab and lets its own observe/act loop run entirely in-page for one `execute()`
 * call, rather than the main agent driving snapshot/click/type rounds itself.
 *
 * Navigation survival: a cross-document navigation destroys the page's JS context (and the
 * injected instance with it), so there is no way to reactively capture exact state at the
 * instant before navigation. Instead a background poll reads a condensed progress snapshot
 * off the running instance every PROGRESS_POLL_INTERVAL_MS; on a confirmed `did-navigate`,
 * the destination is allowed to settle and the task returns at that safe action boundary.
 * BrowserController then attaches snapshotAfter for the supervising agent, avoiding a second
 * model call solely to describe the new document. A same-page (`did-navigate-in-page`)
 * navigation is a no-op because the JS context survives it. A child window is a different
 * target entirely, so opening one ends the originating instance with an explicit active-tab
 * handoff instead of letting it reason against the stale parent page.
 */

export type BrowserTaskArgs = {
  instruction: string;
  maxSteps?: number;
  timeoutMs?: number;
  allowedDomains?: string[];
  allowJavaScript?: boolean;
  allowSensitiveActions?: boolean;
  visible?: boolean;
};

// Supplementary rail, not the only line of defense: this only pauses the autonomous loop so
// the main agent can hand control back to a real chat with the user (per the onAskUser design
// decision, page-agent's own ask_user tool stays disabled). It is intentionally conservative
// and easy to bypass by an adversarial page; approval-gating remains the primary safeguard.
// allowSensitiveActions is the deliberate override for after the user has confirmed — without
// it a legitimate, user-approved flow on a page containing these phrases could never proceed.
const SENSITIVE_ACTION_PATTERN =
  "/\\b(confirm(ed)?\\s+(payment|purchase|order)|place\\s+order|complete\\s+purchase|pay\\s+now|submit\\s+payment|delete\\s+(my\\s+)?account|permanently\\s+delete|deactivate\\s+account|cancel\\s+subscription|authorize\\s+payment|confirm\\s+transfer|send\\s+money|wire\\s+transfer)\\b/i";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PAGE_AGENT_BUNDLE_PATH = path.resolve(currentDir, "../pageAgentBundle/page-agent.iife.js");

const DEFAULT_MAX_STEPS = 100;
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 200;
// A generous ceiling, not an expected wait: slow providers can take minutes per completion,
// and the model circuit below stops genuinely dead endpoints long before this fires. Callers
// can still choose a smaller budget for short tasks or cancel a run at any time.
const DEFAULT_TIMEOUT_MS = 4_200_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 14_400_000;
const STOP_GRACE_MS = 5_000;
const PROXY_TOKEN_TTL_SLOP_MS = 60_000;
// Default pause between agent loops (override via browserTaskModel.stepDelayMs). This is the
// requested proactive provider rate limit; reactive 429/503 Retry-After handling in the proxy
// remains a separate recovery path for provider-side throttling.
const STEP_DELAY_SECONDS = 35;
// page-agent defaults to 2 retries with a flat 100ms delay; NIM queue timeouts routinely burn
// both. Extra attempts are cheap relative to failing the whole multi-step task.
const LLM_MAX_RETRIES = 4;
const PROGRESS_POLL_INTERVAL_MS = 1_000;
const NAVIGATION_SETTLE_TIMEOUT_MS = 10_000;
const NAVIGATION_STABLE_MS = 300;
const POST_SUBMIT_NAVIGATION_SETTLE_TIMEOUT_MS = 30_000;
const POST_SUBMIT_NAVIGATION_STABLE_MS = 1_000;
const TRANSIENT_FAILURE_THRESHOLD = 3;
const TRANSIENT_CIRCUIT_TTL_MS = 2 * 60_000;
const CONFIG_CIRCUIT_TTL_MS = 15 * 60_000;
const MAX_RESULT_PROXY_DIAGNOSTICS = 10;
// A rotation attempt still needs to register a proxy, inject a fresh instance, and get at
// least one model round-trip; below this much of the shared timeoutMs budget left, trying a
// fallback candidate can't accomplish anything and just burns the remainder on a doomed attempt.
const MIN_ROTATION_REMAINING_MS = 5_000;
const FRAME_PROBE_TIMEOUT_MS = 1_500;
const FRAME_PROBE_SCRIPT = `(function() {
  var selector = 'input:not([type="hidden"]),button,select,textarea,a[href],[role="button"],[role="combobox"],[contenteditable="true"]';
  var elements = document.querySelectorAll ? document.querySelectorAll(selector) : [];
  var visibleInteractiveCount = 0;
  var limit = Math.min(elements.length, 1000);
  for (var i = 0; i < limit; i++) {
    var element = elements[i];
    var rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    var style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
    if (
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      (!style || (style.display !== "none" && style.visibility !== "hidden"))
    ) {
      visibleInteractiveCount++;
    }
  }
  return {
    readyState: document.readyState || "",
    visible: document.visibilityState !== "hidden",
    width: Math.max(0, window.innerWidth || 0),
    height: Math.max(0, window.innerHeight || 0),
    formCount: document.forms ? document.forms.length : 0,
    visibleInteractiveCount: visibleInteractiveCount,
    textLength: document.body && document.body.innerText ? document.body.innerText.length : 0
  };
})()`;

type BrowserTaskStopReason = "timeout" | "cancelled" | "infrastructure" | "target_closed";
type ModelCircuit = { openedAt: number; expiresAt: number; reason: string };
const modelCircuits = new Map<string, ModelCircuit>();

type InjectedTaskResult = {
  ok: boolean;
  success?: boolean;
  data?: string;
  stepCount?: number;
  error?: string;
  trace?: string[];
  tokensUsed?: number;
};

type PolledProgress = {
  stepCount: number;
  lastAction?: string;
  lastGoal?: string;
};

export type JavaScriptExecutionTarget = {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
};

export type BrowserTaskExecutionTarget = {
  target: JavaScriptExecutionTarget;
  frame?: WebFrameMain;
  isMainFrame: boolean;
  processId?: number;
  routingId?: number;
  url: string;
};

type FrameProbe = {
  readyState?: string;
  visible?: boolean;
  width?: number;
  height?: number;
  formCount?: number;
  visibleInteractiveCount?: number;
  textLength?: number;
};

const NAVIGATION_SHELL_INSTRUCTION_PATTERN =
  /(?:\b(?:application\s+navigator|navigator\s+(?:filter|search|menu)|polaris\s+navigation|main\s+navigation|left(?:-hand)?\s+navigation)\b|["']?(?:all|favorites|history|workspaces)["']?\s+(?:menu|tab)\b)/i;

let cachedBundleText: string | undefined;

async function loadPageAgentBundle(): Promise<string> {
  if (cachedBundleText === undefined) {
    cachedBundleText = await readFile(PAGE_AGENT_BUNDLE_PATH, "utf8");
  }
  return cachedBundleText;
}

/**
 * Test-only seam: the real bundle path is resolved relative to the bundled main.js output
 * (see PAGE_AGENT_BUNDLE_PATH), which only exists after `desktop:main:build`. Tests that
 * import this module as plain TS source can preload a stand-in bundle instead.
 */
export function __setPageAgentBundleTextForTests(text: string | undefined): void {
  cachedBundleText = text;
}

function frameDepth(frame: WebFrameMain): number {
  let depth = 0;
  let parent = frame.parent;
  while (parent) {
    depth += 1;
    parent = parent.parent;
  }
  return depth;
}

function frameProbeScore(frame: WebFrameMain, probe: FrameProbe): number {
  if (!probe.visible || (probe.width ?? 0) <= 0 || (probe.height ?? 0) <= 0) {
    return 0;
  }
  const nameBonus = /^(?:gsft_main|content|workspace|main)$/i.test(frame.name || "") ? 10_000 : 0;
  const formBonus = Math.min(Math.max(probe.formCount ?? 0, 0), 10) * 2_000;
  const interactionBonus = Math.min(Math.max(probe.visibleInteractiveCount ?? 0, 0), 500) * 25;
  const areaBonus = (probe.width ?? 0) * (probe.height ?? 0) >= 50_000 ? 500 : 0;
  const readyBonus = probe.readyState === "complete" || probe.readyState === "interactive" ? 200 : 0;
  const textBonus = (probe.textLength ?? 0) > 0 ? 100 : 0;
  return nameBonus + formBonus + interactionBonus + areaBonus + readyBonus + textBonus + frameDepth(frame) * 50;
}

async function probeFrame(frame: WebFrameMain): Promise<FrameProbe | undefined> {
  if (frame.detached || frame.isDestroyed()) {
    return undefined;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      frame.executeJavaScript(FRAME_PROBE_SCRIPT, false),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), FRAME_PROBE_TIMEOUT_MS);
      })
    ]);
    return result && typeof result === "object" ? (result as FrameProbe) : undefined;
  } catch {
    return undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Some app shells keep global navigation outside their substantial work iframe.
 * Those instructions must start in the main document; otherwise the model sees
 * only the current form/home card and may click an unrelated element with a
 * vaguely similar label.
 */
export function browserTaskTargetsNavigationShell(instruction: string): boolean {
  return NAVIGATION_SHELL_INSTRUCTION_PATTERN.test(instruction);
}

/**
 * A global-navigation task is impossible on a standalone ServiceNow content
 * document such as catalog_home.do: the Application Navigator exists only in
 * navpage/the unified navigation shell. Reject before spending browser-model
 * steps against a similarly named page-local search box.
 */
export function serviceNowNavigationSurfaceMismatch(instruction: string, currentUrl: string): string | undefined {
  if (!browserTaskTargetsNavigationShell(instruction)) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(currentUrl);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "service-now.com" && !host.endsWith(".service-now.com")) {
    return undefined;
  }
  const path = parsed.pathname.toLowerCase();
  if (path.endsWith("/navpage.do") || path === "/now/nav/ui" || path.startsWith("/now/nav/ui/")) {
    return undefined;
  }
  return `Stopped before browser-agent execution: this task requires ServiceNow's global Application Navigator, but the active document is the standalone page ${currentUrl.slice(0, 1_000)} and has no navigator. Use browser_open on the exact navpage.do URL supplied by the user, then retry the global-navigation task; do not use this page's local search box.`;
}

/**
 * PageController can pierce ordinary same-origin iframes, but a browser shell may
 * place its work iframe beneath a shadow root. Electron still exposes that frame
 * through WebFrameMain, so run the page agent directly in the most substantial
 * visible work frame. This keeps the model's snapshot scoped to the real form
 * instead of an empty outer app shell. Global-navigation instructions are the
 * exception: their controls live in that outer document.
 */
export async function selectBrowserTaskExecutionTarget(
  contents: WebContents,
  allowedDomains: string[],
  instruction = ""
): Promise<BrowserTaskExecutionTarget> {
  let contentsUrl = "";
  try {
    contentsUrl = contents.getURL();
  } catch {
    // A partially destroyed target or a small test double may not expose a URL.
  }
  const fallback: BrowserTaskExecutionTarget = {
    target: contents,
    isMainFrame: true,
    url: contentsUrl
  };
  if (browserTaskTargetsNavigationShell(instruction)) {
    return fallback;
  }
  let mainFrame: WebFrameMain | undefined;
  let frames: WebFrameMain[] = [];
  try {
    mainFrame = contents.mainFrame;
    frames = mainFrame?.framesInSubtree ?? [];
  } catch {
    return fallback;
  }
  if (!mainFrame || frames.length <= 1) {
    return fallback;
  }

  const candidates = frames.filter((frame) => {
    if (frame === mainFrame || frame.detached || frame.isDestroyed()) {
      return false;
    }
    try {
      const host = new URL(frame.url).hostname.toLowerCase();
      return Boolean(host && hostAllowed(host, allowedDomains));
    } catch {
      return false;
    }
  });
  const probed = await Promise.all(
    candidates.map(async (frame) => ({
      frame,
      score: frameProbeScore(frame, (await probeFrame(frame)) ?? {})
    }))
  );
  const best = probed.sort((left, right) => right.score - left.score)[0];
  // Avoid moving the agent into incidental analytics, media, or tiny helper
  // frames. A named work frame, a real form, or a sufficiently interactive app
  // comfortably exceeds this threshold.
  if (!best || best.score < 1_200) {
    return fallback;
  }
  return {
    target: best.frame,
    frame: best.frame,
    isMainFrame: false,
    processId: best.frame.processId,
    routingId: best.frame.routingId,
    url: best.frame.url
  };
}

export async function runBrowserTask(
  contents: WebContents,
  args: BrowserTaskArgs,
  modelConfig: BrowserTaskModelConfig,
  signal?: AbortSignal,
  onProgress?: (progress: { stepIndex: number; summary: string }) => void
): Promise<BrowserToolResult> {
  const instruction = stripStaleBrowserTaskIndices(args.instruction);
  const timeoutMs = clamp(Math.trunc(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const primaryMaxSteps = clamp(Math.trunc(args.maxSteps ?? modelConfig.maxSteps ?? DEFAULT_MAX_STEPS), MIN_MAX_STEPS, MAX_MAX_STEPS);
  const primaryStepDelaySeconds = Math.max(0, (modelConfig.stepDelayMs ?? STEP_DELAY_SECONDS * 1_000) / 1_000);
  const candidateMetadata = (candidate: BrowserTaskModelConfig, candidateMaxSteps: number, candidateStepDelaySeconds: number) => ({
    providerId: candidate.providerId,
    providerName: candidate.providerName,
    model: candidate.model,
    endpoint: safeEndpoint(candidate.baseUrl),
    contextWindowTokens: candidate.contextWindowTokens,
    maxSteps: candidateMaxSteps,
    timeoutMs,
    stepDelayMs: Math.round(candidateStepDelaySeconds * 1_000)
  });
  const navigationSurfaceMismatch = serviceNowNavigationSurfaceMismatch(instruction, contents.getURL());
  if (navigationSurfaceMismatch) {
    return {
      success: false,
      data: navigationSurfaceMismatch,
      stepCount: 0,
      stopped: false,
      navigationCount: 0,
      durationMs: 0,
      browserTaskModel: candidateMetadata(modelConfig, primaryMaxSteps, primaryStepDelaySeconds),
      proxyDiagnostics: []
    };
  }

  // Primary first, then configured fallbacks in order. A candidate whose circuit is already
  // open from an earlier call is dropped up front — it would only fail the same way again.
  const modelCandidates = dedupeModelCandidates([modelConfig, ...(modelConfig.fallbacks ?? [])]);
  const viableCandidates = modelCandidates.filter((candidate) => !activeModelCircuit(modelCircuitKey(candidate)));
  if (viableCandidates.length === 0) {
    const primaryMetadata = candidateMetadata(modelConfig, primaryMaxSteps, primaryStepDelaySeconds);
    if (modelCandidates.length === 1) {
      const openCircuit = activeModelCircuit(modelCircuitKey(modelConfig))!;
      return {
        success: false,
        data: `Browser task model is temporarily unavailable: ${openCircuit.reason} Retry after ${new Date(openCircuit.expiresAt).toISOString()} or select another browser-task model/provider.`,
        stepCount: 0,
        stopped: true,
        stopReason: "infrastructure",
        navigationCount: 0,
        durationMs: 0,
        browserTaskModel: primaryMetadata,
        proxyDiagnostics: []
      };
    }
    const reasons = modelCandidates.flatMap((candidate) => {
      const circuit = activeModelCircuit(modelCircuitKey(candidate));
      return circuit ? [`${candidate.model} (${circuit.reason})`] : [];
    });
    return {
      success: false,
      data: `All configured browser-task models are temporarily unavailable: ${reasons.join(" ")} Select another browser-task model/provider, or retry after a circuit cools down.`,
      stepCount: 0,
      stopped: true,
      stopReason: "infrastructure",
      navigationCount: 0,
      durationMs: 0,
      browserTaskModel: primaryMetadata,
      proxyDiagnostics: []
    };
  }
  // Normalize here (not just in-page) so a mixed-case or dot-prefixed entry from the model
  // ("Example.COM", ".example.com") cannot make the in-page host check reject every page.
  const allowedDomains = normalizeAllowedDomains(args.allowedDomains?.length ? args.allowedDomains : defaultAllowedDomains(contents));
  const bundleText = await loadPageAgentBundle();

  const startedAt = Date.now();
  let deadlineTimer: NodeJS.Timeout | undefined;
  let stopReason: BrowserTaskStopReason | undefined;
  let onTargetDestroyed: (() => void) | undefined;
  let onPopupCreated: (() => void) | undefined;
  let settleInfrastructureStop: ((result: InjectedTaskResult) => void) | undefined;
  let popupOpened = false;
  const infrastructureStopPromise = new Promise<InjectedTaskResult>((resolve) => {
    settleInfrastructureStop = resolve;
  });
  const popupPromise = new Promise<InjectedTaskResult>((resolve) => {
    onPopupCreated = () => {
      if (popupOpened || stopReason) {
        return;
      }
      popupOpened = true;
      resolve({
        ok: true,
        success: false,
        data: "The browser action opened a new tab or popup. It is now the agent target tab (agentTargetTabId in browser_state); continue the remaining lookup or dialog work there. Do not repeat the popup-opening action."
      });
    };
    contents.on("did-create-window", onPopupCreated);
  });
  const stopPromise = new Promise<InjectedTaskResult>((resolve) => {
    const settleStop = (reason: "timeout" | "cancelled" | "target_closed", message: string) => {
      if (stopReason) {
        return;
      }
      stopReason = reason;
      resolve({ ok: false, error: message });
    };
    deadlineTimer = setTimeout(() => settleStop("timeout", `Browser task exceeded its ${timeoutMs}ms budget.`), timeoutMs);
    onTargetDestroyed = () => settleStop("target_closed", "The browser tab closed while the delegated task was running.");
    contents.on("destroyed", onTargetDestroyed);
    if (signal) {
      if (signal.aborted) {
        settleStop("cancelled", "Browser task was cancelled.");
      } else {
        signal.addEventListener("abort", () => settleStop("cancelled", "Browser task was cancelled."), { once: true });
      }
    }
  });

  let stepsUsedSoFar = 0;
  let navigationResumeCount = 0;
  let finalResult: InjectedTaskResult = { ok: false, error: "Browser task did not run." };
  // Progress last polled off the current instance; used to report how far the task got when
  // it is stopped without returning a result of its own (timeout/cancel before settle).
  // Assigned per iteration so a previous instance's steps (already folded into
  // stepsUsedSoFar on navigation resume) are never counted twice.
  let lastKnownProgress: PolledProgress | undefined;
  // One proxy token per attempted candidate; every one of them is torn down below regardless
  // of which attempt finalResult came from.
  const registeredTokens: string[] = [];
  // Only populated when a candidate actually failed and rotation moved to the next one; a
  // single-candidate call (the default, no fallbackModels configured) never touches this.
  const rotatedFrom: string[] = [];
  let modelMetadata = candidateMetadata(modelConfig, primaryMaxSteps, primaryStepDelaySeconds);
  let circuitKey = modelCircuitKey(modelConfig);
  let token = "";

  try {
    for (let candidateIndex = 0; candidateIndex < viableCandidates.length; candidateIndex += 1) {
      const candidate = viableCandidates[candidateIndex];
      const hasNextCandidate = candidateIndex < viableCandidates.length - 1;
      circuitKey = modelCircuitKey(candidate);
      const candidateMaxSteps = clamp(Math.trunc(args.maxSteps ?? candidate.maxSteps ?? DEFAULT_MAX_STEPS), MIN_MAX_STEPS, MAX_MAX_STEPS);
      const candidateStepDelaySeconds = Math.max(0, (candidate.stepDelayMs ?? STEP_DELAY_SECONDS * 1_000) / 1_000);
      modelMetadata = candidateMetadata(candidate, candidateMaxSteps, candidateStepDelaySeconds);

      // The stop can fire before the first injection (pre-aborted signal) or between
      // rotation attempts; never hand the page a fresh task after that. (Rotation always
      // resets stopReason to undefined before continuing, so "infrastructure" can never be
      // seen here — that case is handled, and decided, within the attempt that raised it.)
      if (stopReason) {
        finalResult = {
          ok: false,
          error:
            stopReason === "cancelled"
              ? "Browser task was cancelled."
              : stopReason === "target_closed"
                ? "The browser tab closed while the delegated task was running. Inspect browser_state and continue on the originating tab."
                : `Browser task exceeded its ${timeoutMs}ms budget.`
        };
        break;
      }

      const registered = await registerBrowserTaskProxyEntry({
        realBaseUrl: candidate.baseUrl,
        realApiKey: candidate.apiKey,
        ttlMs: timeoutMs + PROXY_TOKEN_TTL_SLOP_MS
      });
      token = registered.token;
      const proxyBaseUrl = registered.proxyBaseUrl;
      registeredTokens.push(token);

      const remainingSteps = clamp(candidateMaxSteps - stepsUsedSoFar, 1, MAX_MAX_STEPS);
      const script = injectedTaskScript(bundleText, {
        instruction,
        proxyBaseUrl,
        token,
        model: candidate.model,
        maxSteps: remainingSteps,
        stepDelaySeconds: candidateStepDelaySeconds,
        // Steps already completed by pre-navigation instances; keeps trace step numbers
        // aligned with the cumulative stepCount in the tool result.
        stepIndexOffset: stepsUsedSoFar,
        allowedDomains,
        allowJavaScript: Boolean(args.allowJavaScript),
        allowSensitiveActions: Boolean(args.allowSensitiveActions),
        visible: Boolean(args.visible)
      });
      const executionTarget = await selectBrowserTaskExecutionTarget(contents, allowedDomains, instruction);

      let navigated = false;
      let settleNavigation: ((result: InjectedTaskResult) => void) | undefined;
      const navigationPromise = new Promise<InjectedTaskResult>((resolve) => {
        settleNavigation = resolve;
      });
      const onNavigate = () => {
        if (navigated) {
          return;
        }
        navigated = true;
        // Electron does not consistently reject an in-flight executeJavaScript promise when a
        // navigation destroys its execution context. Treat the navigation event itself as the
        // terminal signal for this injected instance so the fresh-document resume can start
        // immediately instead of waiting for the outer task deadline.
        settleNavigation?.({ ok: false, error: "The page navigated while the browser task was running." });
      };
      const onFrameNavigate = (
        _event: unknown,
        url: string,
        _httpResponseCode: number,
        _httpStatusText: string,
        isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
      ) => {
        if (executionTarget.isMainFrame || isMainFrame) {
          return;
        }
        const exactFrame = frameProcessId === executionTarget.processId && frameRoutingId === executionTarget.routingId;
        let replacementFrame: WebFrameMain | undefined;
        try {
          replacementFrame = contents.mainFrame.framesInSubtree.find(
            (frame) => frame.processId === frameProcessId && frame.routingId === frameRoutingId
          );
        } catch {
          // The old frame can be detached while Electron is publishing its replacement.
        }
        const sameWorkFrame = Boolean(executionTarget.frame?.name) && replacementFrame?.name === executionTarget.frame?.name;
        const sameTreeNode =
          executionTarget.frame?.frameTreeNodeId !== undefined &&
          replacementFrame?.frameTreeNodeId === executionTarget.frame.frameTreeNodeId;
        let allowedDestination = false;
        try {
          allowedDestination = hostAllowed(new URL(url).hostname.toLowerCase(), allowedDomains);
        } catch {
          // Non-URL frame events are not useful navigation boundaries.
        }
        if (allowedDestination && (exactFrame || sameWorkFrame || sameTreeNode)) {
          onNavigate();
        }
      };
      const initialMainUrl = contents.getURL();
      const onNavigateInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
        // ServiceNow updates the Polaris shell route in-place while replacing
        // gsft_main. The top document survives, but the child document containing
        // PageAgent does not, so this is a real task navigation boundary.
        if (!executionTarget.isMainFrame && isMainFrame && url !== initialMainUrl) {
          onNavigate();
        }
      };
      contents.on("did-navigate", onNavigate);
      if (!executionTarget.isMainFrame) {
        contents.on("did-frame-navigate", onFrameNavigate);
        contents.on("did-navigate-in-page", onNavigateInPage);
      }
      let lastProgress: PolledProgress | undefined;
      let instanceSettled = false;
      // One poll in flight at a time: a throttled or wedged renderer answers executeJavaScript
      // late or never, and dispatching a fresh poll every tick regardless once queued ~2,300
      // calls over a 38-minute background hang — all of which flooded back at once when the
      // renderer woke. Skipping ticks while a poll is outstanding costs nothing (the next
      // answered tick reads the same cumulative history) and bounds the backlog at one.
      let pollInFlight = false;
      const pollTimer = setInterval(() => {
        if (!pollInFlight) {
          pollInFlight = true;
          void pollProgress(executionTarget.target)
            .then((progress) => {
              // An in-flight poll can resolve after the instance settled (and, on a navigation
              // resume, after its steps were folded into stepsUsedSoFar) — drop it.
              if (instanceSettled) {
                return;
              }
              // A child-frame navigation can swap routing ids without emitting a
              // matchable event. The replacement document has no task global, which
              // is an unambiguous context-loss signal after injection.
              if (!progress) {
                if (!executionTarget.isMainFrame) {
                  onNavigate();
                }
                return;
              }
              const isNewStep = progress.stepCount !== lastProgress?.stepCount;
              lastProgress = progress;
              if (isNewStep && progress.stepCount > 0) {
                onProgress?.({
                  stepIndex: stepsUsedSoFar + progress.stepCount,
                  summary: progress.lastGoal ?? progress.lastAction ?? `step ${progress.stepCount}`
                });
              }
            })
            .catch(() => {
              if (!instanceSettled && !executionTarget.isMainFrame) {
                onNavigate();
              }
            })
            .finally(() => {
              pollInFlight = false;
            });
        }
        const circuitFailure = circuitFailureFromDiagnostics(getBrowserTaskProxyDiagnostics(token));
        if (circuitFailure && !stopReason) {
          stopReason = "infrastructure";
          modelCircuits.set(circuitKey, {
            openedAt: Date.now(),
            expiresAt: Date.now() + circuitFailure.ttlMs,
            reason: circuitFailure.reason
          });
          settleInfrastructureStop?.({ ok: false, error: circuitFailure.reason });
        }
      }, PROGRESS_POLL_INTERVAL_MS);

      const taskPromise = executeInjectedTask(executionTarget.target, script);
      let result: InjectedTaskResult;
      try {
        result = await Promise.race([taskPromise, navigationPromise, popupPromise, stopPromise, infrastructureStopPromise]);
      } finally {
        instanceSettled = true;
        clearInterval(pollTimer);
        contents.off("did-navigate", onNavigate);
        if (!executionTarget.isMainFrame) {
          contents.off("did-frame-navigate", onFrameNavigate);
          contents.off("did-navigate-in-page", onNavigateInPage);
        }
      }
      lastKnownProgress = lastProgress;

      if (popupOpened) {
        // The page agent is scoped to the originating WebContents and cannot observe the child
        // tab. Stop it promptly so it cannot keep scrolling/clicking the parent while the popup
        // is active, then preserve any action progress that became visible during the stop.
        await Promise.race([stopInjectedTask(executionTarget.target).catch(() => undefined), delay(STOP_GRACE_MS)]);
        const popupProgress = await pollProgress(executionTarget.target).catch(() => undefined);
        if (popupProgress) {
          lastKnownProgress = popupProgress;
        }
        finalResult = {
          ...result,
          stepCount: popupProgress?.stepCount ?? lastProgress?.stepCount ?? result.stepCount ?? 0
        };
        break;
      }

      if (stopReason === "target_closed") {
        finalResult = result;
        break;
      }

      if (stopReason === "timeout" || stopReason === "cancelled" || stopReason === "infrastructure") {
        // A wedged renderer can make executeJavaScript never resolve; the stop request and
        // the settle wait share the same bound so a timeout can never hang the tool call.
        await Promise.race([stopInjectedTask(executionTarget.target).catch(() => undefined), delay(STOP_GRACE_MS)]);
        const settled = await Promise.race([taskPromise, delay(STOP_GRACE_MS).then(() => undefined)]);
        finalResult = settled ?? result;
        if (stopReason === "infrastructure" && !finalResult.ok) {
          const progressStepCount = stepsUsedSoFar + (finalResult.stepCount ?? lastKnownProgress?.stepCount ?? 0);
          const remainingMs = timeoutMs - (Date.now() - startedAt);
          if (canRotateToNextCandidate(progressStepCount, hasNextCandidate, remainingMs)) {
            rotatedFrom.push(`${candidate.model} (${activeModelCircuit(circuitKey)?.reason ?? finalResult.error ?? "endpoint unavailable"})`);
            stopReason = undefined;
            continue;
          }
        }
        break;
      }

      if (!result.ok && navigated) {
        // did-navigate can be the first hop of a redirect/reload chain. Wait for the final
        // destination, then stop at this safe action boundary. BrowserController attaches a
        // fresh snapshotAfter; another in-page LLM call merely to describe the destination
        // adds latency and another opportunity for a stale-index action.
        await waitForNavigationToSettle(contents, lastProgress);
        navigationResumeCount += 1;
        stepsUsedSoFar += lastProgress?.stepCount ?? 0;
        lastKnownProgress = undefined;
        // Check the post-navigation host before treating the boundary as successful.
        const nextHost = currentHost(contents);
        if (nextHost && !hostAllowed(nextHost, allowedDomains)) {
          finalResult = {
            ok: false,
            error: `Browser task stopped: the page navigated to "${nextHost}", which is outside the allowed domain list for this task.`
          };
          break;
        }
        const newRecordMismatch = newRecordNavigationMismatch(instruction, contents.getURL());
        if (newRecordMismatch) {
          finalResult = {
            ok: true,
            success: false,
            data: newRecordMismatch,
            stepCount: 0
          };
          break;
        }
        finalResult = {
          ok: true,
          success: true,
          data: buildNavigationCheckpointResult(lastProgress, navigationResumeCount, contents.getURL()),
          stepCount: 0
        };
        break;
      }

      finalResult = result;
      if (!finalResult.ok) {
        // The mid-run poll ticks every second and may not have caught a failure the whole
        // call already settled from (a fast-failing first request, or executeJavaScript
        // itself rejecting). Check once more so this attempt is still rotation-eligible.
        const freshCircuitFailure = circuitFailureFromDiagnostics(getBrowserTaskProxyDiagnostics(token));
        if (freshCircuitFailure) {
          stopReason = "infrastructure";
          modelCircuits.set(circuitKey, {
            openedAt: Date.now(),
            expiresAt: Date.now() + freshCircuitFailure.ttlMs,
            reason: freshCircuitFailure.reason
          });
          const progressStepCount = stepsUsedSoFar + (finalResult.stepCount ?? lastKnownProgress?.stepCount ?? 0);
          const remainingMs = timeoutMs - (Date.now() - startedAt);
          if (canRotateToNextCandidate(progressStepCount, hasNextCandidate, remainingMs)) {
            rotatedFrom.push(`${candidate.model} (${freshCircuitFailure.reason})`);
            stopReason = undefined;
            continue;
          }
        }
      }
      break;
    }

    const durationMs = Date.now() - startedAt;
    const success = finalResult.ok ? Boolean(finalResult.success) : false;
    const stepCount = stepsUsedSoFar + (finalResult.stepCount ?? lastKnownProgress?.stepCount ?? 0);
    let data = finalResult.ok ? (finalResult.data ?? "") : (finalResult.error ?? "Browser task failed.");
    // Only when the task did NOT succeed: a task that completed during the stop grace window
    // keeps its real answer as data (stopReason still records that the deadline fired).
    if (stopReason === "timeout" && !success) {
      // page-agent reports a graceful stop as "Task aborted", which reads like a user action;
      // replace it with what actually happened and how to avoid it next time.
      const inPageReport =
        finalResult.ok && finalResult.data && finalResult.data !== "Task aborted" ? ` Last in-page report: ${finalResult.data}` : "";
      data = `Browser task exceeded its ${timeoutMs}ms budget after ${stepCount} step(s). For multi-step tasks on slow model providers, raise timeoutMs (up to ${MAX_TIMEOUT_MS}) or split the instruction into smaller tasks.${inPageReport}`;
    }
    if (stopReason === "infrastructure" && !success) {
      const failure = activeModelCircuit(circuitKey);
      data = `${failure?.reason ?? data} Browser-task retries for this model are paused temporarily; choose another configured model/provider or retry after the circuit cools down.`;
    }
    if (stopReason === "target_closed" && !success) {
      data =
        "The browser tab closed while the delegated task was running. This can be an expected result of selecting a value in a popup lookup; inspect browser_state and continue or verify on the originating tab.";
    }
    if (!success && stepCount === 0 && isModelConnectivityFailure(data)) {
      data = `${data} — the in-page agent could not reach its model endpoint before taking a single step. This is an infrastructure/connectivity failure, not a problem with the instruction; retrying browser_task with reworded instructions will not help. Check browser_console for CORS or network errors and report the failure to the user.`;
    }
    const result: BrowserToolResult = {
      success,
      data,
      stepCount,
      stopped: Boolean(stopReason),
      stopReason,
      popupOpened: popupOpened || undefined,
      navigationCount: navigationResumeCount,
      durationMs,
      browserTaskModel: modelMetadata,
      // Diagnostics are for debugging failures; on success they are pure context cost for the
      // main agent (up to 50 entries per result), so attach a bounded tail only when needed.
      proxyDiagnostics: success ? [] : getBrowserTaskProxyDiagnostics(token).slice(-MAX_RESULT_PROXY_DIAGNOSTICS)
    };
    if (finalResult.trace?.length) {
      result.trace = finalResult.trace;
    }
    if (finalResult.tokensUsed) {
      result.tokensUsed = finalResult.tokensUsed;
    }
    if (rotatedFrom.length > 0) {
      result.rotatedModels = rotatedFrom;
    }
    return result;
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
    if (onTargetDestroyed) {
      contents.off("destroyed", onTargetDestroyed);
    }
    if (onPopupCreated) {
      contents.off("did-create-window", onPopupCreated);
    }
    for (const registeredToken of registeredTokens) {
      unregisterBrowserTaskProxyEntry(registeredToken);
    }
  }
}

function modelCircuitKey(config: BrowserTaskModelConfig): string {
  return `${safeEndpoint(config.baseUrl)}\n${config.model}`;
}

function activeModelCircuit(key: string): ModelCircuit | undefined {
  const circuit = modelCircuits.get(key);
  if (circuit && circuit.expiresAt <= Date.now()) {
    modelCircuits.delete(key);
    return undefined;
  }
  return circuit;
}

/** Primary first, each fallback in configured order; a repeated (baseUrl, model) pair collapses to its first occurrence. */
function dedupeModelCandidates(candidates: BrowserTaskModelConfig[]): BrowserTaskModelConfig[] {
  const seen = new Set<string>();
  const deduped: BrowserTaskModelConfig[] = [];
  for (const candidate of candidates) {
    const key = modelCircuitKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

/**
 * Rotation is only safe when the failed attempt made zero observable progress: page-agent's
 * history/memory lives inside the instance that just died, so resuming on a different model
 * would mean guessing at continuation instead of replaying, the exact risk navigation
 * checkpoints already stop short of. A candidate with real steps taken instead returns its
 * checkpoint as final, same as a navigation boundary, and leaves the follow-up call to rotate.
 */
function canRotateToNextCandidate(progressStepCount: number, hasNextCandidate: boolean, remainingMs: number): boolean {
  return progressStepCount === 0 && hasNextCandidate && remainingMs >= MIN_ROTATION_REMAINING_MS;
}

export function circuitFailureFromDiagnostics(diagnostics: BrowserTaskProxyDiagnostic[]): { reason: string; ttlMs: number } | undefined {
  let consecutiveTransient = 0;
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const diagnostic = diagnostics[index];
    // Attempts the proxy is already retrying with backoff are in-flight recoveries, not
    // endpoint failures; counting them would open the circuit mid-recovery (a single
    // rate-limited request records several 429s before its eventual 200).
    if (diagnostic.willRetry) {
      continue;
    }
    if (diagnostic.outcome === "success") {
      break;
    }
    if ([400, 401, 403, 404].includes(diagnostic.status)) {
      return {
        reason: `The configured browser-task model endpoint returned HTTP ${diagnostic.status} for ${diagnostic.path} (attempt ${diagnostic.attempt}). The model name, provider, credentials, or endpoint configuration is invalid or unavailable.`,
        ttlMs: CONFIG_CIRCUIT_TTL_MS
      };
    }
    if (diagnostic.outcome === "network_error" || [408, 429, 500, 502, 503, 504].includes(diagnostic.status)) {
      consecutiveTransient += 1;
    } else {
      break;
    }
  }
  if (consecutiveTransient >= TRANSIENT_FAILURE_THRESHOLD) {
    const latest = diagnostics[diagnostics.length - 1];
    return {
      reason: `The browser-task model endpoint failed ${consecutiveTransient} consecutive attempts (latest HTTP ${latest.status}, ${latest.latencyMs}ms).`,
      ttlMs: TRANSIENT_CIRCUIT_TTL_MS
    };
  }
  return undefined;
}

function safeEndpoint(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/[?#].*$/, "").slice(0, 500);
  }
}

/**
 * Matches the page-agent's zero-step model-connectivity failures ("InvokeError: Network
 * request failed", "Failed to fetch"). These mean the in-page agent never reached its model
 * (CORS, proxy down, provider unreachable) — a different instruction cannot fix them.
 */
function isModelConnectivityFailure(data: string): boolean {
  return /network request failed|failed to fetch|networkerror|err_connection|load failed/i.test(data);
}

function buildNavigationCheckpointResult(progress: PolledProgress | undefined, navigationResumeCount: number, currentUrl: string): string {
  const stepCount = progress?.stepCount ?? 0;
  // lastAction/lastGoal are model-generated under page influence and end up in a tool result;
  // condensing bounds what a hostile page can steer into that slot.
  const lastAction = condenseForPrompt(progress?.lastAction, 100);
  const lastGoal = condenseForPrompt(progress?.lastGoal, 200);
  const actionNote = lastAction ? ` (last action: ${lastAction}${lastGoal ? `, aiming to ${lastGoal}` : ""})` : "";
  const safeCurrentUrl = condenseForPrompt(currentUrl, 1_000) ?? "unknown";
  const progressNote =
    stepCount > 0
      ? `The previous document recorded ${stepCount} completed step(s)${actionNote}.`
      : "The previous action replaced the document before progress polling could record it.";
  return `Navigation checkpoint ${navigationResumeCount}: the previous document was replaced while this task was running.\n${progressNote}\nCurrent page URL: ${safeCurrentUrl}\nThe browser task stopped at this safe navigation boundary. The calling agent must inspect snapshotAfter and issue a fresh, destination-specific browser_task only if more work is needed; do not repeat the completed action.`;
}

function isLikelyPostSubmitProgress(progress: PolledProgress | undefined): boolean {
  const latestIntent = `${progress?.lastAction ?? ""} ${progress?.lastGoal ?? ""}`;
  return /\b(?:submit|save|insert|update|create)\b/i.test(latestIntent);
}

function isTransientPostSubmitUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.pathname.endsWith(".do") && url.searchParams.has("sysparm_now_ui_interaction");
  } catch {
    return false;
  }
}

async function waitForNavigationToSettle(contents: WebContents, progress?: PolledProgress): Promise<void> {
  // Older Electron test doubles (and any alternate WebContents-compatible target) may not
  // expose isLoading; their navigation event is already the only available boundary.
  if (typeof contents.isLoading !== "function") {
    return;
  }
  const initialUrl = contents.getURL();
  // ServiceNow first redirects a submitted form through a short-lived *.do URL carrying
  // sysparm_now_ui_interaction, then performs a delayed redirect to the saved parent/list.
  // A normal New-record form may also use sys_id=-1, so only the interaction marker (or
  // explicit last-step submit intent) earns the longer window.
  const postSubmit = isLikelyPostSubmitProgress(progress) || isTransientPostSubmitUrl(initialUrl);
  const deadline = Date.now() + (postSubmit ? POST_SUBMIT_NAVIGATION_SETTLE_TIMEOUT_MS : NAVIGATION_SETTLE_TIMEOUT_MS);
  const stableWindow = postSubmit ? POST_SUBMIT_NAVIGATION_STABLE_MS : NAVIGATION_STABLE_MS;
  let stableSince: number | undefined;
  let lastUrl = initialUrl;
  while (Date.now() < deadline) {
    await delay(100);
    const currentUrl = contents.getURL();
    if (contents.isLoading() || currentUrl !== lastUrl || (postSubmit && isTransientPostSubmitUrl(currentUrl))) {
      lastUrl = currentUrl;
      stableSince = undefined;
      continue;
    }
    stableSince ??= Date.now();
    if (Date.now() - stableSince >= stableWindow) {
      return;
    }
  }
}

function condenseForPrompt(text: string | undefined, maxChars: number): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, maxChars) : undefined;
}

function injectedTaskScript(
  bundleText: string,
  options: {
    instruction: string;
    proxyBaseUrl: string;
    token: string;
    model: string;
    maxSteps: number;
    stepDelaySeconds: number;
    stepIndexOffset: number;
    allowedDomains: string[];
    allowJavaScript: boolean;
    allowSensitiveActions: boolean;
    visible: boolean;
  }
): string {
  return `(function() {
// Idempotent, guarded engine load: re-running the ~2MB bundle on a document that already has
// it is wasted work, and an eval-time throw must surface its real message instead of
// Electron's opaque "Script failed to execute".
if (!window.__ArivuPageAgentLib) {
  try {
${bundleText}
  } catch (engineError) {
    return { ok: false, error: "The browser task engine failed to load: " + String(engineError && engineError.message ? engineError.message : engineError) };
  }
}
if (window.__arivuPageAgentTask && window.__arivuPageAgentTask.status === "running") {
  return { ok: false, error: "A browser task is already running on this tab." };
}
// Clear any stop reason left by a previous task in this JS context; without this a later
// task on the same page would report a stale, false safety stop.
window.__arivuPageAgentStopReason = undefined;
var lib = window.__ArivuPageAgentLib;
if (!lib) {
  return { ok: false, error: "The browser task engine failed to load." };
}
var allowedDomains = ${JSON.stringify(options.allowedDomains)};
var sensitivePattern = ${SENSITIVE_ACTION_PATTERN};
var checkSensitiveText = ${JSON.stringify(!options.allowSensitiveActions)};
function arivuNormalizeHost(host) {
  return (host || "").trim().replace(/^\\.+/, "").toLowerCase();
}
function arivuHostAllowed(host) {
  var normalized = arivuNormalizeHost(host);
  if (!normalized) {
    return false;
  }
  return allowedDomains.some(function(domain) {
    return normalized === domain || normalized.endsWith("." + domain);
  });
}
var arivuAnnotateCustomControls = ${ANNOTATE_CUSTOM_CONTROLS_SNIPPET};
var arivuOnBeforeStep = async function(agentInstance) {
  try {
    arivuAnnotateCustomControls(document);
  } catch (err) {
    console.warn("[Arivu] Custom control snapshot annotation unavailable:", err);
  }
  var url = await agentInstance.pageController.getCurrentUrl();
  var host;
  try {
    host = new URL(url).hostname;
  } catch (err) {
    host = "";
  }
  if (host && !arivuHostAllowed(host)) {
    window.__arivuPageAgentStopReason = "Stopped: navigated to \\"" + host + "\\", which is outside the allowed domain list for this task.";
    void agentInstance.stop();
    return;
  }
  // getBrowserState (not innerText) on purpose: its extractor pierces shadow roots and nested
  // same-origin iframes, which cheaper text sources miss. The core re-extracts right after
  // this hook, so this costs one extra extraction per step — accepted for rail fidelity.
  if (checkSensitiveText) {
    var state = await agentInstance.pageController.getBrowserState();
    if (state && sensitivePattern.test(state.content || "")) {
      window.__arivuPageAgentStopReason = "Stopped: this page appears to require a sensitive confirmation (payment, order, account change, or similar). Ask the user before proceeding, then re-run with allowSensitiveActions if they approve.";
      void agentInstance.stop();
    }
  }
};
var arivuCapPageContent = ${CAP_PAGE_CONTENT_SNIPPET};
var arivuBackfillReflection = ${BACKFILL_REFLECTION_SNIPPET};
var arivuBuildTrace = ${BUILD_TRACE_SNIPPET};
var arivuInstallAgentVisualTheme = ${INSTALL_AGENT_VISUAL_THEME_SNIPPET};
var arivuInstallServiceNowVariableTypeGuard = ${INSTALL_SERVICE_NOW_VARIABLE_TYPE_GUARD_SNIPPET};
var arivuInstallUnrelatedCheckboxLabelGuard = ${INSTALL_UNRELATED_CHECKBOX_LABEL_GUARD_SNIPPET};
var arivuAgentVisualThemeInstalled = false;
if (${JSON.stringify(options.visible)}) {
  try {
    arivuAgentVisualThemeInstalled = arivuInstallAgentVisualTheme();
  } catch (err) {
    console.warn("[Arivu] Browser agent visual theme unavailable:", err);
  }
}
var pageController;
try {
  pageController = new lib.PageController({ enableMask: ${JSON.stringify(options.visible)} });
} catch (maskError) {
  // The action mask is cosmetic. Pages enforcing Trusted Types (e.g. ServiceNow's polaris
  // shell) reject its raw innerHTML template and throw during construction — seen as an
  // instant "Script failed to execute" killing the whole task. Fall back to running maskless.
  console.warn("[Arivu] Browser agent mask unavailable on this page:", maskError);
  pageController = new lib.PageController({ enableMask: false });
}
var core = new lib.PageAgentCore({
  pageController: pageController,
  baseURL: ${JSON.stringify(options.proxyBaseUrl)},
  model: ${JSON.stringify(options.model)},
  apiKey: ${JSON.stringify(options.token)},
  maxSteps: ${JSON.stringify(options.maxSteps)},
  stepDelay: ${JSON.stringify(options.stepDelaySeconds)},
  maxRetries: ${JSON.stringify(LLM_MAX_RETRIES)},
  experimentalScriptExecutionTool: ${JSON.stringify(options.allowJavaScript)},
  instructions: { system: ${JSON.stringify(ARIVU_PAGE_AGENT_SYSTEM_INSTRUCTIONS)} },
  transformPageContent: arivuCapPageContent,
  onBeforeStep: arivuOnBeforeStep,
  onAfterStep: arivuBackfillReflection
});
if (${JSON.stringify(options.visible)}) {
  try {
    if (window.__arivuPageAgentPanel && typeof window.__arivuPageAgentPanel.dispose === "function") {
      window.__arivuPageAgentPanel.dispose();
    }
    var activityPanel = new lib.Panel(core, { promptForNextTask: false });
    core.onAskUser = undefined;
    activityPanel.wrapper.setAttribute("aria-label", "Browser agent activity");
    activityPanel.wrapper.setAttribute("data-arivu-agent-activity", "true");
    activityPanel.show();
    activityPanel.expand();
    window.__arivuPageAgentPanel = activityPanel;
  } catch (err) {
    console.warn("[Arivu] Browser activity panel unavailable:", err);
  }
}
window.__arivuPageAgentTask = core;
var arivuCleanupServiceNowVariableTypeGuard = function() {};
var arivuCleanupUnrelatedCheckboxLabelGuard = function() {};
try {
  arivuCleanupServiceNowVariableTypeGuard = arivuInstallServiceNowVariableTypeGuard(
    core,
    ${JSON.stringify(options.instruction)}
  );
} catch (err) {
  console.warn("[Arivu] ServiceNow variable type guard unavailable:", err);
}
try {
  arivuCleanupUnrelatedCheckboxLabelGuard = arivuInstallUnrelatedCheckboxLabelGuard(
    core,
    ${JSON.stringify(options.instruction)}
  );
} catch (err) {
  console.warn("[Arivu] Unrelated checkbox label guard unavailable:", err);
}
try {
  arivuAnnotateCustomControls(document);
} catch (err) {
  console.warn("[Arivu] Initial custom control snapshot annotation unavailable:", err);
}
return core.execute(${JSON.stringify(options.instruction)}).then(function(result) {
  try {
    arivuCleanupServiceNowVariableTypeGuard();
  } catch {}
  try {
    arivuCleanupUnrelatedCheckboxLabelGuard();
  } catch {}
  var history = (result && result.history) || [];
  var stepCount = 0;
  for (var i = 0; i < history.length; i++) {
    if (history[i] && history[i].type === "step") {
      stepCount++;
    }
  }
  var trace = { entries: [], tokensUsed: 0 };
  try {
    trace = arivuBuildTrace(history, ${JSON.stringify(options.stepIndexOffset)});
  } catch (err) {}
  var stopReason = window.__arivuPageAgentStopReason;
  var data = (result && result.data) || "";
  if (stopReason) {
    data = data ? (stopReason + " " + data) : stopReason;
  }
  return {
    ok: true,
    success: !!(result && result.success),
    data: data,
    stepCount: stepCount,
    safetyStop: !!stopReason,
    trace: trace.entries,
    tokensUsed: trace.tokensUsed
  };
}).catch(function(err) {
  try {
    arivuCleanupServiceNowVariableTypeGuard();
  } catch {}
  try {
    arivuCleanupUnrelatedCheckboxLabelGuard();
  } catch {}
  return { ok: false, error: String(err && err.message ? err.message : err) };
});
})()`;
}

function defaultAllowedDomains(contents: WebContents): string[] {
  try {
    const host = new URL(contents.getURL()).hostname.toLowerCase();
    return host ? [host] : [];
  } catch {
    return [];
  }
}

function normalizeAllowedDomains(domains: string[]): string[] {
  return domains.map((domain) => domain.trim().replace(/^\.+/, "").toLowerCase()).filter(Boolean);
}

function currentHost(contents: WebContents): string {
  try {
    return new URL(contents.getURL()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Browser-state indices are regenerated after every DOM change. Supervising
 * models sometimes copy an index from snapshotAfter into the next instruction;
 * leaving that hint in place makes a small DOM model obey the stale number even
 * when the current element at that index has a different label. Preserve the
 * semantic instruction while removing only explicit index annotations.
 */
export function stripStaleBrowserTaskIndices(instruction: string): string {
  return instruction
    .replace(/\s*[[(]\s*index\s*:?\s*#?\d+\s*[\])]/gi, "")
    .replace(/\bindex\s*:?\s*#?\d+\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

/**
 * A stale related-list index can point at the first existing row after records are
 * added, even though the instruction says to click New. Navigation destroys the
 * page-agent context before its after-step guard can inspect the clicked element,
 * so validate the destination at the supervisor boundary.
 */
export function newRecordNavigationMismatch(instruction: string, destinationUrl: string): string | undefined {
  const asksToClickNew =
    /\bclick\b[\s\S]{0,80}\bnew\b[\s\S]{0,40}\bbutton\b/i.test(instruction) ||
    /\bclick\b[\s\S]{0,80}\bbutton\b[\s\S]{0,40}\bnew\b/i.test(instruction);
  let decodedUrl = destinationUrl;
  for (let decodeAttempt = 0; decodeAttempt < 2; decodeAttempt++) {
    try {
      const next = decodeURIComponent(decodedUrl);
      if (next === decodedUrl) {
        break;
      }
      decodedUrl = next;
    } catch {
      // Keep the last valid decoding for malformed escape sequences.
      break;
    }
  }
  let destinationPath = "";
  let destinationSysId: string | null = null;
  try {
    const parsed = new URL(decodedUrl);
    destinationPath = parsed.pathname;
    destinationSysId = parsed.searchParams.get("sys_id");
  } catch {
    destinationPath = /^https?:\/\/[^/]+([^?#]*)/i.exec(decodedUrl)?.[1] ?? "";
    destinationSysId = /[?&]sys_id=([^&#]+)/i.exec(decodedUrl)?.[1] ?? null;
  }
  const blankRecordTable = /\/([a-z0-9_]+\.do)$/i.exec(destinationPath)?.[1];
  const asksToSelectExisting =
    /\b(?:select(?:ed|ing)?|choos(?:e|ing)|pick(?:ed|ing)?)\b[\s\S]{0,140}\b(?:existing|available|matching|row|record|result|category|option|entry)\b/i.test(
      instruction
    ) ||
    /\bclick\b[\s\S]{0,140}\b(?:existing|available|matching|row|record|result|category|option|entry)\b/i.test(instruction) ||
    /\b(?:existing|available|matching|row|record|result|category|option|entry)\b[\s\S]{0,140}\bclick\b/i.test(instruction);
  const asksToCreateRecord =
    asksToClickNew ||
    /\bcreate\b[\s\S]{0,80}\b(?:record|category|choice|variable|item)\b/i.test(instruction) ||
    /\badd\b[\s\S]{0,80}\b(?:new|blank)\b[\s\S]{0,80}\b(?:record|category|choice|variable|item)\b/i.test(instruction);
  if (blankRecordTable && destinationSysId === "-1" && asksToSelectExisting && !asksToCreateRecord) {
    return `Stopped for correction: a task to select an existing list/lookup record opened a blank new ${blankRecordTable} record instead (${destinationUrl}). Use Back, clear unwanted list conditions with the All breadcrumb if needed, and click the exact existing linked row; never use New for a selection task.`;
  }
  if (!asksToClickNew) {
    return undefined;
  }
  let expectedPath: "question_choice.do" | "item_option_new.do" | undefined;
  const addsChoiceRecord = /\b(?:add|create)\s+(?:(?:a|the)\s+)?(?:(?:new|first|next|another)\s+)?choice\b(?!\s+variable)/i.test(
    instruction
  );
  if (/\bquestion choices?\b/i.test(instruction) || addsChoiceRecord) {
    expectedPath = "question_choice.do";
  } else if (/\bvariables?\b|\bcheckbox\b/i.test(instruction)) {
    expectedPath = "item_option_new.do";
  }
  if (!expectedPath) {
    return undefined;
  }
  const landedOnExpectedTable = decodedUrl.toLowerCase().includes(`/${expectedPath}`);
  const sysId = /[?&]sys_id=([^&#]+)/i.exec(decodedUrl)?.[1];
  if (landedOnExpectedTable && sysId === "-1") {
    return undefined;
  }
  const recordKind = expectedPath === "question_choice.do" ? "Question Choice" : "Variable";
  return `Stopped for correction: the requested related-list New button did not open a blank ${recordKind} form (expected ${expectedPath}?sys_id=-1), and instead navigated to ${destinationUrl}. The prior index was stale. Inspect snapshotAfter and click the exact current button type=submit value=sysverb_new; do not click an existing row.`;
}

/** Mirrors the in-page arivuHostAllowed check; `domains` must already be normalized. */
function hostAllowed(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// The injected result comes from a JS context the page can fully control; bound and coerce
// every field before it flows into the main agent's tool result.
const MAX_RESULT_DATA_CHARS = 16_000;
// Preserve one bounded entry for every possible agent step. The aggregate stays small
// enough for the persisted browser-task artifact while avoiding the old last-30-only gap.
const MAX_RESULT_TRACE_ENTRIES = MAX_MAX_STEPS;
const MAX_RESULT_TRACE_ENTRY_CHARS = 120;

function sanitizeInjectedResult(raw: unknown): InjectedTaskResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Browser task returned no result." };
  }
  const result = raw as Record<string, unknown>;
  const sanitized: InjectedTaskResult = { ok: Boolean(result.ok) };
  if (result.success !== undefined) {
    sanitized.success = Boolean(result.success);
  }
  if (typeof result.data === "string") {
    sanitized.data = boundText(result.data, MAX_RESULT_DATA_CHARS);
  }
  if (typeof result.error === "string") {
    sanitized.error = boundText(result.error, MAX_RESULT_DATA_CHARS);
  }
  if (typeof result.stepCount === "number" && Number.isFinite(result.stepCount)) {
    sanitized.stepCount = Math.max(0, Math.trunc(result.stepCount));
  }
  if (Array.isArray(result.trace)) {
    sanitized.trace = result.trace
      .filter((entry): entry is string => typeof entry === "string")
      .slice(-MAX_RESULT_TRACE_ENTRIES)
      .map((entry) => boundText(entry, MAX_RESULT_TRACE_ENTRY_CHARS));
  }
  if (typeof result.tokensUsed === "number" && Number.isFinite(result.tokensUsed) && result.tokensUsed > 0) {
    sanitized.tokensUsed = Math.trunc(result.tokensUsed);
  }
  return sanitized;
}

function boundText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}… (truncated)` : text;
}

async function executeInjectedTask(target: JavaScriptExecutionTarget, script: string): Promise<InjectedTaskResult> {
  try {
    const result = await target.executeJavaScript(script, true);
    return sanitizeInjectedResult(result);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function stopInjectedTask(target: JavaScriptExecutionTarget): Promise<void> {
  await target.executeJavaScript(
    `(function() {
      if (window.__arivuPageAgentTask && typeof window.__arivuPageAgentTask.stop === "function") {
        return window.__arivuPageAgentTask.stop().then(function() { return true; }).catch(function() { return false; });
      }
      return Promise.resolve(false);
    })()`,
    true
  );
}

async function pollProgress(target: JavaScriptExecutionTarget): Promise<PolledProgress | undefined> {
  const result = (await target.executeJavaScript(
    `(function() {
      if (!window.__arivuPageAgentTask) {
        return null;
      }
      var history = window.__arivuPageAgentTask.history || [];
      var steps = history.filter(function(event) { return event && event.type === "step"; });
      var last = steps[steps.length - 1];
      return {
        stepCount: steps.length,
        lastAction: last && last.action && last.action.name || undefined,
        lastGoal: last && last.reflection && last.reflection.next_goal || undefined
      };
    })()`,
    true
  )) as PolledProgress | null;
  return result ?? undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
