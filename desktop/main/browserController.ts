import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  nativeImage,
  powerSaveBlocker,
  shell,
  type WebContents,
  type ContextMenuParams,
  type WebFrameMain,
  type Input,
  type MessageBoxOptions,
  type MenuItemConstructorOptions,
  type Session,
  type WebPreferences
} from "electron";
import { appDataDir } from "../../src/config.js";
import {
  normalizeBrowserMode,
  normalizeBrowserUrl,
  type BrowserConsoleEntry,
  type BrowserMode,
  type BrowserState,
  type BrowserTabState,
  type BrowserTargetState,
  type BrowserTaskModelConfig,
  type BrowserToolController,
  type BrowserToolResult
} from "../../src/tools/browserControl.js";
import { runBrowserTask } from "./browserTaskSupervisor.js";
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
import { codexBrowserShellHtml } from "./codexBrowserShell.js";
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

type BrowserStateListener = (state: BrowserState) => void;

type BrowserTargetRecord = Omit<BrowserTargetState, "activeTabId" | "tabs"> & {
  logs: BrowserConsoleEntry[];
  faviconUrl?: string;
  failedUrl?: string;
  recoveryTitle?: string;
  lastScreenshotSize?: BrowserImageSize;
  lastViewport?: BrowserViewport;
};

type BrowserTabRecord = BrowserTargetRecord & {
  contents: WebContents;
  view?: BrowserView;
  popupWindow?: BrowserWindow;
};

type BrowserImageSize = {
  width: number;
  height: number;
};

type BrowserViewport = {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
};

type BrowserDeviceViewport = {
  enabled: boolean;
  preset: string;
  width: number;
  height: number;
  scale: number;
};

type BrowserFrameMeta = {
  index: number;
  url: string;
  name?: string;
  origin: string;
  mainFrame: boolean;
};

type BrowserFrameInspection =
  | (BrowserFrameMeta & {
      ok: true;
      snapshot: BrowserToolResult;
    })
  | (BrowserFrameMeta & {
      ok: false;
      error: string;
    });

type BrowserDownloadRecord = {
  id: string;
  filename: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  savePath?: string;
};

type BrowserSessionSnapshot = {
  version: 1;
  tabs: string[];
  activeIndex: number;
  history?: BrowserHistoryRecord[];
  permissions?: Record<string, "allow" | "block">;
  settings?: {
    askDownloadLocation?: boolean;
    downloadDirectory?: string;
  };
};

type BrowserHistoryRecord = {
  url: string;
  title: string;
  visitedAt: string;
};

