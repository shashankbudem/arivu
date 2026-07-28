/**
 * JS source snippets injected into the page alongside the page-agent IIFE bundle
 * (see browserTaskSupervisor.ts). Kept as raw source strings rather than live
 * functions serialized with Function.prototype.toString() so bundler transforms
 * (minify, keepNames' __name helper) can never corrupt what runs in the page
 * context. Tests evaluate them with `new Function` to exercise the real code.
 *
 * All snippets are self-contained function expressions: no captured variables,
 * no library references, ES5-compatible syntax.
 */

/**
 * Injected as page-agent's `instructions.system`, which the core prepends to the
 * per-step user prompt. Every rule here earns its tokens on every step, so keep it
 * short and behavioral. Each rule fixes a failure observed in real task logs:
 * - Weaker models (gemma, nemotron via NIM) omit the optional reflection fields,
 *   which makes the agent's own history render "undefined" and lose its memory
 *   thread across steps.
 * - A model clicked an already-checked checkbox "to verify" it, toggling it off.
 * - A model clicked a <select> twice instead of using select_dropdown_option.
 * - Reference/autocomplete fields need the suggestion click to commit the value.
 */
export const ARIVU_PAGE_AGENT_SYSTEM_INSTRUCTIONS = [
  "You are running inside Arivu's automated browser on behalf of a supervising agent.",
  "- In EVERY AgentOutput call, fill evaluation_previous_goal, memory, and next_goal. They are your only memory between steps; leaving them empty makes you lose track of the task and repeat work.",
  '- AgentOutput action must be a JSON object containing exactly one real action, for example {"input_text":{"index":903,"text":"requested_for"}}. Never encode action as a string, invent shorthand such as "fill 903", or return several actions at once.',
  "- Numeric indices mentioned inside the user request are only stale hints from an earlier snapshot. Before every action, resolve the target again from the CURRENT browser_state. If an action says no interactive element exists at an index, do not wait or retry that index—match the exact current label/type/id instead.",
  "- Before every indexed action, copy the index of the exact current element whose type and label match the goal. Never guess an adjacent index: a goal to click a tab must target the element labeled as that tab, never a nearby input or checkbox.",
  "- Form text fields: input_text must target the current indexed input or textarea, never its adjacent label. If input_text says the target is not an input, re-read the current state and use the labeled input; do not retry or guess an adjacent stale index.",
  "- An element with a current [index] is directly actionable; click_element_by_index brings it into view. Do not spend steps scrolling solely to expose a target that is already indexed, and never substitute an adjacent heading/menu after a scroll.",
  '- Checkboxes: checked=true in the browser state means the box is already ON; checked=false means OFF. Target the indexed input type=checkbox itself, not its adjacent label, and verify the next browser state changed. Never click a checkbox to "verify" or "ensure" its state — click only when its current state differs from what the task needs.',
  "- Native <select> elements: use select_dropdown_option with the visible option text. Clicking a <select> element does nothing useful.",
  "- Custom comboboxes/Select2 fields are role=combobox inputs, not native selects: never use select_dropdown_option on them. Click the input; if no options are listed yet, use input_text with the desired option to populate/filter the list; then click the exact matching suggestion in the next state. Verify the field's displayed value changed before moving on; typed filter text alone is not a selection.",
  "- Autocomplete/reference inputs (search-as-you-type fields): after input_text a suggestion list usually appears — the correct next action is to click the matching suggestion (new elements are marked with *[). The typed text alone does not commit the value.",
  "- Reference lookups: prefer an unlocked editable autocomplete/reference input and its suggestion list. Avoid lookup buttons that open a popup or new tab when an editable input exists; a task is bound to its current tab and cannot continue inside a child window.",
  '- ServiceNow\'s persistent header action "Create favorite for ..." is not an open dialog. Only close an overlay when the current browser state contains a visible role=dialog or explicit dialog controls.',
  '- ServiceNow lists: text typed into a Search input is not applied until Enter. To clear existing conditions, use the "All" breadcrumb/clear control rather than a condition breadcrumb or New, then search and inspect the refreshed rows.',
  "- ServiceNow related lists: create a child record with the actual button type=submit value=sysverb_new. To open an existing row, click its Open record link, not Preview, a filter breadcrumb, the list context menu, or a field label.",
  '- ServiceNow Question Choices: when the related list and its button value=sysverb_new are already present, click that New button directly. "Question Choices" menus and Show/Hide List only configure or collapse the list; they do not open a choice editor. Never scroll for Add New when the indexed sysverb_new button is present.',
  "- ServiceNow MRVS children: create them from the existing Variable Set record's Variables related-list New button. Their Type is the requested child type (for example Multi Line Text), not Multi Row Variable Set; the existing Variable Set is the parent.",
  '- Lines like "(N more plain text lines omitted)" mean long non-interactive text was shortened to save space. All interactive [index] elements are still listed.',
  "- ServiceNow forms: use the labeled fields in the deepest visible form rather than similarly named navigation items in the outer shell. After Submit/Update, wait for navigation and verify the saved record or related list before calling done.",
  "- Prefer DOM actions from the CURRENT browser_state (click/type/select by current index). inspect_screenshot is a last-resort recovery tool for actual pixels — not routine verification.",
  "- Call inspect_screenshot when: (1) the same click/type/select failed twice and browser_state does not explain why, (2) Arivu reports a prolonged no-progress loop / auto recovery capture, or (3) you are about to give up or report the task failed — call inspect_screenshot once first (unless you already captured this task), inspect the image on the NEXT observation, then either recover with current DOM indices or call done with a precise failure reason. Never spam screenshots of an unchanged page.",
  "- If locate_and_click is available, use it only when the same current DOM action failed twice or the target is genuinely pixel-only (canvas, remote desktop, closed component surface). Describe exactly one visually unique target with nearby text/region. It captures fresh pixels, rejects ambiguous/stale coordinates, clicks once, and must be verified from the next browser_state. Never use it for payments, deletion, submission, or other sensitive confirmation.",
  "- If execute_javascript is among your available actions and you are stuck — the same click/input_text/select attempt has now failed twice in a row, or the goal has no obvious click/type/select equivalent (reading a value the DOM doesn't expose, a hidden control, a custom widget) — use it to read the exact state you need or drive the interaction directly, then verify the result in the next browser state before continuing. Do not reach for it before trying the direct action at least twice.",
  "- If you do not know what a specific field, control, or workflow on this site expects — not a DOM mechanics problem execute_javascript can solve, but not knowing the right answer at all — use search_web with a concise, specific query before guessing further. Read the result, then act on what you learned; do not search repeatedly for the same question."
].join("\n");

/**
 * Creates the in-page recovery controller used by inspect_screenshot.
 *
 * PageAgent 1.11's public message type is text-only, but its LLM config exposes
 * transformRequestBody. The controller captures pixels through Arivu's authenticated
 * loopback route and appends an opaque placeholder to the next model request as an
 * OpenAI-compatible image_url content part. The trusted main-process proxy replaces the
 * placeholder with pixels after the request leaves the page, so the website never receives
 * its tab capture. After that turn the raw request is scrubbed from PageAgent history.
 *
 * Automatic recovery is deliberately conservative: the same exact action must repeat,
 * or the same next goal must repeat with failure/uncertainty, for the configured wall-clock
 * threshold. This avoids treating a merely long provider response or a normal multi-field
 * form task as "stuck".
 */
