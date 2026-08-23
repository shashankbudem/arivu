import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  normalizeBrowserMode,
  normalizeBrowserUrl,
  type BrowserConsoleEntry,
  type BrowserMode,
  type BrowserState,
  type BrowserTabState,
  type BrowserTargetState,
  type BrowserToolController,
  type BrowserToolResult
} from "../tools/browserControl.js";

const RESULT_SENTINEL = "__ARIVU_BROWSER_USE_JSON__";
const DEFAULT_TEMP_PREFIX = "arivu-browser-use-";

export type BrowserUseCliRunRequest = {
  script: string;
  env: Record<string, string>;
};

export type BrowserUseCliRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type BrowserUseCliRunner = (request: BrowserUseCliRunRequest) => Promise<BrowserUseCliRunResult>;

export type BrowserUseCliControllerOptions = {
  /** The Arivu chat/session id. It is converted into a stable Browser Use daemon name. */
  sessionId: string;
  runner?: BrowserUseCliRunner;
  tempDirectory?: string;
};

type IndexedElement = {
  index: number;
  role: string;
  name: string;
  value?: string;
  x: number;
  y: number;
};

type BrowserUsePage = {
  url?: string;
  title?: string;
  w?: number;
  h?: number;
};

/**
 * A direct Browser Use browser-harness adapter for terminal hosts. Browser Use is used only
 * for CDP primitives; Arivu remains responsible for model calls, task looping, and policy.
 */
export class BrowserUseCliController implements BrowserToolController {
  readonly sessionName: string;
  private readonly runner: BrowserUseCliRunner;
  private readonly tempDirectory: string;
  // Browser Use controls an external Chrome target. Default to visible semantics so the
  // registry never silently repurposes the user's active tab as a hidden browser.
  private defaultMode: BrowserMode = "visible";
  private activeMode: BrowserMode = "visible";
  private activeTabId: string | undefined;
  private tabs: BrowserTabState[] = [];
  private page: BrowserUsePage = {};
  private indexedElements = new Map<number, IndexedElement>();
  private lastScreenshot: { path: string; width: number; height: number; viewportWidth: number; viewportHeight: number } | undefined;

  constructor(options: BrowserUseCliControllerOptions) {
    this.sessionName = browserUseSessionName(options.sessionId);
    this.runner = options.runner ?? runBrowserUseCli;
    this.tempDirectory = options.tempDirectory ?? os.tmpdir();
  }

  getState(): BrowserState {
    return {
      // browser-harness drives an external Chrome session. There is no TUI-owned pane.
      paneOpen: false,
      defaultMode: this.defaultMode,
      activeMode: this.activeMode,
      visible: this.targetState("visible"),
      background: this.targetState("background")
    };
  }

  async selectTab(args: { tabId: string }): Promise<BrowserToolResult> {
    const tab =
      this.tabs.find((candidate) => candidate.id === args.tabId) ??
      (await this.refreshState()).tabs?.find((candidate) => candidate.id === args.tabId);
    if (!tab) {
      throw new Error(`Unknown Browser Use tab: ${args.tabId}. Run browser_snapshot or browser_open first to refresh tabs.`);
    }
    const targetId = this.targetIdForTab(tab);
    if (!targetId) {
      throw new Error(`Browser Use tab ${args.tabId} has no CDP target id.`);
    }
    const payload = await this.invoke(
      `switch_tab(${python(targetId)})\n_arivu_emit({"tab": current_tab(), "page": page_info(), "tabs": list_tabs()})`
    );
    this.applyState(payload);
    this.activeTabId = args.tabId;
    return this.result({ tabId: args.tabId, activeTabId: args.tabId });
  }

  async open(args: {
    url: string;
    mode?: BrowserMode;
    tabId?: string;
    newTab?: boolean;
    source?: "user" | "agent";
  }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    const url = normalizeBrowserUrl(args.url);
    if (args.tabId) {
      await this.selectTab({ tabId: args.tabId });
    }
    // Agent navigation without a selected tab must preserve the user's current Chrome tab.
    const newTab = Boolean(args.newTab || (args.source === "agent" && !args.tabId));
    const navigate = newTab ? `new_tab(${python(url)})` : `ensure_real_tab()\ngoto_url(${python(url)})`;
    const payload = await this.invoke(
      `${navigate}\nwait_for_load()\n_arivu_emit({"page": page_info(), "currentTab": current_tab(), "tabs": list_tabs()})`
    );
    this.applyState(payload);
    this.activeMode = mode;
    return this.result({ url: this.page.url ?? url, title: this.page.title ?? "", newTab }, mode);
  }

