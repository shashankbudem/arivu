import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserView, BrowserWindow, nativeImage, type WebContents, type WebFrameMain, type WebPreferences } from "electron";
import { appDataDir } from "../../src/config.js";
import {
  normalizeBrowserMode,
  normalizeBrowserUrl,
  type BrowserBounds,
  type BrowserConsoleEntry,
  type BrowserMode,
  type BrowserState,
  type BrowserTargetState,
  type BrowserTaskModelConfig,
  type BrowserToolController,
  type BrowserToolResult
} from "../../src/tools/browserControl.js";
import { runBrowserTask } from "./browserTaskSupervisor.js";
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

const MAX_CONSOLE_LOGS = 300;
// Budget for the serialized element list in snapshot/screenshot results. Without it a busy
// page (e.g. ServiceNow) can push a single tool result past the request auto-compaction
// threshold, which strips native tool protocol and derails tool calling on the next turn.
const MAX_VISUAL_ELEMENTS_JSON_CHARS = 48_000;
const DEFAULT_BACKGROUND_BOUNDS = { width: 1280, height: 800 };
const VISIBLE_CHROME_HEIGHT = 96;
const VISIBLE_START_PAGE_TITLE = "Arivu Browser";
const VISIBLE_START_PAGE_PREFIX = "data:text/html;charset=utf-8,";
const VISIBLE_START_PAGE_MARKER = "arivu-browser-start";
const VISIBLE_SHELL_PAGE_MARKER = "arivu-browser-shell";
const VISIBLE_SHELL_COMMAND_PROTOCOL = "arivu-browser:";
const BROWSER_PARTITION = "persist:arivu-browser";

