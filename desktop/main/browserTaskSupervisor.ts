import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebContents } from "electron";
import type { BrowserTaskModelConfig, BrowserToolResult } from "../../src/tools/browserControl.js";
import {
  getBrowserTaskProxyDiagnostics,
  registerBrowserTaskProxyEntry,
  unregisterBrowserTaskProxyEntry,
  type BrowserTaskProxyDiagnostic
} from "./browserTaskProxy.js";
import {
  ARIVU_PAGE_AGENT_SYSTEM_INSTRUCTIONS,
  BACKFILL_REFLECTION_SNIPPET,
  BUILD_TRACE_SNIPPET,
  CAP_PAGE_CONTENT_SNIPPET,
  INSTALL_AGENT_VISUAL_THEME_SNIPPET
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
 * the last-polled snapshot seeds a resume instruction for a fresh instance on the new
 * document, under a shrunk step budget and a separate navigation-resume cap. A same-page
 * (`did-navigate-in-page`) navigation is a no-op: the JS context survives those.
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
const MAX_NAVIGATION_RESUMES = 6;
const TRANSIENT_FAILURE_THRESHOLD = 3;
const TRANSIENT_CIRCUIT_TTL_MS = 2 * 60_000;
const CONFIG_CIRCUIT_TTL_MS = 15 * 60_000;
const MAX_RESULT_PROXY_DIAGNOSTICS = 10;

type BrowserTaskStopReason = "timeout" | "cancelled" | "infrastructure";
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

export async function runBrowserTask(
  contents: WebContents,
  args: BrowserTaskArgs,
  modelConfig: BrowserTaskModelConfig,
  signal?: AbortSignal,
  onProgress?: (progress: { stepIndex: number; summary: string }) => void
): Promise<BrowserToolResult> {
  const maxSteps = clamp(Math.trunc(args.maxSteps ?? modelConfig.maxSteps ?? DEFAULT_MAX_STEPS), MIN_MAX_STEPS, MAX_MAX_STEPS);
  const stepDelaySeconds = Math.max(0, (modelConfig.stepDelayMs ?? STEP_DELAY_SECONDS * 1_000) / 1_000);
  const timeoutMs = clamp(Math.trunc(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const modelMetadata = {
    providerId: modelConfig.providerId,
    providerName: modelConfig.providerName,
    model: modelConfig.model,
    endpoint: safeEndpoint(modelConfig.baseUrl),
    maxSteps,
    timeoutMs,
    stepDelayMs: Math.round(stepDelaySeconds * 1_000)
  };
  const circuitKey = modelCircuitKey(modelConfig);
  const openCircuit = activeModelCircuit(circuitKey);
  if (openCircuit) {
    return {
      success: false,
      data: `Browser task model is temporarily unavailable: ${openCircuit.reason} Retry after ${new Date(openCircuit.expiresAt).toISOString()} or select another browser-task model/provider.`,
      stepCount: 0,
      stopped: true,
      stopReason: "infrastructure",
      navigationCount: 0,
      durationMs: 0,
      browserTaskModel: modelMetadata,
      proxyDiagnostics: []
    };
  }
  // Normalize here (not just in-page) so a mixed-case or dot-prefixed entry from the model
  // ("Example.COM", ".example.com") cannot make the in-page host check reject every page.
  const allowedDomains = normalizeAllowedDomains(args.allowedDomains?.length ? args.allowedDomains : defaultAllowedDomains(contents));
  const bundleText = await loadPageAgentBundle();
  const { token, proxyBaseUrl } = await registerBrowserTaskProxyEntry({
    realBaseUrl: modelConfig.baseUrl,
    realApiKey: modelConfig.apiKey,
    ttlMs: timeoutMs + PROXY_TOKEN_TTL_SLOP_MS
  });

  const startedAt = Date.now();
  let deadlineTimer: NodeJS.Timeout | undefined;
  let stopReason: BrowserTaskStopReason | undefined;
  let settleInfrastructureStop: ((result: InjectedTaskResult) => void) | undefined;
  const infrastructureStopPromise = new Promise<InjectedTaskResult>((resolve) => {
    settleInfrastructureStop = resolve;
  });
  const stopPromise = new Promise<InjectedTaskResult>((resolve) => {
    const settleStop = (reason: "timeout" | "cancelled", message: string) => {
      if (stopReason) {
        return;
      }
      stopReason = reason;
      resolve({ ok: false, error: message });
    };
    deadlineTimer = setTimeout(() => settleStop("timeout", `Browser task exceeded its ${timeoutMs}ms budget.`), timeoutMs);
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
  let resumeInstruction: string | undefined;
  let finalResult: InjectedTaskResult = { ok: false, error: "Browser task did not run." };
  // Progress last polled off the current instance; used to report how far the task got when
  // it is stopped without returning a result of its own (timeout/cancel before settle).
  // Assigned per iteration so a previous instance's steps (already folded into
  // stepsUsedSoFar on navigation resume) are never counted twice.
  let lastKnownProgress: PolledProgress | undefined;

  try {
    while (true) {
      // The stop can fire before the first injection (pre-aborted signal) or between
      // navigation resumes; never hand the page a fresh task after that.
      if (stopReason) {
        finalResult = {
          ok: false,
          error:
            stopReason === "cancelled"
              ? "Browser task was cancelled."
              : stopReason === "infrastructure"
                ? "Browser task stopped because its model endpoint became unavailable."
                : `Browser task exceeded its ${timeoutMs}ms budget.`
        };
        break;
      }
      const remainingSteps = clamp(maxSteps - stepsUsedSoFar, 1, MAX_MAX_STEPS);
      const script = injectedTaskScript(bundleText, {
        instruction: resumeInstruction ?? args.instruction,
        proxyBaseUrl,
        token,
        model: modelConfig.model,
        maxSteps: remainingSteps,
        stepDelaySeconds,
        // Steps already completed by pre-navigation instances; keeps trace step numbers
        // aligned with the cumulative stepCount in the tool result.
        stepIndexOffset: stepsUsedSoFar,
        allowedDomains,
        allowJavaScript: Boolean(args.allowJavaScript),
        allowSensitiveActions: Boolean(args.allowSensitiveActions),
        visible: Boolean(args.visible)
      });

      let navigated = false;
      const onNavigate = () => {
        navigated = true;
      };
      contents.on("did-navigate", onNavigate);
      let lastProgress: PolledProgress | undefined;
      let instanceSettled = false;
      const pollTimer = setInterval(() => {
        void pollProgress(contents)
          .then((progress) => {
            // An in-flight poll can resolve after the instance settled (and, on a navigation
            // resume, after its steps were folded into stepsUsedSoFar) — drop it.
            if (!progress || instanceSettled) {
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
          .catch(() => undefined);
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

      const taskPromise = executeInjectedTask(contents, script);
      let result: InjectedTaskResult;
      try {
        result = await Promise.race([taskPromise, stopPromise, infrastructureStopPromise]);
      } finally {
        instanceSettled = true;
        clearInterval(pollTimer);
        contents.off("did-navigate", onNavigate);
      }
      lastKnownProgress = lastProgress;

      if (stopReason) {
        // A wedged renderer can make executeJavaScript never resolve; the stop request and
        // the settle wait share the same bound so a timeout can never hang the tool call.
        await Promise.race([stopInjectedTask(contents).catch(() => undefined), delay(STOP_GRACE_MS)]);
        const settled = await Promise.race([taskPromise, delay(STOP_GRACE_MS).then(() => undefined)]);
        finalResult = settled ?? result;
        break;
      }

      if (!result.ok && navigated) {
        navigationResumeCount += 1;
        stepsUsedSoFar += lastProgress?.stepCount ?? 0;
        // Folded into stepsUsedSoFar above; must not be re-added via the fallback below.
        lastKnownProgress = undefined;
        if (navigationResumeCount > MAX_NAVIGATION_RESUMES || stepsUsedSoFar >= maxSteps) {
          finalResult = {
            ok: false,
            error: `Browser task stopped after ${navigationResumeCount} navigations without finishing (last known progress: ${
              lastProgress?.stepCount ?? 0
            } step(s)).`
          };
          break;
        }
        // Check the post-navigation host BEFORE re-injecting: the injected script carries the
        // live proxy token, and the in-page allowlist check only stops the agent after the
        // script (and token) are already in the new page's context.
        const nextHost = currentHost(contents);
        if (nextHost && !hostAllowed(nextHost, allowedDomains)) {
          finalResult = {
            ok: false,
            error: `Browser task stopped: the page navigated to "${nextHost}", which is outside the allowed domain list for this task.`
          };
          break;
        }
        resumeInstruction = buildResumeInstruction(args.instruction, lastProgress);
        continue;
      }

      finalResult = result;
      break;
    }

    const durationMs = Date.now() - startedAt;
    const success = finalResult.ok ? Boolean(finalResult.success) : false;
    const stepCount = stepsUsedSoFar + (finalResult.stepCount ?? lastKnownProgress?.stepCount ?? 0);
    let data = finalResult.ok ? (finalResult.data ?? "") : (finalResult.error ?? "Browser task failed.");
    const terminalCircuitFailure = !success ? circuitFailureFromDiagnostics(getBrowserTaskProxyDiagnostics(token)) : undefined;
    if (terminalCircuitFailure && !stopReason) {
      stopReason = "infrastructure";
      modelCircuits.set(circuitKey, {
        openedAt: Date.now(),
        expiresAt: Date.now() + terminalCircuitFailure.ttlMs,
        reason: terminalCircuitFailure.reason
      });
    }
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
    if (!success && stepCount === 0 && isModelConnectivityFailure(data)) {
      data = `${data} — the in-page agent could not reach its model endpoint before taking a single step. This is an infrastructure/connectivity failure, not a problem with the instruction; retrying browser_task with reworded instructions will not help. Check browser_console for CORS or network errors and report the failure to the user.`;
    }
    const result: BrowserToolResult = {
      success,
      data,
      stepCount,
      stopped: Boolean(stopReason),
      stopReason,
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
    return result;
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
    unregisterBrowserTaskProxyEntry(token);
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

function buildResumeInstruction(originalInstruction: string, progress: PolledProgress | undefined): string {
  if (!progress || progress.stepCount === 0) {
    return originalInstruction;
  }
  // lastAction/lastGoal are model-generated under page influence and end up inside the resumed
  // agent's <user_request>; condensing bounds what a hostile page can steer into that slot.
  const lastAction = condenseForPrompt(progress.lastAction, 100);
  const lastGoal = condenseForPrompt(progress.lastGoal, 200);
  const actionNote = lastAction ? ` (last action: ${lastAction}${lastGoal ? `, aiming to ${lastGoal}` : ""})` : "";
  return `${originalInstruction}\n\nNote: you already completed ${progress.stepCount} step(s) toward this task before the page navigated${actionNote}. Continue from here on the new page. If the task already looks complete, finish immediately instead of repeating work.`;
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
var arivuOnBeforeStep = async function(agentInstance) {
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
return core.execute(${JSON.stringify(options.instruction)}).then(function(result) {
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

async function executeInjectedTask(contents: WebContents, script: string): Promise<InjectedTaskResult> {
  try {
    const result = await contents.executeJavaScript(script, true);
    return sanitizeInjectedResult(result);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function stopInjectedTask(contents: WebContents): Promise<void> {
  await contents.executeJavaScript(
    `(function() {
      if (window.__arivuPageAgentTask && typeof window.__arivuPageAgentTask.stop === "function") {
        return window.__arivuPageAgentTask.stop().then(function() { return true; }).catch(function() { return false; });
      }
      return Promise.resolve(false);
    })()`,
    true
  );
}

async function pollProgress(contents: WebContents): Promise<PolledProgress | undefined> {
  const result = (await contents.executeJavaScript(
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