const MAX_CONSOLE_LOGS = 300;
// Budget for the serialized element list in snapshot/screenshot results. Without it a busy
// page (e.g. ServiceNow) can push a single tool result past the request auto-compaction
// threshold, which strips native tool protocol and derails tool calling on the next turn.
const MAX_VISUAL_ELEMENTS_JSON_CHARS = 48_000;
const DEFAULT_BACKGROUND_BOUNDS = { width: 1280, height: 800 };
const DEFAULT_VISIBLE_CHROME_HEIGHT = 80;
const VISIBLE_START_PAGE_TITLE = "Arivu Browser";
const VISIBLE_START_PAGE_PREFIX = "data:text/html;charset=utf-8,";
const VISIBLE_START_PAGE_MARKER = "arivu-browser-start";
const VISIBLE_LOAD_ERROR_PAGE_MARKER = "arivu-browser-load-error";
const VISIBLE_SETTINGS_PAGE_MARKER = "arivu-browser-settings";
const VISIBLE_SHELL_COMMAND_PROTOCOL = "arivu-browser:";
const BROWSER_PARTITION = "persist:arivu-browser";
const BROWSER_SESSION_FILE = "browser-session.json";

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
  private didAttemptVisibleSessionRestore = false;
  private restoringVisibleSession = false;
  private visibleSessionWriteTimer: ReturnType<typeof setTimeout> | undefined;
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
    contents.focus();
    contents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
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

  async task(args: {
    instruction: string;
    mode?: BrowserMode;
    tabId?: string;
    maxSteps?: number;
    timeoutMs?: number;
    allowedDomains?: string[];
    allowJavaScript?: boolean;
    allowSensitiveActions?: boolean;
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
    const result = await this.withFreshSnapshot(contents, taskResult);
    this.updateTargetFromContents(mode, contents, target);
    this.emitState();
    return this.resultForMode(mode, result, target);
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
            const surfaceImage = await contents.capturePage();
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
        return contents.capturePage();
      });
    }
    const debuggerImage = await capturePageWithDebugger(contents);
    if (debuggerImage && !debuggerImage.isEmpty()) {
      return debuggerImage;
    }
    return contents.capturePage();
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
    if (this.visibleTabOrder.length === 0 && window && !window.isDestroyed()) {
      this.createVisibleTab({ activate: true });
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
    if (this.visibleTabOrder.length === 0 && this.visibleWindow && !this.visibleWindow.isDestroyed()) {
      this.createVisibleTab({ activate: true });
      return;
    }
    this.attachActiveVisibleView();
    this.emitState();
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
    if (this.didAttemptVisibleSessionRestore || !this.browserSessionPersistenceEnabled()) {
      return;
    }
    this.didAttemptVisibleSessionRestore = true;
    let snapshot: BrowserSessionSnapshot;
    try {
      snapshot = JSON.parse(readFileSync(this.browserSessionPath(), "utf8")) as BrowserSessionSnapshot;
    } catch {
      return;
    }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.tabs)) {
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
    this.restoringVisibleSession = true;
    try {
      const restored = urls.map((url) => this.createVisibleTab({ url: url || undefined, activate: false }));
      const activeIndex = clampNumber(Number(snapshot.activeIndex) || 0, 0, restored.length - 1);
      this.activeVisibleTabId = restored[activeIndex]?.id ?? restored[0]?.id;
      this.attachActiveVisibleView();
      this.emitState();
    } finally {
      this.restoringVisibleSession = false;
    }
  }

  private scheduleVisibleSessionWrite() {
    if (!this.didAttemptVisibleSessionRestore || this.restoringVisibleSession || !this.browserSessionPersistenceEnabled()) {
      return;
    }
    if (this.visibleSessionWriteTimer) {
      clearTimeout(this.visibleSessionWriteTimer);
    }
    this.visibleSessionWriteTimer = setTimeout(() => {
      this.visibleSessionWriteTimer = undefined;
      this.persistVisibleSessionNow();
    }, 300);
  }

  private persistVisibleSessionNow() {
    if (!this.didAttemptVisibleSessionRestore || !this.browserSessionPersistenceEnabled()) {
      return;
    }
    if (this.visibleSessionWriteTimer) {
      clearTimeout(this.visibleSessionWriteTimer);
      this.visibleSessionWriteTimer = undefined;
    }
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
    const snapshot: BrowserSessionSnapshot = {
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
    try {
      mkdirSync(appDataDir(), { recursive: true });
      writeFileSync(this.browserSessionPath(), JSON.stringify(snapshot), "utf8");
    } catch {
      // Session restoration is best-effort and must not block browser navigation.
    }
  }

  private browserSessionPath() {
    return path.join(appDataDir(), BROWSER_SESSION_FILE);
  }

  private browserSessionPersistenceEnabled() {
    return process.env.ARIVU_BROWSER_SMOKE !== "1" && process.env.ARIVU_DESKTOP_SMOKE !== "1";
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

function visibleShellPageUrl() {
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(codexBrowserShellHtml({ defaultChromeHeight: DEFAULT_VISIBLE_CHROME_HEIGHT }))}`;
}

function isVisibleShellPageUrl(url: string) {
  return url === visibleShellPageUrl();
}

function isVisibleShellCommandUrl(url: string) {
  try {
    return new URL(url).protocol === VISIBLE_SHELL_COMMAND_PROTOCOL;
  } catch {
    return false;
  }
}

function parseVisibleShellCommand(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== VISIBLE_SHELL_COMMAND_PROTOCOL) {
      return undefined;
    }
    return {
      action: parsed.hostname,
      params: parsed.searchParams
    };
  } catch {
    return undefined;
  }
}

function isVisibleSettingsCommandUrl(url: string) {
  const command = parseVisibleShellCommand(url);
  return Boolean(
    command &&
    [
      "set-ask-download",
      "choose-download-directory",
      "settings-clear-cookies",
      "settings-clear-cache",
      "settings-clear-history",
      "settings-reset-permissions",
      "settings-import-profile",
      "settings-add-credential",
      "settings-remove-credential",
      "settings-add-autofill",
      "settings-remove-autofill",
      "settings-load-extension",
      "settings-remove-extension",
      "settings-open-extension"
    ].includes(command.action)
  );
}

function visibleStartPageUrl() {
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(visibleStartPageHtml())}`;
}

function isVisibleStartPageUrl(url: string) {
  return url === visibleStartPageUrl();
}

function visibleSettingsPageUrl(state: {
  askDownloadLocation: boolean;
  downloadDirectory: string;
  historyCount: number;
  permissionCount: number;
  credentials: Array<{ id: string; origin: string; username: string; label?: string }>;
  autofillProfiles: Array<{ id: string; label: string; fullName?: string; email?: string; phone?: string }>;
  extensions: Array<{ id: string; name: string; version: string; optionsUrl?: string }>;
}) {
  const credentialRows = state.credentials.length
    ? state.credentials
        .map(
          (credential) =>
            `<div class="saved-row"><div><strong>${escapeHtml(credential.label || credential.username)}</strong><span>${escapeHtml(credential.username)} · ${escapeHtml(credential.origin)}</span></div><button class="danger" data-command="settings-remove-credential" data-id="${escapeHtml(credential.id)}">Remove</button></div>`
        )
        .join("")
    : `<p class="empty">No passwords saved.</p>`;
  const profileRows = state.autofillProfiles.length
    ? state.autofillProfiles
        .map(
          (profile) =>
            `<div class="saved-row"><div><strong>${escapeHtml(profile.label)}</strong><span>${escapeHtml([profile.fullName, profile.email, profile.phone].filter(Boolean).join(" · "))}</span></div><button class="danger" data-command="settings-remove-autofill" data-id="${escapeHtml(profile.id)}">Remove</button></div>`
        )
        .join("")
    : `<p class="empty">No autofill profiles saved.</p>`;
  const extensionRows = state.extensions.length
    ? state.extensions
        .map(
          (extension) =>
            `<div class="saved-row"><div><strong>${escapeHtml(extension.name)}</strong><span>Version ${escapeHtml(extension.version)} · ${escapeHtml(extension.id)}</span></div><div class="actions">${extension.optionsUrl ? `<button data-command="settings-open-extension" data-url="${escapeHtml(extension.optionsUrl)}">Options</button>` : ""}<button class="danger" data-command="settings-remove-extension" data-id="${escapeHtml(extension.id)}">Remove</button></div></div>`
        )
        .join("")
    : `<p class="empty">No unpacked extensions loaded.</p>`;
  const html = `<!doctype html>
<html lang="en" data-${VISIBLE_SETTINGS_PAGE_MARKER}>
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline';form-action 'none'">
  <title>Browser settings</title>
  <style>
    :root{color-scheme:dark;--bg:#171717;--panel:#202020;--field:#151515;--line:#343434;--text:#f2f2f2;--muted:#a3a3a3;--accent:#5b9cf5;--danger:#ffaaa4}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 Inter,system-ui,sans-serif}main{width:min(880px,calc(100vw - 40px));margin:0 auto;padding:40px 0 80px}header{position:sticky;top:0;padding:0 0 20px;background:linear-gradient(var(--bg) 78%,transparent);z-index:2}h1{font-size:26px;margin:0 0 18px;letter-spacing:0}#search{width:100%;height:38px}section{display:grid;gap:14px}article{padding:18px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}article[hidden]{display:none}h2{font-size:16px;margin:0 0 6px;letter-spacing:0}p{margin:0;color:var(--muted)}.row,.saved-row{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.stack,.saved-row>div{min-width:0;display:grid;gap:3px}.saved-row span,.path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px}.path{font-family:ui-monospace,SFMono-Regular,monospace;color:#bbb}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:14px}.form-grid .wide{grid-column:1/-1}.form-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px}input,button{font:inherit}input[type=text],input[type=password],input[type=email],input[type=tel],input[type=search]{min-width:0;height:36px;border:1px solid var(--line);border-radius:7px;background:var(--field);color:var(--text);padding:0 10px;outline:0}input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button{flex:0 0 auto;border:1px solid var(--line);border-radius:7px;background:#292929;color:var(--text);padding:7px 10px;cursor:pointer}button:hover{background:#333}.primary{border-color:#4779b9;background:#315f98}.switch{display:flex;align-items:center;gap:9px;color:var(--muted)}input[type=checkbox]{accent-color:var(--accent);width:16px;height:16px}.count{color:var(--text);font-weight:600}.danger{color:var(--danger)}.empty{margin-top:12px}.hint{margin-top:8px;font-size:12px}.actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
    @media(max-width:620px){main{width:min(100% - 24px,880px);padding-top:24px}.form-grid{grid-template-columns:1fr}.form-grid .wide{grid-column:auto}.row,.saved-row{align-items:flex-start}.saved-row{flex-direction:column}.saved-row button{align-self:flex-end}}
    @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f6f5;--panel:#fff;--field:#fff;--line:#d8d8d5;--text:#1c1c1b;--muted:#686865;--danger:#a92f2a}button{background:#f1f1ef}.primary{background:#3269aa;color:#fff}.path{color:#555}}
  </style>
</head>
<body><main><header><h1>Browser settings</h1><input id="search" type="search" placeholder="Search settings" aria-label="Search browser settings"></header><section>
  <article data-search="downloads location save ask"><h2>Downloads</h2><p>Control where files downloaded by the isolated Arivu browser are saved.</p><div class="row"><div class="stack"><strong>Download location</strong><div class="path">${escapeHtml(state.downloadDirectory)}</div></div><button data-command="choose-download-directory">Change</button></div><div class="row"><span>Ask where to save each file</span><label class="switch"><input id="ask-download" type="checkbox" ${state.askDownloadLocation ? "checked" : ""}>Ask</label></div></article>
  <article data-search="privacy cookies cache history clear browsing data import profile"><h2>Privacy and browser data</h2><p>History entries: <span class="count">${state.historyCount}</span></p><div class="actions"><button class="primary" data-command="settings-import-profile">Import profile export</button><button data-command="settings-clear-cookies">Clear cookies</button><button data-command="settings-clear-cache">Clear cache</button><button class="danger" data-command="settings-clear-history">Delete history</button></div><p class="hint">Import accepts Chrome-compatible password CSV files or Arivu JSON exports containing passwords, cookies, and autofill profiles.</p></article>
  <article data-search="password manager credentials login"><h2>Password manager</h2><p>Passwords are encrypted with the operating system credential store and never shown in this page.</p>${credentialRows}<form id="credential-form" class="form-grid"><input name="label" type="text" placeholder="Label"><input name="origin" type="text" placeholder="https://example.com" required><input name="username" type="text" autocomplete="username" placeholder="Username" required><input name="password" type="password" autocomplete="new-password" placeholder="Password" required><div class="form-actions"><button class="primary" type="submit">Save password</button></div></form></article>
  <article data-search="autofill contact address phone email"><h2>Autofill profiles</h2><p>Saved contact details can be filled into the current page from Browser options.</p>${profileRows}<form id="autofill-form" class="form-grid"><input name="label" type="text" placeholder="Profile name" required><input name="fullName" type="text" autocomplete="name" placeholder="Full name"><input name="email" type="email" autocomplete="email" placeholder="Email"><input name="phone" type="tel" autocomplete="tel" placeholder="Phone"><input class="wide" name="addressLine1" type="text" autocomplete="address-line1" placeholder="Address"><input name="city" type="text" autocomplete="address-level2" placeholder="City"><input name="region" type="text" autocomplete="address-level1" placeholder="State or region"><input name="postalCode" type="text" autocomplete="postal-code" placeholder="Postal code"><input name="country" type="text" autocomplete="country-name" placeholder="Country"><div class="form-actions"><button class="primary" type="submit">Save profile</button></div></form></article>
  <article data-search="extensions add-ons developer unpacked"><h2>Extensions</h2><p>Load unpacked Chromium extensions for this isolated profile. Chrome Web Store packages are not supported by Electron.</p>${extensionRows}<div class="actions"><button class="primary" data-command="settings-load-extension">Load unpacked extension</button></div></article>
  <article data-search="permissions camera microphone location notifications clipboard fullscreen"><h2>Site permissions</h2><p>Saved permission decisions: <span class="count">${state.permissionCount}</span>. Per-site controls are available from the site-information button.</p><div class="row"><span>Reset all saved permission decisions</span><button data-command="settings-reset-permissions">Reset permissions</button></div></article>
  <article data-search="developer devtools inspect cdp debugging"><h2>Developer tools</h2><p>Use F12 or Browser options > Inspect to open Chromium DevTools for the active page.</p></article>
  <article data-search="keyboard shortcuts tabs navigation zoom find accessibility"><h2>Keyboard shortcuts</h2><p>Ctrl/Command+L address · Ctrl/Command+T new tab · Ctrl/Command+W close tab · Ctrl+Tab cycle tabs · Ctrl/Command+F find · Ctrl/Command+R reload · Ctrl/Command +/- zoom</p></article>
</section></main><script>
  const command=(name,params={})=>{const url=new URL("arivu-browser://"+name);for(const[key,value]of Object.entries(params))if(value!==undefined&&value!=="")url.searchParams.set(key,String(value));location.href=url.href};
  document.querySelectorAll("[data-command]").forEach(button=>button.addEventListener("click",()=>command(button.dataset.command,{id:button.dataset.id,url:button.dataset.url})));
  document.getElementById("ask-download").addEventListener("change",event=>command("set-ask-download",{value:event.target.checked}));
  document.getElementById("credential-form").addEventListener("submit",event=>{event.preventDefault();command("settings-add-credential",Object.fromEntries(new FormData(event.target)))});
  document.getElementById("autofill-form").addEventListener("submit",event=>{event.preventDefault();command("settings-add-autofill",Object.fromEntries(new FormData(event.target)))});
  document.getElementById("search").addEventListener("input",event=>{const query=event.target.value.trim().toLowerCase();document.querySelectorAll("article").forEach(article=>article.hidden=Boolean(query)&&!article.dataset.search.includes(query)&&!article.innerText.toLowerCase().includes(query))});
</script></body></html>`;
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(html)}`;
}

function isVisibleSettingsPageUrl(url: string) {
  if (!url.startsWith(VISIBLE_START_PAGE_PREFIX)) {
    return false;
  }
  try {
    return decodeURIComponent(url).includes(`data-${VISIBLE_SETTINGS_PAGE_MARKER}`);
  } catch {
    return false;
  }
}

function visibleLoadErrorPageUrl(failedUrl: string, errorCode: number, errorDescription: string) {
  let host = failedUrl;
  try {
    host = new URL(failedUrl).hostname || failedUrl;
  } catch {
    // Keep the raw URL in the fallback page.
  }
  const summary =
    errorCode === -105
      ? `${host}'s server IP address could not be found`
      : errorCode === -106
        ? `${host} could not be loaded because the computer is offline`
        : errorCode === -102
          ? `${host} refused to connect`
          : errorCode === -118
            ? `${host} took too long to respond`
            : errorCode <= -200 && errorCode >= -299
              ? `${host}'s certificate could not be verified`
              : `${host} could not be loaded`;
  const failedUrlJson = JSON.stringify(failedUrl).replace(/</g, "\\u003c");
  const html = `<!doctype html><html data-${VISIBLE_LOAD_ERROR_PAGE_MARKER}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><title>This site can't be reached</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171717;color:#f1f1f1;font-family:Inter,system-ui,sans-serif}.card{width:min(560px,calc(100vw - 48px));padding:42px}.icon{width:42px;height:42px;border:2px solid #777;border-radius:50%;display:grid;place-items:center;color:#aaa;font-size:22px}h1{margin:24px 0 10px;font-size:26px}p{color:#aaa;line-height:1.55}.try{margin-top:24px;color:#ddd}.try+ul{padding-left:20px;color:#aaa;line-height:1.7}button{margin-top:20px;border:0;border-radius:9px;padding:9px 15px;background:#f1f1f1;color:#171717;font-weight:650;cursor:pointer}code{display:block;margin-top:18px;color:#777;font-size:11px}@media(prefers-color-scheme:light){:root{color-scheme:light}body{background:#f7f7f6;color:#1c1c1b}p,.try+ul{color:#686865}.try{color:#333}button{background:#1c1c1b;color:#fff}}</style></head><body><main class="card"><div class="icon">!</div><h1>This site can't be reached</h1><p>${escapeHtml(summary)}</p><p class="try">Try:</p><ul><li>Checking the connection</li><li>Checking the proxy, firewall, and DNS configuration</li></ul><button id="retry" type="button">Reload</button><code>${escapeHtml(errorDescription)} (${errorCode})</code></main><script>document.getElementById("retry").addEventListener("click",()=>{location.href=${failedUrlJson}})</script></body></html>`;
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(html)}`;
}

function visibleCrashRecoveryPageUrl(failedUrl: string, reason: string) {
  const retryTargetJson = JSON.stringify(failedUrl || visibleStartPageUrl()).replace(/</g, "\\u003c");
  const html = `<!doctype html><html data-${VISIBLE_LOAD_ERROR_PAGE_MARKER}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><title>This tab crashed</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171717;color:#f1f1f1;font-family:Inter,system-ui,sans-serif}.card{width:min(560px,calc(100vw - 48px));padding:42px}.icon{width:42px;height:42px;border:2px solid #777;border-radius:50%;display:grid;place-items:center;color:#aaa;font-size:22px}h1{margin:24px 0 10px;font-size:26px}p{color:#aaa;line-height:1.55}button{margin-top:20px;border:0;border-radius:9px;padding:9px 15px;background:#f1f1f1;color:#171717;font-weight:650;cursor:pointer}code{display:block;margin-top:18px;color:#777;font-size:11px}@media(prefers-color-scheme:light){:root{color-scheme:light}body{background:#f7f7f6;color:#1c1c1b}p{color:#686865}button{background:#1c1c1b;color:#fff}}</style></head><body><main class="card"><div class="icon">!</div><h1>This tab crashed</h1><p>The page renderer stopped unexpectedly. Reload the tab to continue where you left off.</p><button id="retry" type="button">Reload tab</button><code>${escapeHtml(reason)}</code></main><script>document.getElementById("retry").addEventListener("click",()=>{location.href=${retryTargetJson}})</script></body></html>`;
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(html)}`;
}

function isVisibleLoadErrorPageUrl(url: string) {
  if (!url.startsWith(VISIBLE_START_PAGE_PREFIX)) {
    return false;
  }
  try {
    return decodeURIComponent(url).includes(`data-${VISIBLE_LOAD_ERROR_PAGE_MARKER}`);
  } catch {
    return false;
  }
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character
  );
}

function visibleStartPageHtml() {
  return `<!doctype html>
