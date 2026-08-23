import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, nativeImage, type NativeImage } from "electron";
import { appEnv } from "../../src/config.js";
import type { DesktopBrowserController } from "./browserController.js";

export function createDesktopSmokeHarness(browserController: DesktopBrowserController) {
  async function captureSmokeScreenshot(window: BrowserWindow | undefined) {
    if (!window) {
      return;
    }
    await waitForDesktopSmokeContent(window);
    await prepareDesktopSmokeView(window);
    const image = await captureNonBlankPage(window);
    const smokeView = appEnv("DESKTOP_SMOKE_VIEW");
    const screenshotName =
      smokeView === "settings"
        ? "arivu-desktop-smoke-settings.png"
        : smokeView === "search-provider-manager"
          ? "arivu-desktop-smoke-search-providers.png"
          : smokeView === "context-compaction"
            ? "arivu-desktop-smoke-context-compaction.png"
            : "arivu-desktop-smoke.png";
    const screenshotPath = path.join(os.tmpdir(), screenshotName);
    await writeFile(screenshotPath, image.toPNG());
    console.log(`desktop smoke screenshot: ${screenshotPath}`);
  }

  async function prepareDesktopSmokeView(window: BrowserWindow) {
    const smokeView = appEnv("DESKTOP_SMOKE_VIEW");
    if (smokeView === "context-compaction") {
      await prepareContextCompactionSmokeView(window);
      return;
    }
    if (
      smokeView !== "settings" &&
      smokeView !== "browser-task-model" &&
      smokeView !== "visual-grounding-model" &&
      smokeView !== "search-provider-manager"
    ) {
      return;
    }
    const runtimeToolsVisible = await window.webContents.executeJavaScript(
      `window.arivu.listTools().then(({ tools }) => {
        const names = new Set(tools.map((tool) => tool.name));
        return ["arivu_runtime_status", "arivu_set_tool_state", "arivu_select_browser_model", "arivu_propose_mcp_server"]
          .every((name) => names.has(name));
      })`,
      true
    );
    if (!runtimeToolsVisible) {
      throw new Error("desktop smoke: guarded runtime controls are missing from the Tools list");
    }
    await window.webContents.executeJavaScript(`document.querySelector(".onboarding-skip")?.click()`, true);
    await waitForRendererExpression(window, `!document.querySelector(".onboarding-dialog")`, 2_000);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="Settings"]')?.click()`, true);
    if (!(await waitForRendererSelector(window, '.settings-navigation [data-settings-section="models"]', 5_000))) {
      throw new Error("desktop smoke: sectioned settings navigation did not render");
    }

    const sectionIds = ["models", "browser", "integrations", "permissions", "skills", "worktrees", "diagnostics"];
    for (const sectionId of sectionIds) {
      const switched = await window.webContents.executeJavaScript(
        `(() => {
          const button = document.querySelector(${JSON.stringify(`[data-settings-section="${sectionId}"]`)});
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click();
          return true;
        })()`,
        true
      );
      if (!switched || !(await waitForRendererSelector(window, `[data-settings-panel="${sectionId}"]:not([hidden])`, 2_000))) {
        throw new Error(`desktop smoke: settings section did not activate: ${sectionId}`);
      }
    }

    const requestedSection =
      smokeView === "browser-task-model" || smokeView === "visual-grounding-model"
        ? "browser"
        : smokeView === "search-provider-manager"
          ? "integrations"
          : (appEnv("DESKTOP_SMOKE_SETTINGS_SECTION") ?? "models");
    if (!sectionIds.includes(requestedSection)) {
      throw new Error(`desktop smoke: unknown settings section: ${requestedSection}`);
    }
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(`[data-settings-section="${requestedSection}"]`)})?.click()`,
      true
    );
    if (!(await waitForRendererSelector(window, `[data-settings-panel="${requestedSection}"]:not([hidden])`, 2_000))) {
      throw new Error(`desktop smoke: requested settings section did not activate: ${requestedSection}`);
    }

    if (smokeView === "browser-task-model") {
      const opened = await window.webContents.executeJavaScript(
        `(() => {
          const button = document.querySelector('button[aria-label^="Choose browser task model"]');
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click();
          return true;
        })()`,
        true
      );
      if (!opened) {
        throw new Error("desktop smoke: browser-task model picker trigger was not found");
      }
      const dialogOpened = await waitForRendererSelector(window, '.model-dialog[aria-label="Select browser task model"]', 2_000);
      if (!dialogOpened) {
        throw new Error("desktop smoke: browser-task model picker did not open");
      }
    }
    if (smokeView === "visual-grounding-model") {
      const opened = await window.webContents.executeJavaScript(
        `(() => {
          const button = document.querySelector('button[aria-label^="Choose visual grounding model"]');
          if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
          button.click();
          return true;
        })()`,
        true
      );
      if (!opened) {
        throw new Error("desktop smoke: visual-grounding model picker trigger was not found or was disabled");
      }
      const dialogOpened = await waitForRendererSelector(window, '.model-dialog[aria-label="Select visual grounding model"]', 2_000);
      if (!dialogOpened) {
        throw new Error("desktop smoke: visual-grounding model picker did not open");
      }
    }
    if (smokeView === "search-provider-manager") {
      const managerReady = (await window.webContents.executeJavaScript(
        `(() => {
          const manager = document.querySelector("[data-search-provider-manager]");
          const picker = manager?.querySelector("[data-search-provider-select]");
          const add = Array.from(manager?.querySelectorAll("button") ?? [])
            .find((button) => button.textContent?.includes("Add provider"));
          const type = Array.from(manager?.querySelectorAll("label") ?? [])
            .find((label) => label.textContent?.includes("Provider type"))
            ?.querySelector("select");
          if (!(manager instanceof HTMLElement) || manager.hidden) return { ok: false, reason: "hidden" };
          if (!(picker instanceof HTMLSelectElement) || !(add instanceof HTMLButtonElement) || !(type instanceof HTMLSelectElement)) {
            return { ok: false, reason: "controls" };
          }
          const before = picker.options.length;
          add.click();
          return { ok: true, before };
        })()`,
        true
      )) as { ok?: boolean; before?: number; reason?: string };
      if (!managerReady.ok) {
        throw new Error(`desktop smoke: search provider manager is incomplete (${managerReady.reason ?? "unknown"})`);
      }
      const managerUpdated = await waitForRendererExpression(
        window,
        `(() => {
          const manager = document.querySelector("[data-search-provider-manager]");
          const picker = manager?.querySelector("[data-search-provider-select]");
          return picker instanceof HTMLSelectElement && picker.options.length === ${Number(managerReady.before ?? 0) + 1};
        })()`,
        2_000
      );
      if (!managerUpdated) {
        throw new Error("desktop smoke: adding a search provider did not update the manager");
      }
      const changedKind = await window.webContents.executeJavaScript(
        `(() => {
          const manager = document.querySelector("[data-search-provider-manager]");
          const type = Array.from(manager?.querySelectorAll("label") ?? [])
            .find((label) => label.textContent?.includes("Provider type"))
            ?.querySelector("select");
          if (!(type instanceof HTMLSelectElement)) return false;
          type.value = "brave";
          type.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`,
        true
      );
      if (!changedKind) {
        throw new Error("desktop smoke: search provider type control was not available");
      }
      const braveReady = await waitForRendererExpression(
        window,
        `(() => {
          const manager = document.querySelector("[data-search-provider-manager]");
          const endpoint = Array.from(manager?.querySelectorAll("label") ?? [])
            .find((label) => label.textContent?.includes("Search endpoint"))
            ?.querySelector("input");
          return endpoint instanceof HTMLInputElement && endpoint.value.includes("api.search.brave.com");
        })()`,
        2_000
      );
      if (!braveReady) {
        throw new Error("desktop smoke: changing provider type did not load the Brave endpoint");
      }
      const saveClicked = await window.webContents.executeJavaScript(
        `(() => {
          const save = document.querySelector(".settings-header .save-button");
          if (!(save instanceof HTMLButtonElement)) return false;
          save.click();
          return true;
        })()`,
        true
      );
      if (!saveClicked) {
        throw new Error("desktop smoke: Settings save button was not available");
      }
      const savedSearchProvider = await waitForRendererExpression(
        window,
        `window.arivu.getState().then((state) => {
          const active = state.config.webSearchProviders.find(
            (provider) => provider.id === state.config.activeWebSearchProviderId
          );
          return state.config.webSearchProviders.length === ${Number(managerReady.before ?? 0) + 1} && active?.kind === "brave";
        })`,
        4_000
      );
      if (!savedSearchProvider) {
        throw new Error("desktop smoke: active search provider did not persist");
      }
      await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="Settings"]')?.click()`, true);
      if (!(await waitForRendererSelector(window, '[data-settings-section="integrations"]', 2_000))) {
        throw new Error("desktop smoke: Settings did not reopen after saving a search provider");
      }
      await window.webContents.executeJavaScript(`document.querySelector('[data-settings-section="integrations"]')?.click()`, true);
      const persistedManagerVisible = await waitForRendererExpression(
        window,
        `(() => {
          const manager = document.querySelector("[data-search-provider-manager]");
          const picker = manager?.querySelector("[data-search-provider-select]");
          const displayName = Array.from(manager?.querySelectorAll("label") ?? [])
            .find((label) => label.textContent?.includes("Display name"))
            ?.querySelector("input");
          const endpoint = Array.from(manager?.querySelectorAll("label") ?? [])
            .find((label) => label.textContent?.includes("Search endpoint"))
            ?.querySelector("input");
          return manager instanceof HTMLElement && !manager.hidden &&
            picker instanceof HTMLSelectElement && picker.options.length === ${Number(managerReady.before ?? 0) + 1} &&
            picker.selectedOptions[0]?.textContent?.trim() === "Brave Search" &&
            displayName instanceof HTMLInputElement && displayName.value === "Brave Search" &&
            endpoint instanceof HTMLInputElement && endpoint.value.includes("api.search.brave.com");
        })()`,
        2_000
      );
      if (!persistedManagerVisible) {
        throw new Error("desktop smoke: saved search provider manager did not render after reopening Settings");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  async function prepareContextCompactionSmokeView(window: BrowserWindow) {
    const sessionId = appEnv("DESKTOP_SMOKE_SESSION_ID");
    if (!sessionId) {
      throw new Error("desktop smoke: ARIVU_DESKTOP_SMOKE_SESSION_ID is required for the context-compaction view");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error("desktop smoke: context-compaction fixture chat id is invalid");
    }

    await window.webContents.executeJavaScript(`document.querySelector(".onboarding-skip")?.click()`, true);
    const sessionSelector = `[data-session-id="${sessionId}"] .recent-chat-row`;
    if (!(await waitForRendererSelector(window, sessionSelector, 5_000))) {
      throw new Error("desktop smoke: context-compaction fixture chat was not listed");
    }
    const opened = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector(${JSON.stringify(sessionSelector)});
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
      true
    );
    if (
      !opened ||
      !(await waitForRendererExpression(
        window,
        `window.arivu.getState().then((state) => state.sessionId === ${JSON.stringify(sessionId)})`,
        5_000
      ))
    ) {
      throw new Error("desktop smoke: context-compaction fixture chat did not open");
    }
    if (!(await waitForRendererSelector(window, 'button[aria-label="Compact context"]:not([disabled])', 5_000))) {
      throw new Error("desktop smoke: context compaction control was not enabled");
    }

    const visibleMessageCountBefore = await window.webContents.executeJavaScript(
      `document.querySelectorAll(".message-list article.message").length`,
      true
    );
    await window.webContents.executeJavaScript(
      `(() => {
        window.confirm = () => true;
        const button = document.querySelector('button[aria-label="Compact context"]');
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
        button.click();
        return true;
      })()`,
      true
    );
    if (!(await waitForRendererExpression(window, `window.arivu.getState().then((state) => state.context.compacted === true)`, 5_000))) {
      throw new Error("desktop smoke: context compaction did not complete");
    }
    if (
      !(await waitForRendererExpression(
        window,
        `Array.from(document.querySelectorAll(".sidebar-footer span")).some((element) =>
          element.textContent?.startsWith("Compacted ")
        )`,
        5_000
      ))
    ) {
      throw new Error("desktop smoke: compacted context did not reach the renderer");
    }

    const visibleMessageCountAfter = await window.webContents.executeJavaScript(
      `document.querySelectorAll(".message-list article.message").length`,
      true
    );
    if (visibleMessageCountAfter !== visibleMessageCountBefore) {
      throw new Error(
        `desktop smoke: visible history changed after compaction (${visibleMessageCountBefore} -> ${visibleMessageCountAfter})`
      );
    }

    const commandOpened = await window.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('.composer textarea[placeholder^="Ask Arivu"]');
        if (!(input instanceof HTMLTextAreaElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(input, "/session");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`,
      true
    );
    if (!commandOpened || !(await waitForRendererSelector(window, "#slash-command-session", 2_000))) {
      throw new Error("desktop smoke: session-details command was not available");
    }
    await window.webContents.executeJavaScript(`document.querySelector("#slash-command-session")?.click()`, true);
    if (!(await waitForRendererSelector(window, '.command-output-panel[aria-label="Session details"]', 2_000))) {
      throw new Error("desktop smoke: session details did not render");
    }
    if (!(await waitForRendererSelector(window, ".command-output-panel .command-output-row", 2_000))) {
      throw new Error("desktop smoke: session detail rows did not render");
    }

    const contextDetails = (await window.webContents.executeJavaScript(
      `(() => Object.fromEntries(
        Array.from(document.querySelectorAll(".command-output-row")).map((row) => [
          row.querySelector("dt")?.textContent?.trim() ?? "",
          row.querySelector("dd")?.textContent?.trim() ?? ""
        ])
      ))()`,
      true
    )) as Record<string, string>;
    const workingMessageCount = Number(contextDetails["Working messages"]);
    const savedHistoryCount = Number.parseInt(contextDetails["Saved history"] ?? "", 10);
    if (
      contextDetails["Context mode"]?.startsWith("Compacted") !== true ||
      !Number.isFinite(workingMessageCount) ||
      !Number.isFinite(savedHistoryCount) ||
      workingMessageCount >= savedHistoryCount ||
      savedHistoryCount !== visibleMessageCountAfter
    ) {
      throw new Error(`desktop smoke: context counters are inconsistent (${JSON.stringify(contextDetails)})`);
    }
    await window.webContents.executeJavaScript(
      `document.querySelector('.command-output-panel[aria-label="Session details"]')?.scrollIntoView({ block: "center" })`,
      true
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  async function waitForRendererSelector(window: BrowserWindow, selector: string, timeoutMs: number) {
    return waitForRendererExpression(window, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, timeoutMs);
  }

  async function waitForRendererExpression(window: BrowserWindow, expression: string, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const found = await window.webContents.executeJavaScript(expression, true).catch(() => false);
      if (found) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async function captureBrowserSmoke(window: BrowserWindow | undefined) {
    if (!window) {
      return;
    }
    await waitForDesktopSmokeContent(window);
    console.log("browser smoke: preparing fixture pages");
    const secondUrl = await writeBrowserSmokePage("two", "Arivu browser smoke tab two", undefined, true);
    const firstUrl = await writeBrowserSmokePage("one", "Arivu browser smoke tab one", secondUrl);
    console.log("browser smoke: opening fixture tabs");
    const first = await browserController.open({ url: firstUrl, mode: "visible" });
    const second = await browserController.open({ url: secondUrl, mode: "visible", newTab: true });
    const firstTabId = typeof first.tabId === "string" ? first.tabId : undefined;
    const secondTabId = typeof second.tabId === "string" ? second.tabId : undefined;
    if (!firstTabId || !secondTabId) {
      throw new Error("browser smoke: visible tab ids were not returned");
    }
    browserController.selectVisibleTab(firstTabId);
    console.log("browser smoke: capturing first tab");
    const firstScreenshot = await browserController.screenshot({ mode: "visible", tabId: firstTabId });
    console.log("browser smoke: opening page popup");
    await browserController.clickAt({ x: 90, y: 142, mode: "visible", tabId: firstTabId });
    console.log("browser smoke: verifying page popup");
    const popupResult = await browserController.snapshot({ mode: "visible", tabId: firstTabId });
    const popupAccepted = JSON.stringify(popupResult).includes("Popup accepted");
    const popupTab = browserController
      .getState()
      .visible.tabs?.find((tab) => tab.id !== firstTabId && tab.id !== secondTabId && tab.url === secondUrl);
    if (!popupAccepted || !popupTab) {
      throw new Error("browser smoke: window.open did not return a usable Arivu popup tab");
    }
    const popupSnapshot = await browserController.snapshot({ mode: "visible", tabId: popupTab.id });
    if (!JSON.stringify(popupSnapshot).includes("Arivu browser smoke tab two")) {
      throw new Error("browser smoke: the popup tab could not be inspected by tab id");
    }
    console.log("browser smoke: closing page popup from inside the popup");
    await browserController.clickAt({ x: 300, y: 142, mode: "visible", tabId: popupTab.id }).catch(() => undefined);
    if (!(await waitForBrowserTabToClose(popupTab.id, 3_000))) {
      throw new Error("browser smoke: a self-closed popup remained in visible tab state");
    }
    console.log("browser smoke: capturing second tab");
    // selectTab is the agent tool: it retargets agent defaults WITHOUT switching the user's
    // view. Verify that, then switch the visible tab through the user path so the shell
    // assertions below (tab cycling, review panel) run against the expected active tab.
    const activeBeforeAgentSelect = browserController.getState().visible.activeTabId;
    const selectedSecond = await browserController.selectTab({ tabId: secondTabId });
    if (browserController.getState().visible.activeTabId !== activeBeforeAgentSelect) {
      throw new Error("browser smoke: agent selectTab must not change the user's active tab");
    }
    if (browserController.getState().visible.agentTargetTabId !== secondTabId) {
      throw new Error("browser smoke: agent selectTab did not retarget the agent's default tab");
    }
    browserController.selectVisibleTab(secondTabId);
    const secondScreenshot = await browserController.screenshot({ mode: "visible", tabId: secondTabId });
    await assertLightBrowserSmokeScreenshot(firstScreenshot.screenshotPath, "first tab");
    await assertLightBrowserSmokeScreenshot(secondScreenshot.screenshotPath, "second tab after popup switch");
    const browserState = browserController.getState();
    const browserWindow = BrowserWindow.getAllWindows().find(
      (candidate) => candidate !== window && candidate.getTitle() === "Arivu Browser"
    );
    let browserShellScreenshotPath: string | undefined;
    if (browserWindow && !browserWindow.isDestroyed()) {
      const image = await browserWindow.webContents.capturePage();
      // BrowserView pixels are a separate compositor surface and are intentionally absent here;
      // this artifact validates the native tab/address shell only. Per-tab paths above contain
      // the actual page pixels.
      browserShellScreenshotPath = path.join(os.tmpdir(), "arivu-browser-smoke-shell.png");
      await writeFile(browserShellScreenshotPath, image.toPNG());
    }
    if (!browserWindow || browserWindow.isDestroyed()) {
      throw new Error("browser smoke: browser shell window was not available for command testing");
    }
    console.log("browser smoke: cycling tabs through the shell command bridge");
    await browserWindow.webContents.executeJavaScript('location.href="arivu-browser://cycle-tab?direction=-1"', true);
    if (!(await waitForBrowserActiveTab(firstTabId, 2_000))) {
      throw new Error("browser smoke: reverse tab cycling did not select the first tab");
    }
    await browserWindow.webContents.executeJavaScript('location.href="arivu-browser://cycle-tab?direction=1"', true);
    if (!(await waitForBrowserActiveTab(secondTabId, 2_000))) {
      throw new Error("browser smoke: forward tab cycling did not restore the second tab");
    }
    console.log("browser smoke: verifying scaled device preview");
    await browserWindow.webContents.executeJavaScript('location.href="arivu-browser://device-preset?preset=4k"', true);
    const deviceScale = await waitForBrowserShellText(browserWindow, "#device-scale", "% preview", 3_000);
    if (!deviceScale) {
      throw new Error("browser smoke: oversized device preview was not scaled into the browser window");
    }
    await browserWindow.webContents.executeJavaScript('location.href="arivu-browser://toggle-device"', true);
    console.log("browser smoke: verifying review panel and annotation handoff");
    await browserWindow.webContents.executeJavaScript('document.getElementById("review")?.click()', true);
    const reviewVisible = await browserWindow.webContents.executeJavaScript(
      'document.getElementById("reviewbar")?.hidden === false && document.body.innerText.includes("Design adjustments")',
      true
    );
    if (!reviewVisible) {
      throw new Error("browser smoke: browser review panel did not open");
    }
    const activeContents = browserController.getVisibleTabWebContents(secondTabId);
    await activeContents.executeJavaScript(
      `console.info(${JSON.stringify("__ARIVU_BROWSER_ANNOTATION__")} + JSON.stringify({kind:"region",label:"Smoke region",rect:{x:20,y:20,width:160,height:90}}))`,
      true
    );
    const annotationId = await waitForBrowserAnnotation(3_000);
    if (!annotationId) {
      throw new Error("browser smoke: region annotation did not reach browser collaboration state");
    }
    await browserWindow.webContents.executeJavaScript(
      `location.href=${JSON.stringify(`arivu-browser://annotation-send?id=${encodeURIComponent(annotationId)}&comment=${encodeURIComponent("Smoke review note")}`)}`,
      true
    );
    if (!(await waitForBrowserHandoff(3_000))) {
      throw new Error("browser smoke: annotations were not handed to the Arivu composer");
    }
    const reviewImage = await browserWindow.webContents.capturePage();
    const browserReviewScreenshotPath = path.join(os.tmpdir(), "arivu-browser-smoke-review.png");
    await writeFile(browserReviewScreenshotPath, reviewImage.toPNG());
    console.log("browser smoke: verifying visible/background tab transfer");
    await browserController.open({ url: firstUrl, mode: "background" });
    await browserWindow.webContents.executeJavaScript('location.href="arivu-browser://adopt-agent-tab"', true);
    const adoptedTabId = await waitForNewBrowserActiveTab(secondTabId, 3_000);
    if (!adoptedTabId || !(await waitForBrowserSnapshotText(adoptedTabId, "Arivu browser smoke tab one", 3_000))) {
      throw new Error("browser smoke: background agent page was not adopted into a visible tab");
    }
    console.log("browser smoke: verifying the categorized load-error surface");
    await browserController
      .open({ url: "http://127.0.0.1:65534/arivu-browser-smoke-error", mode: "visible", newTab: true })
      .catch(() => undefined);
    const errorTabId = browserController.getState().visible.activeTabId;
    if (!errorTabId || !(await waitForBrowserSnapshotText(errorTabId, "This site can't be reached", 4_000))) {
      throw new Error("browser smoke: load failures did not render the retry surface");
    }
    console.log("browser smoke: verifying browser settings navigation");
    await browserWindow.webContents.executeJavaScript('location.href="arivu-browser://open-settings"', true);
    const settingsTabId = await waitForNewBrowserActiveTab(errorTabId, 2_000);
    if (
      !settingsTabId ||
      !(await waitForBrowserSnapshotText(settingsTabId, "Privacy and browser data", 3_000)) ||
      !(await waitForBrowserSnapshotText(settingsTabId, "Password manager", 3_000)) ||
      !(await waitForBrowserSnapshotText(settingsTabId, "Extensions", 3_000))
    ) {
      throw new Error("browser smoke: browser settings did not open as an addressable tab");
    }
    console.log("browser smoke: verifying show/hide and final-tab window lifecycle");
    const hiddenState = browserController.setPaneOpen(false);
    if (hiddenState.paneOpen || browserWindow.isVisible()) {
      throw new Error("browser smoke: hiding the browser left its window or pane state open");
    }
    const toggledOpenState = browserController.togglePaneOpen();
    if (!toggledOpenState.paneOpen || !browserWindow.isVisible()) {
      throw new Error("browser smoke: toggling the hidden browser did not show its window");
    }
    let restoredFromMinimized = true;
    if (browserWindow.isMinimizable()) {
      browserWindow.minimize();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (browserWindow.isMinimized()) {
        browserController.setPaneOpen(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        restoredFromMinimized = !browserWindow.isMinimized() && browserWindow.isVisible();
        if (!restoredFromMinimized) {
          throw new Error("browser smoke: showing the browser did not restore its minimized window");
        }
      }
    }
    const lifecycleTabIds = (browserController.getState().visible.tabs ?? []).map((tab) => tab.id);
    for (const tabId of lifecycleTabIds) {
      browserController.closeVisibleTab(tabId);
    }
    const closedLastTabState = browserController.getState();
    if ((closedLastTabState.visible.tabs?.length ?? 0) !== 0 || closedLastTabState.paneOpen || !browserWindow.isDestroyed()) {
      throw new Error("browser smoke: closing the final tab did not close the browser window");
    }
    const reopenedAfterLastTabState = browserController.togglePaneOpen();
    const reopenedBrowserWindow = await waitForVisibleBrowserWindow(window, 3_000);
    if (
      !reopenedAfterLastTabState.paneOpen ||
      reopenedAfterLastTabState.visible.tabs?.length !== 1 ||
      !reopenedBrowserWindow ||
      reopenedBrowserWindow.isDestroyed() ||
      !reopenedBrowserWindow.isVisible()
    ) {
      throw new Error("browser smoke: showing the browser after its final tab closed did not create a fresh tab");
    }
    browserController.setPaneOpen(false);
    console.log(
      JSON.stringify(
        {
          browserSmoke: true,
          tabs: browserState.visible.tabs?.map((tab) => ({
            id: tab.id,
            title: tab.title,
            url: tab.url,
            lastScreenshotAt: tab.lastScreenshotAt
          })),
          activeTabId: browserState.visible.activeTabId,
          selectedTabId: selectedSecond.tabId,
          popupAccepted,
          popupTabId: popupTab.id,
          errorTabId,
          loadErrorSurface: true,
          settingsTabId,
          settingsSurface: true,
          showHideLifecycle: true,
          finalTabClosesBrowser: true,
          restoredFromMinimized,
          deviceScale,
          annotationHandoff: true,
          adoptedTabId,
          firstScreenshotPath: firstScreenshot.screenshotPath,
          secondScreenshotPath: secondScreenshot.screenshotPath,
          browserShellScreenshotPath,
          browserReviewScreenshotPath
        },
        null,
        2
      )
    );
    browserController.detach(window);
  }

  async function assertLightBrowserSmokeScreenshot(screenshotPath: unknown, label: string) {
    if (typeof screenshotPath !== "string" || !screenshotPath) {
      throw new Error(`browser smoke: ${label} did not return a screenshot path`);
    }
    const image = nativeImage.createFromBuffer(await readFile(screenshotPath));
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const strideX = Math.max(1, Math.floor(size.width / 96));
    const strideY = Math.max(1, Math.floor(size.height / 54));
    let samples = 0;
    let lightSamples = 0;
    for (let y = 0; y < size.height; y += strideY) {
      for (let x = 0; x < size.width; x += strideX) {
        const index = (y * size.width + x) * 4;
        const blue = bitmap[index] ?? 0;
        const green = bitmap[index + 1] ?? 0;
        const red = bitmap[index + 2] ?? 0;
        samples += 1;
        if (red >= 220 && green >= 220 && blue >= 220) {
          lightSamples += 1;
        }
      }
    }
    if (samples === 0 || lightSamples / samples < 0.8) {
      throw new Error(`browser smoke: ${label} screenshot is blank, clipped, or covered by a stale compositor surface`);
    }
  }

  async function writeBrowserSmokePage(name: string, heading: string, popupUrl?: string, selfClose = false) {
    const filePath = path.join(os.tmpdir(), `arivu-browser-smoke-${name}.html`);
    const popupMarkup = popupUrl
      ? `<button id="open-popup" type="button">Open popup</button><p id="popup-status">Popup not tested</p><script>document.getElementById("open-popup").addEventListener("click",()=>{const popup=window.open(${JSON.stringify(popupUrl)},"_blank");document.getElementById("popup-status").textContent=popup?"Popup accepted":"Popup blocked";});</script>`
      : "";
    const closeMarkup = selfClose ? '<button id="close-popup" type="button" onclick="window.close()">Close popup</button>' : "";
    await writeFile(
      filePath,
      `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title><style>body{margin:32px;background:#ffffff;color:#111111;font-family:system-ui,sans-serif}main{display:grid;gap:12px}#open-popup{position:fixed;left:40px;top:120px;width:160px;height:44px}#close-popup{position:fixed;left:220px;top:120px;width:160px;height:44px}</style></head><body><main><h1>${heading}</h1><p>${new Date().toISOString()}</p>${popupMarkup}${closeMarkup}</main></body></html>`,
      "utf8"
    );
    return pathToFileURL(filePath).toString();
  }

  async function waitForBrowserTabToClose(tabId: string, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!browserController.getState().visible.tabs?.some((tab) => tab.id === tabId)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async function waitForBrowserActiveTab(tabId: string, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (browserController.getState().visible.activeTabId === tabId) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async function waitForVisibleBrowserWindow(hostWindow: BrowserWindow, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          candidate !== hostWindow && !candidate.isDestroyed() && candidate.getTitle() === "Arivu Browser" && candidate.isVisible()
      );
      if (browserWindow) {
        return browserWindow;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  async function waitForBrowserSnapshotText(tabId: string, text: string, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = await browserController.snapshot({ mode: "visible", tabId }).catch(() => undefined);
      if (snapshot && JSON.stringify(snapshot).includes(text)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }

  async function waitForNewBrowserActiveTab(previousTabId: string, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const activeTabId = browserController.getState().visible.activeTabId;
      if (activeTabId && activeTabId !== previousTabId) {
        return activeTabId;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  async function waitForBrowserShellText(window: BrowserWindow, selector: string, text: string, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = await window.webContents
        .executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`, true)
        .catch(() => "");
      if (typeof value === "string" && value.includes(text)) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  async function waitForBrowserAnnotation(timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const annotationId = browserController.getState().collaboration?.activeAnnotationId;
      if (annotationId) return annotationId;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  async function waitForBrowserHandoff(timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (browserController.getState().collaboration?.handoff) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async function waitForDesktopSmokeContent(window: BrowserWindow) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      const ready = await window.webContents
        .executeJavaScript(`Boolean(document.querySelector(".app-shell")) && document.body.innerText.trim().length > 0`, true)
        .catch(() => false);
      if (ready) {
        await waitForRendererPaint(window);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  async function waitForRendererPaint(window: BrowserWindow) {
    await window.webContents.executeJavaScript(`document.body?.getBoundingClientRect().width ?? 0`, true).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  async function captureNonBlankPage(window: BrowserWindow) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      window.show();
      window.focus();
      await waitForRendererPaint(window);
      const image = await window.webContents.capturePage();
      if (nativeImageHasVisibleContent(image)) {
        return image;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("desktop smoke screenshot appears blank.");
  }

  function nativeImageHasVisibleContent(image: NativeImage) {
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) {
      return false;
    }
    const bitmap = image.toBitmap();
    const strideX = Math.max(1, Math.floor(size.width / 96));
    const strideY = Math.max(1, Math.floor(size.height / 54));
    let visibleSamples = 0;
    for (let y = 0; y < size.height; y += strideY) {
      for (let x = 0; x < size.width; x += strideX) {
        const index = (y * size.width + x) * 4;
        const blue = bitmap[index] ?? 0;
        const green = bitmap[index + 1] ?? 0;
        const red = bitmap[index + 2] ?? 0;
        if (red > 70 || green > 70 || blue > 70) {
          visibleSamples += 1;
          if (visibleSamples > 20) {
            return true;
          }
        }
      }
    }
    return false;
  }

  return {
    captureBrowserSmoke,
    captureSmokeScreenshot
  };
}
