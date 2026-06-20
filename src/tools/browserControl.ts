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
  visible: BrowserTargetState;
  background: BrowserTargetState;
};

export type BrowserTargetState = {
  mode: BrowserMode;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError?: string;
  lastScreenshotPath?: string;
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

export type BrowserToolController = {
  open(args: { url: string; mode?: BrowserMode }): Promise<BrowserToolResult>;
  screenshot(args: { mode?: BrowserMode }): Promise<BrowserToolResult>;
  snapshot(args: { mode?: BrowserMode; maxLength?: number }): Promise<BrowserToolResult>;
  console(args: { mode?: BrowserMode; levels?: string[]; limit?: number }): Promise<BrowserToolResult>;
  click(args: { target: string; mode?: BrowserMode }): Promise<BrowserToolResult>;
  type(args: { target: string; text: string; mode?: BrowserMode; submit?: boolean }): Promise<BrowserToolResult>;
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
  const parsed = new URL(`https://${trimmed}`);
  assertAllowedBrowserProtocol(parsed);
  return parsed.toString();
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