export const CREATE_SCREENSHOT_RECOVERY_SNIPPET = String.raw`(function(options) {
  options = options || {};
  var endpoint = String(options.endpoint || "");
  var token = String(options.token || "");
  var thresholdMs = Math.max(0, Number(options.thresholdMs) || 90000);
  var cooldownMs = Math.max(0, Number(options.cooldownMs) || 120000);
  var minimumRepeats = Math.max(2, Number(options.minimumRepeats) || 3);
  var now = typeof options.now === "function" ? options.now : function() { return Date.now(); };
  var request = typeof options.fetch === "function" ? options.fetch : function(url, init) { return fetch(url, init); };
  var pendingImage;
  var imageAttached = false;
  var lastCaptureAt = -Infinity;
  var lastGoal = "";
  var goalSince = 0;
  var goalRepeats = 0;
  var goalFailures = 0;
  var lastAction = "";
  var actionSince = 0;
  var actionRepeats = 0;
  var lastStepFailed = false;
  // When the same DOM action fails twice, capture sooner than the full stuck threshold so the
  // model can use vision before burning the remaining step budget.
  var failedActionThresholdMs = Math.min(thresholdMs, 15_000);

  var normalize = function(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 600);
  };
  var actionSignature = function(step) {
    if (!step || !step.action) return "";
    var input = "";
    try {
      input = JSON.stringify(step.action.input || {});
    } catch (err) {}
    return normalize(String(step.action.name || "") + " " + input);
  };
  var failed = function(step) {
    var reflection = step && step.reflection;
    var text = normalize(
      String(reflection && reflection.evaluation_previous_goal || "") + " " +
      String(step && step.action && step.action.output || "")
    );
    return /\b(fail(?:ed|ure)?|error|uncertain|unable|stuck)\b|\bdid not\b|\bno change\b|\bnot found\b|\bdoes not\b/.test(text);
  };
  var updateRepeatState = function(step, timestamp) {
    var goal = normalize(step && step.reflection && step.reflection.next_goal);
    var action = actionSignature(step);
    lastStepFailed = failed(step);
    if (goal && goal === lastGoal) {
      goalRepeats++;
    } else {
      lastGoal = goal;
      goalRepeats = goal ? 1 : 0;
      goalFailures = 0;
      goalSince = timestamp;
    }
    if (goal && lastStepFailed) goalFailures++;
    if (action && action === lastAction) {
      actionRepeats++;
    } else {
      lastAction = action;
      actionRepeats = action ? 1 : 0;
      actionSince = timestamp;
    }
  };
  var shouldAutoCapture = function(timestamp) {
    if (pendingImage || timestamp - lastCaptureAt < cooldownMs) return false;
    var repeatedActionIsStuck =
      actionRepeats >= minimumRepeats && timestamp - actionSince >= thresholdMs;
    var repeatedFailedGoalIsStuck =
      goalRepeats >= minimumRepeats &&
      goalFailures >= 2 &&
      timestamp - goalSince >= thresholdMs;
    // Same exact DOM action failed twice: trigger inspect_screenshot recovery without waiting
    // the full no-progress wall-clock (still bounded by failedActionThresholdMs).
    var failedActionTwice =
      lastStepFailed &&
      actionRepeats >= 2 &&
      timestamp - actionSince >= failedActionThresholdMs;
    return repeatedActionIsStuck || repeatedFailedGoalIsStuck || failedActionTwice;
  };
  var capture = async function(reason, signal) {
    if (pendingImage) {
      return "A recovery screenshot is already queued for your next observation.";
    }
    var response;
    try {
      response = await request(endpoint, {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        signal: signal
      });
    } catch (err) {
      return "Screenshot capture failed: " + String(err && err.message ? err.message : err) + ". Continue with browser_state.";
    }
    if (!response || !response.ok) {
      return "Screenshot capture failed" +
        (response && typeof response.status === "number" ? " (HTTP " + response.status + ")" : "") +
        ". Continue with browser_state.";
    }
    var data;
    try {
      data = await response.json();
    } catch (err) {
      return "Screenshot capture returned an invalid response. Continue with browser_state.";
    }
    if (!data || data.queued !== true) {
      return "Screenshot capture was not queued. Continue with browser_state.";
    }
    pendingImage = "arivu-recovery-screenshot://pending";
    imageAttached = false;
    lastCaptureAt = now();
    return "Recovery screenshot captured" +
      (data.width && data.height ? " (" + data.width + "x" + data.height + ")" : "") +
      ". Its pixels will be attached to your NEXT observation; analyze them before choosing another action. Reason: " +
      normalize(reason || "visual inspection");
  };
  var transformRequestBody = function(body) {
    if (!pendingImage || !body || !Array.isArray(body.messages)) return body;
    for (var index = body.messages.length - 1; index >= 0; index--) {
      var message = body.messages[index];
      if (!message || message.role !== "user") continue;
      var textContent = typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content.slice()
          : [];
      textContent.push({ type: "image_url", image_url: { url: pendingImage } });
      message.content = textContent;
      imageAttached = true;
      break;
    }
    return body;
  };
  var scrubAttachedRequests = function(history) {
    if (!Array.isArray(history)) return;
    for (var index = history.length - 1; index >= 0; index--) {
      var event = history[index];
      if (!event || event.type !== "step") continue;
      if (imageAttached && event.rawRequest) {
        event.rawRequest = undefined;
      }
      break;
    }
  };
  var afterStep = async function(agent, history) {
    scrubAttachedRequests(history);
    if (imageAttached) {
      pendingImage = undefined;
      imageAttached = false;
    }
    var steps = Array.isArray(history)
      ? history.filter(function(event) { return event && event.type === "step"; })
      : [];
    var latest = steps[steps.length - 1];
    if (!latest) return;
    var timestamp = now();
    updateRepeatState(latest, timestamp);
    if (!shouldAutoCapture(timestamp)) return;
    var result = await capture("the same goal or exact action has made no progress for " + Math.round(thresholdMs / 1000) + " seconds");
    if (agent && typeof agent.pushObservation === "function") {
      agent.pushObservation(
        result.indexOf("Recovery screenshot captured") === 0
          ? "Arivu detected a prolonged no-progress loop and automatically captured a recovery screenshot. Its pixels are attached to this observation. Inspect the image before the next action; do not repeat the unchanged action."
          : result
      );
    }
  };
  return {
    capture: capture,
    transformRequestBody: transformRequestBody,
    afterStep: afterStep,
    hasPendingImage: function() { return !!pendingImage; }
  };
})`;

/**
 * Runs before page-agent snapshots. ServiceNow Select2 controls keep the real
 * selected text in a sibling `.select2-chosen` span while exposing an empty,
 * visually hidden combobox input. The upstream extractor therefore emits an
 * apparently blank combobox and weaker DOM models cannot verify a persisted
 * selection. Mirror the rendered value into an aria-label used only by the
 * snapshot/accessibility layer; no form value or ServiceNow state is changed.
 *
 * Same-origin nested frames are annotated recursively because UI16 forms live
 * inside `gsft_main` while page-agent itself is injected into the outer shell.
 */
export const ANNOTATE_CUSTOM_CONTROLS_SNIPPET = String.raw`(function(rootDocument) {
  var seen = [];
  var annotated = 0;
  var normalize = function(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  };
  var cleanLabel = function(value, selected) {
    var label = normalize(value).replace(/Link opens in new tab/gi, "").trim();
    return label.toLowerCase() === selected.toLowerCase() ? "" : label;
  };
  var visit = function(doc) {
    if (!doc || seen.indexOf(doc) !== -1) return;
    seen.push(doc);
    var containers = doc.querySelectorAll ? doc.querySelectorAll(".select2-container") : [];
    for (var i = 0; i < containers.length; i++) {
      var container = containers[i];
      var input = container.querySelector && container.querySelector('input[role="combobox"]');
      var chosen = container.querySelector && container.querySelector(".select2-chosen");
      var selected = normalize(chosen && chosen.textContent);
      if (!input || !selected) continue;
      var original = input.getAttribute("data-arivu-original-aria-label");
      if (original === null) {
        original = input.getAttribute("aria-label") || "";
        input.setAttribute("data-arivu-original-aria-label", original);
      }
      var fieldLabel = cleanLabel(original, selected);
      if (!fieldLabel) {
        var labelledBy = normalize(input.getAttribute("aria-labelledby")).split(" ");
        var labelParts = [];
        for (var j = 0; j < labelledBy.length; j++) {
          if (!labelledBy[j]) continue;
          var labelNode = doc.getElementById && doc.getElementById(labelledBy[j]);
          if (!labelNode || labelNode === chosen) continue;
          var part = cleanLabel(labelNode.textContent, selected);
          if (part) labelParts.push(part);
        }
        fieldLabel = normalize(labelParts.join(" "));
      }
      if (!fieldLabel && input.id && doc.querySelector) {
        var directLabel = doc.querySelector('label[for="' + input.id.replace(/"/g, '\\"') + '"]');
        fieldLabel = cleanLabel(directLabel && directLabel.textContent, selected);
      }
      input.setAttribute("aria-label", (fieldLabel || "Combobox") + ": " + selected);
      annotated++;
    }
    var frames = doc.querySelectorAll ? doc.querySelectorAll("iframe") : [];
    for (var k = 0; k < frames.length; k++) {
      try {
        visit(frames[k].contentDocument);
      } catch (err) {}
    }
    // UI shells can place their work iframe inside an open shadow root. Such an
    // iframe is absent from document.querySelectorAll("iframe"), but it still
    // appears in the document window's frame collection. Walk that collection as
    // well so controls in ServiceNow's shadow-hosted gsft_main are annotated.
    var frameWindows = doc.defaultView && doc.defaultView.frames;
    var frameCount = frameWindows && typeof frameWindows.length === "number" ? frameWindows.length : 0;
    for (var m = 0; m < frameCount; m++) {
      try {
        visit(frameWindows[m].document);
      } catch (err) {}
    }
  };
  visit(rootDocument || (typeof document !== "undefined" ? document : null));
  return annotated;
})`;

