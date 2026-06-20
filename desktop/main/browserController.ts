import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, type WebContents, type WebPreferences } from "electron";
import {
  normalizeBrowserMode,
  normalizeBrowserUrl,
  type BrowserBounds,
  type BrowserConsoleEntry,
  type BrowserMode,
  type BrowserState,
  type BrowserTargetState,
  type BrowserToolController,
  type BrowserToolResult
} from "../../src/tools/browserControl.js";

type BrowserStateListener = (state: BrowserState) => void;

type BrowserTargetRecord = BrowserTargetState & {
  logs: BrowserConsoleEntry[];
};

const MAX_CONSOLE_LOGS = 300;
const DEFAULT_BACKGROUND_BOUNDS = { width: 1280, height: 800 };
const VISIBLE_START_PAGE_TITLE = "Arivu Browser";
const VISIBLE_START_PAGE_PREFIX = "data:text/html;charset=utf-8,";
const VISIBLE_START_PAGE_MARKER = "arivu-browser-start";

export class DesktopBrowserController implements BrowserToolController {
  private hostWindow: BrowserWindow | undefined;
  private visibleWindow: BrowserWindow | undefined;
  private backgroundWindow: BrowserWindow | undefined;
  private destroyingVisibleWindow = false;
  private paneOpen = false;
  private defaultMode: BrowserMode = "background";
  private readonly listeners = new Set<BrowserStateListener>();
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
      visible: publicTarget(this.targets.visible),
      background: publicTarget(this.targets.background)
    };
  }

  setPaneOpen(open: boolean) {
    this.paneOpen = open;
    if (open) {
      const window = this.ensureVisibleWindow();
      const waitingForStartPage = this.ensureVisibleStartPage(window.webContents);
      if (waitingForStartPage) {
        const showWhenReady = () => this.showVisibleWindow(window);
        window.webContents.once("did-finish-load", showWhenReady);
        window.webContents.once("did-fail-load", showWhenReady);
      } else {
        this.showVisibleWindow(window);
      }
    } else if (this.visibleWindow && !this.visibleWindow.isDestroyed()) {
      this.visibleWindow.hide();
    }
    this.emitState();
    return this.getState();
  }

  setDefaultMode(mode: BrowserMode) {
    this.defaultMode = mode;
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

  goBack(mode?: BrowserMode) {
    const target = this.targetForMode(mode);
    const contents = this.webContentsForMode(target);
    if (contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    }
    return this.getState();
  }

  goForward(mode?: BrowserMode) {
    const target = this.targetForMode(mode);
    const contents = this.webContentsForMode(target);
    if (contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
    return this.getState();
  }

  reload(mode?: BrowserMode) {
    const target = this.targetForMode(mode);
    const contents = this.webContentsForMode(target);
    contents.reload();
    return this.getState();
  }

  stop(mode?: BrowserMode) {
    const target = this.targetForMode(mode);
    const contents = this.webContentsForMode(target);
    if (contents.isLoading()) {
      contents.stop();
    }
    return this.getState();
  }

  async open(args: { url: string; mode?: BrowserMode }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    const url = normalizeBrowserUrl(args.url);
    if (mode === "visible") {
      this.setPaneOpen(true);
    }
    const contents = this.webContentsForMode(mode);
    this.targets[mode].lastError = undefined;
    await contents.loadURL(url);
    this.updateTargetFromContents(mode, contents);
    this.emitState();
    return this.resultForMode(mode, { url: contents.getURL(), title: contents.getTitle() });
  }

  async screenshot(args: { mode?: BrowserMode }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    const contents = this.webContentsForMode(mode);
    assertPageLoaded(contents, mode);
    const image = await this.captureTargetPage(mode, contents);
    const screenshotPath = path.join(os.tmpdir(), `arivu-browser-${mode}-${Date.now()}.png`);
    await writeFile(screenshotPath, image.toPNG());
    this.targets[mode].lastScreenshotPath = screenshotPath;
    this.emitState();
    return this.resultForMode(mode, {
      screenshotPath,
      size: image.getSize()
    });
  }

  async snapshot(args: { mode?: BrowserMode; maxLength?: number }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    const contents = this.webContentsForMode(mode);
    assertPageLoaded(contents, mode);
    const maxLength = clampNumber(args.maxLength ?? 12_000, 1_000, 20_000);
    const snapshot = (await contents.executeJavaScript(snapshotScript(maxLength), true)) as unknown;
    return this.resultForMode(mode, { snapshot });
  }

  async console(args: { mode?: BrowserMode; levels?: string[]; limit?: number }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    const allowedLevels = new Set((args.levels ?? []).map((level) => level.toLowerCase()));
    const limit = clampNumber(args.limit ?? 50, 1, 100);
    const logs = this.targets[mode].logs
      .filter((entry) => allowedLevels.size === 0 || allowedLevels.has(entry.level))
      .slice(-limit);
    return this.resultForMode(mode, { logs });
  }

  async click(args: { target: string; mode?: BrowserMode }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    const contents = this.webContentsForMode(mode);
    assertPageLoaded(contents, mode);
    const result = (await contents.executeJavaScript(clickScript(args.target), true)) as BrowserToolResult;
    this.updateTargetFromContents(mode, contents);
    this.emitState();
    return this.resultForMode(mode, result);
  }

  async type(args: { target: string; text: string; mode?: BrowserMode; submit?: boolean }): Promise<BrowserToolResult> {
    const mode = this.targetForMode(args.mode);
    const contents = this.webContentsForMode(mode);
    assertPageLoaded(contents, mode);
    const result = (await contents.executeJavaScript(typeScript(args.target, args.text, Boolean(args.submit)), true)) as BrowserToolResult;
    this.updateTargetFromContents(mode, contents);
    this.emitState();
    return this.resultForMode(mode, result);
  }

  private targetForMode(mode: BrowserMode | undefined) {
    return normalizeBrowserMode(mode) ?? this.defaultMode;
  }

  private webContentsForMode(mode: BrowserMode) {
    if (mode === "visible") {
      return this.ensureVisibleWindow().webContents;
    }
    return this.ensureBackgroundWindow().webContents;
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
      webPreferences: browserWebPreferences("visible")
    });
    this.visibleWindow = window;
    this.configureWebContents("visible", window.webContents);
    this.ensureVisibleStartPage(window.webContents);
    window.on("show", () => {
      this.paneOpen = true;
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
    window.on("closed", () => {
      this.visibleWindow = undefined;
      this.targets.visible = initialTarget("visible");
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
    this.configureWebContents("background", window.webContents);
    window.on("closed", () => {
      this.backgroundWindow = undefined;
      this.targets.background = initialTarget("background");
      this.emitState();
    });
    return window;
  }

  private configureWebContents(mode: BrowserMode, contents: WebContents) {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (isVisibleStartPageUrl(url)) {
        return;
      }
      try {
        normalizeBrowserUrl(url);
      } catch (error) {
        event.preventDefault();
        this.targets[mode].lastError = error instanceof Error ? error.message : String(error);
        this.emitState();
      }
    });
    contents.on("did-start-loading", () => {
      this.targets[mode].loading = true;
      this.emitState();
    });
    contents.on("did-stop-loading", () => {
      this.updateTargetFromContents(mode, contents);
      this.emitState();
    });
    contents.on("did-navigate", () => {
      this.updateTargetFromContents(mode, contents);
      this.emitState();
    });
    contents.on("did-navigate-in-page", () => {
      this.updateTargetFromContents(mode, contents);
      this.emitState();
    });
    contents.on("page-title-updated", () => {
      this.updateTargetFromContents(mode, contents);
      this.emitState();
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      if (errorCode === -3) {
        return;
      }
      this.targets[mode].lastError = `${errorDescription} (${errorCode})`;
      this.targets[mode].url = validatedUrl || contents.getURL();
      this.targets[mode].loading = false;
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
      this.targets[mode].logs = [...this.targets[mode].logs, entry].slice(-MAX_CONSOLE_LOGS);
      this.emitState();
    });
  }

  private updateTargetFromContents(mode: BrowserMode, contents: WebContents) {
    const target = this.targets[mode];
    const url = contents.getURL();
    target.url = mode === "visible" && isVisibleStartPageUrl(url) ? "" : url;
    target.title = mode === "visible" && isVisibleStartPageUrl(url) ? VISIBLE_START_PAGE_TITLE : contents.getTitle();
    target.loading = contents.isLoading();
    target.canGoBack = contents.navigationHistory.canGoBack();
    target.canGoForward = contents.navigationHistory.canGoForward();
  }

  private resultForMode(mode: BrowserMode, result: BrowserToolResult): BrowserToolResult {
    const target = this.targets[mode];
    return {
      mode,
      url: target.url,
      title: target.title,
      loading: target.loading,
      ...result
    };
  }

  private async captureTargetPage(mode: BrowserMode, contents: WebContents) {
    void mode;
    return contents.capturePage();
  }

  private ensureVisibleStartPage(contents: WebContents) {
    const url = contents.getURL();
    if (isVisibleStartPageUrl(url)) {
      return contents.isLoading();
    }
    if (url) {
      return false;
    }
    if (contents.isLoading()) {
      return true;
    }
    void contents.loadURL(visibleStartPageUrl()).catch((error: unknown) => {
      this.targets.visible.lastError = error instanceof Error ? error.message : String(error);
      this.emitState();
    });
    return true;
  }

  private showVisibleWindow(window: BrowserWindow) {
    if (!this.paneOpen || window.isDestroyed()) {
      return;
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
    for (const listener of this.listeners) {
      listener(state);
    }
  }
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
      <input id="url-input" name="url" type="text" inputmode="url" spellcheck="false" placeholder="https://example.com or localhost:5173" autofocus>
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
      return assertAllowedUrl("https://" + value).href;
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

function initialTarget(mode: BrowserMode): BrowserTargetRecord {
  return {
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
    mode: target.mode,
    url: target.url,
    title: target.title,
    loading: target.loading,
    canGoBack: target.canGoBack,
    canGoForward: target.canGoForward,
    ...(target.lastError ? { lastError: target.lastError } : {}),
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
    partition: `arivu-browser-${mode}`
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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function snapshotScript(maxLength: number) {
  return `(() => {
    const maxLength = ${JSON.stringify(maxLength)};
    const textOf = (element) => (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
    const attr = (element, name) => element.getAttribute(name) || "";
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
    const elementLabel = (element) => [
      attr(element, "aria-label"),
      attr(element, "title"),
      attr(element, "placeholder"),
      element.alt || "",
      textOf(element)
    ].find(Boolean) || "";
    const elements = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,a,button,input,textarea,select,[role],img"))
      .filter(isVisible)
      .slice(0, 220)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: attr(element, "role") || undefined,
        id: element.id || undefined,
        label: elementLabel(element).slice(0, 180) || undefined,
        href: element.href || undefined,
        type: attr(element, "type") || undefined,
        name: attr(element, "name") || undefined
      }))
      .filter((element) => element.label || element.href || element.id || element.role);
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, maxLength),
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
    function visibleBrowserCandidates() {
      const seen = new Set();
      return Array.from(document.querySelectorAll("button,a,input,textarea,select,[role],label,[contenteditable=true]"))
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
        const selected = resolveBrowserTarget(document.querySelector(rawTarget));
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
      return element.querySelector("input,textarea,select,[contenteditable=true]");
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
