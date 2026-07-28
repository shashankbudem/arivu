import { shell, type BrowserWindow } from "electron";
import { isExternalHttpUrl, isTrustedAppNavigationUrl } from "./navigationSafety.js";

export function configureMainWindowNavigation(window: BrowserWindow, options: { devUrl: string | undefined; rendererIndex: string }) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalIfSafe(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedAppNavigationUrl(url, options)) {
      return;
    }

    event.preventDefault();
    void openExternalIfSafe(url);
  });
}

async function openExternalIfSafe(url: string) {
  if (isExternalHttpUrl(url)) {
    await shell.openExternal(url);
  }
}
