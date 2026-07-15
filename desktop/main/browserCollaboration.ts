export const BROWSER_ANNOTATION_CONSOLE_PREFIX = "__ARIVU_BROWSER_ANNOTATION__";

export type BrowserAnnotationMode = "browse" | "element" | "region";

export type BrowserAnnotationSelection = {
  kind: "element" | "region";
  selector?: string;
  label?: string;
  rect: { x: number; y: number; width: number; height: number };
  computedStyle?: BrowserDesignPatch;
};

export type BrowserDesignPatch = {
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontFamily?: string;
  fontWeight?: string;
  borderColor?: string;
  borderWidth?: string;
  borderRadius?: string;
  width?: string;
  height?: string;
  display?: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  gap?: string;
  margin?: string;
  padding?: string;
};

export type BrowserPendingAnnotation = BrowserAnnotationSelection & {
  id: string;
  tabId: string;
  url: string;
  title: string;
  comment: string;
  createdAt: string;
  screenshotPath?: string;
  designPatch?: BrowserDesignPatch;
};

const DESIGN_KEYS = new Set<keyof BrowserDesignPatch>([
  "color",
  "backgroundColor",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "borderColor",
  "borderWidth",
  "borderRadius",
  "width",
  "height",
  "display",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "margin",
  "padding"
]);

export function normalizeBrowserDesignPatch(input: Record<string, unknown>): BrowserDesignPatch {
  const patch: BrowserDesignPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (DESIGN_KEYS.has(key as keyof BrowserDesignPatch) && typeof value === "string" && value.trim().length <= 120) {
      patch[key as keyof BrowserDesignPatch] = value.trim();
    }
  }
  return patch;
}

export function installBrowserAnnotationScript(mode: BrowserAnnotationMode) {
  return `(() => {
    window.__arivuAnnotationCleanup?.();
    if (${JSON.stringify(mode)} === "browse") return { mode: "browse" };
    const prefix = ${JSON.stringify(BROWSER_ANNOTATION_CONSOLE_PREFIX)};
    const root = document.documentElement;
    const overlay = document.createElement("div");
    const hint = document.createElement("div");
    const selection = document.createElement("div");
    overlay.dataset.arivuAnnotationOverlay = "true";
    Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "2147483646", pointerEvents: "none", cursor: "crosshair" });
    Object.assign(hint.style, { position: "fixed", left: "50%", top: "16px", transform: "translateX(-50%)", zIndex: "2147483647", padding: "8px 12px", borderRadius: "8px", background: "#171717", color: "#f5f5f5", border: "1px solid #444", font: "12px system-ui", boxShadow: "0 8px 28px #0008", pointerEvents: "none" });
    hint.textContent = ${JSON.stringify(mode === "element" ? "Select an element to comment or adjust" : "Drag to capture a region")};
    Object.assign(selection.style, { position: "fixed", zIndex: "2147483646", border: "2px solid #36c59d", background: "rgba(54,197,157,.12)", pointerEvents: "none", display: "none" });
    root.append(overlay, hint, selection);
    let start = null;
    const emit = (payload) => console.info(prefix + JSON.stringify(payload));
    const rectPayload = (rect) => ({ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
    const selector = (element) => {
      if (element.id && !/\\s/.test(element.id)) return "#" + CSS.escape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && parts.length < 6) {
        let part = current.tagName.toLowerCase();
        const stableClass = [...current.classList].find((name) => /^[a-z][a-z0-9_-]{1,40}$/i.test(name) && !/active|selected|hover|focus/i.test(name));
        if (stableClass) part += "." + CSS.escape(stableClass);
        const parent = current.parentElement;
        if (parent) {
          const same = [...parent.children].filter((child) => child.tagName === current.tagName);
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        const candidate = parts.join(" > ");
        try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch {}
        current = parent;
      }
      return parts.join(" > ");
    };
    const stylePayload = (element) => {
      const style = getComputedStyle(element);
      return { color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, borderColor: style.borderColor, borderWidth: style.borderWidth, borderRadius: style.borderRadius, width: style.width, height: style.height, display: style.display, flexDirection: style.flexDirection, justifyContent: style.justifyContent, alignItems: style.alignItems, gap: style.gap, margin: style.margin, padding: style.padding };
    };
    const targetAt = (event) => {
      overlay.style.display = "none";
      const target = document.elementFromPoint(event.clientX, event.clientY);
      overlay.style.display = "block";
      return target;
    };
    const onMove = (event) => {
      if (${JSON.stringify(mode)} === "region" && start) {
        const x = Math.min(start.x, event.clientX), y = Math.min(start.y, event.clientY);
        Object.assign(selection.style, { display: "block", left: x + "px", top: y + "px", width: Math.abs(event.clientX - start.x) + "px", height: Math.abs(event.clientY - start.y) + "px" });
        return;
      }
      if (${JSON.stringify(mode)} !== "element") return;
      const target = targetAt(event);
      if (!target || target === root || target === document.body) return;
      const rect = target.getBoundingClientRect();
      Object.assign(selection.style, { display: "block", left: rect.x + "px", top: rect.y + "px", width: rect.width + "px", height: rect.height + "px" });
    };
    const onDown = (event) => {
      event.preventDefault(); event.stopPropagation();
      if (${JSON.stringify(mode)} === "region") start = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event) => {
      event.preventDefault(); event.stopPropagation();
      if (${JSON.stringify(mode)} === "element") {
        const target = targetAt(event);
        if (!target || target === root || target === document.body) return;
        const rect = target.getBoundingClientRect();
        emit({ kind: "element", selector: selector(target), label: (target.getAttribute("aria-label") || target.innerText || target.textContent || target.tagName).trim().slice(0, 160), rect: rectPayload(rect), computedStyle: stylePayload(target) });
      } else if (start) {
        const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) };
        start = null;
        if (rect.width >= 8 && rect.height >= 8) emit({ kind: "region", rect: rectPayload(rect), label: "Selected region" });
      }
    };
    window.__arivuAnnotationCleanup = () => { window.removeEventListener("pointermove", onMove, true); window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("pointerup", onUp, true); overlay.remove(); hint.remove(); selection.remove(); delete window.__arivuAnnotationCleanup; };
    window.addEventListener("pointermove", onMove, true); window.addEventListener("pointerdown", onDown, true); window.addEventListener("pointerup", onUp, true);
    overlay.style.pointerEvents = "auto";
    return { mode: ${JSON.stringify(mode)} };
  })()`;
}