/**
 * Passed as page-agent's `transformPageContent`. Long runs of non-interactive text
 * lines (no `[index]<` marker) are collapsed and the whole content is bounded.
 * Motivating case: a ServiceNow form dumped a ~700-line role list as one element's
 * plain text into every step's browser_state (~8K tokens per step, every step) —
 * interactive elements always survive this cap, only prose runs are shortened.
 */
export const CAP_PAGE_CONTENT_SNIPPET = String.raw`(function(content) {
  var MAX_RUN_LINES = 30;
  var MAX_TOTAL_CHARS = 60000;
  var lines = String(content || "").split("\n");
  var out = [];
  var run = [];
  var flushRun = function() {
    if (run.length > MAX_RUN_LINES) {
      for (var j = 0; j < MAX_RUN_LINES; j++) out.push(run[j]);
      out.push("(" + (run.length - MAX_RUN_LINES) + " more plain text lines omitted)");
    } else {
      for (var k = 0; k < run.length; k++) out.push(run[k]);
    }
    run = [];
  };
  for (var i = 0; i < lines.length; i++) {
    if (/\[\d+\]</.test(lines[i])) {
      flushRun();
      out.push(lines[i]);
    } else {
      run.push(lines[i]);
    }
  }
  flushRun();
  var result = out.join("\n");
  if (result.length > MAX_TOTAL_CHARS) {
    result = result.slice(0, MAX_TOTAL_CHARS) + "\n(page content truncated; scroll or focus a smaller area to see more)";
  }
  return result;
})`;

/**
 * Passed as page-agent's `onAfterStep`. Backfills reflection fields the model
 * omitted so subsequent prompts never render literal "undefined" in the agent's
 * own history (the core interpolates the fields unconditionally). It also stops
 * after a Select2 filter was typed but not committed, and recovers when a weaker
 * model incorrectly uses the native-select tool on an open Select2. When the open
 * dropdown has exactly one visible exact-text suggestion, it commits that
 * suggestion in the same task; otherwise it makes the supervising agent issue a
 * bounded correction instead of letting later fields be saved under the old type.
 */
