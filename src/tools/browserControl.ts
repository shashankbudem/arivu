export type BrowserMode = "visible" | "background";

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserState = {
  paneOpen: boolean;
  defaultMode: BrowserMode;
  activeMode: BrowserMode;
  visible: BrowserTargetState;
  background: BrowserTargetState;
};

export type BrowserTabState = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError?: string;
  lastSnapshotAt?: string;
  lastScreenshotAt?: string;
  lastScreenshotPath?: string;
};

export type BrowserTargetState = BrowserTabState & {
  mode: BrowserMode;
  activeTabId?: string;
  tabs?: BrowserTabState[];
};

export type BrowserConsoleEntry = {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  sourceId?: string;
  lineNumber?: number;
  url: string;
  timestamp: string;
};

export type BrowserToolResult = Record<string, unknown>;

export type BrowserTaskModelConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxSteps?: number;
  stepDelayMs?: number;
};

export type BrowserToolController = {
  getState(): BrowserState;
  selectTab(args: { tabId: string }): Promise<BrowserToolResult>;
  open(args: { url: string; mode?: BrowserMode; tabId?: string; newTab?: boolean }): Promise<BrowserToolResult>;
  screenshot(args: { mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult>;
  snapshot(args: { mode?: BrowserMode; tabId?: string; maxLength?: number }): Promise<BrowserToolResult>;
  console(args: { mode?: BrowserMode; tabId?: string; levels?: string[]; limit?: number }): Promise<BrowserToolResult>;
  click(args: { target?: string; index?: number; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult>;
  clickAt(args: {
    x: number;
    y: number;
    mode?: BrowserMode;
    tabId?: string;
    coordinateSpace?: "css" | "image";
  }): Promise<BrowserToolResult>;
  type(args: {
    target?: string;
    index?: number;
    text: string;
    mode?: BrowserMode;
    tabId?: string;
    submit?: boolean;
  }): Promise<BrowserToolResult>;
  scroll(args: {
    direction: "up" | "down" | "left" | "right";
    pixels?: number;
    numPages?: number;
    index?: number;
    mode?: BrowserMode;
    tabId?: string;
  }): Promise<BrowserToolResult>;
  selectOption(args: { index: number; optionText: string; mode?: BrowserMode; tabId?: string }): Promise<BrowserToolResult>;
  task(args: {
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
  }): Promise<BrowserToolResult>;
};

export function normalizeBrowserMode(value: unknown): BrowserMode | undefined {
  return value === "visible" || value === "background" ? value : undefined;
}

export function formatBrowserToolResult(action: string, result: BrowserToolResult) {
  return JSON.stringify({ action, ...result }, null, 2);
}

export function normalizeBrowserUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Browser URL is required.");
  }
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[\w.-]+:\d+(?:\/|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    const parsed = new URL(trimmed);
    assertAllowedBrowserProtocol(parsed);
    return parsed.toString();
  }
  if (!isLikelyBrowserHost(trimmed)) {
    return googleBrowserSearchUrl(trimmed);
  }
  const parsed = new URL(`https://${trimmed}`);
  assertAllowedBrowserProtocol(parsed);
  return parsed.toString();
}

function isLikelyBrowserHost(value: string) {
  return /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(value);
}

function googleBrowserSearchUrl(query: string) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  return url.toString();
}

export function isLocalBrowserUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "file:" || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function assertAllowedBrowserProtocol(url: URL) {
  if (!["http:", "https:", "file:"].includes(url.protocol)) {
    throw new Error(`Browser navigation only supports http, https, and file URLs, not ${url.protocol}`);
  }
}