export function applyBrowserDesignPatchScript(selector: string, patch: BrowserDesignPatch) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("The selected element is no longer on the page.");
    if (!element.dataset.arivuOriginalStyle) element.dataset.arivuOriginalStyle = element.getAttribute("style") || "";
    Object.assign(element.style, ${JSON.stringify(patch)});
    element.dataset.arivuDesignPreview = "true";
    return { applied: true };
  })()`;
}

export function discardBrowserDesignPatchScript(selector: string) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { discarded: false };
    const original = element.dataset.arivuOriginalStyle;
    if (original === undefined) return { discarded: false };
    if (original) element.setAttribute("style", original); else element.removeAttribute("style");
    delete element.dataset.arivuOriginalStyle; delete element.dataset.arivuDesignPreview;
    return { discarded: true };
  })()`;
}

export function browserAutofillScript(
  profile: Record<string, string | undefined> | undefined,
  credential: { username: string; password: string } | undefined
) {
  return `(() => {
    const profile = ${JSON.stringify(profile ?? {})};
    const credential = ${JSON.stringify(credential ?? {})};
    const fields = [...document.querySelectorAll("input, textarea, select")].filter((element) => !element.disabled && !element.readOnly);
    const values = { name: profile.fullName, fullname: profile.fullName, "given-name": profile.fullName, email: profile.email, tel: profile.phone, phone: profile.phone, "address-line1": profile.addressLine1, address: profile.addressLine1, "address-line2": profile.addressLine2, city: profile.city, "address-level2": profile.city, state: profile.region, "address-level1": profile.region, "postal-code": profile.postalCode, zip: profile.postalCode, country: profile.country, username: credential.username, "current-password": credential.password, password: credential.password };
    let count = 0;
    for (const field of fields) {
      const hints = [field.autocomplete, field.name, field.id, field.type, field.placeholder].filter(Boolean).join(" ").toLowerCase();
      const key = Object.keys(values).find((candidate) => hints.includes(candidate));
      const value = key ? values[key] : undefined;
      if (value === undefined || value === "") continue;
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
      if (descriptor?.set) descriptor.set.call(field, value); else field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true })); field.dispatchEvent(new Event("change", { bubbles: true }));
      count += 1;
    }
    return { count };
  })()`;
}
