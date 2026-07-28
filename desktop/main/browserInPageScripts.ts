const MAX_SCRIPT_RESULT_CHARS = 8_000;

export function describePointScript(x: number, y: number) {
  return `(() => {
    const x = ${JSON.stringify(x)};
    const y = ${JSON.stringify(y)};
    const element = document.elementFromPoint(x, y);
    if (!element) {
      return { x, y, element: null };
    }
    const rect = element.getBoundingClientRect();
    const text = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.getAttribute("alt"),
      element.innerText,
      element.textContent,
      element.value
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
    return {
      x,
      y,
      element: {
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        role: element.getAttribute("role") || undefined,
        label: text ? text.slice(0, 180) : undefined,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          centerX: Math.round(rect.x + rect.width / 2),
          centerY: Math.round(rect.y + rect.height / 2)
        }
      }
    };
  })()`;
}

export function snapshotScript(maxLength: number) {
  return `(() => {
    const maxLength = ${JSON.stringify(maxLength)};
    const semanticSelector = "h1,h2,h3,h4,h5,h6,a,button,input,textarea,select,label,[role],img,[contenteditable=true],summary";
    const textOf = (element) => [
      element.innerText,
      element.textContent,
      element.value
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
    const attr = (element, name) => element.getAttribute(name) || "";
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
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
    const queryAllDeep = (root, selector, seen = new Set(), output = []) => {
      if (!root || !root.querySelectorAll) {
        return output;
      }
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          output.push(element);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          queryAllDeep(element.shadowRoot, selector, seen, output);
        }
      }
      return output;
    };
    const collectVisibleText = () => {
      const chunks = [];
      const pushText = (text) => {
        const normalized = normalize(text);
        if (normalized) {
          chunks.push(normalized);
        }
      };
      if (document.body) {
        pushText(document.body.innerText);
      }
      for (const element of queryAllDeep(document, semanticSelector)) {
        if (isVisible(element)) {
          pushText(elementLabel(element));
        }
      }
      return Array.from(new Set(chunks)).join("\\n").slice(0, maxLength);
    };
    const elementLabel = (element) => [
      attr(element, "aria-label"),
      attr(element, "title"),
      attr(element, "placeholder"),
      element.alt || "",
      textOf(element)
    ].find(Boolean) || "";
    const selectorFor = (element) => {
      if (element.id) {
        return "#" + CSS.escape(element.id);
      }
      const parts = [];
      let current = element;
      while (current && current instanceof Element && parts.length < 4) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        const index = sameTag.indexOf(current) + 1;
        parts.unshift(sameTag.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
        current = parent;
      }
      return parts.join(" > ");
    };
    const elements = queryAllDeep(document, semanticSelector)
      .filter(isVisible)
      .slice(0, 220)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          role: attr(element, "role") || undefined,
          id: element.id || undefined,
          selector: selectorFor(element) || undefined,
          label: elementLabel(element).slice(0, 180) || undefined,
          href: element.href || undefined,
          type: attr(element, "type") || undefined,
          name: attr(element, "name") || undefined,
          disabled: element.disabled === true || attr(element, "aria-disabled") === "true" || undefined,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            centerX: Math.round(rect.x + rect.width / 2),
            centerY: Math.round(rect.y + rect.height / 2)
          }
        };
      })
      .filter((element) => element.label || element.href || element.id || element.role);
    return {
      url: location.href,
      title: document.title,
      text: collectVisibleText().replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, maxLength),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      elements
    };
  })()`;
}

/**
 * Wraps a model-authored script so it runs with the same result shape regardless of what the
 * script itself does: `{ ok: true, result }` on success, `{ ok: false, error }` if it throws.
 * The user's code is captured in its own inner async IIFE so `return`/`await` work exactly as
 * they would in a normal async function body, without letting an early `return` skip this
 * wrapper's own error handling.
 *
 * Serialization happens here, inside the page, because a value crossing back through
 * executeJavaScript is structurally cloned: DOM nodes, functions, and circular references
 * would otherwise silently vanish or throw instead of producing a readable result.
 */
export function executeJavaScriptScript(script: string) {
  return `(async () => {
    function arivuSafeSerialize(value, seen) {
      if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        if (typeof value === "function") {
          return "[Function" + (value.name ? ": " + value.name : "") + "]";
        }
        if (typeof value === "bigint") {
          return value.toString() + "n";
        }
        return value;
      }
      if (typeof value === "function") {
        return "[Function" + (value.name ? ": " + value.name : "") + "]";
      }
      if (typeof Node !== "undefined" && value instanceof Node) {
        var tag = value.nodeType === 1 ? "<" + value.tagName.toLowerCase() + ">" : String(value.nodeName || "node");
        return "[DOM " + tag + "]";
      }
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      if (Array.isArray(value)) {
        return value.slice(0, 500).map(function(item) { return arivuSafeSerialize(item, seen); });
      }
      var out = {};
      var keys = Object.keys(value).slice(0, 200);
      for (var i = 0; i < keys.length; i++) {
        try {
          out[keys[i]] = arivuSafeSerialize(value[keys[i]], seen);
        } catch (err) {
          out[keys[i]] = "[Unserializable]";
        }
      }
      return out;
    }
    try {
      var arivuScriptResult = await (async () => {
        ${script}
      })();
      return { ok: true, result: arivuSafeSerialize(arivuScriptResult, new WeakSet()) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  })()`;
}

export function boundScriptResult(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= MAX_SCRIPT_RESULT_CHARS) {
    return value;
  }
  return `${serialized.slice(0, MAX_SCRIPT_RESULT_CHARS)}\n[truncated ${serialized.length - MAX_SCRIPT_RESULT_CHARS} more characters]`;
}

export function clickScript(target: string) {
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

export function typeScript(target: string, text: string, submit: boolean) {
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
    function queryAllDeep(root, selector, seen = new Set(), output = []) {
      if (!root || !root.querySelectorAll) {
        return output;
      }
      for (const element of root.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          output.push(element);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          queryAllDeep(element.shadowRoot, selector, seen, output);
        }
      }
      return output;
    }
    function querySelectorDeep(selector) {
      try {
        const direct = document.querySelector(selector);
        if (direct) {
          return direct;
        }
      } catch {
        throw new Error("Invalid selector");
      }
      for (const element of queryAllDeep(document, "*")) {
        if (element.matches?.(selector)) {
          return element;
        }
      }
      return null;
    }
    function visibleBrowserCandidates() {
      const seen = new Set();
      return queryAllDeep(document, "button,a,input,textarea,select,[role],label,[contenteditable=true]")
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
        const selected = resolveBrowserTarget(querySelectorDeep(rawTarget));
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
      return queryAllDeep(element, "input,textarea,select,[contenteditable=true]")[0] || null;
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
