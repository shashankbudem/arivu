import { codexBrowserShellHtml } from "./codexBrowserShell.js";

export const DEFAULT_VISIBLE_CHROME_HEIGHT = 80;
export const VISIBLE_START_PAGE_TITLE = "Arivu Browser";
const VISIBLE_START_PAGE_PREFIX = "data:text/html;charset=utf-8,";
const VISIBLE_START_PAGE_MARKER = "arivu-browser-start";
const VISIBLE_LOAD_ERROR_PAGE_MARKER = "arivu-browser-load-error";
const VISIBLE_SETTINGS_PAGE_MARKER = "arivu-browser-settings";
const VISIBLE_SHELL_COMMAND_PROTOCOL = "arivu-browser:";

export function visibleShellPageUrl() {
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(codexBrowserShellHtml({ defaultChromeHeight: DEFAULT_VISIBLE_CHROME_HEIGHT }))}`;
}

export function isVisibleShellPageUrl(url: string) {
  return url === visibleShellPageUrl();
}

export function isVisibleShellCommandUrl(url: string) {
  try {
    return new URL(url).protocol === VISIBLE_SHELL_COMMAND_PROTOCOL;
  } catch {
    return false;
  }
}

export function parseVisibleShellCommand(url: string) {
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

export function isVisibleSettingsCommandUrl(url: string) {
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

export function visibleStartPageUrl() {
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(visibleStartPageHtml())}`;
}

export function isVisibleStartPageUrl(url: string) {
  return url === visibleStartPageUrl();
}

export function visibleSettingsPageUrl(state: {
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

export function isVisibleSettingsPageUrl(url: string) {
  if (!url.startsWith(VISIBLE_START_PAGE_PREFIX)) {
    return false;
  }
  try {
    return decodeURIComponent(url).includes(`data-${VISIBLE_SETTINGS_PAGE_MARKER}`);
  } catch {
    return false;
  }
}

export function visibleLoadErrorPageUrl(failedUrl: string, errorCode: number, errorDescription: string) {
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

export function visibleCrashRecoveryPageUrl(failedUrl: string, reason: string) {
  const retryTargetJson = JSON.stringify(failedUrl || visibleStartPageUrl()).replace(/</g, "\\u003c");
  const html = `<!doctype html><html data-${VISIBLE_LOAD_ERROR_PAGE_MARKER}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><title>This tab crashed</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171717;color:#f1f1f1;font-family:Inter,system-ui,sans-serif}.card{width:min(560px,calc(100vw - 48px));padding:42px}.icon{width:42px;height:42px;border:2px solid #777;border-radius:50%;display:grid;place-items:center;color:#aaa;font-size:22px}h1{margin:24px 0 10px;font-size:26px}p{color:#aaa;line-height:1.55}button{margin-top:20px;border:0;border-radius:9px;padding:9px 15px;background:#f1f1f1;color:#171717;font-weight:650;cursor:pointer}code{display:block;margin-top:18px;color:#777;font-size:11px}@media(prefers-color-scheme:light){:root{color-scheme:light}body{background:#f7f7f6;color:#1c1c1b}p{color:#686865}button{background:#1c1c1b;color:#fff}}</style></head><body><main class="card"><div class="icon">!</div><h1>This tab crashed</h1><p>The page renderer stopped unexpectedly. Reload the tab to continue where you left off.</p><button id="retry" type="button">Reload tab</button><code>${escapeHtml(reason)}</code></main><script>document.getElementById("retry").addEventListener("click",()=>{location.href=${retryTargetJson}})</script></body></html>`;
  return `${VISIBLE_START_PAGE_PREFIX}${encodeURIComponent(html)}`;
}

export function isVisibleLoadErrorPageUrl(url: string) {
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