export const BACKFILL_REFLECTION_SNIPPET = String.raw`(function(agentInstance, history) {
  var last = history && history[history.length - 1];
  if (!last || last.type !== "step") {
    return;
  }
  var reflection = last.reflection || (last.reflection = {});
  if (!reflection.evaluation_previous_goal) reflection.evaluation_previous_goal = "(not recorded)";
  if (!reflection.memory) reflection.memory = "(not recorded)";
  if (!reflection.next_goal) reflection.next_goal = "(not recorded)";
  var action = last.action || {};
  var output = String(action.output || "");
  var typed = action.input && typeof action.input.text === "string" ? action.input.text.replace(/\s+/g, " ").trim() : "";
  var task = String((agentInstance && agentInstance.task) || "");
  var serviceNowListSearch =
    action.name === "input_text" &&
    typed &&
    /<input\b[^>]*\btype=search\b[^>]*\bplaceholder=Search\b/i.test(output) &&
    /\b(?:search|filter|find|look\s+for|lookup|list)\b/i.test(task) &&
    typeof document !== "undefined" &&
    (
      /_list\.do(?:[?#]|$)/i.test(String((document.location && document.location.href) || "")) ||
      (typeof document.querySelector === "function" && !!document.querySelector(".list2_body, table[role=grid]"))
    );
  if (serviceNowListSearch && typeof document.querySelectorAll === "function") {
    var normalizeSearchValue = function(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    };
    var searchInputs = document.querySelectorAll('input[type="search"]');
    var searchInput = null;
    var activeElement = document.activeElement;
    if (
      activeElement &&
      typeof activeElement.matches === "function" &&
      activeElement.matches('input[type="search"]') &&
      normalizeSearchValue(activeElement.value) === normalizeSearchValue(typed)
    ) {
      searchInput = activeElement;
    }
    if (!searchInput) {
      var matchingSearchInputs = [];
      for (var searchIndex = 0; searchIndex < searchInputs.length; searchIndex++) {
        var candidate = searchInputs[searchIndex];
        var candidateRect =
          candidate && typeof candidate.getBoundingClientRect === "function" ? candidate.getBoundingClientRect() : null;
        var candidateVisible = !candidateRect || (candidateRect.width > 0 && candidateRect.height > 0);
        if (
          candidateVisible &&
          normalizeSearchValue(candidate.value) === normalizeSearchValue(typed) &&
          String(candidate.getAttribute && candidate.getAttribute("placeholder") || "").toLowerCase() === "search"
        ) {
          matchingSearchInputs.push(candidate);
        }
      }
      if (matchingSearchInputs.length === 1) {
        searchInput = matchingSearchInputs[0];
      }
    }
    if (searchInput && typeof searchInput.dispatchEvent === "function" && typeof KeyboardEvent !== "undefined") {
      if (typeof searchInput.focus === "function") searchInput.focus();
      action.output = output + " Submitted the ServiceNow list search with Enter.";
      reflection.evaluation_previous_goal =
        'Entered "' + typed.slice(0, 120) + '" and submitted the ServiceNow list search with Enter.';
      reflection.next_goal = "Inspect the refreshed list rows; do not wait or retype the same search.";
      var enterEventOptions = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      };
      searchInput.dispatchEvent(new KeyboardEvent("keydown", enterEventOptions));
      searchInput.dispatchEvent(new KeyboardEvent("keypress", enterEventOptions));
      searchInput.dispatchEvent(new KeyboardEvent("keyup", enterEventOptions));
      return;
    }
  }
  var normalizeChoice = function(value) {
    return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
  };
  var normalizeChoiceTokens = function(value) {
    var tokens = String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
    return tokens.sort().join("|");
  };
  var sameChoice = function(left, right) {
    return (
      normalizeChoice(left) === normalizeChoice(right) ||
      (normalizeChoiceTokens(left) && normalizeChoiceTokens(left) === normalizeChoiceTokens(right))
    );
  };
  var idMatch = /\bid=(s2id_[^\s>]+)/.exec(output);
  var typedSelect2Filter = action.name === "input_text" && typed && idMatch;
  var failedNativeSelectOnCustomControl =
    action.name === "select_dropdown_option" && typed && /not a select element/i.test(output);
  if ((typedSelect2Filter || failedNativeSelectOnCustomControl) && typeof document !== "undefined") {
    var input = idMatch ? document.getElementById(idMatch[1]) : null;
    var container = input && typeof input.closest === "function" ? input.closest(".select2-container") : null;
    if (!container && typeof document.querySelector === "function") {
      container = document.querySelector(".select2-container.select2-dropdown-open, .select2-container-active");
    }
    var displayed = String((container && container.textContent) || "").replace(/\s+/g, " ").trim();
    if (!sameChoice(displayed, typed)) {
      var exactSuggestions = [];
      var visibleSuggestions = [];
      if (typeof document.querySelectorAll === "function") {
        var suggestions = document.querySelectorAll('[role="option"], .select2-result-label');
        for (var suggestionIndex = 0; suggestionIndex < suggestions.length; suggestionIndex++) {
          var suggestion = suggestions[suggestionIndex];
          var suggestionText = String(suggestion.textContent || "").replace(/\s+/g, " ").trim();
          var rect = typeof suggestion.getBoundingClientRect === "function" ? suggestion.getBoundingClientRect() : null;
          var visible = !rect || (rect.width > 0 && rect.height > 0);
          var actionableSuggestion =
            typeof suggestion.closest === "function" ? suggestion.closest('[role="option"]') || suggestion : suggestion;
          if (
            visible &&
            suggestionText &&
            !/^(?:no matches found|searching[.…]*)$/i.test(suggestionText) &&
            visibleSuggestions.indexOf(actionableSuggestion) === -1
          ) {
            visibleSuggestions.push(actionableSuggestion);
          }
          if (visible && sameChoice(suggestionText, typed)) {
            var actionableSuggestion =
              typeof suggestion.closest === "function" ? suggestion.closest('[role="option"]') || suggestion : suggestion;
            if (exactSuggestions.indexOf(actionableSuggestion) === -1) {
              exactSuggestions.push(actionableSuggestion);
            }
          }
        }
      }
      if (exactSuggestions.length === 1 && typeof exactSuggestions[0].click === "function") {
        exactSuggestions[0].click();
        displayed = String((container && container.textContent) || "").replace(/\s+/g, " ").trim();
        if (sameChoice(displayed, typed)) {
          action.output = output + ' Committed the unique exact "' + typed.slice(0, 120) + '" suggestion.';
          reflection.evaluation_previous_goal =
            'Committed the unique exact "' + typed.slice(0, 120) + '" custom-combobox suggestion.';
          reflection.next_goal = "Continue with the remaining requested form fields.";
          return;
        }
      }
      if (failedNativeSelectOnCustomControl) {
        reflection.next_goal =
          'Use input_text on the active custom combobox to filter "' + typed.slice(0, 120) +
          '", then click its unique exact suggestion; do not use select_dropdown_option.';
        return;
      }
      var safeTyped = typed.slice(0, 120);
      if (visibleSuggestions.length > 0) {
        reflection.evaluation_previous_goal =
          'Filtered the custom combobox with "' + safeTyped + '" and exposed selectable candidates.';
        reflection.next_goal =
          'Inspect the visible custom-combobox candidates and click the one that exactly represents the requested value; the filter text itself is not a selection.';
        return;
      }
      var safeDisplayed = displayed.slice(0, 120) || "(blank)";
      if (typeof window !== "undefined") {
        window.__arivuPageAgentStopReason =
          'Stopped for correction: custom combobox filter "' + safeTyped + '" was typed but not committed; the displayed value is still "' + safeDisplayed + '". Run a follow-up browser_task that clicks the exact "' + safeTyped + '" suggestion and verifies the displayed value before continuing.';
      }
      reflection.next_goal = 'Click the exact "' + safeTyped + '" suggestion and verify the custom combobox displays it.';
      if (agentInstance && typeof agentInstance.stop === "function") {
        // PageAgentCore.stop() waits for the active run (including this lifecycle
        // hook) to settle. Never return/await it here or the hook deadlocks with
        // the run it is trying to cancel.
        agentInstance.stop().catch(function() { return undefined; });
      }
      return;
    }
  }
  if (
    action.name === "click_element_by_index" &&
    /\b(?:go\s+)?back\b/i.test(task) &&
    /\badditional actions\b/i.test(output)
  ) {
    if (typeof window !== "undefined") {
      window.__arivuPageAgentStopReason =
        "Stopped for correction: the requested Back control was not clicked; Additional actions is a menu. Inspect the current snapshot first because the prior submit may already have returned to the destination, then target an exact visible Back control only if one still exists.";
    }
    reflection.next_goal =
      "Inspect the current page; do not click Additional actions. Use an exact visible Back control only if navigation is still required.";
    if (agentInstance && typeof agentInstance.stop === "function") {
      agentInstance.stop().catch(function() { return undefined; });
    }
    return;
  }
  var wantsOpenRow =
    /\bopen\b[\s\S]{0,100}\b(?:row|record|variable|priority)\b/i.test(task) ||
    /\b(?:row|record|variable|priority)\b[\s\S]{0,100}\bopen\b/i.test(task);
  if (
    action.name === "click_element_by_index" &&
    wantsOpenRow &&
    /(?:\btype=checkbox\b|select record for action)/i.test(output)
  ) {
    if (typeof window !== "undefined") {
      window.__arivuPageAgentStopReason =
        "Stopped for correction: clicked the row-selection checkbox instead of opening the record. Run a follow-up browser_task that clicks the exact Open record link in the row (for example, the anchor labeled \"Open record: Priority\"), not \"Select record for action\".";
    }
    reflection.next_goal = "Click the row's exact Open record link; do not click its selection checkbox.";
    if (agentInstance && typeof agentInstance.stop === "function") {
      agentInstance.stop().catch(function() { return undefined; });
    }
    return;
  }
  var currentIndex = action.input && action.input.index;
  var previousStep = null;
  for (var historyIndex = history.length - 2; historyIndex >= 0; historyIndex--) {
    if (history[historyIndex] && history[historyIndex].type === "step") {
      previousStep = history[historyIndex];
      break;
    }
  }
  var previousAction = previousStep && previousStep.action;
  var normalizedOutput = output.replace(/\s+/g, " ").trim().toLowerCase();
  var previousOutput = String((previousAction && previousAction.output) || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (
    action.name === "click_element_by_index" &&
    previousAction &&
    previousAction.name === "click_element_by_index" &&
    currentIndex !== undefined &&
    previousAction.input &&
    previousAction.input.index === currentIndex &&
    normalizedOutput &&
    normalizedOutput === previousOutput &&
    /\b(?:back|open|new|submit|update)\b/i.test(task)
  ) {
    if (typeof window !== "undefined") {
      window.__arivuPageAgentStopReason =
        "Stopped for correction: the same indexed click produced the same result twice with no observable progress. The index or page state is stale. Inspect the current snapshot and issue a destination-specific follow-up instead of retrying that index.";
    }
    reflection.next_goal = "Re-resolve the target from the current snapshot; do not retry the same stale index.";
    if (agentInstance && typeof agentInstance.stop === "function") {
      agentInstance.stop().catch(function() { return undefined; });
    }
    return;
  }
  if (
    action.name === "click_element_by_index" &&
    /(?:related list|question choices)/i.test(task) &&
    /(?:sysverb_new|actual new button|button[^.]*\bnew\b|\badd\s+new\b|\b(?:add|create)\b[\s\S]{0,80}\bchoices?\b)/i.test(
      task
    ) &&
    /(?:\baria-haspopup=menu\b|>\s*(?:show|hide)\s+list\b)/i.test(output) &&
    !/\bvalue=sysverb_new\b/i.test(output)
  ) {
    if (typeof window !== "undefined") {
      window.__arivuPageAgentStopReason =
        "Stopped for correction: clicked a related-list menu/header instead of the actual New button. Run a follow-up browser_task that clicks the indexed button type=submit value=sysverb_new directly; indexed controls are actionable without pre-scrolling.";
    }
    reflection.next_goal = "Click the exact indexed button type=submit value=sysverb_new; do not click the related-list heading or menu.";
    if (agentInstance && typeof agentInstance.stop === "function") {
      agentInstance.stop().catch(function() { return undefined; });
    }
    return;
  }
})`;

/**
 * Stops an indexed label click before its default action can invert an unrelated
 * checkbox. This is installed before execute(), because an onAfterStep check is
 * already too late once a ServiceNow label has toggled its associated field.
 */
