import { existsSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BrowserView,
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  powerSaveBlocker,
  shell,
  type WebContents,
  type ContextMenuParams,
  type Input,
  type MessageBoxOptions,
  type MenuItemConstructorOptions,
  type Session
} from "electron";
import { appDataDir } from "../../src/config.js";
import { locateAnythingInViewport } from "../../src/browser/locateAnythingHarness.js";
import {
  normalizeBrowserMode,
  normalizeBrowserUrl,
  type BrowserConsoleEntry,
  type BrowserMode,
  type BrowserState,
  type BrowserTargetState,
  type BrowserTaskModelConfig,
  type BrowserToolController,
  type BrowserToolResult
} from "../../src/tools/browserControl.js";
import type { WebSearchProviderProfile } from "../../src/tools/webSearchProvider.js";
import { runBrowserTask } from "./browserTaskSupervisor.js";
import type { BrowserTaskScreenshot, BrowserTaskVisualClickResult } from "./browserTaskProxy.js";
import {
  BROWSER_ANNOTATION_CONSOLE_PREFIX,
  applyBrowserDesignPatchScript,
  browserAutofillScript,
  discardBrowserDesignPatchScript,
  installBrowserAnnotationScript,
  normalizeBrowserDesignPatch,
  type BrowserAnnotationMode,
  type BrowserAnnotationSelection,
  type BrowserDesignPatch,
  type BrowserPendingAnnotation
} from "./browserCollaboration.js";
import { BrowserProfileStore, type BrowserImportedCookie } from "./browserProfileStore.js";
import {
  boundIndexedContent,
  clickElementByIndex,
  freshPageSnapshot,
  indexedPageState,
  inputTextByIndex,
  scrollPage,
  selectOptionByIndex
} from "./pageControllerRuntime.js";
import type {
  BrowserDeviceViewport,
  BrowserDownloadRecord,
  BrowserFrameInspection,
  BrowserHistoryRecord,
  BrowserSessionSnapshot,
  BrowserStateListener,
  BrowserTabRecord,
  BrowserTargetRecord,
  BrowserViewport,
  BrowserVisualViewportState
} from "./browserTypes.js";
import {
  DEFAULT_VISIBLE_CHROME_HEIGHT,
  VISIBLE_START_PAGE_TITLE,
  isVisibleLoadErrorPageUrl,
  isVisibleSettingsCommandUrl,
  isVisibleSettingsPageUrl,
  isVisibleShellCommandUrl,
  isVisibleShellPageUrl,
  isVisibleStartPageUrl,
  parseVisibleShellCommand,
  visibleCrashRecoveryPageUrl,
  visibleLoadErrorPageUrl,
  visibleSettingsPageUrl,
  visibleShellPageUrl,
  visibleStartPageUrl
} from "./browserPages.js";
import {
  assertAllowedPopupUrl,
  assertBrowserVisualViewportUnchanged,
  assertPageLoaded,
  availableDownloadPath,
  axPropertyValue,
  browserPermissionKey,
  browserShellWebPreferences,
  browserWebPreferences,
  capElementsBySerializedSize,
  clampNumber,
  frameInfo,
  frameList,
  humanizePermission,
  initialTarget,
  isNavigationAbortError,
  isRecord,
  isRestorableBrowserUrl,
  isSuccessfulFrameInspection,
  mergeSnapshotText,
  normalizeConsoleLevel,
  publicTab,
  publicTarget
} from "./browserUtilities.js";
import { capturePageWithDebugger, capturePageWithTimeout, delay, pruneOldBrowserScreenshots, waitForFreshPaint } from "./browserCapture.js";
import {
  boundScriptResult,
  clickScript,
  describePointScript,
  executeJavaScriptScript,
  snapshotScript,
  typeScript
} from "./browserInPageScripts.js";
import { BrowserSessionPersistence } from "./browserSessionPersistence.js";

const MAX_CONSOLE_LOGS = 300;
// Budget for the serialized element list in snapshot/screenshot results. Without it a busy
// page (e.g. ServiceNow) can push a single tool result past the request auto-compaction
// threshold, which strips native tool protocol and derails tool calling on the next turn.
const MAX_VISUAL_ELEMENTS_JSON_CHARS = 48_000;
// Native BrowserView capture can occasionally remain pending forever after a
// compositor swap. Screenshotting is diagnostic and must not pin the whole agent
// run, so each native attempt is bounded before the existing CDP fallback runs.
// A script with a blocking synchronous loop can wedge the renderer's JS thread forever;
// executeJavaScript would then never resolve. This bounds the tool call itself so it always
// returns to the model — the renderer may still be busy in the background afterward.
const SCRIPT_EXECUTION_TIMEOUT_MS = 15_000;
// Keeps a large returned value from pushing a single tool result past the request
// auto-compaction threshold (same concern as MAX_VISUAL_ELEMENTS_JSON_CHARS above).
const VISUAL_GROUNDING_MAX_DIMENSION = 1_600;
const VISUAL_GROUNDING_JPEG_QUALITY = 90;
const VISUAL_GROUNDING_MAX_DATA_URL_CHARS = 8_000_000;
const DEFAULT_BACKGROUND_BOUNDS = { width: 1280, height: 800 };

export class DesktopBrowserController implements BrowserToolController {
  private hostWindow: BrowserWindow | undefined;
  private visibleWindow: BrowserWindow | undefined;
  private backgroundWindow: BrowserWindow | undefined;
  private destroyingVisibleWindow = false;
  private paneOpen = false;
  private defaultMode: BrowserMode = "background";
  private activeMode: BrowserMode = "background";
  private activeVisibleTabId: string | undefined;
  private visibleChromeHeight = DEFAULT_VISIBLE_CHROME_HEIGHT;
  private readonly recentlyClosedVisibleTabs: Array<{ url: string; title: string }> = [];
  private findOpen = false;
  private findQuery = "";
  private findMatches = 0;
  private findActiveMatch = 0;
  private deviceViewport: BrowserDeviceViewport = { enabled: false, preset: "responsive", width: 390, height: 844, scale: 1 };
  private annotationMode: BrowserAnnotationMode = "browse";
  private readonly pendingAnnotations: BrowserPendingAnnotation[] = [];
  private activeAnnotationId: string | undefined;
  private nextAnnotationNumber = 1;
  private collaborationHandoff: { id: number; prompt: string; screenshotPaths: string[] } | undefined;
  private nextHandoffId = 1;
  private profileStore: BrowserProfileStore | undefined;
  private readonly loadedExtensionPaths = new Map<string, string>();
  private shellNotice: { id: number; message: string; error?: boolean } | undefined;
  private nextShellNoticeId = 1;
  private visibleShellRenderInFlight = false;
  private visibleShellRenderPending = false;
  private visibleShellReady = false;
  private readonly configuredBrowserSessions = new WeakSet<Session>();
  private readonly browserDownloads: BrowserDownloadRecord[] = [];
  private readonly browserHistory: BrowserHistoryRecord[] = [];
  private readonly browserPermissions = new Map<string, "allow" | "block">();
  private askDownloadLocation = false;
  private downloadDirectory: string | undefined;
  private readonly visibleSessionPersistence = new BrowserSessionPersistence();
  private nextVisibleTabNumber = 1;
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly visibleTabs = new Map<string, BrowserTabRecord>();
  private readonly visibleTabOrder: string[] = [];
  /**
   * The tab agent tools default to when no tabId is passed. Deliberately separate from
   * activeVisibleTabId (the tab the user is looking at): agent work must never switch or
   * focus the user's view as a side effect of resolving its own target.
   */
  private agentTargetTabId: string | undefined;
  /** Tabs with a delegated browser_task currently running (throttling disabled, badge shown). */
  private readonly agentTaskTabIds = new Set<string>();
  /** Where to return the user's view when they leave the agent tab via the Hide control. */
  private watchReturnTabId: string | undefined;
  private agentPowerSaveBlockerId: number | undefined;
  private readonly targets: Record<BrowserMode, BrowserTargetRecord> = {
    visible: initialTarget("visible"),
    background: initialTarget("background")
  };

  attach(window: BrowserWindow) {
    this.hostWindow = window;
  }

  detach(window: BrowserWindow) {
    if (this.hostWindow !== window) {
      return;
    }
    this.persistVisibleSessionNow();
    this.destroyVisibleWindow();
    this.hostWindow = undefined;
  }

  onState(listener: BrowserStateListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): BrowserState {
    return {
      paneOpen: this.paneOpen,
      defaultMode: this.defaultMode,
      activeMode: this.activeMode,
      visible: this.publicVisibleTarget(),
      background: publicTarget(this.targets.background),
      collaboration: {
        mode: this.annotationMode,
        pendingCount: this.pendingAnnotations.length,
        activeAnnotationId: this.activeAnnotationId,
        handoff: this.collaborationHandoff
      }
    };
  }

  setPaneOpen(open: boolean) {
    this.paneOpen = open;
    if (open) {
      this.rememberMode("visible");
      const window = this.ensureVisibleWindow();
      this.restoreVisibleSessionOnce();
      this.ensureVisibleTab();
      const waitingForShell = this.ensureVisibleShellPage(window.webContents);
      if (waitingForShell) {
        const showWhenReady = () => this.showVisibleWindow(window);
        window.webContents.once("did-finish-load", showWhenReady);
        window.webContents.once("did-fail-load", showWhenReady);
      } else {
        this.showVisibleWindow(window);
      }
      this.attachActiveVisibleView();
    } else if (this.visibleWindow && !this.visibleWindow.isDestroyed()) {
      this.visibleWindow.hide();
    }
    this.emitState();
    return this.getState();
  }

  togglePaneOpen() {
    return this.setPaneOpen(!this.paneOpen);
  }

  setDefaultMode(mode: BrowserMode) {
    this.defaultMode = mode;
    this.rememberMode(mode);
    this.emitState();
    return this.getState();
  }

  goBack(mode?: BrowserMode, tabId?: string) {
    const target = this.targetForMode(mode);
    this.rememberMode(target);
    const { contents } = this.browserContextForMode(target, tabId);
    if (contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    }
    return this.getState();
  }