<html lang="en" data-${VISIBLE_START_PAGE_MARKER}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
  <title>${VISIBLE_START_PAGE_TITLE}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #000000;
      --panel: #0a0e10;
      --line: #1a2a30;
      --text: #e8f4f8;
      --muted: #7a919c;
      --accent: #00d4ff;
      --accent-strong: #67e8f9;
      --error: #ff8b7f;
    }
    * {
      box-sizing: border-box;
    }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 40px;
      background: linear-gradient(180deg, #000000 0%, #050a0c 100%);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(680px, 100%);
      display: grid;
      gap: 18px;
    }
    h1 {
      margin: 0;
      font-size: 32px;
      line-height: 1.1;
      font-weight: 760;
      letter-spacing: 0;
    }
    form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      box-shadow: 0 18px 55px rgba(0, 0, 0, 0.28);
    }
    input {
      min-width: 0;
      height: 46px;
      border: 0;
      outline: 0;
      border-radius: 10px;
      padding: 0 14px;
      background: #05080a;
      color: var(--text);
      font: inherit;
    }
    input::placeholder {
      color: var(--muted);
    }
    input:focus {
      box-shadow: 0 0 0 2px rgba(71, 199, 151, 0.45);
    }
    button {
      height: 46px;
      border: 0;
      border-radius: 999px;
      padding: 0 22px;
      background: var(--accent);
      color: #001018;
      font: inherit;
      font-weight: 720;
      cursor: pointer;
    }
    button:hover {
      background: var(--accent-strong);
    }
    p {
      min-height: 20px;
      margin: 0;
      color: var(--error);
      font-size: 14px;
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --bg: #f7f7f6;
        --panel: #ffffff;
        --line: #d8d8d5;
        --text: #1c1c1b;
        --muted: #6d6d68;
        --accent: #0891b2;
        --accent-strong: #0e7490;
        --error: #a92f2a;
      }
      body { background: #f7f7f6; }
      form, input { background: #ffffff; }
      button { color: #ffffff; }
    }
    @media (max-width: 560px) {
      body {
        padding: 22px;
      }
      form {
        grid-template-columns: 1fr;
      }
      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>Arivu Browser</h1>
    <form id="open-form" autocomplete="off">
      <input id="url-input" name="url" type="text" inputmode="url" spellcheck="false" placeholder="Search or enter URL" autofocus>
      <button type="submit">Open</button>
    </form>
    <p id="error" role="status" aria-live="polite"></p>
  </main>
  <script>
    const form = document.getElementById("open-form");
    const input = document.getElementById("url-input");
    const error = document.getElementById("error");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      error.textContent = "";
      const rawValue = input.value.trim();
      if (!rawValue) {
        error.textContent = "Enter a URL.";
        input.focus();
        return;
      }
      try {
        const nextUrl = normalizeUrl(rawValue);
        window.location.assign(nextUrl);
      } catch {
        error.textContent = "Enter a valid URL.";
        input.focus();
      }
    });
    function normalizeUrl(value) {
      if (/^https?:\\/\\//i.test(value) || /^file:\\/\\//i.test(value)) {
        return assertAllowedUrl(value).href;
      }
      if (/^(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?(\\/.*)?$/i.test(value)) {
        return assertAllowedUrl("http://" + value).href;
      }
      if (/^[\\w.-]+:\\d+(\\/.*)?$/i.test(value)) {
        return assertAllowedUrl("http://" + value).href;
      }
      if (/^[a-z0-9.-]+\\.[a-z]{2,}(:\\d+)?(\\/.*)?$/i.test(value)) {
        return assertAllowedUrl("https://" + value).href;
      }
      return googleSearchUrl(value);
    }
    function googleSearchUrl(value) {
      return "https://www.google.com/search?q=" + encodeURIComponent(value);
    }
    function assertAllowedUrl(value) {
      const url = new URL(value);
      if (!["http:", "https:", "file:"].includes(url.protocol)) {
        throw new Error("Unsupported protocol");
      }
      return url;
    }
  </script>
</body>
</html>`;
}

/**
 * Keeps elements (in document order, so earlier/on-screen elements win) until their combined
 * serialized size reaches the budget. Element index positions stay stable for the kept prefix.
 */
function capElementsBySerializedSize<T>(elements: T[], budgetChars: number): T[] {
  let used = 0;
  let kept = 0;
  for (const element of elements) {
    used += JSON.stringify(element).length + 1;
    if (used > budgetChars) {
      break;
    }
    kept += 1;
  }
  return kept === elements.length ? elements : elements.slice(0, kept);
}

function initialTarget(mode: BrowserMode, id: string = mode): BrowserTargetRecord {
  return {
    id,
    mode,
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    owner: mode === "background" ? "agent" : "user",
    logs: []
  };
}

function publicTab(target: BrowserTargetRecord): BrowserTabState {
  return {
    id: target.id,
    url: target.url,
    title: target.title,
    ...(target.faviconUrl ? { faviconUrl: target.faviconUrl } : {}),
    loading: target.loading,
    canGoBack: target.canGoBack,
    canGoForward: target.canGoForward,
    owner: target.owner,
    ...(target.lastError ? { lastError: target.lastError } : {}),
    ...(target.lastSnapshotAt ? { lastSnapshotAt: target.lastSnapshotAt } : {}),
    ...(target.lastScreenshotAt ? { lastScreenshotAt: target.lastScreenshotAt } : {}),
    ...(target.lastScreenshotPath ? { lastScreenshotPath: target.lastScreenshotPath } : {})
  };
}

function publicTarget(target: BrowserTargetRecord): BrowserTargetState {
  return { ...publicTab(target), mode: target.mode };
}

function humanizePermission(permission: string): string {
  return permission
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
}

function browserPermissionKey(origin: string, permission: string) {
  let normalizedOrigin = origin;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    // Preserve Chromium's requesting-origin value if it is not a standard URL.
  }
  return `${normalizedOrigin}|${permission}`;
}

function browserWebPreferences(mode: BrowserMode): WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    offscreen: mode === "background",
    partition: BROWSER_PARTITION
  };
}

function assertAllowedPopupUrl(url: string) {
  if (url === "about:blank" || url.startsWith("about:blank#") || url.startsWith("about:blank?")) {
    return;
  }
  normalizeBrowserUrl(url);
}

function browserShellWebPreferences(): WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true
  };
}

function normalizeConsoleLevel(level: unknown): BrowserConsoleEntry["level"] {
  if (level === "error" || level === 3) {
    return "error";
  }
  if (level === "warning" || level === "warn" || level === 2) {
    return "warning";
  }
  if (level === "debug" || level === "verbose" || level === 0) {
    return "debug";
  }
  return "info";
}

function assertPageLoaded(contents: WebContents, mode: BrowserMode) {
  if (!contents.getURL()) {
    throw new Error(`The ${mode} browser has not opened a page yet.`);
  }
}

function isNavigationAbortError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ERR_ABORTED") || message.includes("(-3)");
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isRestorableBrowserUrl(value: string) {
  if (value === "") {
    return true;
  }
  try {
    return ["http:", "https:", "file:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function availableDownloadPath(directory: string, filename: string) {
  const safeFilename = path.basename(filename) || "download";
  const extension = path.extname(safeFilename);
  const stem = path.basename(safeFilename, extension);
  let candidate = path.join(directory, safeFilename);
  for (let suffix = 1; suffix < 10_000 && existsSync(candidate); suffix += 1) {
    candidate = path.join(directory, `${stem} (${suffix})${extension}`);
  }
  return candidate;
}

function frameList(contents: WebContents) {
  const frames = contents.mainFrame.framesInSubtree;
  return frames.length > 0 ? frames : [contents.mainFrame];
}

function frameInfo(frame: WebFrameMain, mainFrame: WebFrameMain, index: number) {
  return {
    index,
    url: frame.url,
    name: frame.name || undefined,
    origin: frame.origin,
    mainFrame: frame === mainFrame
  };
}

function mergeSnapshotText(parts: string[], maxLength: number) {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of parts) {
    const normalized = part.replace(/\n{3,}/g, "\n\n").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged.join("\n\n").slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSuccessfulFrameInspection(frame: BrowserFrameInspection): frame is BrowserFrameMeta & { ok: true; snapshot: BrowserToolResult } {
  return frame.ok && isRecord(frame.snapshot);
}

function axPropertyValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isRecord(value)) {
    const nestedValue = value.value;
    if (typeof nestedValue === "string" || typeof nestedValue === "number" || typeof nestedValue === "boolean") {
      return String(nestedValue);
    }
  }
  return "";
}

async function waitForFreshPaint(contents: WebContents) {
  await waitForLoadToStop(contents);
  try {
    return (await contents.executeJavaScript(freshPaintScript(), true)) as BrowserToolResult;
  } catch (error) {
    await delay(180);
    return {
      ok: false,
      reason: "paint-wait-failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function waitForLoadToStop(contents: WebContents) {
  if (!contents.isLoading()) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, 2_000);
    const onStopLoading = () => done();
    const onFailLoad = () => done();
    function done() {
      clearTimeout(timeout);
      contents.off("did-stop-loading", onStopLoading);
      contents.off("did-fail-load", onFailLoad);
      resolve();
    }
    contents.once("did-stop-loading", onStopLoading);
    contents.once("did-fail-load", onFailLoad);
  });
}

async function capturePageWithDebugger(contents: WebContents, captureBeyondViewport = false) {
  const debuggerApi = contents.debugger;
  const wasAttached = debuggerApi.isAttached();
  try {
    if (!wasAttached) {
      debuggerApi.attach("1.3");
    }
    const result = (await Promise.race([
      debuggerApi.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport
      }),
      delay(3_000).then(() => {
        throw new Error("CDP screenshot capture timed out.");
      })
    ])) as BrowserToolResult;
    const data = typeof result.data === "string" ? result.data : "";
    if (!data) {
      return undefined;
    }
    return nativeImage.createFromBuffer(Buffer.from(data, "base64"));
  } catch {
    return undefined;
  } finally {
    if (!wasAttached && debuggerApi.isAttached()) {
      debuggerApi.detach();
    }
  }
}

function freshPaintScript() {
  return `(() => new Promise((resolve) => {
    const startedAt = performance.now();
    const minWaitMs = 500;
    const quietMs = 120;
    const timeoutMs = 1500;
    let lastMutationAt = startedAt;
    let frameCount = 0;
    let completed = false;
    const observer = new MutationObserver(() => {
      lastMutationAt = performance.now();
      frameCount = 0;
    });
    const complete = (reason) => {
      if (completed) {
        return;
      }
      completed = true;
      observer.disconnect();
      clearTimeout(timeout);
      resolve({
        ok: reason === "stable",
        reason,
        elapsedMs: Math.round(performance.now() - startedAt),
        frameCount
      });
    };
    const timeout = setTimeout(() => complete("timeout"), timeoutMs);
    try {
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
    } catch {}
    const scheduleFrame = (callback) => {
      let called = false;
      const finish = () => {
        if (called) {
          return;
        }
        called = true;
        clearTimeout(fallback);
        callback();
      };
      const fallback = setTimeout(finish, 80);
      requestAnimationFrame(finish);
    };
    const tick = () => {
      scheduleFrame(() => {
        frameCount += 1;
        const now = performance.now();
        if (now - startedAt >= minWaitMs && now - lastMutationAt >= quietMs && frameCount >= 3) {
          complete("stable");
          return;
        }
        tick();
      });
    };
    const fonts = document.fonts?.ready && typeof document.fonts.ready.then === "function" ? document.fonts.ready : Promise.resolve();
    fonts.catch(() => undefined).finally(tick);
  }))()`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describePointScript(x: number, y: number) {
  return `(() => {
    const x = ${JSON.stringify(x)};
    const y = ${JSON.stringify(y)};
    const element = document.elementFromPoint(x, y);
    if (!element) {
      return { x, y, element: null };
    }
    const rect = element.getBoundingClientRect();
    const text = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.getAttribute("alt"),
      element.innerText,
      element.textContent,
      element.value
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
    return {
      x,
      y,
      element: {
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        role: element.getAttribute("role") || undefined,
        label: text ? text.slice(0, 180) : undefined,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          centerX: Math.round(rect.x + rect.width / 2),
          centerY: Math.round(rect.y + rect.height / 2)
        }
      }
    };
  })()`;
}

function snapshotScript(maxLength: number) {
  return `(() => {
    const maxLength = ${JSON.stringify(maxLength)};
    const semanticSelector = "h1,h2,h3,h4,h5,h6,a,button,input,textarea,select,label,[role],img,[contenteditable=true],summary";
    const textOf = (element) => [
      element.innerText,
      element.textContent,
      element.value
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
    const attr = (element, name) => element.getAttribute(name) || "";
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof Element)) {
        return false;
      }
      if (element.closest("[hidden], [aria-hidden='true']")) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const queryAllDeep = (root, selector, seen = new Set(), output = []) => {
      if (!root || !root.querySelectorAll) {
        return output;
      }
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          output.push(element);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          queryAllDeep(element.shadowRoot, selector, seen, output);
        }
      }
      return output;
    };
    const collectVisibleText = () => {
      const chunks = [];
      const pushText = (text) => {
        const normalized = normalize(text);
        if (normalized) {
          chunks.push(normalized);
        }
      };
      if (document.body) {
        pushText(document.body.innerText);
      }
      for (const element of queryAllDeep(document, semanticSelector)) {
        if (isVisible(element)) {
          pushText(elementLabel(element));
        }
      }
      return Array.from(new Set(chunks)).join("\\n").slice(0, maxLength);
    };
    const elementLabel = (element) => [
      attr(element, "aria-label"),
      attr(element, "title"),
      attr(element, "placeholder"),
      element.alt || "",
      textOf(element)
    ].find(Boolean) || "";
    const selectorFor = (element) => {
      if (element.id) {
        return "#" + CSS.escape(element.id);
      }
      const parts = [];
      let current = element;
      while (current && current instanceof Element && parts.length < 4) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        const index = sameTag.indexOf(current) + 1;
        parts.unshift(sameTag.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
        current = parent;
      }
      return parts.join(" > ");
    };
    const elements = queryAllDeep(document, semanticSelector)
      .filter(isVisible)
      .slice(0, 220)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          role: attr(element, "role") || undefined,
          id: element.id || undefined,
          selector: selectorFor(element) || undefined,
          label: elementLabel(element).slice(0, 180) || undefined,
          href: element.href || undefined,
          type: attr(element, "type") || undefined,
          name: attr(element, "name") || undefined,
          disabled: element.disabled === true || attr(element, "aria-disabled") === "true" || undefined,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            centerX: Math.round(rect.x + rect.width / 2),
            centerY: Math.round(rect.y + rect.height / 2)
          }
        };
      })
      .filter((element) => element.label || element.href || element.id || element.role);
    return {
      url: location.href,
      title: document.title,
      text: collectVisibleText().replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, maxLength),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      elements
    };
  })()`;
}

function clickScript(target: string) {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const element = findBrowserTarget(target);
    if (!element) {
      return { ok: false, error: "No element matched target", target };
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    element.click();
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return { ok: true, target, matched: describeBrowserTarget(element) };

    ${findTargetHelpers()}
  })()`;
}