export const INSTALL_UNRELATED_CHECKBOX_LABEL_GUARD_SNIPPET = String.raw`(function(agentInstance, task) {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return function() {};
  }
  var normalize = function(value) {
    return String(value || "")
      .replace(/[_\-.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  };
  var normalizedTask = normalize(task);
  var phraseNamedInTask = function(value) {
    var phrase = normalize(value);
    if (!phrase) return false;
    return (" " + normalizedTask + " ").indexOf(" " + phrase + " ") !== -1;
  };
  var resolveCheckbox = function(label) {
    if (!label) return null;
    if (label.control && String(label.control.type || "").toLowerCase() === "checkbox") {
      return label.control;
    }
    var htmlFor = String(
      (typeof label.getAttribute === "function" && label.getAttribute("for")) ||
      label.htmlFor ||
      ""
    );
    var candidateIds = [htmlFor];
    if (/^ni\./i.test(htmlFor)) candidateIds.push(htmlFor.slice(3));
    for (var candidateIndex = 0; candidateIndex < candidateIds.length; candidateIndex++) {
      var byId = candidateIds[candidateIndex] && document.getElementById
        ? document.getElementById(candidateIds[candidateIndex])
        : null;
      if (byId && String(byId.type || "").toLowerCase() === "checkbox") return byId;
    }
    var checkboxes = document.querySelectorAll ? document.querySelectorAll('input[type="checkbox"]') : [];
    for (var checkboxIndex = 0; checkboxIndex < checkboxes.length; checkboxIndex++) {
      var checkbox = checkboxes[checkboxIndex];
      var checkboxId = String(checkbox.id || "");
      var checkboxName = String(checkbox.name || "");
      for (var idIndex = 0; idIndex < candidateIds.length; idIndex++) {
        if (
          candidateIds[idIndex] &&
          (checkboxId === candidateIds[idIndex] || checkboxName === candidateIds[idIndex])
        ) {
          return checkbox;
        }
      }
    }
    return null;
  };
  var blocked = false;
  var onClick = function(event) {
    if (blocked) return;
    var target = event && event.target;
    var label =
      target && typeof target.closest === "function"
        ? target.closest("label")
        : target && String(target.tagName || "").toLowerCase() === "label"
          ? target
          : null;
    var checkbox = resolveCheckbox(label);
    if (!checkbox) return;
    var labelText = String(
      (label && (label.textContent || label.innerText)) ||
      (checkbox.getAttribute && checkbox.getAttribute("aria-label")) ||
      ""
    );
    var checkboxId = String(checkbox.id || "");
    var checkboxName = String(checkbox.name || "");
    var lastIdentifierToken = normalize(checkboxName || checkboxId).split(" ").pop() || "";
    if (
      phraseNamedInTask(labelText) ||
      phraseNamedInTask(checkboxId) ||
      phraseNamedInTask(checkboxName) ||
      phraseNamedInTask(lastIdentifierToken)
    ) {
      return;
    }
    blocked = true;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (event && typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
    var safeLabel = normalize(labelText || lastIdentifierToken || "unnamed checkbox").slice(0, 120);
    if (typeof window !== "undefined") {
      window.__arivuPageAgentStopReason =
        'Stopped before action: prevented a click on unrelated checkbox label "' + safeLabel +
        '" because the task does not name that field. Re-run with the exact checkbox field named if it must change.';
    }
    if (agentInstance && typeof agentInstance.stop === "function") {
      agentInstance.stop().catch(function() { return undefined; });
    }
  };
  document.addEventListener("click", onClick, true);
  return function() {
    document.removeEventListener("click", onClick, true);
  };
})`;

/**
 * Prevents ServiceNow variable records from being submitted under the old Type
 * when a task's requested Select2 choice was only typed into the search input.
 * The guard is deliberately narrow: it activates only when exactly one real
 * option from item_option_new.type is named in the task.
 */
export const INSTALL_SERVICE_NOW_VARIABLE_TYPE_GUARD_SNIPPET = String.raw`(function(agentInstance, task) {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return function() {};
  }
  var select = document.getElementById("item_option_new.type");
  if (!select || !select.options) {
    return function() {};
  }
  var normalize = function(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  };
  var compact = function(value) {
    return normalize(value).replace(/[\s_-]+/g, "");
  };
  var normalizedTask = compact(task);
  var namedOptions = [];
  for (var optionIndex = 0; optionIndex < select.options.length; optionIndex++) {
    var optionText = String(select.options[optionIndex].textContent || select.options[optionIndex].text || "")
      .replace(/\s+/g, " ")
      .trim();
    var normalizedOption = compact(optionText);
    if (normalizedOption && normalizedOption !== "none" && normalizedTask.indexOf(normalizedOption) !== -1) {
      namedOptions.push(optionText);
    }
  }
  if (namedOptions.length !== 1) {
    return function() {};
  }
  var expectedType = namedOptions[0];
  var onSubmit = function(event) {
    var selectedOption = select.options[select.selectedIndex];
    var actualType = String((selectedOption && (selectedOption.textContent || selectedOption.text)) || "")
      .replace(/\s+/g, " ")
      .trim();
    if (compact(actualType) === compact(expectedType)) {
      return;
    }
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (event && typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
    if (typeof window !== "undefined") {
      window.__arivuPageAgentStopReason =
        'Stopped before submit: the task requires variable Type "' + expectedType +
        '", but the persisted Select2 value is still "' + (actualType || "(blank)") +
        '". Select the unique exact suggestion and verify the displayed value before saving.';
    }
    if (agentInstance && typeof agentInstance.stop === "function") {
      agentInstance.stop().catch(function() { return undefined; });
    }
  };
  document.addEventListener("submit", onSubmit, true);
  return function() {
    document.removeEventListener("submit", onSubmit, true);
  };
})`;

/**
 * Restyles page-agent's visible automation mask. The upstream mask ships with a
 * cyan/purple WebGL border and a large arrow asset; Arivu uses a ServiceNow-inspired
 * evergreen/teal gradient and a compact reference-matched blue pointer instead. Also keeps
 * the real cursor visible (upstream hides it) and locks the mask to always swallow real
 * mouse/keyboard input instead of upstream's default of only doing so intermittently, mid-
 * action -- see the inline comment below for why this needs to win over upstream's own toggling.
 */
export const INSTALL_AGENT_VISUAL_THEME_SNIPPET = String.raw`(function() {
  var STYLE_ID = "arivu-agent-visual-theme";
  var MASK_ID = "page-agent-runtime_simulator-mask";
  var oldStyle = document.getElementById(STYLE_ID);
  if (oldStyle) oldStyle.remove();
  var styleElement = document.createElement("style");
  styleElement.id = STYLE_ID;
  styleElement.setAttribute("data-page-agent-ignore", "true");
  styleElement.textContent =
    // Upstream toggles the mask's own pointerEvents between "none" (real clicks pass through
    // to the page) and "auto" (captured and swallowed -- see its click/mousedown/wheel/keydown
    // listeners, which just stopPropagation+preventDefault) via plain inline style writes keyed
    // to whether the agent is mid-action. Both are non-!important, so this !important rule wins
    // over either one and keeps the mask permanently in the capturing state: the user's real
    // mouse/keyboard can never reach the page while the agent has it, not just during the brief
    // windows upstream would otherwise allow. The agent's own actions are unaffected -- those
    // are synthesized directly against the target element, not routed through this cascade.
    // cursor:not-allowed (not "none") keeps the real pointer visible and visually explains why
    // clicking does nothing, rather than hiding it behind the mask's own simulated cursor icon.
    "#" + MASK_ID + "{" +
      "cursor:not-allowed!important;pointer-events:auto!important;isolation:isolate}" +
    "#" + MASK_ID + ">canvas{opacity:0!important}" +
    "#" + MASK_ID + "::before{content:'';position:absolute;inset:0;pointer-events:none;padding:3px;" +
      "background:linear-gradient(115deg,#032d42,#075985,#00c49a,#62d84e,#81b5a1,#032d42);" +
      "background-size:300% 300%;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);" +
      "-webkit-mask-composite:xor;mask-composite:exclude;filter:drop-shadow(0 0 9px rgba(0,196,154,.72));" +
      "animation:arivu-agent-border 3.2s linear infinite;z-index:1}" +
    "#" + MASK_ID + ">div[class*='_cursor_']{width:34px!important;height:34px!important;margin:0!important;filter:drop-shadow(0 3px 5px rgba(3,45,66,.42));z-index:2!important}" +
    "#" + MASK_ID + ">div[class*='_cursor_']::before{content:'';position:absolute;inset:0;" +
      "background:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 34 34'%3E%3Cpath d='M4.9 3.35c-.78-.33-1.56.03-1.86.7-.11.25-.12.52-.02.82 2.3 6.9 4.64 14.1 7.03 21.78.43 1.43 2.43 1.4 2.93.03l2.9-7.43c.27-.7.79-1.22 1.47-1.47l7.87-2.66c1.43-.48 1.5-2.47.13-3.04C17.65 8.82 10.82 5.76 4.9 3.35Z' fill='%23286fbe' stroke='white' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\") center/contain no-repeat}" +
    "#" + MASK_ID + " [class*='cursorFilling'],#" + MASK_ID + " [class*='cursorBorder']{display:none!important}" +
    "#" + MASK_ID + " [class*='cursorRipple']{width:30px!important;height:30px!important;margin-left:-15px!important;margin-top:-15px!important}" +
    "#" + MASK_ID + " [class*='cursorRipple']::after{border-color:#286fbe!important;border-width:3px!important}" +
    "@keyframes arivu-agent-border{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}" +
    "@media(prefers-reduced-motion:reduce){#" + MASK_ID + "::before{animation:none}}";
  (document.head || document.documentElement).appendChild(styleElement);
  document.documentElement.setAttribute("data-arivu-agent-theme", "servicenow");
  return true;
})`;