  async screenshot(args: { mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    const directory = await mkdtemp(path.join(this.tempDirectory, DEFAULT_TEMP_PREFIX));
    const screenshotPath = path.join(directory, "viewport.png");
    const payload = await this.invoke(
      `from PIL import Image\n_path = capture_screenshot(${python(screenshotPath)})\n_page = page_info()\n_size = Image.open(_path).size\n_arivu_emit({"screenshotPath": _path, "size": {"width": _size[0], "height": _size[1]}, "page": _page, "tabs": list_tabs(), "currentTab": current_tab()})`
    );
    this.applyState(payload);
    const size = object(payload.size);
    const width = number(size.width) ?? number(this.page.w) ?? 0;
    const height = number(size.height) ?? number(this.page.h) ?? 0;
    const viewportWidth = number(this.page.w) ?? width;
    const viewportHeight = number(this.page.h) ?? height;
    this.lastScreenshot = { path: screenshotPath, width, height, viewportWidth, viewportHeight };
    return this.result({ screenshotPath, size: { width, height }, viewport: { width: viewportWidth, height: viewportHeight } }, mode);
  }

  async snapshot(args: { mode?: BrowserMode; tabId?: string; maxLength?: number }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    const maxLength = clamp(args.maxLength ?? 12_000, 1_000, 20_000);
    const payload = await this.invoke(snapshotScript(maxLength));
    this.applyState(payload);
    return this.result(
      {
        snapshot: {
          url: this.page.url ?? "",
          title: this.page.title ?? "",
          text: string(payload.text),
          elements: [...this.indexedElements.values()],
          viewport: { width: number(this.page.w) ?? 0, height: number(this.page.h) ?? 0 },
          diagnostics: { elementCount: this.indexedElements.size, note: "Element indexes are valid until the next browser snapshot." }
        }
      },
      mode
    );
  }

  async console(args: { mode?: BrowserMode; tabId?: string; levels?: string[]; limit?: number }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    // Browser-harness does not retain console history between direct calls. Returning an
    // explicit empty list is more honest than pretending a fresh CDP subscription is history.
    const logs: BrowserConsoleEntry[] = [];
    return this.result({ logs, note: "Browser Use CLI does not expose historical console entries for a persistent session." }, mode);
  }

  async click(args: { target?: string; index?: number; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    const point = args.index === undefined ? undefined : this.indexedElements.get(args.index);
    if (args.index !== undefined && !point) {
      throw new Error(`Unknown browser element index ${args.index}. Run browser_snapshot and use one of its current element indexes.`);
    }
    const payload = point
      ? await this.invoke(
          `click_at_xy(${point.x}, ${point.y})\n_arivu_emit({"ok": True, "matched": ${python(point)}, "page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`
        )
      : await this.invoke(findAndClickScript(args.target ?? ""));
    this.applyState(payload);
    return this.result(
      { ok: payload.ok !== false, ...(point ? { index: point.index, matched: point } : { target: args.target ?? "" }) },
      mode
    );
  }

  async clickAt(args: {
    x: number;
    y: number;
    mode?: BrowserMode;
    tabId?: string;
    coordinateSpace?: "css" | "image";
  }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
      throw new Error("Click coordinates must be finite numbers.");
    }
    const requestedSpace = args.coordinateSpace ?? "css";
    const point = this.resolvePoint(args.x, args.y, requestedSpace);
    const payload = await this.invoke(
      `click_at_xy(${point.x}, ${point.y})\n_arivu_emit({"ok": True, "page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`
    );
    this.applyState(payload);
    return this.result(
      { ok: true, x: point.x, y: point.y, coordinateSpace: "css", requested: { x: args.x, y: args.y, coordinateSpace: requestedSpace } },
      mode
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
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    const point = args.index === undefined ? undefined : this.indexedElements.get(args.index);
    if (args.index !== undefined && !point) {
      throw new Error(`Unknown browser element index ${args.index}. Run browser_snapshot and use one of its current element indexes.`);
    }
    const script = point
      ? `click_at_xy(${point.x}, ${point.y})\ntype_text(${python(args.text)})`
      : findAndTypeScript(args.target ?? "", args.text);
    const payload = await this.invoke(
      `${script}\n${args.submit ? 'press_key("Enter")\n' : ""}_arivu_emit({"ok": True, "page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`
    );
    this.applyState(payload);
    return this.result(
      { ok: true, ...(point ? { index: point.index } : { target: args.target ?? "" }), submit: Boolean(args.submit) },
      mode
    );
  }

  async keypress(args: { key: string; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    const payload = await this.invoke(
      `press_key(${python(args.key)})\n_arivu_emit({"ok": True, "page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`
    );
    this.applyState(payload);
    return this.result({ ok: true, key: args.key }, mode);
  }

  async scroll(args: {
    direction: "up" | "down" | "left" | "right";
    pixels?: number;
    numPages?: number;
    index?: number;
    mode?: BrowserMode;
    tabId?: string;
  }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    const distance = Math.max(1, Math.round(args.pixels ?? (args.numPages ?? 1) * 600));
    const dx = args.direction === "left" ? -distance : args.direction === "right" ? distance : 0;
    const dy = args.direction === "up" ? -distance : args.direction === "down" ? distance : 0;
    const payload = await this.invoke(
      `_page = page_info()\nscroll((_page.get("w") or 1) / 2, (_page.get("h") or 1) / 2, dx=${dx}, dy=${dy})\n_arivu_emit({"ok": True, "page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`
    );
    this.applyState(payload);
    return this.result({ ok: true, direction: args.direction, pixels: distance }, mode);
  }

  async selectOption(args: { index: number; optionText: string; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    const point = this.indexedElements.get(args.index);
    if (!point) {
      throw new Error(`Unknown browser element index ${args.index}. Run browser_snapshot and use one of its current element indexes.`);
    }
    const payload = await this.invoke(selectAtPointScript(point, args.optionText));
    this.applyState(payload);
    if (payload.ok === false) {
      throw new Error(string(payload.error) || `Could not select ${args.optionText}.`);
    }
    return this.result({ ok: true, index: args.index, optionText: args.optionText }, mode);
  }

  async executeJavaScript(args: { script: string; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult> {
    const mode = this.mode(args.mode);
    await this.selectOptionalTab(args.tabId);
    const payload = await this.invoke(
      `_result = js(${python(args.script)})\n_arivu_emit({"ok": True, "result": _result, "page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`
    );
    this.applyState(payload);
    return this.result({ ok: true, result: payload.result }, mode);
  }

  async task(_args: Parameters<BrowserToolController["task"]>[0]): Promise<BrowserToolResult> {
    throw new Error(
      "browser_task is unavailable in TUI/CLI Browser Use sessions. This backend exposes direct browser primitives only; it never starts Browser Use's autonomous Agent."
    );
  }

  private mode(requested: BrowserMode | undefined) {
    const mode = normalizeBrowserMode(requested) ?? this.activeMode ?? this.defaultMode;
    this.activeMode = mode;
    return mode;
  }

  private async selectOptionalTab(tabId: string | undefined) {
    if (tabId) {
      await this.selectTab({ tabId });
    }
  }

  private async refreshState() {
    const payload = await this.invoke(stateScript());
    this.applyState(payload);
    return { tabs: this.tabs };
  }

  private async invoke(body: string): Promise<Record<string, unknown>> {
    let result: BrowserUseCliRunResult;
    try {
      result = await this.runner({ script: envelope(body), env: { BU_NAME: this.sessionName } });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "ENOENT") {
        throw new Error(
          "Browser Use CLI is unavailable. Install the browser-harness `browser-use` command, then run `browser-use --doctor`."
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    const payload = parseBrowserUseOutput(result.stdout);
    if (!payload) {
      const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      if (result.exitCode !== 0) {
        throw new Error(
          `Browser Use CLI failed (exit ${result.exitCode}). ${details || "Run `browser-use --doctor` to diagnose the browser connection."}`
        );
      }
      throw new Error(
        "Browser Use CLI returned no Arivu JSON result. Check that the installed browser-harness CLI supports heredoc helper execution."
      );
    }
    if (payload.ok === false) {
      throw new Error(string(payload.error) || "Browser Use browser action failed.");
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Browser Use CLI failed (exit ${result.exitCode}). ${result.stderr || "Run `browser-use --doctor` to diagnose the browser connection."}`
      );
    }
    return payload;
  }

  private applyState(payload: Record<string, unknown>) {
    const page = object(payload.page);
    this.page = { url: string(page.url), title: string(page.title), w: number(page.w), h: number(page.h) };
    const current = object(payload.currentTab);
    const currentId = string(current.targetId) || string(current.target_id);
    const rawTabs = Array.isArray(payload.tabs) ? payload.tabs.map(object) : [];
    this.tabs = rawTabs.map((tab, index) => {
      const targetId = string(tab.targetId) || string(tab.target_id);
      return {
        id: tabId(targetId, index),
        url: string(tab.url),
        title: string(tab.title),
        loading: false,
        canGoBack: false,
        canGoForward: false,
        ...(targetId ? { owner: "agent" as const } : {})
      };
    });
    this.activeTabId = this.tabs.find((tab, index) => tab.id === tabId(currentId, index))?.id ?? this.activeTabId ?? this.tabs[0]?.id;
    if (Array.isArray(payload.elements)) {
      const elements = payload.elements.map(object);
      const indexed: IndexedElement[] = [];
      for (const element of elements) {
        const index = number(element.index);
        const x = number(element.x);
        const y = number(element.y);
        if (index === undefined || x === undefined || y === undefined) continue;
        const value = string(element.value) || undefined;
        indexed.push({ index, role: string(element.role), name: string(element.name), ...(value ? { value } : {}), x, y });
      }
      this.indexedElements = new Map(indexed.map((element) => [element.index, element]));
    }
  }

  private targetState(mode: BrowserMode): BrowserTargetState {
    const active = this.tabs.find((tab) => tab.id === this.activeTabId) ?? this.tabs[0];
    return {
      id: active?.id ?? `browser-use-${mode}`,
      mode,
      url: active?.url ?? this.page.url ?? "",
      title: active?.title ?? this.page.title ?? "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      activeTabId: this.activeTabId,
      agentTargetTabId: this.activeTabId,
      tabs: this.tabs
    };
  }

  private targetIdForTab(tab: BrowserTabState) {
    const prefix = "browser-use-tab-";
    return tab.id.startsWith(prefix) ? tab.id.slice(prefix.length) : undefined;
  }

  private resolvePoint(x: number, y: number, coordinateSpace: "css" | "image") {
    if (coordinateSpace === "css") {
      return { x, y };
    }
    const screenshot = this.lastScreenshot;
    if (!screenshot || screenshot.width <= 0 || screenshot.height <= 0) {
      throw new Error("Image coordinate clicks require a previous browser_screenshot result for this Browser Use session.");
    }
    return { x: (x / screenshot.width) * screenshot.viewportWidth, y: (y / screenshot.height) * screenshot.viewportHeight };
  }

  private result(result: BrowserToolResult, mode = this.activeMode): BrowserToolResult {
    const active = this.tabs.find((tab) => tab.id === this.activeTabId) ?? this.tabs[0];
    return {
      mode,
      tabId: active?.id,
      activeTabId: this.activeTabId,
      url: active?.url ?? this.page.url ?? "",
      title: active?.title ?? this.page.title ?? "",
      ...result
    };
  }
}

export function browserUseSessionName(sessionId: string) {
  // browser-harness includes BU_NAME in a macOS Unix socket path. Keep this deliberately
  // compact so a long workspace or temporary-directory prefix cannot exceed AF_UNIX limits.
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `arivu-${digest}`;
}

export function parseBrowserUseOutput(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .reverse()
    .find((candidate) => candidate.startsWith(RESULT_SENTINEL));
  if (!line) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(RESULT_SENTINEL.length));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function runBrowserUseCli(request: BrowserUseCliRunRequest): Promise<BrowserUseCliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("browser-use", [], { env: { ...process.env, ...request.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    child.stdin.end(request.script);
  });
}

function envelope(body: string) {
  return `import json\ndef _arivu_emit(value):\n    print(${python(RESULT_SENTINEL)} + json.dumps(value, default=str))\ntry:\n${indent(body)}\nexcept Exception as exc:\n    _arivu_emit({"ok": False, "error": str(exc), "errorType": type(exc).__name__})\n`;
}

function snapshotScript(maxLength: number) {
  return `ensure_real_tab()\n_page = page_info()\n_ax = cdp("Accessibility.getFullAXTree").get("nodes", [])\n_elements = []\nfor _node in _ax:\n    _role = ((_node.get("role") or {}).get("value") or "")\n    _name = ((_node.get("name") or {}).get("value") or "")\n    _backend = _node.get("backendDOMNodeId")\n    if not _backend or not _role or _role in ("generic", "none", "ignored") or not _name:\n        continue\n    try:\n        _quad = cdp("DOM.getBoxModel", backendNodeId=_backend)["model"]["content"]\n        _x = sum(_quad[0::2]) / 4\n        _y = sum(_quad[1::2]) / 4\n        if _x < 0 or _y < 0 or _x > (_page.get("w") or 0) or _y > (_page.get("h") or 0):\n            continue\n        _elements.append({"index": len(_elements), "role": str(_role), "name": str(_name), "x": _x, "y": _y})\n    except Exception:\n        pass\n    if len(_elements) >= 300:\n        break\n_text = js("(document.body && document.body.innerText) || ''") or ""\n_arivu_emit({"page": _page, "text": str(_text)[:${maxLength}], "elements": _elements, "tabs": list_tabs(), "currentTab": current_tab()})`;
}

function stateScript() {
  return `ensure_real_tab()\n_arivu_emit({"page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`;
}

function findAndClickScript(target: string) {
  return `
_target = ${python(target)}
_point = js("""(() => {
  const query = ${JSON.stringify(target)}.trim();
  let node;
  try { node = document.querySelector(query); } catch {}
  if (!node) node = [...document.querySelectorAll('button,a,input,select,textarea,[role="button"],[aria-label]')]
    .find((item) => [item.innerText, item.textContent, item.getAttribute('aria-label'), item.value].some((value) => String(value || '').trim() === query));
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, tag: node.tagName, text: (node.innerText || node.getAttribute('aria-label') || node.value || '').trim() };
})()""")
if not _point:
    raise RuntimeError(f"No browser element matched {_target!r}. Run browser_snapshot and use an element index.")
click_at_xy(_point["x"], _point["y"])
_arivu_emit({"ok": True, "matched": _point, "page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`;
}

function findAndTypeScript(target: string, text: string) {
  return `
_target = ${python(target)}
_point = js("""(() => {
  const query = ${JSON.stringify(target)}.trim();
  let node;
  try { node = document.querySelector(query); } catch {}
  if (!node) node = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[aria-label]')]
    .find((item) => [item.getAttribute('aria-label'), item.placeholder, item.name, item.id].some((value) => String(value || '').trim() === query));
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
})()""")
if not _point:
    raise RuntimeError(f"No browser input matched {_target!r}. Run browser_snapshot and use an element index.")
click_at_xy(_point["x"], _point["y"])
type_text(${python(text)})`;
}

function selectAtPointScript(point: IndexedElement, optionText: string) {
  return `
_outcome = js("""(() => {
  const node = document.elementFromPoint(${point.x}, ${point.y});
  const select = node && node.closest && node.closest('select');
  if (!select) return { ok: false, error: 'Indexed element is not a native select.' };
  const option = [...select.options].find((candidate) => candidate.text.trim() === ${JSON.stringify(optionText)} || candidate.value === ${JSON.stringify(optionText)});
  if (!option) return { ok: false, error: 'Option not found.' };
  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()""")
_arivu_emit({"ok": bool(_outcome and _outcome.get("ok")), "error": (_outcome or {}).get("error"), "page": page_info(), "tabs": list_tabs(), "currentTab": current_tab()})`;
}

function python(value: unknown) {
  return JSON.stringify(value);
}

function indent(value: string) {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function tabId(targetId: string, index: number) {
  return targetId ? `browser-use-tab-${targetId}` : `browser-use-tab-${index}`;
}