export class DesktopBrowserController implements BrowserToolController {
  private hostWindow: BrowserWindow | undefined;
  private visibleWindow: BrowserWindow | undefined;
  private backgroundWindow: BrowserWindow | undefined;
  private destroyingVisibleWindow = false;
  private paneOpen = false;
  private defaultMode: BrowserMode = "background";
  private activeMode: BrowserMode = "background";
  private activeVisibleTabId: string | undefined;
  private nextVisibleTabNumber = 1;
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly visibleTabs = new Map<string, BrowserTabRecord>();
  private readonly visibleTabOrder: string[] = [];
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
      background: publicTarget(this.targets.background)
    };
  }

  setPaneOpen(open: boolean) {
    this.paneOpen = open;
    if (open) {
      this.rememberMode("visible");
      const window = this.ensureVisibleWindow();
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

  setVisibleBounds(bounds: BrowserBounds) {
    void bounds;
    return this.getState();
  }

  setVisibleSuppressed(suppressed: boolean) {
    void suppressed;
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
    const { contents } = this.browserContextForMode(target, tabId);
    contents.reload();
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

  async selectTab(args: { tabId: string }): Promise<BrowserToolResult> {
    const target = this.selectVisibleTabById(args.tabId);
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

  async open(args: { url: string; mode?: BrowserMode; tabId?: string; newTab?: boolean }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    this.rememberMode(mode);
    const url = normalizeBrowserUrl(args.url);
    let selectedTabId = args.tabId;
    if (mode === "visible") {
      this.paneOpen = true;
      const window = this.ensureVisibleWindow();
      this.ensureVisibleShellPage(window.webContents);
      this.showVisibleWindow(window);
      if (args.newTab || (!selectedTabId && !this.activeVisibleTab())) {
        selectedTabId = this.createVisibleTab({ activate: true, deferLoad: true }).id;
      }
    }
    const { contents, target } = this.browserContextForMode(mode, selectedTabId);
    target.lastError = undefined;
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
    this.prepareForScreenshot(mode, contents);
    const preInspectPaint = await waitForFreshPaint(contents);
    const visual = (await this.inspectPage(mode, contents, 6_000)) as BrowserToolResult & { viewport?: BrowserViewport };
    this.prepareForScreenshot(mode, contents);
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
    const snapshot = await this.inspectPage(mode, contents, maxLength);
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
    const taskResult = await runBrowserTask(
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
      const target = this.ensureVisibleTab(tabId);
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

  private rememberMode(mode: BrowserMode) {
    this.activeMode = mode;
  }

  private async inspectPage(mode: BrowserMode, contents: WebContents, maxLength: number): Promise<BrowserToolResult> {
    void mode;
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

  private prepareForScreenshot(mode: BrowserMode, contents: WebContents) {
    if (mode === "visible") {
      const window = this.ensureVisibleWindow();
      if (window.isMinimized()) {
        window.restore();
      }
      if (!window.isMaximized()) {
        window.maximize();
      }
      if (!window.isVisible()) {
        window.show();
      }
      window.focus();
    }
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
      backgroundColor: "#11100f",
      autoHideMenuBar: true,
      webPreferences: browserShellWebPreferences()
    });
    this.visibleWindow = window;
    this.configureVisibleShell(window);
    this.ensureVisibleShellPage(window.webContents);
    window.on("show", () => {
      this.paneOpen = true;
      this.attachActiveVisibleView();
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
    contents.on("did-finish-load", () => this.renderVisibleShellState());
  }

  private configureWebContents(mode: BrowserMode, target: BrowserTargetRecord, contents: WebContents) {
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
          backgroundColor: "#11100f",
          webPreferences: browserWebPreferences("visible")
        }
      };
    });
    contents.on("did-create-window", (popupWindow, details) => {
      if (mode === "visible") {
        // Electron's BrowserView-backed createWindow path stalls window.open in current
        // releases. Keep the native child window alive, but register its WebContents as a
        // normal visible target so Arivu can select, inspect, and close it by tab id.
        this.registerVisiblePopupWindow(popupWindow, details.disposition);
      }
    });
    contents.on("will-navigate", (event, url) => {
      if (isVisibleStartPageUrl(url)) {
        return;
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
      this.emitState();
    });
    contents.on("did-navigate", () => {
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
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      if (errorCode === -3) {
        return;
      }
      target.lastError = `${errorDescription} (${errorCode})`;
      target.url = validatedUrl || contents.getURL();
      target.loading = false;
      this.emitState();
    });
    contents.on("console-message", (details) => {
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

  private updateTargetFromContents(mode: BrowserMode, contents: WebContents, target: BrowserTargetRecord) {
    const url = contents.getURL();
    target.url = mode === "visible" && isVisibleStartPageUrl(url) ? "" : url;
    target.title = mode === "visible" && isVisibleStartPageUrl(url) ? VISIBLE_START_PAGE_TITLE : contents.getTitle();
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
      ...result
    };
  }

  private async captureTargetPage(mode: BrowserMode, contents: WebContents) {
    // A visible BrowserView has a reliable native surface once prepareForScreenshot has
    // selected and attached it. CDP Page.captureScreenshot can retain stale compositor tiles
    // after switching away from a native popup window, producing a partly black image even
    // though the page is painted. Prefer the attached surface for visible tabs and keep CDP
    // as the fallback; hidden/background contents still need CDP first.
    if (mode === "visible") {
      const surfaceImage = await contents.capturePage();
      if (!surfaceImage.isEmpty()) {
        return surfaceImage;
      }
    }
    const debuggerImage = await capturePageWithDebugger(contents);
    if (debuggerImage && !debuggerImage.isEmpty()) {
      return debuggerImage;
    }
    return contents.capturePage();
  }

  private publicVisibleTarget(): BrowserTargetState {
    const active = this.activeVisibleTab() ?? this.targets.visible;
    return {
      ...publicTarget(active),
      activeTabId: this.activeVisibleTabId,
      tabs: this.visibleTabOrder
        .map((id) => this.visibleTabs.get(id))
        .filter((tab): tab is BrowserTabRecord => Boolean(tab))
        .map(publicTab)
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

  private createVisibleTab(options: { url?: string; activate?: boolean; deferLoad?: boolean } = {}) {
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
      this.attachActiveVisibleView();
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
    disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other"
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
    this.activeVisibleTabId = tabId;
    this.rememberMode("visible");
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
    if (target.view && window && !window.isDestroyed()) {
      try {
        window.removeBrowserView(target.view);
      } catch {
        // The view may already be detached; closing continues regardless.
      }
    }
    this.visibleTabs.delete(tabId);
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
  }

  private forgetVisiblePopupTab(tabId: string) {
    const target = this.visibleTabs.get(tabId);
    if (!target?.popupWindow) {
      return;
    }
    this.visibleTabs.delete(tabId);
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
  }

  private attachActiveVisibleView() {
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
      active.popupWindow.maximize();
      active.popupWindow.show();
      active.popupWindow.focus();
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
    active.view.webContents.focus();
  }

  private updateVisibleViewLayout() {
    const window = this.visibleWindow;
    const active = this.activeVisibleTab();
    if (!window || window.isDestroyed() || !active?.view) {
      return;
    }
    const [width, height] = window.getContentSize();
    active.view.setBounds({
      x: 0,
      y: VISIBLE_CHROME_HEIGHT,
      width: Math.max(0, width),
      height: Math.max(0, height - VISIBLE_CHROME_HEIGHT)
    });
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
            this.selectVisibleTabById(tabId);
          }
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
      }
    } catch (error) {
      const active = this.activeVisibleTab() ?? this.targets.visible;
      active.lastError = error instanceof Error ? error.message : String(error);
      this.emitState();
    }
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
    const state = this.publicVisibleTarget();
    const script = `window.__ARIVU_BROWSER_APPLY_STATE__?.(${JSON.stringify(state)});`;
    void contents.executeJavaScript(script, true).catch(() => undefined);
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
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function visibleShellPageUrl() {
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(visibleShellPageHtml())}`;
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

function visibleShellPageHtml() {
  return `<!doctype html>
<html lang="en" data-${VISIBLE_SHELL_PAGE_MARKER}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
  <title>${VISIBLE_START_PAGE_TITLE}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11100f;
      --panel: #171716;
      --panel-2: #1f2220;
      --line: #302f2b;
      --text: #f4f0e7;
      --muted: #a7a199;
      --accent: #47c797;
      --accent-strong: #73e0b8;
      --error: #ff8b7f;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      user-select: none;
    }
    .browser-shell {
      height: ${VISIBLE_CHROME_HEIGHT}px;
      display: grid;
      grid-template-rows: 42px 54px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #131615 0%, #101211 100%);
    }
    .tabs {
      min-width: 0;
      display: flex;
      align-items: end;
      gap: 4px;
      padding: 7px 10px 0;
      overflow: hidden;
    }
    .tab {
      min-width: 104px;
      max-width: 230px;
      height: 34px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 24px;
      align-items: center;
      gap: 4px;
      border: 1px solid transparent;
      border-bottom: 0;
      border-radius: 8px 8px 0 0;
      padding: 0 3px 0 11px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .tab.active {
      background: var(--panel);
      border-color: var(--line);
      color: var(--text);
    }
    .tab-title {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 13px;
      font-weight: 650;
    }
    .tab.loading .tab-title::before {
      content: "";
      display: inline-block;
      width: 7px;
      height: 7px;
      margin-right: 7px;
      border-radius: 999px;
      background: var(--accent);
      vertical-align: 1px;
    }
    .tab-close,
    .new-tab,
    .nav-button {
      display: grid;
      place-items: center;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
    }
    .tab-close {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      font-size: 18px;
      line-height: 1;
    }
    .tab-close:hover,
    .new-tab:hover,
    .nav-button:hover:not(:disabled) {
      border-color: var(--line);
      background: var(--panel-2);
      color: var(--text);
    }
    .new-tab {
      width: 32px;
      height: 32px;
      margin-bottom: 2px;
      border-radius: 8px;
      font-size: 22px;
      line-height: 1;
    }
    .controls {
      display: grid;
      grid-template-columns: repeat(3, 34px) minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      padding: 9px 12px 10px;
      background: var(--panel);
    }
    .nav-button {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      font-size: 17px;
    }
    .nav-button svg {
      width: 16px;
      height: 16px;
      display: block;
      stroke: currentColor;
    }
    .nav-button:disabled {
      opacity: 0.34;
      cursor: default;
    }
    form {
      min-width: 0;
    }
    input {
      width: 100%;
      min-width: 0;
      height: 36px;
      border: 1px solid var(--line);
      outline: 0;
      border-radius: 10px;
      padding: 0 13px;
      background: #100f0e;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      user-select: text;
    }
    input::placeholder {
      color: var(--muted);
    }
    input:focus {
      box-shadow: 0 0 0 2px rgba(71, 199, 151, 0.45);
    }
    .error {
      position: fixed;
      right: 12px;
      top: 104px;
      max-width: min(520px, calc(100vw - 24px));
      display: none;
      padding: 10px 12px;
      border: 1px solid rgba(255, 139, 127, 0.45);
      border-radius: 8px;
      background: rgba(36, 18, 17, 0.96);
      color: var(--error);
      font-size: 13px;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.35);
      z-index: 10;
    }
    .error.visible {
      display: block;
    }
    @media (max-width: 720px) {
      .tab {
        min-width: 72px;
        max-width: 160px;
      }
      .controls {
        grid-template-columns: repeat(3, 32px) minmax(0, 1fr);
        gap: 7px;
      }
    }
  </style>
</head>
<body>
  <main class="browser-shell">
    <div class="tabs" id="tabs" role="tablist" aria-label="Browser tabs"></div>
    <div class="controls">
      <button class="nav-button" id="back" type="button" aria-label="Back">&lt;</button>
      <button class="nav-button" id="forward" type="button" aria-label="Forward">&gt;</button>
      <button class="nav-button" id="reload" type="button" aria-label="Reload"></button>
      <form id="address-form" autocomplete="off">
        <input id="address" name="url" type="text" inputmode="url" spellcheck="false" placeholder="Search or enter URL">
      </form>
    </div>
  </main>
  <div class="error" id="error" role="status" aria-live="polite"></div>
  <script>
    let browserState = null;
    const tabs = document.getElementById("tabs");
    const addressForm = document.getElementById("address-form");
    const address = document.getElementById("address");
    const error = document.getElementById("error");
    const back = document.getElementById("back");
    const forward = document.getElementById("forward");
    const reload = document.getElementById("reload");
    const reloadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
    const stopIcon = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';

    window.__ARIVU_BROWSER_APPLY_STATE__ = (state) => {
      browserState = state;
      render(state);
    };

    addressForm.addEventListener("submit", (event) => {
      event.preventDefault();
      hideError();
      const rawValue = address.value.trim();
      if (!rawValue) {
        showError("Enter a URL.");
        address.focus();
        return;
      }
      try {
        const nextUrl = normalizeUrl(rawValue);
        send("navigate", { id: browserState?.activeTabId || "", url: nextUrl });
      } catch {
        showError("Enter a valid URL.");
        address.focus();
      }
    });

    back.addEventListener("click", () => send("back", { id: browserState?.activeTabId || "" }));
    forward.addEventListener("click", () => send("forward", { id: browserState?.activeTabId || "" }));
    reload.addEventListener("click", () => send(browserState?.loading ? "stop" : "reload", { id: browserState?.activeTabId || "" }));

    function render(state) {
      const tabItems = Array.isArray(state.tabs) ? state.tabs : [];
      tabs.textContent = "";
      for (const tab of tabItems) {
        const tabButton = document.createElement("button");
        tabButton.type = "button";
        tabButton.className = ["tab", tab.id === state.activeTabId ? "active" : "", tab.loading ? "loading" : ""].filter(Boolean).join(" ");
        tabButton.setAttribute("role", "tab");
        tabButton.setAttribute("aria-selected", tab.id === state.activeTabId ? "true" : "false");
        tabButton.title = tab.title || tab.url || "New tab";
        tabButton.addEventListener("click", () => send("select-tab", { id: tab.id }));
        const title = document.createElement("span");
        title.className = "tab-title";
        title.textContent = tab.title || hostLabel(tab.url) || "New tab";
        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab-close";
        close.setAttribute("aria-label", "Close tab");
        close.textContent = "x";
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          send("close-tab", { id: tab.id });
        });
        tabButton.append(title, close);
        tabs.append(tabButton);
      }
      const newTab = document.createElement("button");
      newTab.type = "button";
      newTab.className = "new-tab";
      newTab.setAttribute("aria-label", "New tab");
      newTab.textContent = "+";
      newTab.addEventListener("click", () => send("new-tab"));
      tabs.append(newTab);
      if (document.activeElement !== address) {
        address.value = state.url || "";
      }
      back.disabled = !state.canGoBack;
      forward.disabled = !state.canGoForward;
      reload.innerHTML = state.loading ? stopIcon : reloadIcon;
      reload.setAttribute("aria-label", state.loading ? "Stop" : "Reload");
      reload.title = state.loading ? "Stop" : "Reload";
      if (state.lastError) {
        showError(state.lastError);
      } else {
        hideError();
      }
    }

    function send(action, params = {}) {
      const url = new URL("arivu-browser://" + action);
      for (const [key, value] of Object.entries(params)) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
      window.location.href = url.href;
    }

    function showError(message) {
      error.textContent = message;
      error.classList.add("visible");
    }

    function hideError() {
      error.textContent = "";
      error.classList.remove("visible");
    }

    function hostLabel(value) {
      if (!value) {
        return "";
      }
      try {
        return new URL(value).hostname || value;
      } catch {
        return value;
      }
    }

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

function visibleStartPageUrl() {
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(visibleStartPageHtml())}`;
}

function isVisibleStartPageUrl(url: string) {
  return url === visibleStartPageUrl();
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
      --bg: #11100f;
      --panel: #171716;
      --line: #302f2b;
      --text: #f4f0e7;
      --muted: #a7a199;
      --accent: #47c797;
      --accent-strong: #73e0b8;
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
      background: linear-gradient(180deg, #11100f 0%, #101315 100%);
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
      background: #100f0e;
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
      color: #07100c;
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
    logs: []
  };
}

function publicTarget(target: BrowserTargetRecord): BrowserTargetState {
  return {
    id: target.id,
    mode: target.mode,
    url: target.url,
    title: target.title,
    loading: target.loading,
    canGoBack: target.canGoBack,
    canGoForward: target.canGoForward,
    ...(target.lastError ? { lastError: target.lastError } : {}),
    ...(target.lastSnapshotAt ? { lastSnapshotAt: target.lastSnapshotAt } : {}),
    ...(target.lastScreenshotAt ? { lastScreenshotAt: target.lastScreenshotAt } : {}),
    ...(target.lastScreenshotPath ? { lastScreenshotPath: target.lastScreenshotPath } : {})
  };
}

function publicTab(target: BrowserTabRecord) {
  return {
    id: target.id,
    url: target.url,
    title: target.title,
    loading: target.loading,
    canGoBack: target.canGoBack,
    canGoForward: target.canGoForward,
    ...(target.lastError ? { lastError: target.lastError } : {}),
    ...(target.lastSnapshotAt ? { lastSnapshotAt: target.lastSnapshotAt } : {}),
    ...(target.lastScreenshotAt ? { lastScreenshotAt: target.lastScreenshotAt } : {}),
    ...(target.lastScreenshotPath ? { lastScreenshotPath: target.lastScreenshotPath } : {})
  };
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

async function capturePageWithDebugger(contents: WebContents) {
  const debuggerApi = contents.debugger;
  const wasAttached = debuggerApi.isAttached();
  try {
    if (!wasAttached) {
      debuggerApi.attach("1.3");
    }
    const result = (await debuggerApi.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    })) as BrowserToolResult;
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