/**
 * Interactive page-agent activity panel, upserted directly into a tab's top frame
 * by the main-process supervisor (never injected as part of the per-frame agent
 * script). Unlike the old page-agent Panel -- which lived in whichever frame the
 * agent happened to run in and could leave a second, stale instance behind when a
 * later browser_task call targeted a different frame -- this panel has exactly one
 * possible home per tab.
 *
 * It renders the tab's complete browser_task history in a bounded scrolling region.
 * The active task stays expanded with Pause/Resume and Stop controls. Terminal tasks
 * collapse automatically but retain their full action timeline and can be expanded
 * by the user. Built with createElement/textContent only, never innerHTML -- pages
 * enforcing Trusted Types (e.g. ServiceNow's polaris shell) reject raw innerHTML.
 */
export const PRESENCE_CHIP_ID = "arivu-agent-presence-chip";

export const UPDATE_PRESENCE_CHIP_SNIPPET = String.raw`(function(tasks) {
  var CHIP_ID = ${JSON.stringify(PRESENCE_CHIP_ID)};
  var STYLE_ID = CHIP_ID + "-theme";
  var STYLE_VERSION = "2";
  var style = document.getElementById(STYLE_ID);
  if (!style || style.getAttribute("data-arivu-version") !== STYLE_VERSION) {
    if (style) style.remove();
    style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute("data-page-agent-ignore", "true");
    style.setAttribute("data-arivu-version", STYLE_VERSION);
    style.textContent =
      "#" + CHIP_ID + "{position:fixed;right:14px;bottom:14px;z-index:2147483646;" +
        "width:min(380px,calc(100vw - 28px));max-height:min(470px,calc(100vh - 28px));" +
        "display:flex;flex-direction:column;overflow:hidden;border-radius:13px;" +
        "background:rgba(3,25,34,.97);border:1px solid rgba(0,196,154,.5);" +
        "box-shadow:0 0 0 1px rgba(40,111,190,.14),0 16px 44px rgba(0,15,22,.48);" +
        "font:12px/1.42 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
        "color:#e7f3ef;pointer-events:auto;isolation:isolate;text-align:left}" +
      "#" + CHIP_ID + ",#" + CHIP_ID + " *{box-sizing:border-box}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-head{display:flex;align-items:center;gap:7px;flex:none;" +
        "min-height:42px;padding:9px 11px;border-bottom:1px solid rgba(129,181,161,.18);" +
        "background:linear-gradient(110deg,rgba(3,45,66,.94),rgba(5,70,70,.9))}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-dot{width:7px;height:7px;border-radius:50%;flex:none;" +
        "background:#62d84e;box-shadow:0 0 0 rgba(98,216,78,.58);animation:" + CHIP_ID + "-pulse 1.8s ease-out infinite}" +
      "#" + CHIP_ID + "." + CHIP_ID + "-paused ." + CHIP_ID + "-dot{background:#f4c95d;animation:none}" +
      "#" + CHIP_ID + "." + CHIP_ID + "-stopping ." + CHIP_ID + "-dot{background:#ee9b5f;animation:none}" +
      "#" + CHIP_ID + "." + CHIP_ID + "-idle ." + CHIP_ID + "-dot{background:#6fae98;animation:none}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-title{font-weight:700;letter-spacing:.01em;color:#a4f1db}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-state{min-width:0;overflow:hidden;text-overflow:ellipsis;" +
        "white-space:nowrap;color:#9aafa8}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-count{margin-left:auto;flex:none;padding:2px 7px;border-radius:999px;" +
        "background:rgba(0,196,154,.1);color:#85cbb8;font-size:11px}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-list{min-height:0;overflow-y:auto;overscroll-behavior:contain;" +
        "scrollbar-width:thin;scrollbar-color:rgba(129,181,161,.45) transparent;padding:6px}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task{border:1px solid rgba(129,181,161,.14);" +
        "border-radius:9px;background:rgba(255,255,255,.025);overflow:hidden;margin-bottom:5px}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task:last-child{margin-bottom:0}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task.current,#" + CHIP_ID + " ." + CHIP_ID + "-task.paused,#" + CHIP_ID + " ." + CHIP_ID + "-task.stopping{" +
        "border-color:rgba(0,196,154,.36);background:rgba(0,196,154,.045)}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-summary{appearance:none;width:100%;border:0;margin:0;padding:7px 8px;" +
        "display:flex;align-items:flex-start;gap:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task:not(.terminal) ." + CHIP_ID + "-summary{cursor:default}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task-icon{flex:none;width:14px;padding-top:1px;text-align:center;color:#6fae98;font-weight:700}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task.failed ." + CHIP_ID + "-task-icon{color:#ef8d79}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task.stopped ." + CHIP_ID + "-task-icon{color:#eeae72}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task.current ." + CHIP_ID + "-task-icon{color:#62d84e}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task.paused ." + CHIP_ID + "-task-icon{color:#f4c95d}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task-label{min-width:0;flex:1;white-space:nowrap;overflow:hidden;" +
        "text-overflow:ellipsis;color:#a9b8b2}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task.open ." + CHIP_ID + "-task-label{white-space:normal;overflow:visible;color:#e7f3ef}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task.current ." + CHIP_ID + "-task-label,#" + CHIP_ID + " ." + CHIP_ID + "-task.paused ." + CHIP_ID + "-task-label{" +
        "color:#f1fbf8;font-weight:600}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-action-count{flex:none;color:#76958b;font-size:11px;white-space:nowrap}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-chevron{flex:none;width:12px;text-align:center;color:#729086;transition:transform .15s ease}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-task.open ." + CHIP_ID + "-chevron{transform:rotate(90deg)}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-body{padding:0 8px 8px 29px}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-controls{display:flex;gap:6px;margin:1px 0 7px}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-control{appearance:none;border:1px solid rgba(129,181,161,.35);" +
        "border-radius:7px;background:rgba(40,111,190,.15);color:#b8dfff;padding:4px 9px;font:600 11px/1.4 inherit;cursor:pointer}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-control:hover{background:rgba(40,111,190,.26);border-color:rgba(129,181,161,.62)}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-control.stop{margin-left:auto;background:rgba(194,70,58,.12);border-color:rgba(239,141,121,.32);color:#ffb2a2}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-control:disabled{opacity:.55;cursor:wait}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-phase{margin:1px 0 7px;color:#8fa39d;font-size:11px}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-timeline{display:grid;gap:5px}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-action{border-left:2px solid rgba(0,196,154,.34);padding:3px 0 3px 8px;min-width:0}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-action-head{display:flex;gap:5px;align-items:baseline;color:#9cd9c8;font-size:11px;font-weight:700}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-action-name{min-width:0;overflow-wrap:anywhere;color:#d6e9e3}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-field{display:grid;grid-template-columns:53px minmax(0,1fr);gap:5px;margin-top:2px;" +
        "color:#91a19c;font-size:11px}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-field-label{color:#668a7f}" +
      "#" + CHIP_ID + " ." + CHIP_ID + "-field-value{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#9fafa9}" +
      "@keyframes " + CHIP_ID + "-pulse{0%{box-shadow:0 0 0 0 rgba(98,216,78,.55)}70%{box-shadow:0 0 0 6px rgba(98,216,78,0)}100%{box-shadow:0 0 0 0 rgba(98,216,78,0)}}" +
      "@media(prefers-reduced-motion:reduce){#" + CHIP_ID + " ." + CHIP_ID + "-dot{animation:none}#" + CHIP_ID + " ." + CHIP_ID + "-chevron{transition:none}}";
    (document.head || document.documentElement).appendChild(style);
  }
  var chip = document.getElementById(CHIP_ID);
  if (!chip) {
    chip = document.createElement("div");
    chip.id = CHIP_ID;
    chip.setAttribute("data-page-agent-ignore", "true");
    chip.setAttribute("role", "region");
    chip.setAttribute("aria-label", "Arivu agent activity");
  }
  var previousListElement = chip.querySelector("." + CHIP_ID + "-list");
  var preservedScrollTop = previousListElement ? previousListElement.scrollTop : 0;
  var preservedScrollLeft = previousListElement ? previousListElement.scrollLeft : 0;
  var expandedTaskIds = chip.__arivuExpandedTaskIds || {};
  chip.__arivuExpandedTaskIds = expandedTaskIds;
  while (chip.firstChild) {
    chip.removeChild(chip.firstChild);
  }
  var list = Array.isArray(tasks) ? tasks : [];
  var activeTask = null;
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i] && (list[i].status === "current" || list[i].status === "paused" || list[i].status === "stopping")) {
      activeTask = list[i];
      break;
    }
  }
  var panelState = activeTask ? activeTask.status : "idle";
  chip.className = CHIP_ID + "-" + panelState;

  var head = document.createElement("div");
  head.className = CHIP_ID + "-head";
  head.setAttribute("aria-live", "polite");
  var dot = document.createElement("span");
  dot.className = CHIP_ID + "-dot";
  var title = document.createElement("span");
  title.className = CHIP_ID + "-title";
  title.textContent = "Arivu agent";
  var state = document.createElement("span");
  state.className = CHIP_ID + "-state";
  state.textContent =
    panelState === "paused"
      ? "Paused"
      : panelState === "stopping"
        ? "Stopping"
        : panelState === "current"
          ? "Working"
          : "Activity";
  var count = document.createElement("span");
  count.className = CHIP_ID + "-count";
  count.textContent = list.length + (list.length === 1 ? " task" : " tasks");
  head.appendChild(dot);
  head.appendChild(title);
  head.appendChild(state);
  head.appendChild(count);
  chip.appendChild(head);

  var listElement = document.createElement("div");
  listElement.className = CHIP_ID + "-list";
  var issueCommand = function(type, taskId, button, pendingLabel) {
    window.__arivuPageAgentPresenceCommand = {
      type: type,
      taskId: taskId,
      nonce: String(Date.now()) + "-" + String(Math.random())
    };
    if (button) {
      var priorLabel = button.textContent;
      button.disabled = true;
      button.textContent = pendingLabel;
      setTimeout(function() {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = priorLabel;
        }
      }, 2500);
    }
  };
  var appendField = function(card, fieldLabel, value) {
    if (!value) return;
    var field = document.createElement("div");
    field.className = CHIP_ID + "-field";
    var labelElement = document.createElement("span");
    labelElement.className = CHIP_ID + "-field-label";
    labelElement.textContent = fieldLabel;
    var valueElement = document.createElement("span");
    valueElement.className = CHIP_ID + "-field-value";
    valueElement.textContent = String(value);
    field.appendChild(labelElement);
    field.appendChild(valueElement);
    card.appendChild(field);
  };
  var renderTask = function(rawTask) {
    var task = rawTask || {};
    var allowedStatuses = { current: true, paused: true, stopping: true, done: true, failed: true, stopped: true };
    var status = allowedStatuses[task.status] ? task.status : "current";
    var terminal = status === "done" || status === "failed" || status === "stopped";
    var taskId = String(task.id || "");
    var open = !terminal || !!expandedTaskIds[taskId];
    var actions = Array.isArray(task.actions) ? task.actions : [];
    var row = document.createElement("div");
    row.className = CHIP_ID + "-task " + status + (terminal ? " terminal" : "") + (open ? " open" : "");
    var summary = document.createElement("button");
    summary.type = "button";
    summary.className = CHIP_ID + "-summary";
    summary.setAttribute("aria-expanded", open ? "true" : "false");
    var icon = document.createElement("span");
    icon.className = CHIP_ID + "-task-icon";
    icon.textContent =
      status === "done"
        ? "✓"
        : status === "failed"
          ? "✕"
          : status === "stopped"
            ? "■"
            : status === "paused"
              ? "Ⅱ"
              : status === "stopping"
                ? "…"
                : "▶";
    var text = document.createElement("span");
    text.className = CHIP_ID + "-task-label";
    text.textContent = String(task.instruction || "");
    var actionCount = document.createElement("span");
    actionCount.className = CHIP_ID + "-action-count";
    actionCount.textContent = actions.length + (actions.length === 1 ? " action" : " actions");
    var chevron = document.createElement("span");
    chevron.className = CHIP_ID + "-chevron";
    chevron.textContent = terminal ? "›" : "";
    summary.appendChild(icon);
    summary.appendChild(text);
    summary.appendChild(actionCount);
    summary.appendChild(chevron);
    row.appendChild(summary);

    var body = document.createElement("div");
    body.className = CHIP_ID + "-body";
    body.hidden = !open;
    if (!terminal) {
      var controls = document.createElement("div");
      controls.className = CHIP_ID + "-controls";
      var pause = document.createElement("button");
      pause.type = "button";
      pause.className = CHIP_ID + "-control pause";
      pause.textContent = status === "paused" ? "Resume" : status === "stopping" ? "Stopping…" : "Pause";
      pause.disabled = status === "stopping";
      pause.setAttribute("aria-label", status === "paused" ? "Resume this agent task" : "Pause this agent task");
      pause.addEventListener("click", function(event) {
        event.preventDefault();
        event.stopPropagation();
        issueCommand(status === "paused" ? "resume" : "pause", taskId, pause, status === "paused" ? "Resuming…" : "Pausing…");
      });
      var stop = document.createElement("button");
      stop.type = "button";
      stop.className = CHIP_ID + "-control stop";
      stop.textContent = status === "stopping" ? "Stopping…" : "Stop";
      stop.disabled = status === "stopping";
      stop.setAttribute("aria-label", "Stop this agent task");
      stop.addEventListener("click", function(event) {
        event.preventDefault();
        event.stopPropagation();
        issueCommand("stop", taskId, stop, "Stopping…");
      });
      controls.appendChild(pause);
      controls.appendChild(stop);
      body.appendChild(controls);
      var phase = document.createElement("div");
      phase.className = CHIP_ID + "-phase";
      phase.textContent =
        status === "paused"
          ? "Paused before the next page action."
          : status === "stopping"
            ? "Stopping the active page agent…"
            : task.phase
              ? String(task.phase)
              : actions.length
                ? "Preparing the next action…"
                : "Preparing the first action…";
      body.appendChild(phase);
    }
    // Build the (potentially large) action timeline lazily. Only the active task and any task the
    // user has expanded materialize their cards; a collapsed terminal task defers until its first
    // expand. This keeps each ~1s panel refresh from rebuilding every historical task's full
    // timeline on a long-lived tab, while still retaining and revealing every action on demand.
    var timelineBuilt = false;
    var fillTimeline = function() {
      if (timelineBuilt) return;
      timelineBuilt = true;
      var timeline = document.createElement("div");
      timeline.className = CHIP_ID + "-timeline";
      for (var actionIndex = 0; actionIndex < actions.length; actionIndex++) {
        var action = actions[actionIndex] || {};
        var card = document.createElement("div");
        card.className = CHIP_ID + "-action";
        var actionHead = document.createElement("div");
        actionHead.className = CHIP_ID + "-action-head";
        var step = document.createElement("span");
        var stepNumber = Number(action.stepIndex) || actionIndex + 1;
        step.textContent = "Step " + (stepNumber < 10 ? "0" + stepNumber : String(stepNumber)) + " ·";
        var actionName = document.createElement("span");
        actionName.className = CHIP_ID + "-action-name";
        actionName.textContent = String(action.name || "unknown_action");
        actionHead.appendChild(step);
        actionHead.appendChild(actionName);
        card.appendChild(actionHead);
        appendField(card, "Input", action.input);
        appendField(card, "Result", action.output);
        appendField(card, "Evaluation", action.evaluation);
        appendField(card, "Memory", action.memory);
        appendField(card, "Next", action.goal);
        timeline.appendChild(card);
      }
      if (actions.length === 0 && terminal) {
        var empty = document.createElement("div");
        empty.className = CHIP_ID + "-phase";
        empty.textContent = "No page actions were recorded.";
        timeline.appendChild(empty);
      }
      body.appendChild(timeline);
    };
    if (open) {
      fillTimeline();
    }
    row.appendChild(body);
    if (terminal) {
      summary.addEventListener("click", function() {
        open = !open;
        expandedTaskIds[taskId] = open || undefined;
        row.classList.toggle("open", open);
        summary.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
          fillTimeline();
        }
        body.hidden = !open;
      });
    }
    listElement.appendChild(row);
  };
  for (var taskIndex = 0; taskIndex < list.length; taskIndex++) {
    renderTask(list[taskIndex]);
  }
  chip.appendChild(listElement);
  var parent = document.body || document.documentElement;
  // Unconditionally (re-)append whether the chip is new or already a child; see below for why.
  parent.appendChild(chip);
  // Re-appending the panel keeps it above late page-owned overlays in DOM order, but Chromium
  // resets a descendant scroller during that move. Restore only after the move and final layout
  // attachment so live action updates cannot pull the user back to the top mid-read.
  if (previousListElement) {
    // Reading these dimensions forces Chromium to finish the flex/max-height layout before the
    // scroll write. Without that flush, the new list can still report a zero scroll range and
    // clamp the restored value back to the top until the next frame.
    var maximumScrollTop = Math.max(0, listElement.scrollHeight - listElement.clientHeight);
    listElement.scrollTop = Math.min(preservedScrollTop, maximumScrollTop);
    listElement.scrollLeft = preservedScrollLeft;
  }
})`;