function typeScript(target: string, text: string, submit: boolean) {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const text = ${JSON.stringify(text)};
    const submit = ${JSON.stringify(submit)};
    const element = findBrowserTarget(target);
    if (!element) {
      return { ok: false, error: "No element matched target", target };
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    if (element instanceof HTMLSelectElement) {
      const option = Array.from(element.options).find((entry) => entry.value === text || entry.textContent.trim() === text);
      if (!option) {
        return { ok: false, error: "No select option matched text", target };
      }
      element.value = option.value;
    } else if (element.isContentEditable) {
      element.textContent = text;
    } else {
      const descriptor =
        element instanceof HTMLTextAreaElement
          ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
          : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(element, text);
      } else {
        element.value = text;
      }
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit) {
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
      const form = element.closest("form");
      if (form?.requestSubmit) {
        form.requestSubmit();
      } else {
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      }
    }
    return { ok: true, target, matched: describeBrowserTarget(element), submitted: submit };

    ${findTargetHelpers()}
  })()`;
}

function findTargetHelpers() {
  return `
    function normalize(value) {
      return String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    }
    function escapeRegExp(value) {
      return value.replace(/[.*+?^${"{"}()}|[\\]\\\\]/g, "\\\\$&");
    }
    function elementText(element) {
      return normalize([
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("placeholder"),
        element.getAttribute("alt"),
        element.innerText,
        element.textContent,
        element.value
      ].filter(Boolean).join(" "));
    }
    function isBrowserTargetVisible(element) {
      if (!(element instanceof Element)) {
        return false;
      }
      if (element.closest("[hidden], [aria-hidden='true']")) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function resolveBrowserTarget(element) {
      const control = labelControl(element);
      return control && isBrowserTargetVisible(control) ? control : element;
    }
    function queryAllDeep(root, selector, seen = new Set(), output = []) {
      if (!root || !root.querySelectorAll) {
        return output;
      }
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          output.push(element);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          queryAllDeep(element.shadowRoot, selector, seen, output);
        }
      }
      return output;
    }
    function querySelectorDeep(selector) {
      try {
        const direct = document.querySelector(selector);
        if (direct) {
          return direct;
        }
      } catch {
        throw new Error("Invalid selector");
      }
      for (const element of queryAllDeep(document, "*")) {
        if (element.matches?.(selector)) {
          return element;
        }
      }
      return null;
    }
    function visibleBrowserCandidates() {
      const seen = new Set();
      return queryAllDeep(document, "button,a,input,textarea,select,[role],label,[contenteditable=true]")
        .filter(isBrowserTargetVisible)
        .map(resolveBrowserTarget)
        .filter((element) => {
          if (!isBrowserTargetVisible(element) || seen.has(element)) {
            return false;
          }
          seen.add(element);
          return true;
        });
    }
    function hasWholePhrase(text, phrase) {
      if (!phrase) {
        return false;
      }
      const phrasePattern = phrase.split(/\\s+/).filter(Boolean).map(escapeRegExp).join("\\\\s+");
      const pattern = new RegExp("(^|[^a-z0-9])" + phrasePattern + "([^a-z0-9]|$)");
      return pattern.test(text);
    }
    function targetTokens(value) {
      return value.split(/[^a-z0-9]+/).filter(Boolean);
    }
    function hasAllWholeTokens(text, target) {
      const textTokens = new Set(targetTokens(text));
      const tokens = targetTokens(target);
      return tokens.length > 0 && tokens.every((token) => textTokens.has(token));
    }
    function findBrowserTarget(rawTarget) {
      try {
        const selected = resolveBrowserTarget(querySelectorDeep(rawTarget));
        if (selected && isBrowserTargetVisible(selected)) {
          return selected;
        }
      } catch {}
      const normalizedTarget = normalize(rawTarget);
      const candidates = visibleBrowserCandidates();
      const exact = candidates.find((element) => elementText(element) === normalizedTarget);
      if (exact) {
        return exact;
      }
      const wholePhrase = candidates.find((element) => hasWholePhrase(elementText(element), normalizedTarget));
      if (wholePhrase) {
        return wholePhrase;
      }
      const prefix = candidates.find((element) => {
        const text = elementText(element);
        return text.startsWith(normalizedTarget + " ") || text.startsWith(normalizedTarget + ":");
      });
      if (prefix) {
        return prefix;
      }
      const tokenMatch = candidates.find((element) => hasAllWholeTokens(elementText(element), normalizedTarget));
      return tokenMatch || null;
    }
    function labelControl(element) {
      if (!(element instanceof HTMLLabelElement)) {
        return null;
      }
      if (element.control) {
        return element.control;
      }
      return queryAllDeep(element, "input,textarea,select,[contenteditable=true]")[0] || null;
    }
    function describeBrowserTarget(element) {
      const text = elementText(element);
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        label: text ? text.slice(0, 160) : undefined,
        role: element.getAttribute("role") || undefined,
        name: element.getAttribute("name") || undefined
      };
    }
  `;
}