  goForward(mode?: BrowserMode, tabId?: string) {
    const target = this.targetForMode(mode);
    this.rememberMode(target);
    const { contents } = this.browserContextForMode(target, tabId);
    if (contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
    return this.getState();
  }

  reload(mode?: BrowserMode, tabId?: string) {
    const target = this.targetForMode(mode);
    this.rememberMode(target);
    const { contents, target: record } = this.browserContextForMode(target, tabId);
    if (record.failedUrl) {
      const failedUrl = record.failedUrl;
      record.failedUrl = undefined;
      record.lastError = undefined;
      record.recoveryTitle = undefined;
      void contents.loadURL(failedUrl).catch(() => undefined);
    } else {
      contents.reload();
    }
    return this.getState();
  }

  stop(mode?: BrowserMode, tabId?: string) {
    const target = this.targetForMode(mode);
    this.rememberMode(target);
    const { contents } = this.browserContextForMode(target, tabId);
    if (contents.isLoading()) {
      contents.stop();
    }
    return this.getState();
  }

  newVisibleTab(args: { url?: string } = {}) {
    const url = args.url ? normalizeBrowserUrl(args.url) : undefined;
    this.paneOpen = true;
    const window = this.ensureVisibleWindow();
    this.ensureVisibleShellPage(window.webContents);
    this.restoreVisibleSessionOnce();
    this.showVisibleWindow(window);
    this.createVisibleTab({ url, activate: true });
    this.emitState();
    return this.getState();
  }

  selectVisibleTab(tabId: string) {
    this.selectVisibleTabById(tabId);
    this.emitState();
    return this.getState();
  }

  getVisibleTabWebContents(tabId: string) {
    const tab = this.visibleTabs.get(tabId);
    if (!tab || tab.contents.isDestroyed()) {
      throw new Error(`Unknown visible browser tab: ${tabId}`);
    }
    return tab.contents;
  }

  async selectTab(args: { tabId: string }): Promise<BrowserToolResult> {
    // Agent tool: retarget subsequent agent calls only. The user's attached view and focus
    // stay exactly where they are — an agent choosing its work tab is not a reason to switch
    // what the user is looking at.
    const target = this.visibleTabs.get(args.tabId);
    if (!target) {
      throw new Error(`Unknown visible browser tab: ${args.tabId}`);
    }
    if (target.contents.isDestroyed()) {
      this.closeVisibleTabById(args.tabId);
      this.emitState();
      throw new Error(`Visible browser tab closed before it could be selected: ${args.tabId}`);
    }
    this.agentTargetTabId = args.tabId;
    this.rememberMode("visible");
    this.updateTargetFromContents("visible", target.contents, target);
    this.emitState();
    return this.resultForMode(
      "visible",
      {
        activeTabId: this.activeVisibleTabId,
        tabs: this.publicVisibleTarget().tabs ?? []
      },
      target
    );
  }

  closeVisibleTab(tabId: string) {
    this.closeVisibleTabById(tabId);
    this.emitState();
    return this.getState();
  }

  async open(args: {
    url: string;
    mode?: BrowserMode;
    tabId?: string;
    newTab?: boolean;
    source?: "user" | "agent";
  }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const url = normalizeBrowserUrl(args.url);
    const initiator = args.source ?? "user";
    let selectedTabId = args.tabId;
    if (mode === "visible") {
      this.paneOpen = true;
      const window = this.ensureVisibleWindow();
      this.ensureVisibleShellPage(window.webContents);
      this.restoreVisibleSessionOnce();
      if (initiator === "user") {
        this.showVisibleWindow(window);
      } else {
        // Agent-initiated: the window may appear if it does not exist yet, but it must never
        // take focus away from whatever app or window the user is currently working in, and
        // an already-placed window is left exactly where the user put it.
        this.revealVisibleWindowInactive(window);
      }
      if (args.newTab) {
        // An agent-requested tab loads without becoming the tab the user is looking at; it
        // becomes the agent's own target instead (resolved below via browserContextForMode).
        selectedTabId = this.createVisibleTab({ activate: initiator === "user", deferLoad: true }).id;
      } else if (!selectedTabId && !this.activeVisibleTab()) {
        selectedTabId = this.createVisibleTab({ activate: true, focus: initiator === "user", deferLoad: true }).id;
      }
    }
    const { contents, target } = this.browserContextForMode(mode, selectedTabId);
    target.lastError = undefined;
    target.failedUrl = undefined;
    target.recoveryTitle = undefined;
    await contents.loadURL(url);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(mode, { url: contents.getURL(), title: contents.getTitle() }, target);
  }

  async screenshot(args: { mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    this.prepareForScreenshot(contents);
    const preInspectPaint = await waitForFreshPaint(contents);
    const visual = (await this.inspectPage(contents, 6_000)) as BrowserToolResult & { viewport?: BrowserViewport };
    this.prepareForScreenshot(contents);
    const preCapturePaint = await waitForFreshPaint(contents);
    const image = await this.captureTargetPage(mode, contents);
    const size = image.getSize();
    const screenshotDir = path.join(appDataDir(), "browser-screenshots");
    await mkdir(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `arivu-browser-${mode}-${target.id}-${Date.now()}.png`);
    await writeFile(screenshotPath, image.toPNG());
    void pruneOldBrowserScreenshots(screenshotDir).catch(() => undefined);
    target.lastScreenshotAt = new Date().toISOString();
    target.lastScreenshotPath = screenshotPath;
    target.lastScreenshotSize = size;
    target.lastViewport = visual.viewport;
    this.emitState();
    return this.resultForMode(
      mode,
      {
        screenshotPath,
        size,
        viewport: visual.viewport,
        paint: {
          preInspect: preInspectPaint,
          preCapture: preCapturePaint
        },
        visual
      },
      target
    );
  }

  async snapshot(args: { mode?: BrowserMode; tabId?: string; maxLength?: number }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    const maxLength = clampNumber(args.maxLength ?? 12_000, 1_000, 20_000);
    const snapshot = await this.inspectPage(contents, maxLength);
    const indexed = await indexedPageState(contents).catch(() => undefined);
    if (indexed) {
      const bounded = boundIndexedContent(indexed.content);
      (snapshot as Record<string, unknown>).elementsTree = bounded.text;
      if (bounded.truncated) {
        (snapshot as Record<string, unknown>).elementsTreeTruncated = true;
      }
    }
    target.lastSnapshotAt = new Date().toISOString();
    this.emitState();
    return this.resultForMode(mode, { snapshot }, target);
  }

  async console(args: { mode?: BrowserMode; tabId?: string; levels?: string[]; limit?: number }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { target } = this.browserContextForMode(mode, args.tabId);
    const allowedLevels = new Set((args.levels ?? []).map((level) => level.toLowerCase()));
    const limit = clampNumber(args.limit ?? 50, 1, 100);
    const logs = target.logs.filter((entry) => allowedLevels.size === 0 || allowedLevels.has(entry.level)).slice(-limit);
    return this.resultForMode(mode, { logs }, target);
  }

  async click(args: { target?: string; index?: number; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    let result: BrowserToolResult | undefined;
    if (args.index !== undefined) {
      const indexedResult = await clickElementByIndex(contents, args.index);
      if (indexedResult) {
        result = indexedResult;
      }
    }
    if (!result) {
      result = await this.executeAcrossFrames(contents, clickScript(args.target ?? ""));
    }
    result = await this.withFreshSnapshot(contents, result);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(mode, result, target);
  }

  async clickAt(args: {
    x: number;
    y: number;
    mode?: BrowserMode;
    tabId?: string;
    coordinateSpace?: "css" | "image";
  }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    const point = this.resolveClickPoint(target, args.x, args.y, args.coordinateSpace ?? "css");
    const matched = (await contents.executeJavaScript(describePointScript(point.x, point.y), true)) as unknown;
    this.dispatchViewportClick(contents, point.x, point.y);
    await delay(120);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(
      mode,
      {
        ok: true,
        x: point.x,
        y: point.y,
        coordinateSpace: "css",
        requested: {
          x: args.x,
          y: args.y,
          coordinateSpace: args.coordinateSpace ?? "css"
        },
        matched
      },
      target
    );
  }

  async type(args: {
    target?: string;
    index?: number;
    text: string;
    mode?: BrowserMode;
    tabId?: string;
    submit?: boolean;
  }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    let result: BrowserToolResult | undefined;
    if (args.index !== undefined && !args.submit) {
      const indexedResult = await inputTextByIndex(contents, args.index, args.text);
      if (indexedResult) {
        result = indexedResult;
      }
    }
    if (!result) {
      result = await this.executeAcrossFrames(contents, typeScript(args.target ?? "", args.text, Boolean(args.submit)));
    }
    result = await this.withFreshSnapshot(contents, result);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(mode, result, target);
  }

  async scroll(args: {
    direction: "up" | "down" | "left" | "right";
    pixels?: number;
    numPages?: number;
    index?: number;
    mode?: BrowserMode;
    tabId?: string;
  }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    const horizontal = args.direction === "left" || args.direction === "right";
    const scrollResult = await scrollPage(contents, {
      horizontal,
      down: args.direction === "down",
      right: args.direction === "right",
      pixels: args.pixels,
      numPages: args.numPages,
      index: args.index
    });
    let result: BrowserToolResult = scrollResult ?? { ok: false, message: "The scroll engine failed to load on this page." };
    result = await this.withFreshSnapshot(contents, result);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(mode, result, target);
  }

  async selectOption(args: { index: number; optionText: string; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    const selectResult = await selectOptionByIndex(contents, args.index, args.optionText);
    let result: BrowserToolResult = selectResult ?? { ok: false, message: "The select engine failed to load on this page." };
    result = await this.withFreshSnapshot(contents, result);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(mode, result, target);
  }

  private async withFreshSnapshot(contents: WebContents, result: BrowserToolResult): Promise<BrowserToolResult> {
    const fields = await freshPageSnapshot(contents);
    return fields ? { ...result, ...fields } : result;
  }

  async executeJavaScript(args: { script: string; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    let result: BrowserToolResult;
    try {
      // userGesture: false is deliberate here (unlike clickAt's describePointScript, which needs
      // it) — a script that could unlock gesture-gated APIs (clipboard, popups) should not get
      // that from this tool alone.
      const outcome = (await Promise.race([
        contents.executeJavaScript(executeJavaScriptScript(args.script), false),
        delay(SCRIPT_EXECUTION_TIMEOUT_MS).then(() => {
          throw new Error(
            `Script execution timed out after ${SCRIPT_EXECUTION_TIMEOUT_MS}ms. The page may still be running it in the background; reload the tab if it stays unresponsive.`
          );
        })
      ])) as { ok: boolean; result?: unknown; error?: string };
      result = outcome.ok ? { ok: true, result: boundScriptResult(outcome.result) } : { ok: false, error: outcome.error };
    } catch (error) {
      // Catches both the timeout above and a script that fails to parse at all (a syntax error
      // in args.script breaks the whole wrapped function, so executeJavaScript itself rejects
      // before the in-page try/catch in executeJavaScriptScript ever runs).
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    result = await this.withFreshSnapshot(contents, result);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(mode, result, target);
  }

  async task(args: {
    instruction: string;
    mode?: BrowserMode;
    tabId?: string;
    maxSteps?: number;
    timeoutMs?: number;
    allowedDomains?: string[];
    allowJavaScript?: boolean;
    allowSensitiveActions?: boolean;
    webSearchProvider?: WebSearchProviderProfile;
    modelConfig: BrowserTaskModelConfig;
    signal?: AbortSignal;
    onProgress?: (progress: { stepIndex: number; summary: string }) => void;
  }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const { contents, target } = this.browserContextForMode(mode, args.tabId);
    assertPageLoaded(contents, mode);
    this.beginAgentBrowserTask(mode, target.id, contents);
    let taskResult: BrowserToolResult;
    try {
      taskResult = await runBrowserTask(
        contents,
        {
          instruction: args.instruction,
          maxSteps: args.maxSteps,
          timeoutMs: args.timeoutMs,
          allowedDomains: args.allowedDomains,
          allowJavaScript: args.allowJavaScript,
          allowSensitiveActions: args.allowSensitiveActions,
          webSearchProvider: args.webSearchProvider,
          captureScreenshot: () => this.captureBrowserTaskScreenshot(mode, contents),
          visualClick: args.modelConfig.visualGrounding
            ? (description, signal) =>
                this.locateAndClickBrowserTaskTarget(mode, contents, target, args.modelConfig.visualGrounding!, description, signal)
            : undefined,
          visible: mode === "visible"
        },
        args.modelConfig,
        args.signal,
        args.onProgress
      );
    } finally {
      this.endAgentBrowserTask(mode, target.id, contents);
    }
    // Attach a bounded post-task page snapshot (the same helper the click/type/scroll/select
    // tools use) so the main agent can verify the delegated outcome from text instead of
    // spending a whole extra turn on a heavier browser_screenshot. Never throws:
    // withFreshSnapshot returns the result unchanged if the page-controller can't load here.
    let result = await this.withFreshSnapshot(contents, taskResult);
    // Failed delegated tasks often leave the supervising agent with only text (snapshotAfter /
    // correction notes). Capture viewport pixels automatically so the next turn has the same
    // recovery evidence a manual browser_screenshot would have produced — except on explicit
    // user cancel, where the page state is not "stuck".
    if (taskResult.success === false && taskResult.stopReason !== "cancelled") {
      result = await this.withFailureScreenshot(mode, contents, target, result);
    }
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(mode, result, target);
  }

  /**
   * Best-effort failure-path capture. Never throws: a missing compositor surface or a closed
   * tab must not replace the real failure reason with a screenshot error.
   */
  private async withFailureScreenshot(
    mode: BrowserMode,
    contents: WebContents,
    target: BrowserTargetRecord,
    result: BrowserToolResult
  ): Promise<BrowserToolResult> {
    if (contents.isDestroyed()) {
      return result;
    }
    try {
      this.prepareForScreenshot(contents);
      await waitForFreshPaint(contents);
      const image = await this.captureTargetPage(mode, contents);
      if (image.isEmpty()) {
        return result;
      }
      const size = image.getSize();
      const screenshotDir = path.join(appDataDir(), "browser-screenshots");
      await mkdir(screenshotDir, { recursive: true });
      const screenshotPath = path.join(screenshotDir, `arivu-browser-task-failure-${mode}-${target.id}-${Date.now()}.png`);
      await writeFile(screenshotPath, image.toPNG());
      target.lastScreenshotAt = new Date().toISOString();
      target.lastScreenshotPath = screenshotPath;
      target.lastScreenshotSize = size;
      // Captured automatically on every failed task (no user opt-in), so reap old screenshots
      // here or the directory grows without bound over a long, failure-heavy session.
      void pruneOldBrowserScreenshots(screenshotDir).catch(() => undefined);
      const data = typeof result.data === "string" ? result.data : "";
      const note =
        "Failure screenshot captured automatically for recovery. Path: " +
        screenshotPath +
        ". Use the pixels plus snapshotAfter; re-issue a destination-specific browser_task from current indices (do not reuse stale ones).";
      return {
        ...result,
        screenshotPath,
        size,
        failureScreenshot: true,
        data: data ? `${data}\n\n${note}` : note
      };
    } catch {
      return result;
    }
  }

  private targetForMode(mode: BrowserMode | undefined) {
    return normalizeBrowserMode(mode) ?? this.activeMode ?? this.defaultMode;
  }

  private browserContextForMode(mode: BrowserMode, tabId?: string) {
    if (mode === "visible") {
      const target = this.resolveVisibleTabForAgent(tabId);
      return {
        target,
        contents: target.contents
      };
    }
    return {
      target: this.targets.background,
      contents: this.ensureBackgroundWindow().webContents
    };
  }

  /**
   * Resolves the tab a tool call should act on WITHOUT activating, attaching, or focusing
   * anything. Selecting a target used to run the full user-facing tab switch
   * (selectVisibleTabById → attachActiveVisibleView → focus), which meant every delegated
   * browser action yanked the view — and with it the user's keyboard — back to the agent's
   * tab. Acting on a WebContents needs none of that; the user's view is only ever changed by
   * the user's own clicks (shell commands) or the explicit Watch control.
   */
  private resolveVisibleTabForAgent(tabId?: string) {
    if (tabId) {
      const target = this.visibleTabs.get(tabId);
      if (!target) {
        throw new Error(`Unknown visible browser tab: ${tabId}`);
      }
      if (target.contents.isDestroyed()) {
        this.closeVisibleTabById(tabId);
        this.emitState();
        throw new Error(`Visible browser tab closed before it could be selected: ${tabId}`);
      }
      this.agentTargetTabId = tabId;
      return target;
    }
    const remembered = this.agentTargetTabId ? this.visibleTabs.get(this.agentTargetTabId) : undefined;
    if (remembered && !remembered.contents.isDestroyed()) {
      return remembered;
    }
    const active = this.activeVisibleTab();
    if (active) {
      this.agentTargetTabId = active.id;
      return active;
    }
    // No tabs exist at all: create one. It may attach (there is nothing else to show), but it
    // must not pull keyboard focus into the window.
    const created = this.createVisibleTab({ activate: true, focus: false });
    this.agentTargetTabId = created.id;
    return created;
  }

  /**
   * Marks a delegated browser task as running on a tab: the renderer is exempted from
   * background throttling (a detached or occluded tab otherwise has its timers slowed to a
   * crawl — the in-page agent lives on timers and a 38-minute background hang came from
   * exactly this), the app is kept out of macOS App Nap while any task runs, and the shell
   * shows a working badge. endAgentBrowserTask restores every one of these.
   */
  private beginAgentBrowserTask(mode: BrowserMode, tabId: string, contents: WebContents) {
    if (mode !== "visible") {
      return;
    }
    this.agentTaskTabIds.add(tabId);
    if (!contents.isDestroyed() && typeof contents.setBackgroundThrottling === "function") {
      contents.setBackgroundThrottling(false);
    }
    if (this.agentPowerSaveBlockerId === undefined) {
      try {
        this.agentPowerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      } catch {
        // Power-save exemption is best-effort; throttling exemption above is the main guard.
      }
    }
    this.emitState();
  }

  private endAgentBrowserTask(mode: BrowserMode, tabId: string, contents: WebContents) {
    if (mode !== "visible") {
      return;
    }
    this.agentTaskTabIds.delete(tabId);
    if (!contents.isDestroyed() && typeof contents.setBackgroundThrottling === "function") {
      contents.setBackgroundThrottling(true);
    }
    if (this.agentTaskTabIds.size === 0 && this.agentPowerSaveBlockerId !== undefined) {
      try {
        powerSaveBlocker.stop(this.agentPowerSaveBlockerId);
      } catch {
        // Releasing the blocker is best-effort.
      }
      this.agentPowerSaveBlockerId = undefined;
      // Polite attention instead of self-surfacing: when the last delegated task finishes
      // while the user is working elsewhere, bounce the dock icon once. Never show or focus
      // a window from here.
      if (process.platform === "darwin" && !BrowserWindow.getFocusedWindow()) {
        try {
          app.dock?.bounce("informational");
        } catch {
          // Dock signaling is decorative; ignore environments without a dock.
        }
      }
    }
    this.emitState();
  }

  /**
   * Agent-path counterpart to showVisibleWindow: reveal the window only if it is not visible
   * at all, without activating the app or taking key status, and never resize or reposition a
   * window the user has placed. Focus stays with whatever the user is doing.
   */
  private revealVisibleWindowInactive(window: BrowserWindow) {
    if (window.isDestroyed() || window.isVisible()) {
      return;
    }
    window.showInactive();
  }

  private rememberMode(mode: BrowserMode) {
    this.activeMode = mode;
  }

  private async inspectPage(contents: WebContents, maxLength: number): Promise<BrowserToolResult> {
    const frames = frameList(contents);
    const frameResults: BrowserFrameInspection[] = await Promise.all(
      frames.slice(0, 30).map(async (frame, index) => {
        const frameMeta = frameInfo(frame, contents.mainFrame, index);
        try {
          const snapshot = (await frame.executeJavaScript(snapshotScript(maxLength), true)) as BrowserToolResult;
          return { ...frameMeta, ok: true, snapshot };
        } catch (error) {
          return {
            ...frameMeta,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
    const successful = frameResults.filter(isSuccessfulFrameInspection);
    const text = mergeSnapshotText(
      successful.map((frame) => String((frame.snapshot as Record<string, unknown>).text ?? "")),
      maxLength
    );
    // Elements carry only frameIndex (the frames summary maps index -> url/name/origin);
    // stamping the full frame URL on every element once inflated a single ServiceNow
    // screenshot result to ~195K chars, forcing request auto-compaction on the first model
    // call, which textified the tool protocol and broke native tool calling downstream.
    const allElements = successful.flatMap((frame) => {
      const snapshot = frame.snapshot as Record<string, unknown>;
      const entries = Array.isArray(snapshot.elements) ? snapshot.elements : [];
      return entries.filter(isRecord).map((entry) => ({
        ...entry,
        frameIndex: frame.index,
        mainFrame: frame.mainFrame
      }));
    });
    const elements = capElementsBySerializedSize(allElements.slice(0, 320), MAX_VISUAL_ELEMENTS_JSON_CHARS);
    const mainSnapshot = successful.find((frame) => frame.mainFrame)?.snapshot as Record<string, unknown> | undefined;
    const viewport = isRecord(mainSnapshot?.viewport) ? (mainSnapshot.viewport as BrowserViewport) : undefined;
    const frameSummaries = frameResults.map((frame) => {
      const snapshot = frame.ok && isRecord(frame.snapshot) ? frame.snapshot : undefined;
      const frameText = typeof snapshot?.text === "string" ? snapshot.text : "";
      const frameElements = Array.isArray(snapshot?.elements) ? snapshot.elements.length : 0;
      return {
        index: frame.index,
        url: frame.url,
        name: frame.name,
        origin: frame.origin,
        mainFrame: frame.mainFrame,
        ok: frame.ok,
        textLength: frameText.length,
        elementCount: frameElements,
        ...(!frame.ok ? { error: frame.error } : {})
      };
    });
    const diagnostics = {
      frameCount: frames.length,
      inspectedFrameCount: frameResults.length,
      textLength: text.length,
      elementCount: elements.length,
      ...(allElements.length > elements.length ? { elementsTruncated: allElements.length - elements.length } : {}),
      empty: text.length === 0 && elements.length === 0,
      note:
        text.length === 0 && elements.length === 0
          ? "No accessible text or elements were found. If visible content is present, delegate interaction to browser_task."
          : "Coordinates are CSS viewport pixels."
    };
    const accessibility = await this.accessibilitySnapshot(contents);

    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      text,
      elements,
      viewport,
      frames: frameSummaries,
      accessibility,
      diagnostics
    };
  }

  private async accessibilitySnapshot(contents: WebContents): Promise<BrowserToolResult> {
    const debuggerApi = contents.debugger;
    const wasAttached = debuggerApi.isAttached();
    try {
      if (!wasAttached) {
        debuggerApi.attach("1.3");
      }
      const result = (await debuggerApi.sendCommand("Accessibility.getFullAXTree", {})) as BrowserToolResult;
      const rawNodes = Array.isArray(result.nodes) ? result.nodes.filter(isRecord) : [];
      const nodes = rawNodes
        .map((node) => {
          const role = axPropertyValue(node.role);
          const name = axPropertyValue(node.name);
          const value = axPropertyValue(node.value);
          const description = axPropertyValue(node.description);
          return {
            role: role || undefined,
            name: name || undefined,
            value: value || undefined,
            description: description || undefined
          };
        })
        .filter((node) => node.role || node.name || node.value || node.description)
        .filter((node) => !["generic", "none", "ignored"].includes(String(node.role ?? "").toLowerCase()))
        .slice(0, 240);
      return {
        ok: true,
        nodeCount: rawNodes.length,
        nodes
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (!wasAttached && debuggerApi.isAttached()) {
        debuggerApi.detach();
      }
    }
  }

  private async executeAcrossFrames(contents: WebContents, script: string): Promise<BrowserToolResult> {
    const frames = frameList(contents);
    const misses: BrowserToolResult[] = [];
    const errors: BrowserToolResult[] = [];
    for (const frame of frames) {
      const meta = frameInfo(frame, contents.mainFrame, frames.indexOf(frame));
      try {
        const result = (await frame.executeJavaScript(script, true)) as BrowserToolResult;
        if (result && typeof result === "object" && result.ok === true) {
          return { ...result, frame: meta };
        }
        if (result && typeof result === "object") {
          misses.push({ ...result, frame: meta });
        }
      } catch (error) {
        errors.push({
          error: error instanceof Error ? error.message : String(error),
          frame: meta
        });
      }
    }
    return {
      ok: false,
      error: "No element matched target in any inspected frame.",
      inspectedFrameCount: frames.length,
      misses: misses.slice(0, 6),
      frameErrors: errors.slice(0, 6)
    };
  }

  private resolveClickPoint(target: BrowserTargetRecord, x: number, y: number, coordinateSpace: "css" | "image") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Click coordinates must be finite numbers.");
    }
    if (coordinateSpace === "css") {
      return { x, y };
    }
    const size = target.lastScreenshotSize;
    const viewport = target.lastViewport;
    if (!size || !viewport || size.width <= 0 || size.height <= 0) {
      throw new Error("Image coordinate clicks require a previous browser_screenshot result for the same browser mode.");
    }
    return {
      x: (x / size.width) * viewport.width,
      y: (y / size.height) * viewport.height
    };
  }

  private dispatchViewportClick(contents: WebContents, x: number, y: number) {
    const clickX = Math.round(x);
    const clickY = Math.round(y);
    contents.focus();
    contents.sendInputEvent({ type: "mouseMove", x: clickX, y: clickY });
    contents.sendInputEvent({ type: "mouseDown", x: clickX, y: clickY, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: clickX, y: clickY, button: "left", clickCount: 1 });
  }

  private async captureBrowserTaskScreenshot(mode: BrowserMode, contents: WebContents): Promise<BrowserTaskScreenshot> {
    const captured = await this.captureBrowserTaskViewportImage(mode, contents);
    return {
      image: captured.imageDataUrl,
      width: captured.imageWidth,
      height: captured.imageHeight
    };
  }

  /**
   * Electron runtime equivalent of Playwright's viewport screenshot -> LocateAnything ->
   * page.mouse.click flow. The grounding request can take seconds, so the visual fingerprint
   * is checked immediately before dispatch; stale coordinates never reach the page.
   */
  private async locateAndClickBrowserTaskTarget(
    mode: BrowserMode,
    contents: WebContents,
    target: BrowserTargetRecord,
    config: NonNullable<BrowserTaskModelConfig["visualGrounding"]>,
    description: string,
    signal: AbortSignal
  ): Promise<BrowserTaskVisualClickResult> {
    if (contents.isDestroyed()) {
      throw new Error("The browser tab closed before visual grounding started.");
    }
    const before = await this.readBrowserVisualViewportState(contents);
    const screenshot = await this.captureBrowserTaskViewportImage(mode, contents, before);
    const point = await locateAnythingInViewport(config, screenshot, description, { signal });
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Visual grounding was cancelled.");
    }
    const after = await this.readBrowserVisualViewportState(contents);
    assertBrowserVisualViewportUnchanged(before, after);
    if (contents.isDestroyed() || contents.isLoading()) {
      throw new Error("The page started navigating during visual grounding; the stale coordinate was not clicked.");
    }
    const matched = (await contents.executeJavaScript(describePointScript(point.viewportX, point.viewportY), true)) as unknown;
    this.dispatchViewportClick(contents, point.viewportX, point.viewportY);
    await delay(120);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return {
      target: description.replace(/\s+/g, " ").trim(),
      x: point.viewportX,
      y: point.viewportY,
      model: config.model,
      matched
    };
  }

  private async captureBrowserTaskViewportImage(mode: BrowserMode, contents: WebContents, viewportState?: BrowserVisualViewportState) {
    if (contents.isDestroyed()) {
      throw new Error("The browser tab closed before its viewport could be captured.");
    }
    this.prepareForScreenshot(contents);
    await waitForFreshPaint(contents);
    const state = viewportState ?? (await this.readBrowserVisualViewportState(contents));
    const captured = await this.captureTargetPage(mode, contents);
    const size = captured.getSize();
    if (captured.isEmpty() || size.width <= 0 || size.height <= 0) {
      throw new Error("The browser returned an empty viewport screenshot.");
    }
    const scale = Math.min(1, VISUAL_GROUNDING_MAX_DIMENSION / Math.max(size.width, size.height));
    const image =
      scale < 1
        ? captured.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "good"
          })
        : captured;
    const outputSize = image.getSize();
    const bytes = image.toJPEG(VISUAL_GROUNDING_JPEG_QUALITY);
    const imageDataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    if (imageDataUrl.length > VISUAL_GROUNDING_MAX_DATA_URL_CHARS) {
      throw new Error("The browser viewport screenshot exceeded the visual grounding transfer limit.");
    }
    return {
      imageDataUrl,
      imageWidth: outputSize.width,
      imageHeight: outputSize.height,
      viewportWidth: state.width,
      viewportHeight: state.height
    };
  }

  private async readBrowserVisualViewportState(contents: WebContents): Promise<BrowserVisualViewportState> {
    if (contents.isDestroyed()) {
      throw new Error("The browser tab closed during visual grounding.");
    }
    const state = (await contents.executeJavaScript(
      `({ url: window.location.href, width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY })`,
      true
    )) as Omit<BrowserVisualViewportState, "frameSignature">;
    if (!state || !Number.isFinite(state.width) || !Number.isFinite(state.height) || state.width <= 0 || state.height <= 0) {
      throw new Error("The browser did not report a valid visual viewport.");
    }
    const frameSignature = frameList(contents)
      .map((frame) => `${frame.name || ""}\u0000${frame.url || ""}\u0000${frame.frameTreeNodeId ?? ""}`)
      .sort()
      .join("\u0001");
    return { ...state, url: contents.getURL() || state.url, frameSignature };
  }

  private prepareForScreenshot(contents: WebContents) {
    // This used to restore, maximize, show, AND focus the browser window before every
    // capture — yanking the whole app in front of whatever the user was doing anywhere on
    // the system. A screenshot never justifies taking the user's screen: capturePage works
    // on a visible-but-buried surface, and captureTargetPage already falls back to a CDP
    // capture for hidden or detached contents.
    contents.invalidate();
  }

  private ensureVisibleWindow() {
    if (this.visibleWindow && !this.visibleWindow.isDestroyed()) {
      return this.visibleWindow;
    }
    const window = new BrowserWindow({
      show: false,
      width: 1120,
      height: 780,
      minWidth: 720,
      minHeight: 480,
      title: "Arivu Browser",
      backgroundColor: "#000000",
      autoHideMenuBar: true,
      webPreferences: browserShellWebPreferences()
    });
    // Electron installs an owner-window listener for every BrowserView. A normal tab set can
    // exceed Node's default of ten without representing an application listener leak.
    window.setMaxListeners(100);
    this.visibleWindow = window;
    this.configureVisibleShell(window);
    this.ensureVisibleShellPage(window.webContents);
    window.on("show", () => {
      this.paneOpen = true;
      // "show" also fires for the agent path's showInactive(); attaching must not pull
      // keyboard focus here. User-driven shows focus the window itself in showVisibleWindow.
      this.attachActiveVisibleView({ focus: false });
      this.emitState();
    });
    window.on("hide", () => {
      this.paneOpen = false;
      this.emitState();
    });
    window.on("close", (event) => {
      if (this.destroyingVisibleWindow) {
        return;
      }
      event.preventDefault();
      window.hide();
    });
    window.on("resize", () => this.updateVisibleViewLayout());
    window.on("maximize", () => this.updateVisibleViewLayout());
    window.on("unmaximize", () => this.updateVisibleViewLayout());
    window.on("closed", () => {
      this.visibleWindow = undefined;
      this.visibleShellRenderInFlight = false;
      this.visibleShellRenderPending = false;
      this.visibleShellReady = false;
      this.resetVisibleTabs();
      this.targets.visible = initialTarget("visible");
      if (this.activeMode === "visible") {
        this.activeMode = "background";
      }
      this.paneOpen = false;
      this.emitState();
    });
    return window;
  }

  private ensureBackgroundWindow() {
    if (this.backgroundWindow && !this.backgroundWindow.isDestroyed()) {
      return this.backgroundWindow;
    }
    const window = new BrowserWindow({
      show: false,
      width: DEFAULT_BACKGROUND_BOUNDS.width,
      height: DEFAULT_BACKGROUND_BOUNDS.height,
      webPreferences: browserWebPreferences("background")
    });
    this.backgroundWindow = window;
    this.configureWebContents("background", this.targets.background, window.webContents);
    window.on("closed", () => {
      this.backgroundWindow = undefined;
      this.targets.background = initialTarget("background");
      if (this.activeMode === "background" && this.visibleWindow && !this.visibleWindow.isDestroyed()) {
        this.activeMode = "visible";
      }
      this.emitState();
    });
    return window;
  }

  private configureVisibleShell(window: BrowserWindow) {
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isVisibleShellCommandUrl(url)) {
        return;
      }
      event.preventDefault();
      void this.handleVisibleShellCommand(url);
    });
    contents.on("did-finish-load", () => {
      this.visibleShellReady = true;
      this.renderVisibleShellState();
    });
    contents.on("before-input-event", (event, input) => {
      if (this.handleBrowserKeyboardInput(input)) {
        event.preventDefault();
      }
    });
  }

  private configureWebContents(mode: BrowserMode, target: BrowserTargetRecord, contents: WebContents) {
    this.configureBrowserSession(contents.session);
    contents.setWindowOpenHandler(({ url }) => {
      if (mode !== "visible") {
        return { action: "deny" };
      }
      try {
        assertAllowedPopupUrl(url);
      } catch (error) {
        target.lastError = error instanceof Error ? error.message : String(error);
        this.emitState();
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          show: false,
          autoHideMenuBar: true,
          backgroundColor: "#000000",
          webPreferences: browserWebPreferences("visible")
        }
      };
    });
    contents.on("did-create-window", (popupWindow, details) => {
      if (mode === "visible") {
        // Electron's BrowserView-backed createWindow path stalls window.open in current
        // releases. Keep the native child window alive, but register its WebContents as a
        // normal visible target so Arivu can select, inspect, and close it by tab id.
        this.registerVisiblePopupWindow(popupWindow, details.disposition, target.id);
      }
    });
    contents.on("will-navigate", (event, url) => {
      if (mode === "visible" && isVisibleSettingsPageUrl(contents.getURL()) && isVisibleSettingsCommandUrl(url)) {
        event.preventDefault();
        void this.handleVisibleShellCommand(url);
        return;
      }
      if (isVisibleStartPageUrl(url) || isVisibleLoadErrorPageUrl(url) || isVisibleSettingsPageUrl(url)) {
        return;
      }
      if (url.startsWith("chrome-extension://")) {
        try {
          if (contents.session.extensions.getExtension(new URL(url).hostname)) {
            return;
          }
        } catch {
          // Fall through to the normal navigation guard.
        }
      }
      try {
        normalizeBrowserUrl(url);
      } catch (error) {
        event.preventDefault();
        target.lastError = error instanceof Error ? error.message : String(error);
        this.emitState();
      }
    });
    contents.on("did-start-loading", () => {
      target.loading = true;
      this.emitState();
    });
    contents.on("did-stop-loading", () => {
      this.updateTargetFromContents(mode, contents, target);
      if (mode === "visible") {
        this.recordBrowserHistory(target, contents);
      }
      this.emitState();
    });
    contents.on("did-navigate", () => {
      if (!isVisibleLoadErrorPageUrl(contents.getURL())) {
        target.failedUrl = undefined;
        target.lastError = undefined;
        target.recoveryTitle = undefined;
      }
      this.updateTargetFromContents(mode, contents, target);
      this.emitState();
    });
    contents.on("did-navigate-in-page", () => {
      this.updateTargetFromContents(mode, contents, target);
      this.emitState();
    });
    contents.on("page-title-updated", () => {
      this.updateTargetFromContents(mode, contents, target);
      this.emitState();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      target.faviconUrl = favicons.find((url) => /^https?:|^data:/i.test(url));
      this.emitState();
    });
    contents.on("found-in-page", (_event, result) => {
      this.findMatches = Math.max(0, result.matches);
      this.findActiveMatch = Math.max(0, result.activeMatchOrdinal);
      this.emitState();
    });
    contents.on("before-input-event", (event, input) => {
      if (this.handleBrowserKeyboardInput(input, target.id)) {
        event.preventDefault();
      }
    });
    contents.on("context-menu", (_event, params) => this.showPageContextMenu(contents, target, params));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      if (errorCode === -3) {
        return;
      }
      target.lastError = `${errorDescription} (${errorCode})`;
      target.failedUrl = validatedUrl || target.url;
      target.recoveryTitle = "This site can't be reached";
      target.url = validatedUrl || contents.getURL();
      target.loading = false;
      this.emitState();
      if (mode === "visible" && target.failedUrl && !isVisibleLoadErrorPageUrl(contents.getURL())) {
        void contents.loadURL(visibleLoadErrorPageUrl(target.failedUrl, errorCode, errorDescription)).catch(() => undefined);
      }
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || (mode === "visible" && !this.visibleTabs.has(target.id))) {
        return;
      }
      const failedUrl = target.failedUrl ?? target.url;
      target.failedUrl = failedUrl;
      target.recoveryTitle = "This tab crashed";
      target.lastError = `The page renderer stopped (${details.reason}).`;
      target.loading = false;
      this.emitState();
      if (mode === "visible") {
        void contents.loadURL(visibleCrashRecoveryPageUrl(failedUrl, details.reason)).catch(() => undefined);
      }
    });
    contents.on("unresponsive", () => {
      target.lastError = "This page is not responding. You can wait or reload it.";
      this.notifyBrowserShell(target.lastError, true);
    });
    contents.on("responsive", () => {
      if (target.lastError?.includes("not responding")) {
        target.lastError = undefined;
        this.notifyBrowserShell("The page is responding again.");
      }
    });
    contents.on("console-message", (details) => {
      if (mode === "visible" && details.message.startsWith(BROWSER_ANNOTATION_CONSOLE_PREFIX)) {
        void this.handleBrowserAnnotationSelection(target, contents, details.message.slice(BROWSER_ANNOTATION_CONSOLE_PREFIX.length));
        return;
      }
      const level = normalizeConsoleLevel(details.level);
      const entry: BrowserConsoleEntry = {
        level,
        message: details.message,
        sourceId: details.sourceId,
        lineNumber: details.lineNumber,
        url: contents.getURL(),
        timestamp: new Date().toISOString()
      };
      target.logs = [...target.logs, entry].slice(-MAX_CONSOLE_LOGS);
      this.emitState();
    });
  }

  private async handleBrowserAnnotationSelection(target: BrowserTargetRecord, contents: WebContents, rawPayload: string) {
    let selection: BrowserAnnotationSelection;
    try {
      selection = JSON.parse(rawPayload) as BrowserAnnotationSelection;
    } catch {
      this.notifyBrowserShell("The browser selection could not be read.", true);
      return;
    }
    if (
      !selection ||
      !["element", "region"].includes(selection.kind) ||
      !selection.rect ||
      ![selection.rect.x, selection.rect.y, selection.rect.width, selection.rect.height].every(Number.isFinite)
    ) {
      this.notifyBrowserShell("The browser selection was incomplete.", true);
      return;
    }
    const id = `annotation-${this.nextAnnotationNumber++}`;
    const screenshotPath = await this.captureAnnotationRegion(contents, id, selection.rect).catch(() => undefined);
    const annotation: BrowserPendingAnnotation = {
      ...selection,
      id,
      tabId: target.id,
      url: target.url,
      title: target.title,
      comment: "",
      createdAt: new Date().toISOString(),
      screenshotPath
    };
    this.pendingAnnotations.push(annotation);
    this.activeAnnotationId = id;
    this.annotationMode = "browse";
    await contents.executeJavaScript(installBrowserAnnotationScript("browse"), true).catch(() => undefined);
    this.notifyBrowserShell(
      selection.kind === "region" ? "Region captured. Add a note before sending." : "Element selected. Add a note or preview adjustments."
    );
    this.emitState();
  }

  private async captureAnnotationRegion(contents: WebContents, id: string, rect: { x: number; y: number; width: number; height: number }) {
    const directory =
      process.env.ARIVU_BROWSER_SMOKE === "1" || process.env.ARIVU_DESKTOP_SMOKE === "1"
        ? os.tmpdir()
        : path.join(appDataDir(), "browser-annotations");
    await mkdir(directory, { recursive: true });
    const image = await contents.capturePage({
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height))
    });
    if (image.isEmpty()) {
      return undefined;
    }
    const screenshotPath = path.join(directory, `${id}.png`);
    await writeFile(screenshotPath, image.toPNG());
    return screenshotPath;
  }

  private async setBrowserAnnotationMode(mode: BrowserAnnotationMode) {
    const active = this.activeVisibleTab();
    this.annotationMode = mode;
    if (active && !active.contents.isDestroyed() && active.url && !active.url.startsWith("arivu://")) {
      await active.contents.executeJavaScript(installBrowserAnnotationScript(mode), true);
    }
    this.emitState();
  }

  private activeAnnotation() {
    return this.pendingAnnotations.find((annotation) => annotation.id === this.activeAnnotationId);
  }

  private async applyActiveAnnotationDesign(patch: BrowserDesignPatch) {
    const annotation = this.activeAnnotation();
    const tab = annotation ? this.visibleTabs.get(annotation.tabId) : undefined;
    if (!annotation?.selector || !tab || tab.contents.isDestroyed()) {
      throw new Error("Select an element before changing its design.");
    }
    annotation.designPatch = { ...annotation.designPatch, ...patch };
    await tab.contents.executeJavaScript(applyBrowserDesignPatchScript(annotation.selector, annotation.designPatch), true);
    this.emitState();
  }

  private async discardBrowserAnnotation(id: string) {
    const index = this.pendingAnnotations.findIndex((annotation) => annotation.id === id);
    if (index < 0) return;
    const [annotation] = this.pendingAnnotations.splice(index, 1);
    const tab = this.visibleTabs.get(annotation.tabId);
    if (annotation.selector && annotation.designPatch && tab && !tab.contents.isDestroyed()) {
      await tab.contents.executeJavaScript(discardBrowserDesignPatchScript(annotation.selector), true).catch(() => undefined);
    }
    this.activeAnnotationId = this.pendingAnnotations.at(-1)?.id;
    this.emitState();
  }

  private sendBrowserAnnotationsToArivu() {
    if (this.pendingAnnotations.length === 0) {
      this.notifyBrowserShell("Add at least one browser comment before sending.", true);
      return;
    }
    const lines = this.pendingAnnotations.map((annotation, index) => {
      const target = annotation.selector ? `element ${annotation.selector}` : "captured region";
      const note = annotation.comment.trim() || "Review this selection.";
      const adjustments =
        annotation.designPatch && Object.keys(annotation.designPatch).length > 0
          ? ` Suggested design: ${JSON.stringify(annotation.designPatch)}.`
          : "";
      return `${index + 1}. ${note} On ${annotation.url}, ${target}.${adjustments}`;
    });
    this.collaborationHandoff = {
      id: this.nextHandoffId++,
      prompt: `Browser review notes:\n${lines.join("\n")}`,
      screenshotPaths: this.pendingAnnotations.flatMap((annotation) => (annotation.screenshotPath ? [annotation.screenshotPath] : []))
    };
    this.notifyBrowserShell(
      `${this.pendingAnnotations.length} browser note${this.pendingAnnotations.length === 1 ? "" : "s"} added to the Arivu composer.`
    );
    this.emitState();
  }

  private browserProfileStore() {
    if (!this.profileStore) {
      const smokeMode = process.env.ARIVU_BROWSER_SMOKE === "1" || process.env.ARIVU_DESKTOP_SMOKE === "1";
      const profilePath = smokeMode
        ? path.join(os.tmpdir(), `arivu-browser-smoke-profile-${process.pid}.json`)
        : path.join(appDataDir(), "browser-profile.json");
      mkdirSync(path.dirname(profilePath), { recursive: true });
      this.profileStore = new BrowserProfileStore(profilePath);
    }
    return this.profileStore;
  }

  private async importBrowserProfileData() {
    const window = this.visibleWindow;
    if (!window || window.isDestroyed()) return;
    const result = await dialog.showOpenDialog(window, {
      title: "Import browser profile data",
      properties: ["openFile"],
      filters: [
        { name: "Browser exports", extensions: ["json", "csv"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return;
    const imported = this.browserProfileStore().importFile(filePath);
    const browserSession = this.activeVisibleTab()?.contents.session;
    let cookieCount = 0;
    if (browserSession) {
      for (const cookie of imported.cookies) {
        if (await this.importBrowserCookie(browserSession, cookie)) cookieCount += 1;
      }
    }
    this.notifyBrowserShell(
      `Imported ${imported.credentials.length} password${imported.credentials.length === 1 ? "" : "s"}, ${imported.autofillProfiles.length} autofill profile${imported.autofillProfiles.length === 1 ? "" : "s"}, and ${cookieCount} cookie${cookieCount === 1 ? "" : "s"}.`
    );
    this.refreshBrowserSettingsTabs();
  }

  private async importBrowserCookie(browserSession: Session, cookie: BrowserImportedCookie) {
    const domain = cookie.domain?.replace(/^\./, "");
    const url = cookie.url || (domain ? `${cookie.secure === false ? "http" : "https"}://${domain}${cookie.path || "/"}` : undefined);
    if (!url || !cookie.name) return false;
    try {
      await browserSession.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.domain ? { domain: cookie.domain } : {}),
        ...(cookie.path ? { path: cookie.path } : {}),
        ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
        ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
        ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {})
      });
      return true;
    } catch {
      return false;
    }
  }

  private addBrowserCredential(params: URLSearchParams) {
    this.browserProfileStore().addCredential({
      origin: params.get("origin") ?? this.activeVisibleTab()?.url ?? "",
      username: params.get("username") ?? "",
      password: params.get("password") ?? "",
      label: params.get("label") || undefined
    });
    this.notifyBrowserShell("Password saved securely.");
    this.refreshBrowserSettingsTabs();
  }

  private addBrowserAutofillProfile(params: URLSearchParams) {
    this.browserProfileStore().addAutofillProfile({
      label: params.get("label") ?? "",
      fullName: params.get("fullName") || undefined,
      email: params.get("email") || undefined,
      phone: params.get("phone") || undefined,
      addressLine1: params.get("addressLine1") || undefined,
      addressLine2: params.get("addressLine2") || undefined,
      city: params.get("city") || undefined,
      region: params.get("region") || undefined,
      postalCode: params.get("postalCode") || undefined,
      country: params.get("country") || undefined
    });
    this.notifyBrowserShell("Autofill profile saved.");
    this.refreshBrowserSettingsTabs();
  }

  private async autofillActivePage(profileId?: string) {
    const active = this.activeVisibleTab();
    if (!active) return;
    const store = this.browserProfileStore();
    const profiles = store.autofillProfiles();
    const profile = profiles.find((entry) => entry.id === profileId) ?? profiles[0];
    const credential = store.credentialForUrl(active.url);
    if (!profile && !credential) {
      this.notifyBrowserShell("No matching password or autofill profile is saved.", true);
      return;
    }
    const result = (await active.contents.executeJavaScript(browserAutofillScript(profile, credential), true)) as { count?: number };
    this.notifyBrowserShell(
      result.count
        ? `Filled ${result.count} field${result.count === 1 ? "" : "s"}. Review before submitting.`
        : "No matching fields were found.",
      !result.count
    );
  }

  private async chooseBrowserExtension() {
    const window = this.visibleWindow;
    const active = this.activeVisibleTab();
    if (!window || !active) return;
    const result = await dialog.showOpenDialog(window, { title: "Load unpacked browser extension", properties: ["openDirectory"] });
    const extensionPath = result.filePaths[0];
    if (result.canceled || !extensionPath) return;
    const extension = await active.contents.session.extensions.loadExtension(extensionPath, { allowFileAccess: true });
    this.loadedExtensionPaths.set(extension.id, extensionPath);
    this.browserProfileStore().addExtensionPath(extensionPath);
    this.notifyBrowserShell(`${extension.name} loaded.`);
    this.refreshBrowserSettingsTabs();
  }

  private removeBrowserExtension(extensionId: string) {
    const active = this.activeVisibleTab();
    if (!active) return;
    const extensionPath = this.loadedExtensionPaths.get(extensionId);
    active.contents.session.extensions.removeExtension(extensionId);
    this.loadedExtensionPaths.delete(extensionId);
    if (extensionPath) this.browserProfileStore().removeExtensionPath(extensionPath);
    this.notifyBrowserShell("Extension removed.");
    this.refreshBrowserSettingsTabs();
  }

  private openBrowserExtensionOptions(rawUrl: string) {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "chrome-extension:") {
      throw new Error("Invalid extension options URL.");
    }
    const target = this.createVisibleTab({ activate: true, deferLoad: true });
    void target.contents.loadURL(parsed.toString()).catch((error: unknown) => {
      target.lastError = error instanceof Error ? error.message : String(error);
      this.emitState();
    });
  }

  private async restoreBrowserExtensions(browserSession: Session) {
    for (const extensionPath of this.browserProfileStore().extensionPaths()) {
      if (!existsSync(extensionPath)) continue;
      try {
        const extension = await browserSession.extensions.loadExtension(extensionPath, { allowFileAccess: true });
        this.loadedExtensionPaths.set(extension.id, extensionPath);
      } catch {
        // Keep the path saved so a temporarily unavailable volume can recover next launch.
      }
    }
    this.emitState();
  }

  private adoptBackgroundAgentTab() {
    const background = this.targets.background;
    if (!background.url) {
      this.notifyBrowserShell("The background agent does not have an open page yet.", true);
      return;
    }
    this.createVisibleTab({ url: background.url, activate: true });
    this.notifyBrowserShell("Agent page adopted as a visible tab.");
  }

  private async sendActiveTabToAgent() {
    const active = this.activeVisibleTab();
    if (!active?.url) {
      this.notifyBrowserShell("Open a page before sending it to the background agent.", true);
      return;
    }
    await this.open({ url: active.url, mode: "background" });
    this.notifyBrowserShell("Current page is now available to the background agent.");
  }

  private updateTargetFromContents(mode: BrowserMode, contents: WebContents, target: BrowserTargetRecord) {
    const url = contents.getURL();
    const startPage = mode === "visible" && isVisibleStartPageUrl(url);
    const loadErrorPage = mode === "visible" && isVisibleLoadErrorPageUrl(url);
    const settingsPage = mode === "visible" && isVisibleSettingsPageUrl(url);
    target.url = startPage ? "" : settingsPage ? "arivu://settings" : loadErrorPage ? (target.failedUrl ?? "") : url;
    target.title = startPage
      ? VISIBLE_START_PAGE_TITLE
      : settingsPage
        ? "Browser settings"
        : loadErrorPage
          ? (target.recoveryTitle ?? "This site can't be reached")
          : contents.getTitle();
    target.loading = contents.isLoading();
    target.canGoBack = contents.navigationHistory.canGoBack();
    target.canGoForward = contents.navigationHistory.canGoForward();
  }

  private resultForMode(mode: BrowserMode, result: BrowserToolResult, target: BrowserTargetRecord): BrowserToolResult {
    return {
      mode,
      tabId: target.id,
      url: target.url,
      title: target.title,
      loading: target.loading,
      activeTabId: this.activeVisibleTabId,
      // activeTabId is what the USER is looking at; agent tools default to agentTargetTabId.
      // Report both so the model never assumes it is acting on the user's tab.
      ...(mode === "visible" && this.agentTargetTabId ? { agentTargetTabId: this.agentTargetTabId } : {}),
      ...result
    };
  }

  private async captureTargetPage(mode: BrowserMode, contents: WebContents) {
    // An attached, painted BrowserView has a reliable native surface. CDP
    // Page.captureScreenshot can retain stale compositor tiles after switching away from a
    // native popup window, producing a partly black image even though the page is painted.
    // Prefer the native surface for visible tabs and keep CDP as the fallback.
    if (mode === "visible") {
      return this.withTemporaryCaptureSurface(contents, async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const surfaceImage = await capturePageWithTimeout(contents);
            if (!surfaceImage.isEmpty()) {
              return surfaceImage;
            }
          } catch {
            // BrowserView surfaces can briefly report UnknownVizError while Chromium swaps
            // compositors. Repaint and retry before falling back to CDP.
          }
          contents.invalidate();
          await delay(120 * (attempt + 1));
        }
        const debuggerImage = await capturePageWithDebugger(contents);
        if (debuggerImage && !debuggerImage.isEmpty()) {
          return debuggerImage;
        }
        return capturePageWithTimeout(contents);
      });
    }
    const debuggerImage = await capturePageWithDebugger(contents);
    if (debuggerImage && !debuggerImage.isEmpty()) {
      return debuggerImage;
    }
    return capturePageWithTimeout(contents);
  }

  /**
   * A detached tab (agent working out of the user's view) has no compositor surface, so both
   * capturePage and CDP fromSurface captures can fail or return stale pixels. For the duration
   * of a capture, attach the view UNDER the user's active view: the active view keeps covering
   * the content area, nothing is raised, shown, or focused, and the previous attachment state
   * is restored afterwards. The user sees and loses nothing.
   */
  private async withTemporaryCaptureSurface<T>(contents: WebContents, run: () => Promise<T>): Promise<T> {
    const window = this.visibleWindow;
    const record = [...this.visibleTabs.values()].find((tab) => tab.contents === contents);
    const view = record?.view;
    if (!window || window.isDestroyed() || !view || window.getBrowserViews().includes(view)) {
      return run();
    }
    window.addBrowserView(view);
    const [width, height] = window.getContentSize();
    view.setBounds({
      x: 0,
      y: this.visibleChromeHeight,
      width: Math.max(1, width),
      height: Math.max(1, height - this.visibleChromeHeight)
    });
    const active = this.activeVisibleTab();
    if (active?.view && active.view !== view && window.getBrowserViews().includes(active.view)) {
      window.setTopBrowserView(active.view);
    }
    try {
      return await run();
    } finally {
      if (!window.isDestroyed()) {
        try {
          window.removeBrowserView(view);
        } catch {
          // The view may already be detached; capture cleanup continues regardless.
        }
      }
    }
  }

  private publicVisibleTarget(): BrowserTargetState {
    const active = this.activeVisibleTab() ?? this.targets.visible;
    return {
      ...publicTarget(active),
      activeTabId: this.activeVisibleTabId,
      ...(this.agentTargetTabId ? { agentTargetTabId: this.agentTargetTabId } : {}),
      tabs: this.visibleTabOrder
        .map((id) => this.visibleTabs.get(id))
        .filter((tab): tab is BrowserTabRecord => Boolean(tab))
        .map((tab) => ({
          ...publicTab(tab),
          ...(this.agentTaskTabIds.has(tab.id) ? { agentActive: true } : {})
        }))
    };
  }

  private activeVisibleTab() {
    return this.activeVisibleTabId ? this.visibleTabs.get(this.activeVisibleTabId) : undefined;
  }

  private ensureVisibleTab(tabId?: string) {
    if (tabId) {
      return this.selectVisibleTabById(tabId);
    }
    const active = this.activeVisibleTab();
    if (active) {
      return active;
    }
    return this.createVisibleTab({ activate: true });
  }

  private createVisibleTab(options: { url?: string; activate?: boolean; focus?: boolean; deferLoad?: boolean } = {}) {
    const id = `tab-${this.nextVisibleTabNumber++}`;
    const view = new BrowserView({
      webPreferences: browserWebPreferences("visible")
    });
    view.setAutoResize({ width: true, height: true });
    const target: BrowserTabRecord = {
      ...initialTarget("visible", id),
      title: VISIBLE_START_PAGE_TITLE,
      contents: view.webContents,
      view
    };
    this.visibleTabs.set(id, target);
    this.visibleTabOrder.push(id);
    this.configureWebContents("visible", target, view.webContents);
    if (options.activate !== false) {
      this.activeVisibleTabId = id;
      this.attachActiveVisibleView({ focus: options.focus });
    }
    if (!options.deferLoad) {
      const url = options.url ? normalizeBrowserUrl(options.url) : visibleStartPageUrl();
      void view.webContents.loadURL(url).catch((error: unknown) => {
        if (isNavigationAbortError(error)) {
          return;
        }
        target.lastError = error instanceof Error ? error.message : String(error);
        target.loading = false;
        this.emitState();
      });
    }
    this.emitState();
    return target;
  }

  private registerVisiblePopupWindow(
    popupWindow: BrowserWindow,
    disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other",
    originTabId?: string
  ) {
    const id = `tab-${this.nextVisibleTabNumber++}`;
    const target: BrowserTabRecord = {
      ...initialTarget("visible", id),
      contents: popupWindow.webContents,
      popupWindow
    };
    this.visibleTabs.set(id, target);
    this.visibleTabOrder.push(id);
    this.configureWebContents("visible", target, popupWindow.webContents);
    popupWindow.on("closed", () => this.forgetVisiblePopupTab(id));
    popupWindow.webContents.once("destroyed", () => this.forgetVisiblePopupTab(id));
    // A popup spawned while a delegated task runs on the opener belongs to the agent, not the
    // user: it becomes the agent's next target (the supervisor ends the opener's task with an
    // explicit handoff) but stays out of the user's view and never takes focus.
    const agentDriven = Boolean(originTabId && this.agentTaskTabIds.has(originTabId));
    if (agentDriven) {
      this.agentTargetTabId = id;
      popupWindow.hide();
      this.updateTargetFromContents("visible", popupWindow.webContents, target);
      this.emitState();
      return;
    }
    if (disposition !== "background-tab") {
      this.activeVisibleTabId = id;
    }
    popupWindow.maximize();
    if (disposition === "background-tab") {
      popupWindow.hide();
    } else {
      popupWindow.show();
      popupWindow.focus();
    }
    this.updateTargetFromContents("visible", popupWindow.webContents, target);
    this.emitState();
  }

  private selectVisibleTabById(tabId: string) {
    const target = this.visibleTabs.get(tabId);
    if (!target) {
      throw new Error(`Unknown visible browser tab: ${tabId}`);
    }
    if (target.contents.isDestroyed()) {
      this.closeVisibleTabById(tabId);
      this.emitState();
      throw new Error(`Visible browser tab closed before it could be selected: ${tabId}`);
    }
    this.activeVisibleTabId = tabId;
    this.rememberMode("visible");
    this.findMatches = 0;
    this.findActiveMatch = 0;
    this.updateTargetFromContents("visible", target.contents, target);
    this.attachActiveVisibleView();
    return target;
  }

  private closeVisibleTabById(tabId: string) {
    const target = this.visibleTabs.get(tabId);
    if (!target) {
      throw new Error(`Unknown visible browser tab: ${tabId}`);
    }
    const window = this.visibleWindow;
    if (target.url && !isVisibleStartPageUrl(target.contents.getURL())) {
      this.recentlyClosedVisibleTabs.push({ url: target.url, title: target.title });
      if (this.recentlyClosedVisibleTabs.length > 20) {
        this.recentlyClosedVisibleTabs.splice(0, this.recentlyClosedVisibleTabs.length - 20);
      }
    }
    if (target.view && window && !window.isDestroyed()) {
      try {
        window.removeBrowserView(target.view);
      } catch {
        // The view may already be detached; closing continues regardless.
      }
    }
    this.visibleTabs.delete(tabId);
    this.forgetAgentTabState(tabId);
    const orderIndex = this.visibleTabOrder.indexOf(tabId);
    if (orderIndex >= 0) {
      this.visibleTabOrder.splice(orderIndex, 1);
    }
    if (target.popupWindow && !target.popupWindow.isDestroyed()) {
      target.popupWindow.destroy();
    } else if (!target.contents.isDestroyed()) {
      target.contents.close({ waitForBeforeUnload: false });
    }
    if (this.activeVisibleTabId === tabId) {
      const nextTabId = this.visibleTabOrder[Math.max(0, orderIndex - 1)] ?? this.visibleTabOrder[0];
      this.activeVisibleTabId = nextTabId;
    }
    if (this.closeVisibleWindowWhenNoTabsRemain()) {
      this.emitState();
      return;
    }
    this.attachActiveVisibleView();
    this.emitState();
  }

  /** Drops per-tab agent bookkeeping when a tab is closed or forgotten. */
  private forgetAgentTabState(tabId: string) {
    this.agentTaskTabIds.delete(tabId);
    if (this.agentTargetTabId === tabId) {
      this.agentTargetTabId = undefined;
    }
    if (this.watchReturnTabId === tabId) {
      this.watchReturnTabId = undefined;
    }
  }

  private forgetVisiblePopupTab(tabId: string) {
    const target = this.visibleTabs.get(tabId);
    if (!target?.popupWindow) {
      return;
    }
    this.visibleTabs.delete(tabId);
    this.forgetAgentTabState(tabId);
    const orderIndex = this.visibleTabOrder.indexOf(tabId);
    if (orderIndex >= 0) {
      this.visibleTabOrder.splice(orderIndex, 1);
    }
    if (this.activeVisibleTabId === tabId) {
      this.activeVisibleTabId = this.visibleTabOrder[Math.max(0, orderIndex - 1)] ?? this.visibleTabOrder[0];
    }
    if (this.closeVisibleWindowWhenNoTabsRemain()) {
      this.emitState();
      return;
    }
    this.attachActiveVisibleView();
    this.emitState();
  }

  private closeVisibleWindowWhenNoTabsRemain() {
    if (this.visibleTabOrder.length > 0) {
      return false;
    }
    this.activeVisibleTabId = undefined;
    this.paneOpen = false;
    if (this.visibleWindow && !this.visibleWindow.isDestroyed()) {
      this.destroyVisibleWindow();
    }
    return true;
  }

  private resetVisibleTabs() {
    for (const target of this.visibleTabs.values()) {
      try {
        if (target.popupWindow && !target.popupWindow.isDestroyed()) {
          target.popupWindow.destroy();
        } else if (!target.contents.isDestroyed()) {
          target.contents.close({ waitForBeforeUnload: false });
        }
      } catch {
        // The tab's webContents may already be destroyed; reset continues regardless.
      }
    }
    this.visibleTabs.clear();
    this.visibleTabOrder.splice(0);
    this.activeVisibleTabId = undefined;
    this.agentTargetTabId = undefined;
    this.agentTaskTabIds.clear();
    this.watchReturnTabId = undefined;
  }

  private restoreVisibleSessionOnce() {
    const snapshot = this.visibleSessionPersistence.readOnce();
    if (!snapshot) {
      return;
    }
    if (Array.isArray(snapshot.history)) {
      this.browserHistory.push(
        ...snapshot.history.slice(-500).filter((entry) => {
          return (
            Boolean(entry) &&
            typeof entry.url === "string" &&
            typeof entry.title === "string" &&
            typeof entry.visitedAt === "string" &&
            isRestorableBrowserUrl(entry.url)
          );
        })
      );
    }
    if (snapshot.permissions && typeof snapshot.permissions === "object") {
      for (const [key, decision] of Object.entries(snapshot.permissions)) {
        if (key.includes("|") && (decision === "allow" || decision === "block")) {
          this.browserPermissions.set(key, decision);
        }
      }
    }
    this.askDownloadLocation = snapshot.settings?.askDownloadLocation === true;
    this.downloadDirectory =
      typeof snapshot.settings?.downloadDirectory === "string" && path.isAbsolute(snapshot.settings.downloadDirectory)
        ? snapshot.settings.downloadDirectory
        : undefined;
    const urls = snapshot.tabs.slice(0, 20).filter((url): url is string => typeof url === "string" && isRestorableBrowserUrl(url));
    if (urls.length === 0) {
      return;
    }
    this.visibleSessionPersistence.whileRestoring(() => {
      const restored = urls.map((url) => this.createVisibleTab({ url: url || undefined, activate: false }));
      const activeIndex = clampNumber(Number(snapshot.activeIndex) || 0, 0, restored.length - 1);
      this.activeVisibleTabId = restored[activeIndex]?.id ?? restored[0]?.id;
      this.attachActiveVisibleView();
      this.emitState();
    });
  }

  private scheduleVisibleSessionWrite() {
    this.visibleSessionPersistence.schedule(() => this.visibleSessionSnapshot());
  }

  private persistVisibleSessionNow() {
    this.visibleSessionPersistence.persistNow(() => this.visibleSessionSnapshot());
  }

  private visibleSessionSnapshot(): BrowserSessionSnapshot {
    const persistedTabs = this.visibleTabOrder.flatMap((id) => {
      const target = this.visibleTabs.get(id);
      if (!target || target.popupWindow) {
        return [];
      }
      const url = target.failedUrl ?? target.url;
      return isRestorableBrowserUrl(url) ? [{ id, url }] : [];
    });
    const tabs = persistedTabs.map((tab) => tab.url);
    const activeIndex = Math.max(
      0,
      persistedTabs.findIndex((tab) => tab.id === this.activeVisibleTabId)
    );
    return {
      version: 1,
      tabs,
      activeIndex,
      history: this.browserHistory.slice(-500),
      permissions: Object.fromEntries(this.browserPermissions),
      settings: {
        askDownloadLocation: this.askDownloadLocation,
        ...(this.downloadDirectory ? { downloadDirectory: this.downloadDirectory } : {})
      }
    };
  }

  private attachActiveVisibleView(options: { focus?: boolean } = {}) {
    // Focus defaults to true for user-driven switches (tab clicks, watch, close). Agent-driven
    // attaches pass focus: false — presenting a view is fine, moving the keyboard is not.
    const focus = options.focus !== false;
    const window = this.visibleWindow;
    const active = this.activeVisibleTab();
    if (!window || window.isDestroyed() || !active) {
      return;
    }
    for (const target of this.visibleTabs.values()) {
      if (target.popupWindow && !target.popupWindow.isDestroyed() && target !== active) {
        target.popupWindow.hide();
      }
    }
    const attached = new Set(window.getBrowserViews());
    for (const view of attached) {
      if (!active.view || view !== active.view) {
        window.removeBrowserView(view);
      }
    }
    if (active.popupWindow && !active.popupWindow.isDestroyed()) {
      if (focus) {
        active.popupWindow.maximize();
        active.popupWindow.show();
        active.popupWindow.focus();
      } else if (!active.popupWindow.isVisible()) {
        active.popupWindow.showInactive();
      }
      return;
    }
    if (!active.view) {
      return;
    }
    if (!attached.has(active.view)) {
      window.addBrowserView(active.view);
    }
    window.setTopBrowserView(active.view);
    this.updateVisibleViewLayout();
    if (focus) {
      active.view.webContents.focus();
    }
  }

  private updateVisibleViewLayout() {
    const window = this.visibleWindow;
    const active = this.activeVisibleTab();
    if (!window || window.isDestroyed() || !active?.view) {
      return;
    }
    const [width, height] = window.getContentSize();
    const availableHeight = Math.max(0, height - this.visibleChromeHeight);
    const scale = this.deviceViewport.enabled
      ? Math.min(1, width / this.deviceViewport.width, availableHeight / this.deviceViewport.height)
      : 1;
    const viewWidth = this.deviceViewport.enabled ? Math.max(1, Math.floor(this.deviceViewport.width * scale)) : Math.max(0, width);
    const viewHeight = this.deviceViewport.enabled ? Math.max(1, Math.floor(this.deviceViewport.height * scale)) : availableHeight;
    this.deviceViewport = { ...this.deviceViewport, scale };
    active.view.setBounds({
      x: this.deviceViewport.enabled ? Math.max(0, Math.floor((width - viewWidth) / 2)) : 0,
      y: this.visibleChromeHeight,
      width: viewWidth,
      height: viewHeight
    });
    void this.applyDeviceEmulation(active.contents, scale);
    this.renderVisibleShellState();
  }

  private async applyDeviceEmulation(contents: WebContents, scale: number) {
    const debuggerApi = contents.debugger;
    try {
      if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
      if (!this.deviceViewport.enabled) {
        await debuggerApi.sendCommand("Emulation.clearDeviceMetricsOverride");
        return;
      }
      await debuggerApi.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: this.deviceViewport.width,
        height: this.deviceViewport.height,
        screenWidth: this.deviceViewport.width,
        screenHeight: this.deviceViewport.height,
        deviceScaleFactor: 1,
        mobile: this.deviceViewport.width <= 768,
        scale
      });
    } catch (error) {
      this.notifyBrowserShell(`Device preview unavailable: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private ensureVisibleShellPage(contents: WebContents) {
    const url = contents.getURL();
    if (isVisibleShellPageUrl(url)) {
      return contents.isLoading();
    }
    if (url) {
      return false;
    }
    if (contents.isLoading()) {
      return true;
    }
    void contents.loadURL(visibleShellPageUrl()).catch((error: unknown) => {
      this.targets.visible.lastError = error instanceof Error ? error.message : String(error);
      this.emitState();
    });
    return true;
  }

  private async handleVisibleShellCommand(rawUrl: string) {
    const command = parseVisibleShellCommand(rawUrl);
    if (!command) {
      return;
    }
    try {
      switch (command.action) {
        case "new-tab": {
          const url = command.params.get("url") || undefined;
          this.createVisibleTab({ url, activate: true });
          break;
        }
        case "select-tab": {
          const tabId = command.params.get("id");
          if (tabId) {
            // Clicking the working tab is an implicit Watch: remember where to return to.
            // Any other manual switch invalidates a stale return point.
            this.watchReturnTabId =
              this.agentTaskTabIds.has(tabId) && this.activeVisibleTabId && this.activeVisibleTabId !== tabId
                ? this.activeVisibleTabId
                : undefined;
            this.selectVisibleTabById(tabId);
          }
          break;
        }
        case "watch-agent": {
          const tabId = command.params.get("id") || [...this.agentTaskTabIds][0] || this.agentTargetTabId;
          if (tabId && this.visibleTabs.has(tabId) && tabId !== this.activeVisibleTabId) {
            this.watchReturnTabId = this.activeVisibleTabId;
            this.selectVisibleTabById(tabId);
            this.emitState();
          }
          break;
        }
        case "hide-agent": {
          // Give the user's view back: return to the tab they were on before watching. The
          // agent keeps working on its tab either way.
          const returnTabId = this.watchReturnTabId;
          this.watchReturnTabId = undefined;
          if (returnTabId && this.visibleTabs.has(returnTabId)) {
            this.selectVisibleTabById(returnTabId);
          }
          this.emitState();
          break;
        }
        case "close-tab": {
          const tabId = command.params.get("id");
          if (tabId) {
            this.closeVisibleTabById(tabId);
          }
          break;
        }
        case "navigate": {
          const tabId = command.params.get("id") || undefined;
          const url = command.params.get("url");
          if (url) {
            await this.open({ url, mode: "visible", tabId });
          }
          break;
        }
        case "back":
          this.goBack("visible", command.params.get("id") || undefined);
          break;
        case "forward":
          this.goForward("visible", command.params.get("id") || undefined);
          break;
        case "reload":
          this.reload("visible", command.params.get("id") || undefined);
          break;
        case "stop":
          this.stop("visible", command.params.get("id") || undefined);
          break;
        case "hard-reload":
          this.activeVisibleTab()?.contents.reloadIgnoringCache();
          break;
        case "layout": {
          this.visibleChromeHeight = clampNumber(Number(command.params.get("height")) || DEFAULT_VISIBLE_CHROME_HEIGHT, 72, 430);
          this.updateVisibleViewLayout();
          break;
        }
        case "reorder-tab": {
          const tabId = command.params.get("id");
          const beforeId = command.params.get("before");
          if (tabId && beforeId) {
            this.reorderVisibleTab(tabId, beforeId);
          }
          break;
        }
        case "tabs-menu":
          this.showVisibleTabsMenu();
          break;
        case "cycle-tab":
          this.cycleVisibleTab(command.params.get("direction") === "-1" ? -1 : 1);
          break;
        case "duplicate-tab": {
          const active = this.activeVisibleTab();
          if (active?.url) {
            this.createVisibleTab({ url: active.url, activate: true });
          }
          break;
        }
        case "reopen-tab": {
          const closed = this.recentlyClosedVisibleTabs.pop();
          if (closed) {
            this.createVisibleTab({ url: closed.url, activate: true });
          }
          break;
        }
        case "open-external": {
          const url = this.activeVisibleTab()?.url;
          if (url) {
            await shell.openExternal(url);
          }
          break;
        }
        case "capture-screenshot":
          await this.captureVisibleViewportToClipboard();
          break;
        case "open-find":
          this.findOpen = true;
          this.emitState();
          break;
        case "close-find":
          this.closeFindInPage();
          break;
        case "find":
          this.findInPage(command.params.get("query") ?? "", command.params.get("forward") !== "false");
          break;
        case "zoom-in":
          this.stepPageZoom(1);
          break;
        case "zoom-out":
          this.stepPageZoom(-1);
          break;
        case "reset-zoom":
          this.setPageZoom(1);
          break;
        case "print":
          this.activeVisibleTab()?.contents.print({ printBackground: true });
          break;
        case "toggle-device":
          this.deviceViewport = { ...this.deviceViewport, enabled: !this.deviceViewport.enabled };
          this.updateVisibleViewLayout();
          this.emitState();
          break;
        case "device-preset":
          this.applyDevicePreset(command.params.get("preset") ?? "responsive");
          break;
        case "device-size":
          this.applyDeviceSize(Number(command.params.get("width")), Number(command.params.get("height")));
          break;
        case "rotate-device":
          this.deviceViewport = { ...this.deviceViewport, width: this.deviceViewport.height, height: this.deviceViewport.width };
          this.updateVisibleViewLayout();
          this.emitState();
          break;
        case "options":
          this.showBrowserOptionsMenu();
          break;
        case "downloads":
          this.showDownloadsMenu();
          break;
        case "site-info":
          this.showSiteInformationMenu();
          break;
        case "annotation-mode":
          await this.setBrowserAnnotationMode(
            command.params.get("mode") === "element" ? "element" : command.params.get("mode") === "region" ? "region" : "browse"
          );
          break;
        case "annotation-select": {
          const annotationId = command.params.get("id");
          if (annotationId && this.pendingAnnotations.some((annotation) => annotation.id === annotationId)) {
            this.activeAnnotationId = annotationId;
            this.emitState();
          }
          break;
        }
        case "annotation-comment": {
          const annotation = this.pendingAnnotations.find((entry) => entry.id === command.params.get("id"));
          if (annotation) {
            annotation.comment = (command.params.get("comment") ?? "").slice(0, 4_000);
            this.emitState();
          }
          break;
        }
        case "annotation-design":
          await this.applyActiveAnnotationDesign(normalizeBrowserDesignPatch(Object.fromEntries(command.params)));
          break;
        case "annotation-preview": {
          const annotation = this.activeAnnotation();
          const tab = annotation ? this.visibleTabs.get(annotation.tabId) : undefined;
          if (annotation?.selector && annotation.designPatch && tab && !tab.contents.isDestroyed()) {
            await tab.contents.executeJavaScript(
              command.params.get("mode") === "original"
                ? discardBrowserDesignPatchScript(annotation.selector)
                : applyBrowserDesignPatchScript(annotation.selector, annotation.designPatch),
              true
            );
          }
          break;
        }
        case "annotation-discard": {
          const annotationId = command.params.get("id");
          if (annotationId) await this.discardBrowserAnnotation(annotationId);
          break;
        }
        case "annotation-send":
          if (command.params.get("id")) {
            const annotation = this.pendingAnnotations.find((entry) => entry.id === command.params.get("id"));
            if (annotation) annotation.comment = (command.params.get("comment") ?? annotation.comment).slice(0, 4_000);
          }
          this.sendBrowserAnnotationsToArivu();
          break;
        case "adopt-agent-tab":
          this.adoptBackgroundAgentTab();
          break;
        case "send-tab-to-agent":
          await this.sendActiveTabToAgent();
          break;
        case "autofill":
          await this.autofillActivePage(command.params.get("profileId") || undefined);
          break;
        case "open-settings":
          this.openBrowserSettings();
          break;
        case "set-ask-download":
          this.askDownloadLocation = command.params.get("value") === "true";
          this.persistVisibleSessionNow();
          this.refreshBrowserSettingsTabs();
          break;
        case "choose-download-directory":
          await this.chooseDownloadDirectory();
          break;
        case "settings-clear-cookies":
          await this.clearBrowserCookies();
          break;
        case "settings-clear-cache":
          await this.clearBrowserCache();
          break;
        case "settings-clear-history":
          this.browserHistory.splice(0);
          this.persistVisibleSessionNow();
          this.notifyBrowserShell("Browser history cleared.");
          this.refreshBrowserSettingsTabs();
          break;
        case "settings-reset-permissions":
          this.browserPermissions.clear();
          this.persistVisibleSessionNow();
          this.notifyBrowserShell("Saved site permissions reset.");
          this.refreshBrowserSettingsTabs();
          break;
        case "settings-import-profile":
          await this.importBrowserProfileData();
          break;
        case "settings-add-credential":
          this.addBrowserCredential(command.params);
          break;
        case "settings-remove-credential": {
          const id = command.params.get("id");
          if (id) this.browserProfileStore().removeCredential(id);
          this.refreshBrowserSettingsTabs();
          break;
        }
        case "settings-add-autofill":
          this.addBrowserAutofillProfile(command.params);
          break;
        case "settings-remove-autofill": {
          const id = command.params.get("id");
          if (id) this.browserProfileStore().removeAutofillProfile(id);
          this.refreshBrowserSettingsTabs();
          break;
        }
        case "settings-load-extension":
          await this.chooseBrowserExtension();
          break;
        case "settings-remove-extension": {
          const id = command.params.get("id");
          if (id) this.removeBrowserExtension(id);
          break;
        }
        case "settings-open-extension": {
          const url = command.params.get("url");
          if (url) this.openBrowserExtensionOptions(url);
          break;
        }
      }
    } catch (error) {
      const active = this.activeVisibleTab() ?? this.targets.visible;
      active.lastError = error instanceof Error ? error.message : String(error);
      this.emitState();
    }
  }

  private reorderVisibleTab(tabId: string, beforeId: string) {
    const from = this.visibleTabOrder.indexOf(tabId);
    const before = this.visibleTabOrder.indexOf(beforeId);
    if (from < 0 || before < 0 || from === before) {
      return;
    }
    this.visibleTabOrder.splice(from, 1);
    const nextBefore = this.visibleTabOrder.indexOf(beforeId);
    this.visibleTabOrder.splice(nextBefore, 0, tabId);
    this.emitState();
  }

  private cycleVisibleTab(direction: -1 | 1) {
    if (this.visibleTabOrder.length < 2) {
      return;
    }
    const activeIndex = Math.max(0, this.visibleTabOrder.indexOf(this.activeVisibleTabId ?? ""));
    const nextIndex = (activeIndex + direction + this.visibleTabOrder.length) % this.visibleTabOrder.length;
    this.selectVisibleTabById(this.visibleTabOrder[nextIndex]);
    this.emitState();
  }

  private showVisibleTabsMenu() {
    const window = this.visibleWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    const template: MenuItemConstructorOptions[] = this.visibleTabOrder.flatMap((id, index) => {
      const tab = this.visibleTabs.get(id);
      if (!tab) {
        return [];
      }
      return [
        {
          label: tab.title || tab.url || `Tab ${index + 1}`,
          type: "radio" as const,
          checked: id === this.activeVisibleTabId,
          click: () => {
            this.selectVisibleTabById(id);
            this.emitState();
          }
        }
      ];
    });
    if (template.length > 0) {
      template.push({ type: "separator" });
    }
    template.push(
      { label: "New tab", accelerator: "CmdOrCtrl+T", click: () => this.createVisibleTab({ activate: true }) },
      {
        label: "Reopen closed tab",
        enabled: this.recentlyClosedVisibleTabs.length > 0,
        click: () => {
          const closed = this.recentlyClosedVisibleTabs.pop();
          if (closed) this.createVisibleTab({ url: closed.url, activate: true });
        }
      }
    );
    Menu.buildFromTemplate(template).popup({ window });
  }

  private handleBrowserKeyboardInput(input: Input, tabId?: string): boolean {
    if (input.type !== "keyDown") {
      return false;
    }
    if (tabId && tabId !== this.activeVisibleTabId) {
      return false;
    }
    const key = input.key.toLowerCase();
    const command = input.meta || input.control;
    if (input.control && key === "tab") {
      this.cycleVisibleTab(input.shift ? -1 : 1);
      return true;
    }
    if (command && key === "l") {
      this.focusVisibleAddressBar();
      return true;
    }
    if (command && key === "t") {
      this.createVisibleTab({ activate: true });
      return true;
    }
    if (command && key === "w") {
      if (this.activeVisibleTabId) {
        this.closeVisibleTabById(this.activeVisibleTabId);
      }
      return true;
    }
    if (command && key === "f") {
      this.findOpen = true;
      this.emitState();
      this.focusVisibleFindInput();
      return true;
    }
    if (command && key === "r") {
      if (input.shift) {
        this.activeVisibleTab()?.contents.reloadIgnoringCache();
      } else {
        this.reload("visible", this.activeVisibleTabId);
      }
      return true;
    }
    if (command && (key === "+" || key === "=")) {
      this.stepPageZoom(1);
      return true;
    }
    if (command && key === "-") {
      this.stepPageZoom(-1);
      return true;
    }
    if (command && key === "0") {
      this.setPageZoom(1);
      return true;
    }
    if ((command && key === "[") || (input.alt && key === "left")) {
      this.goBack("visible", this.activeVisibleTabId);
      return true;
    }
    if ((command && key === "]") || (input.alt && key === "right")) {
      this.goForward("visible", this.activeVisibleTabId);
      return true;
    }
    if (key === "f12") {
      this.activeVisibleTab()?.contents.openDevTools({ mode: "detach" });
      return true;
    }
    if (key === "escape" && this.findOpen) {
      this.closeFindInPage();
      return true;
    }
    return false;
  }

  private focusVisibleAddressBar() {
    const contents = this.visibleWindow?.webContents;
    if (!contents || contents.isDestroyed()) {
      return;
    }
    contents.focus();
    void contents.executeJavaScript('document.getElementById("address")?.focus(); document.getElementById("address")?.select();', true);
  }

  private focusVisibleFindInput() {
    const contents = this.visibleWindow?.webContents;
    if (!contents || contents.isDestroyed()) {
      return;
    }
    contents.focus();
    void contents.executeJavaScript('requestAnimationFrame(() => document.getElementById("find-input")?.focus())', true);
  }

  private findInPage(query: string, forward: boolean) {
    const contents = this.activeVisibleTab()?.contents;
    this.findOpen = true;
    this.findQuery = query;
    if (!contents || contents.isDestroyed() || !query) {
      contents?.stopFindInPage("clearSelection");
      this.findMatches = 0;
      this.findActiveMatch = 0;
      this.emitState();
      return;
    }
    contents.findInPage(query, { forward, findNext: true });
    this.emitState();
  }

  private closeFindInPage() {
    this.findOpen = false;
    this.findMatches = 0;
    this.findActiveMatch = 0;
    this.activeVisibleTab()?.contents.stopFindInPage("keepSelection");
    this.emitState();
  }

  private stepPageZoom(direction: -1 | 1) {
    const current = this.activeVisibleTab()?.contents.getZoomFactor() ?? 1;
    const levels = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    const next =
      direction > 0
        ? (levels.find((level) => level > current + 0.001) ?? levels.at(-1) ?? 3)
        : ([...levels].reverse().find((level) => level < current - 0.001) ?? levels[0]);
    this.setPageZoom(next);
  }

  private setPageZoom(factor: number) {
    const contents = this.activeVisibleTab()?.contents;
    if (!contents || contents.isDestroyed()) {
      return;
    }
    contents.setZoomFactor(clampNumber(factor, 0.5, 3));
    this.emitState();
  }

  private applyDevicePreset(preset: string) {
    const presets: Record<string, { width: number; height: number }> = {
      "mobile-s": { width: 320, height: 568 },
      "mobile-m": { width: 375, height: 667 },
      "mobile-l": { width: 430, height: 932 },
      tablet: { width: 768, height: 1024 },
      laptop: { width: 1440, height: 900 },
      desktop: { width: 1920, height: 1080 },
      "4k": { width: 3840, height: 2160 }
    };
    const selected = presets[preset];
    this.deviceViewport = {
      ...this.deviceViewport,
      enabled: true,
      preset,
      ...(selected ?? {})
    };
    this.updateVisibleViewLayout();
    this.emitState();
  }

  private applyDeviceSize(width: number, height: number) {
    this.deviceViewport = {
      ...this.deviceViewport,
      enabled: true,
      preset: "responsive",
      width: clampNumber(Math.trunc(width || this.deviceViewport.width), 240, 4096),
      height: clampNumber(Math.trunc(height || this.deviceViewport.height), 160, 4096),
      scale: 1
    };
    this.updateVisibleViewLayout();
    this.emitState();
  }

  private async captureVisibleViewportToClipboard() {
    const active = this.activeVisibleTab();
    if (!active || active.contents.isDestroyed()) {
      return;
    }
    const image = await active.contents.capturePage();
    if (image.isEmpty()) {
      this.notifyBrowserShell("The browser viewport could not be captured.", true);
      return;
    }
    clipboard.writeImage(image);
    this.notifyBrowserShell("Browser screenshot copied to the clipboard.");
  }

  private async captureFullPageToClipboard() {
    const active = this.activeVisibleTab();
    if (!active || active.contents.isDestroyed()) {
      return;
    }
    const image = await capturePageWithDebugger(active.contents, true);
    if (!image || image.isEmpty()) {
      this.notifyBrowserShell("The full page could not be captured.", true);
      return;
    }
    clipboard.writeImage(image);
    this.notifyBrowserShell("Full-page screenshot copied to the clipboard.");
  }

  private recordBrowserHistory(target: BrowserTargetRecord, contents: WebContents) {
    const url = target.failedUrl ?? target.url;
    if (!url || !isRestorableBrowserUrl(url) || isVisibleStartPageUrl(contents.getURL()) || isVisibleLoadErrorPageUrl(contents.getURL())) {
      return;
    }
    const previous = this.browserHistory.at(-1);
    if (previous?.url === url && previous.title === target.title) {
      return;
    }
    this.browserHistory.push({ url, title: target.title || url, visitedAt: new Date().toISOString() });
    if (this.browserHistory.length > 500) {
      this.browserHistory.splice(0, this.browserHistory.length - 500);
    }
  }

  private showBrowserHistoryMenu() {
    const recent = this.browserHistory.slice(-20).reverse();
    const template: MenuItemConstructorOptions[] = [
      { label: "History", enabled: false },
      ...(recent.length > 0
        ? [
            { type: "separator" as const },
            ...recent.map((entry) => ({
              label: entry.title || entry.url,
              sublabel: entry.url,
              click: () => this.createVisibleTab({ url: entry.url, activate: true })
            }))
          ]
        : [{ label: "No browsing history", enabled: false }]),
      { type: "separator" },
      {
        label: "Delete browsing history",
        enabled: this.browserHistory.length > 0,
        click: () => {
          this.browserHistory.splice(0);
          this.persistVisibleSessionNow();
          this.notifyBrowserShell("Browser history cleared.");
        }
      }
    ];
    Menu.buildFromTemplate(template).popup({ window: this.visibleWindow });
  }

  private showBrowserOptionsMenu() {
    const active = this.activeVisibleTab();
    if (!active) {
      return;
    }
    const zoom = Math.round(active.contents.getZoomFactor() * 100);
    const template: MenuItemConstructorOptions[] = [
      {
        label: "Take a screenshot",
        submenu: [
          {
            label: "Visible viewport",
            accelerator: "CommandOrControl+Shift+S",
            click: () => void this.captureVisibleViewportToClipboard()
          },
          { label: "Full page", click: () => void this.captureFullPageToClipboard() }
        ]
      },
      {
        label: "Find in page",
        accelerator: "CommandOrControl+F",
        click: () => {
          this.findOpen = true;
          this.emitState();
          this.focusVisibleFindInput();
        }
      },
      { label: "Print…", accelerator: "CommandOrControl+P", click: () => active.contents.print({ printBackground: true }) },
      { label: "History", click: () => this.showBrowserHistoryMenu() },
      { label: "Browser settings", click: () => this.openBrowserSettings() },
      {
        label: "Review and comment",
        submenu: [
          { label: "Select element", click: () => void this.setBrowserAnnotationMode("element") },
          { label: "Capture region", click: () => void this.setBrowserAnnotationMode("region") },
          {
            label: "Send pending notes to Arivu",
            enabled: this.pendingAnnotations.length > 0,
            click: () => this.sendBrowserAnnotationsToArivu()
          }
        ]
      },
      {
        label: "Autofill",
        enabled: this.browserProfileStore().autofillProfiles().length > 0 || this.browserProfileStore().credentialSummaries().length > 0,
        click: () => void this.autofillActivePage()
      },
      {
        label: "Agent tabs",
        submenu: [
          {
            label: "Send current tab to background agent",
            enabled: Boolean(active.url),
            click: () => void this.sendActiveTabToAgent()
          },
          {
            label: "Adopt background agent page",
            enabled: Boolean(this.targets.background.url),
            click: () => this.adoptBackgroundAgentTab()
          }
        ]
      },
      { type: "separator" },
      {
        label: `Zoom (${zoom}%)`,
        submenu: [
          { label: "Zoom in", accelerator: "CommandOrControl+=", click: () => this.stepPageZoom(1) },
          { label: "Zoom out", accelerator: "CommandOrControl+-", click: () => this.stepPageZoom(-1) },
          { label: "Reset", accelerator: "CommandOrControl+0", enabled: zoom !== 100, click: () => this.setPageZoom(1) }
        ]
      },
      {
        label: this.deviceViewport.enabled ? "Hide device toolbar" : "Show device toolbar",
        click: () => {
          this.deviceViewport = { ...this.deviceViewport, enabled: !this.deviceViewport.enabled };
          this.updateVisibleViewLayout();
          this.emitState();
        }
      },
      { type: "separator" },
      { label: "Duplicate tab", click: () => active.url && this.createVisibleTab({ url: active.url, activate: true }) },
      {
        label: "Reopen closed tab",
        enabled: this.recentlyClosedVisibleTabs.length > 0,
        accelerator: "CommandOrControl+Shift+T",
        click: () => {
          const closed = this.recentlyClosedVisibleTabs.pop();
          if (closed) this.createVisibleTab({ url: closed.url, activate: true });
        }
      },
      { label: "Open in external browser", enabled: Boolean(active.url), click: () => active.url && void shell.openExternal(active.url) },
      { type: "separator" },
      {
        label: "Clear browsing data",
        submenu: [
          { label: "Clear cookies", click: () => void this.clearBrowserCookies() },
          { label: "Clear cache", click: () => void this.clearBrowserCache() }
        ]
      },
      { label: "Inspect", accelerator: "F12", click: () => active.contents.openDevTools({ mode: "detach" }) }
    ];
    Menu.buildFromTemplate(template).popup({ window: this.visibleWindow });
  }

  private openBrowserSettings() {
    const existing = [...this.visibleTabs.values()].find((tab) => isVisibleSettingsPageUrl(tab.contents.getURL()));
    if (existing) {
      this.selectVisibleTabById(existing.id);
      this.emitState();
      return;
    }
    const target = this.createVisibleTab({ activate: true, deferLoad: true });
    target.title = "Browser settings";
    void target.contents.loadURL(visibleSettingsPageUrl(this.browserSettingsPageState())).catch((error: unknown) => {
      target.lastError = error instanceof Error ? error.message : String(error);
      this.emitState();
    });
  }

  private refreshBrowserSettingsTabs() {
    const url = visibleSettingsPageUrl(this.browserSettingsPageState());
    for (const target of this.visibleTabs.values()) {
      if (isVisibleSettingsPageUrl(target.contents.getURL())) {
        void target.contents.loadURL(url).catch(() => undefined);
      }
    }
  }

  private browserSettingsPageState() {
    const store = this.browserProfileStore();
    const extensions = this.activeVisibleTab()?.contents.session.extensions.getAllExtensions() ?? [];
    return {
      askDownloadLocation: this.askDownloadLocation,
      downloadDirectory: this.downloadDirectory ?? app.getPath("downloads"),
      historyCount: this.browserHistory.length,
      permissionCount: this.browserPermissions.size,
      credentials: store.credentialSummaries(),
      autofillProfiles: store.autofillProfiles(),
      extensions: extensions.map((extension) => {
        const optionsPage = extension.manifest?.options_ui?.page ?? extension.manifest?.options_page;
        return {
          id: extension.id,
          name: extension.name,
          version: extension.version,
          optionsUrl: typeof optionsPage === "string" ? new URL(optionsPage, extension.url).toString() : undefined
        };
      })
    };
  }

  private async chooseDownloadDirectory() {
    const window = this.visibleWindow;
    const options = {
      title: "Choose browser download location",
      defaultPath: this.downloadDirectory ?? app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">
    };
    const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return;
    }
    this.downloadDirectory = result.filePaths[0];
    this.persistVisibleSessionNow();
    this.refreshBrowserSettingsTabs();
    this.notifyBrowserShell("Browser download location updated.");
  }

  private showDownloadsMenu() {
    const recent = this.browserDownloads.slice(-8).reverse();
    const items: MenuItemConstructorOptions[] = recent.map((download) => {
      const progress =
        download.state === "progressing" && download.totalBytes > 0
          ? ` — ${Math.round((download.receivedBytes / download.totalBytes) * 100)}%`
          : download.state === "completed"
            ? ""
            : ` — ${download.state}`;
      return {
        label: `${download.filename}${progress}`,
        enabled: download.state === "completed" && Boolean(download.savePath),
        click: () => download.savePath && shell.showItemInFolder(download.savePath)
      };
    });
    Menu.buildFromTemplate([
      { label: "Downloads", enabled: false },
      ...(items.length > 0 ? [{ type: "separator" as const }, ...items] : [{ label: "No downloads yet", enabled: false }]),
      { type: "separator" },
      { label: "Open Downloads folder", click: () => void shell.openPath(app.getPath("downloads")) },
      {
        label: "Delete download history",
        enabled: this.browserDownloads.length > 0,
        click: () => {
          this.browserDownloads.splice(0);
          this.notifyBrowserShell("Browser download history cleared.");
        }
      }
    ]).popup({ window: this.visibleWindow });
  }

  private configureBrowserSession(browserSession: Session) {
    if (this.configuredBrowserSessions.has(browserSession)) {
      return;
    }
    this.configuredBrowserSessions.add(browserSession);
    void this.restoreBrowserExtensions(browserSession);
    browserSession.on("will-download", (_event, item) => {
      const downloadDirectory = this.downloadDirectory ?? app.getPath("downloads");
      const defaultPath = path.join(downloadDirectory, item.getFilename());
      if (this.askDownloadLocation) {
        item.setSaveDialogOptions({ title: "Save download", defaultPath });
      } else if (this.downloadDirectory) {
        mkdirSync(downloadDirectory, { recursive: true });
        item.setSavePath(availableDownloadPath(downloadDirectory, item.getFilename()));
      }
      const record: BrowserDownloadRecord = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: item.getFilename(),
        url: item.getURL(),
        state: "progressing",
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes()
      };
      this.browserDownloads.push(record);
      if (this.browserDownloads.length > 50) {
        this.browserDownloads.splice(0, this.browserDownloads.length - 50);
      }
      item.on("updated", (_itemEvent, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        if (state === "interrupted") {
          record.state = "interrupted";
        }
        this.emitState();
      });
      item.once("done", (_itemEvent, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.savePath = item.getSavePath() || undefined;
        record.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        this.notifyBrowserShell(
          state === "completed" ? `${record.filename} downloaded.` : `${record.filename} download ${record.state}.`,
          state !== "completed"
        );
      });
      this.emitState();
    });
    browserSession.setPermissionRequestHandler((requestingContents, permission, callback, details) => {
      const requestUrl = details.requestingUrl || requestingContents.getURL();
      let host = requestUrl;
      let origin = requestUrl;
      try {
        const parsed = new URL(requestUrl);
        host = parsed.hostname;
        origin = parsed.origin;
      } catch {
        // Keep the raw URL when it cannot be parsed.
      }
      const permissionKey = browserPermissionKey(origin, permission);
      const savedDecision = this.browserPermissions.get(permissionKey);
      if (savedDecision) {
        callback(savedDecision === "allow");
        return;
      }
      const permissionDialog: MessageBoxOptions = {
        type: "question",
        buttons: ["Allow", "Block"],
        defaultId: 1,
        cancelId: 1,
        title: "Site permission",
        message: `${host || "This site"} wants permission to use ${humanizePermission(permission)}.`,
        detail: "This permission applies to the isolated Arivu browser profile."
      };
      const response = this.visibleWindow
        ? dialog.showMessageBox(this.visibleWindow, permissionDialog)
        : dialog.showMessageBox(permissionDialog);
      void response.then(
        (result) => {
          const allowed = result.response === 0;
          this.browserPermissions.set(permissionKey, allowed ? "allow" : "block");
          this.persistVisibleSessionNow();
          callback(allowed);
        },
        () => callback(false)
      );
    });
    browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      return this.browserPermissions.get(browserPermissionKey(requestingOrigin, permission)) !== "block";
    });
  }

  private showSiteInformationMenu() {
    const active = this.activeVisibleTab();
    if (!active?.url) {
      return;
    }
    let parsed: URL | undefined;
    try {
      parsed = new URL(active.url);
    } catch {
      // The menu still offers a copy action for unusual URLs.
    }
    const secure = parsed?.protocol === "https:" || parsed?.protocol === "file:";
    const origin = parsed?.origin && parsed.origin !== "null" ? parsed.origin : undefined;
    const permissionEntries: Array<{ permission: string; label: string }> = [
      { permission: "media", label: "Camera and microphone" },
      { permission: "geolocation", label: "Location" },
      { permission: "notifications", label: "Notifications" },
      { permission: "clipboard-read", label: "Clipboard" },
      { permission: "fullscreen", label: "Fullscreen" }
    ];
    const permissionMenu: MenuItemConstructorOptions[] = permissionEntries.map(({ permission, label }) => {
      const key = browserPermissionKey(origin ?? active.url, permission);
      const decision = this.browserPermissions.get(key);
      const setDecision = (next: "allow" | "block" | undefined) => {
        if (next) {
          this.browserPermissions.set(key, next);
        } else {
          this.browserPermissions.delete(key);
        }
        this.persistVisibleSessionNow();
        this.notifyBrowserShell(`${label} permission set to ${next ?? "ask"}.`);
      };
      return {
        label,
        submenu: [
          { label: "Ask", type: "radio", checked: !decision, click: () => setDecision(undefined) },
          { label: "Allow", type: "radio", checked: decision === "allow", click: () => setDecision("allow") },
          { label: "Block", type: "radio", checked: decision === "block", click: () => setDecision("block") }
        ]
      };
    });
    Menu.buildFromTemplate([
      { label: secure ? "Connection is secure" : "Connection is not secure", enabled: false },
      { label: parsed?.hostname || active.url, enabled: false },
      { type: "separator" },
      { label: "Copy page address", click: () => clipboard.writeText(active.url) },
      { label: "Site permissions", enabled: Boolean(origin), submenu: permissionMenu },
      {
        label: "Clear site data",
        enabled: Boolean(parsed?.origin && parsed.origin !== "null"),
        click: () => void this.clearSiteData(parsed?.origin)
      },
      { label: "Inspect", click: () => active.contents.openDevTools({ mode: "detach" }) }
    ]).popup({ window: this.visibleWindow });
  }

  private showPageContextMenu(contents: WebContents, target: BrowserTargetRecord, params: ContextMenuParams) {
    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      );
    } else if (params.selectionText) {
      template.push({ role: "copy" });
    }
    if (params.linkURL) {
      if (template.length) template.push({ type: "separator" });
      template.push(
        { label: "Open link in new tab", click: () => this.createVisibleTab({ url: params.linkURL, activate: true }) },
        { label: "Open in external browser", click: () => void shell.openExternal(params.linkURL) },
        { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) }
      );
    }
    if (template.length) template.push({ type: "separator" });
    template.push(
      { label: "Back", enabled: target.canGoBack, click: () => this.goBack("visible", target.id) },
      { label: "Forward", enabled: target.canGoForward, click: () => this.goForward("visible", target.id) },
      { label: "Reload", click: () => contents.reload() },
      { type: "separator" },
      { label: "Inspect", click: () => contents.inspectElement(params.x, params.y) }
    );
    Menu.buildFromTemplate(template).popup({ window: this.visibleWindow });
  }

  private async clearBrowserCookies() {
    const active = this.activeVisibleTab();
    if (!active) return;
    await active.contents.session.clearStorageData({ storages: ["cookies"] });
    this.notifyBrowserShell("Browser cookies cleared.");
  }

  private async clearBrowserCache() {
    const active = this.activeVisibleTab();
    if (!active) return;
    await active.contents.session.clearCache();
    this.notifyBrowserShell("Browser cache cleared.");
  }

  private async clearSiteData(origin: string | undefined) {
    const active = this.activeVisibleTab();
    if (!active || !origin) return;
    await active.contents.session.clearStorageData({ origin });
    this.notifyBrowserShell("Site data cleared.");
  }

  private notifyBrowserShell(message: string, error = false) {
    this.shellNotice = { id: this.nextShellNoticeId++, message, error: error || undefined };
    this.emitState();
  }

  private renderVisibleShellState() {
    const window = this.visibleWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    const contents = window.webContents;
    if (!contents.getURL() || contents.isDestroyed()) {
      return;
    }
    if (!this.visibleShellReady || this.visibleShellRenderInFlight) {
      this.visibleShellRenderPending = true;
      return;
    }
    this.visibleShellRenderInFlight = true;
    this.visibleShellRenderPending = false;
    const state = {
      ...this.publicVisibleTarget(),
      chrome: {
        zoomPercent: Math.round(((this.activeVisibleTab()?.contents.getZoomFactor() ?? 1) * 100) / 5) * 5,
        findOpen: this.findOpen,
        findQuery: this.findQuery,
        findMatches: this.findMatches,
        findActiveMatch: this.findActiveMatch,
        device: this.deviceViewport,
        annotationMode: this.annotationMode,
        annotations: this.pendingAnnotations,
        activeAnnotationId: this.activeAnnotationId,
        backgroundAgent: {
          url: this.targets.background.url,
          title: this.targets.background.title,
          loading: this.targets.background.loading
        },
        agentWork: this.agentWorkChromeState(),
        notice: this.shellNotice,
        downloadCount: this.browserDownloads.length,
        activeDownloadCount: this.browserDownloads.filter((download) => download.state === "progressing").length
      }
    };
    const script = `window.__ARIVU_BROWSER_APPLY_STATE__?.(${JSON.stringify(state)});`;
    void Promise.race([contents.executeJavaScript(script, true), delay(750).then(() => undefined)])
      .catch(() => undefined)
      .finally(() => {
        this.visibleShellRenderInFlight = false;
        if (this.visibleShellRenderPending) {
          this.renderVisibleShellState();
        }
      });
  }

  /** Chip state for the shell: the first working tab, and whether the user is viewing it. */
  private agentWorkChromeState() {
    const workingTabId = [...this.agentTaskTabIds].find((id) => this.visibleTabs.has(id));
    if (!workingTabId) {
      return undefined;
    }
    const tab = this.visibleTabs.get(workingTabId);
    return {
      tabId: workingTabId,
      title: tab?.title ?? "",
      watching: this.activeVisibleTabId === workingTabId,
      count: this.agentTaskTabIds.size
    };
  }

  private showVisibleWindow(window: BrowserWindow) {
    if (!this.paneOpen || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    if (!window.isMaximized()) {
      window.maximize();
    }
    window.show();
    window.focus();
  }

  private destroyVisibleWindow() {
    if (!this.visibleWindow || this.visibleWindow.isDestroyed()) {
      return;
    }
    this.destroyingVisibleWindow = true;
    this.visibleWindow.destroy();
    this.destroyingVisibleWindow = false;
  }

  private emitState() {
    const state = this.getState();
    this.renderVisibleShellState();
    this.scheduleVisibleSessionWrite();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
