import type { BrowserView, BrowserWindow, WebContents } from "electron";
import type { BrowserConsoleEntry, BrowserState, BrowserTargetState, BrowserToolResult } from "../../src/tools/browserControl.js";

export type BrowserStateListener = (state: BrowserState) => void;

export type BrowserTargetRecord = Omit<BrowserTargetState, "activeTabId" | "tabs"> & {
  logs: BrowserConsoleEntry[];
  faviconUrl?: string;
  failedUrl?: string;
  recoveryTitle?: string;
  lastScreenshotSize?: BrowserImageSize;
  lastViewport?: BrowserViewport;
};

export type BrowserTabRecord = BrowserTargetRecord & {
  contents: WebContents;
  view?: BrowserView;
  popupWindow?: BrowserWindow;
};

export type BrowserImageSize = {
  width: number;
  height: number;
};

export type BrowserViewport = {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
};

export type BrowserVisualViewportState = {
  url: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  frameSignature: string;
};

export type BrowserDeviceViewport = {
  enabled: boolean;
  preset: string;
  width: number;
  height: number;
  scale: number;
};

export type BrowserFrameMeta = {
  index: number;
  url: string;
  name?: string;
  origin: string;
  mainFrame: boolean;
};

export type BrowserFrameInspection =
  | (BrowserFrameMeta & {
      ok: true;
      snapshot: BrowserToolResult;
    })
  | (BrowserFrameMeta & {
      ok: false;
      error: string;
    });

export type BrowserDownloadRecord = {
  id: string;
  filename: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  savePath?: string;
};

export type BrowserSessionSnapshot = {
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

export type BrowserHistoryRecord = {
  url: string;
  title: string;
  visitedAt: string;
};