/**
 * Builds a structured action timeline for the on-page activity panel. Every step
 * is retained (up to PageAgent's outer 200-step ceiling); each field is separately
 * bounded before it leaves the renderer, then validated again in the main process.
 * `startStep` lets polling return only newly completed steps instead of resending a
 * growing history once per second.
 */
export const BUILD_ACTIONS_SNIPPET = String.raw`(function(history, stepOffset, startStep) {
  var MAX_NAME_CHARS = 80;
  var MAX_FIELD_CHARS = 500;
  var offset = typeof stepOffset === "number" && stepOffset > 0 ? Math.trunc(stepOffset) : 0;
  var skip = typeof startStep === "number" && startStep > 0 ? Math.trunc(startStep) : 0;
  var actions = [];
  var stepOrdinal = 0;
  var clean = function(value, maxChars) {
    if (value === undefined || value === null) return "";
    var text = String(value).replace(/\s+/g, " ").trim();
    return text.length > maxChars ? text.slice(0, maxChars) + "… (truncated)" : text;
  };
  var stringify = function(value) {
    if (value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  };
  var list = history || [];
  for (var i = 0; i < list.length; i++) {
    var event = list[i];
    if (!event || event.type !== "step") continue;
    var currentOrdinal = stepOrdinal;
    stepOrdinal++;
    if (currentOrdinal < skip) continue;
    var eventIndex =
      typeof event.stepIndex === "number" && isFinite(event.stepIndex) && event.stepIndex >= 0
        ? Math.trunc(event.stepIndex)
        : currentOrdinal;
    var reflection = event.reflection || {};
    var action = event.action || {};
    var item = {
      stepIndex: offset + eventIndex + 1,
      name: clean(action.name || "unknown_action", MAX_NAME_CHARS)
    };
    var input = clean(stringify(action.input), MAX_FIELD_CHARS);
    var output = clean(action.output, MAX_FIELD_CHARS);
    var evaluation = clean(reflection.evaluation_previous_goal, MAX_FIELD_CHARS);
    var memory = clean(reflection.memory, MAX_FIELD_CHARS);
    var goal = clean(reflection.next_goal, MAX_FIELD_CHARS);
    if (input && input !== "undefined") item.input = input;
    if (output) item.output = output;
    if (evaluation && evaluation !== "(not recorded)") item.evaluation = evaluation;
    if (memory && memory !== "(not recorded)") item.memory = memory;
    if (goal && goal !== "(not recorded)") item.goal = goal;
    actions.push(item);
  }
  return actions;
})`;

