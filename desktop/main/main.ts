import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import type { ApiRequestLogEntry } from "../../src/agent/OpenAICompatibleChatClient.js";
import { appEnv } from "../../src/config.js";
import type { BrowserState } from "../../src/tools/browserControl.js";
import { DesktopBrowserController } from "./browserController.js";
import { DesktopController } from "./desktopController.js";
import { DesktopInteractionBroker } from "./desktopInteractionBroker.js";
import { runDesktopBenchmark } from "./desktopBenchmark.js";
import { registerDesktopIpc } from "./desktopIpc.js";
import { createDesktopSmokeHarness } from "./desktopSmoke.js";
import { configureMainWindowNavigation } from "./mainWindowNavigation.js";
import { installProcessOutputPipeGuards } from "./outputPipeGuard.js";

installProcessOutputPipeGuards();

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "../preload/preload.cjs");
const rendererIndex = path.resolve(currentDir, "../renderer/index.html");
const devUrl = appEnv("DESKTOP_DEV_URL");
let mainWindow: BrowserWindow | undefined;
const interactionBroker = new DesktopInteractionBroker(() => mainWindow);
const browserController = new DesktopBrowserController();
const desktopSmokeHarness = createDesktopSmokeHarness(browserController);
// In-memory ring buffer of recent model calls for the API request log panel. Bounded and never
// persisted; entries are already redacted (no API key) and truncated by the client.
const API_REQUEST_LOG_LIMIT = 50;
const apiRequestLog: ApiRequestLogEntry[] = [];

function recordApiRequestLogEntry(entry: ApiRequestLogEntry) {
  apiRequestLog.push(entry);
  if (apiRequestLog.length > API_REQUEST_LOG_LIMIT) {
    apiRequestLog.splice(0, apiRequestLog.length - API_REQUEST_LOG_LIMIT);
  }
  mainWindow?.webContents.send("apiRequestLog:entry", entry);
}

const controller = new DesktopController({
  browserController,
  interactionBroker,
  recordApiRequestLogEntry,
  emitSessionLifecycleEvent(event) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send("session:event", event);
  }
});
browserController.onState(sendBrowserState);
registerDesktopIpc({
  controller,
  browserController,
  interactionBroker,
  apiRequestLog,
  getMainWindow: () => mainWindow,
  devUrl,
  rendererIndex
});

function sendBrowserState(state: BrowserState) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("browser:state", state);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    title: "Arivu",
    backgroundColor: "#000000",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow = window;
  browserController.attach(window);
  configureMainWindowNavigation(window, { devUrl, rendererIndex });

  if (devUrl) {
    void window.loadURL(devUrl);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(rendererIndex);
  }

  if (appEnv("DESKTOP_SMOKE") === "1" || appEnv("BROWSER_SMOKE") === "1") {
    window.webContents.once("did-finish-load", () => {
      console.log("desktop smoke: renderer loaded");
      setTimeout(() => {
        const smoke =
          appEnv("BROWSER_SMOKE") === "1"
            ? desktopSmokeHarness.captureBrowserSmoke(window)
            : desktopSmokeHarness.captureSmokeScreenshot(window);
        void smoke
          .then(() => app.quit())
          .catch((error) => {
            console.error(`desktop smoke failed: ${error instanceof Error ? error.message : String(error)}`);
            app.exit(1);
          });
      }, 500);
    });
  }

  const benchTaskFile = appEnv("BENCH_TASK");
  if (benchTaskFile) {
    window.webContents.once("did-finish-load", () => {
      console.log("bench: renderer loaded");
      setTimeout(() => {
        void runDesktopBenchmark(benchTaskFile, controller)
          .then((code) => (code === 0 ? app.quit() : app.exit(code)))
          .catch((error) => {
            console.error(`bench entry failed: ${error instanceof Error ? error.message : String(error)}`);
            app.exit(1);
          });
      }, 500);
    });
  }

  window.on("closed", () => {
    browserController.detach(window);
    mainWindow = undefined;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