/**
 * Condenses page-agent's ExecutionResult.history into a bounded, human-readable
 * trace plus a token total, returned to the supervising agent in the tool result.
 * This is the visibility the raw extension logs provide (per-step action, output,
 * goal, usage) without shipping rawRequest/rawResponse payloads across the bridge.
 */
export const BUILD_TRACE_SNIPPET = String.raw`(function(history, stepOffset) {
  var MAX_ENTRIES = 30;
  var MAX_ENTRY_CHARS = 220;
  var offset = typeof stepOffset === "number" && stepOffset > 0 ? stepOffset : 0;
  var entries = [];
  var tokens = 0;
  var list = history || [];
  for (var i = 0; i < list.length; i++) {
    var event = list[i];
    if (!event) continue;
    if (event.type === "step") {
      if (event.usage && typeof event.usage.totalTokens === "number") {
        tokens += event.usage.totalTokens;
      }
      var name = (event.action && event.action.name) || "?";
      var input = "";
      try {
        input = JSON.stringify(event.action && event.action.input);
      } catch (err) {
        input = "";
      }
      var output = String((event.action && event.action.output) || "").replace(/\s+/g, " ");
      var reflectionField = function(key, label) {
        var value = event.reflection && event.reflection[key];
        return value && value !== "(not recorded)" ? " | " + label + ": " + String(value).replace(/\s+/g, " ") : "";
      };
      var evaluation = reflectionField("evaluation_previous_goal", "eval");
      var memory = reflectionField("memory", "memory");
      var goal = reflectionField("next_goal", "goal");
      var inputPart = input && input !== "undefined" ? " " + input : "";
      entries.push(
        ("step " + (event.stepIndex + 1 + offset) + ": " + name + inputPart + " -> " + output + evaluation + memory + goal).slice(
          0,
          MAX_ENTRY_CHARS
        )
      );
    } else if (event.type === "observation") {
      entries.push(("observation: " + String(event.content || "").replace(/\s+/g, " ")).slice(0, MAX_ENTRY_CHARS));
    } else if (event.type === "error") {
      entries.push(("error: " + String(event.message || "").replace(/\s+/g, " ")).slice(0, MAX_ENTRY_CHARS));
    }
  }
  var omitted = entries.length - MAX_ENTRIES;
  if (omitted > 0) {
    entries = entries.slice(omitted);
    entries.unshift("(" + omitted + " earlier trace entries omitted)");
  }
  return { entries: entries, tokensUsed: tokens };
})`;
