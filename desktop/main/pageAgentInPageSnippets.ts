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
  "- If execute_javascript is among your available actions and you are stuck — the same click/input_text/select attempt has now failed twice in a row, or the goal has no obvious click/type/select equivalent (reading a value the DOM doesn't expose, a hidden control, a custom widget) — use it to read the exact state you need or drive the interaction directly, then verify the result in the next browser state before continuing. Do not reach for it before trying the direct action at least twice.",
  "- If you do not know what a specific field, control, or workflow on this site expects — not a DOM mechanics problem execute_javascript can solve, but not knowing the right answer at all — use search_web with a concise, specific query before guessing further. Read the result, then act on what you learned; do not search repeatedly for the same question."
].join("\n");

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
 * A minimal, ephemeral "Arivu is working here" indicator, upserted directly into a
 * tab's top frame by the main-process supervisor (never injected as part of the
 * per-frame agent script). Unlike the old page-agent Panel -- which lived in
 * whichever frame the agent happened to run in and could leave a second, stale
 * instance behind when a later browser_task call targeted a different frame (see
 * selectBrowserTaskExecutionTarget) -- this chip has exactly one possible home per
 * tab, so there is nothing left for a later call to duplicate. Built with
 * createElement/textContent only, never innerHTML -- pages enforcing Trusted Types
 * (e.g. ServiceNow's polaris shell) reject raw innerHTML outright.
 *
 * Shows the ordered list of browser_task calls made so far on this tab (tracked
 * per-WebContents in browserTaskSupervisor.ts, capped to the most recent few):
 * finished ones collapse to a checkmark/cross + their instruction, the in-progress
 * one expands underneath with its live step detail. This is deliberately a rolling
 * window, not the full history -- Arivu's own chrome-side Activity sidebar is the
 * authoritative, unbounded record; this chip stays glanceable on the page itself.
 */
export const PRESENCE_CHIP_ID = "arivu-agent-presence-chip";

export const UPDATE_PRESENCE_CHIP_SNIPPET = String.raw`(function(tasks) {
  var CHIP_ID = ${JSON.stringify(PRESENCE_CHIP_ID)};
  var STYLE_ID = CHIP_ID + "-theme";
  var chip = document.getElementById(CHIP_ID);
  if (!chip) {
    if (!document.getElementById(STYLE_ID)) {
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.setAttribute("data-page-agent-ignore", "true");
      style.textContent =
        "#" + CHIP_ID + "{position:fixed;right:16px;bottom:16px;z-index:2147483000;" +
          "width:min(320px,calc(100vw - 32px));padding:8px 12px;border-radius:9px;" +
          "background:rgba(3,45,66,.94);border:1px solid rgba(129,181,161,.72);" +
          "box-shadow:0 0 0 1px rgba(0,196,154,.18),0 10px 28px rgba(3,45,66,.34);" +
          "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
          "color:#e7f3ef;pointer-events:none;isolation:isolate}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-head{display:flex;align-items:center;gap:6px;" +
          "font-weight:600;letter-spacing:.01em;color:#8fe3cd;margin-bottom:4px}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-dot{width:6px;height:6px;border-radius:50%;flex:none;" +
          "background:#62d84e;box-shadow:0 0 0 rgba(98,216,78,.6);animation:" + CHIP_ID + "-pulse 1.8s ease-out infinite}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-task{display:flex;align-items:flex-start;gap:6px;padding:2px 0}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-task-icon{flex:none;width:13px;text-align:center;color:#6fae98}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-task.failed ." + CHIP_ID + "-task-icon{color:#e08a6f}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-task.current ." + CHIP_ID + "-task-icon{color:#62d84e}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-task-label{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#a9b8b2}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-task.current ." + CHIP_ID + "-task-label{color:#e7f3ef;font-weight:600}" +
        "#" + CHIP_ID + " ." + CHIP_ID + "-detail{padding:2px 0 2px 19px;color:#8b9994;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        "@keyframes " + CHIP_ID + "-pulse{0%{box-shadow:0 0 0 0 rgba(98,216,78,.55)}70%{box-shadow:0 0 0 6px rgba(98,216,78,0)}100%{box-shadow:0 0 0 0 rgba(98,216,78,0)}}" +
        "@media(prefers-reduced-motion:reduce){#" + CHIP_ID + " ." + CHIP_ID + "-dot{animation:none}}";
      (document.head || document.documentElement).appendChild(style);
    }
    chip = document.createElement("div");
    chip.id = CHIP_ID;
    chip.setAttribute("data-page-agent-ignore", "true");
    chip.setAttribute("role", "status");
    chip.setAttribute("aria-live", "polite");
    var head = document.createElement("div");
    head.className = CHIP_ID + "-head";
    var dot = document.createElement("span");
    dot.className = CHIP_ID + "-dot";
    var label = document.createElement("span");
    label.textContent = "Arivu";
    head.appendChild(dot);
    head.appendChild(label);
    chip.appendChild(head);
    (document.body || document.documentElement).appendChild(chip);
  }
  var existingRows = chip.querySelectorAll("." + CHIP_ID + "-task, ." + CHIP_ID + "-detail");
  for (var i = 0; i < existingRows.length; i++) {
    existingRows[i].remove();
  }
  var list = Array.isArray(tasks) ? tasks : [];
  for (var j = 0; j < list.length; j++) {
    var task = list[j] || {};
    var status = task.status === "done" || task.status === "failed" ? task.status : "current";
    var row = document.createElement("div");
    row.className = CHIP_ID + "-task " + status;
    var icon = document.createElement("span");
    icon.className = CHIP_ID + "-task-icon";
    icon.textContent = status === "done" ? "✓" : status === "failed" ? "✕" : "▶";
    var text = document.createElement("span");
    text.className = CHIP_ID + "-task-label";
    text.textContent = String(task.instruction || "");
    row.appendChild(icon);
    row.appendChild(text);
    chip.appendChild(row);
    if (status === "current" && Array.isArray(task.detail)) {
      for (var k = 0; k < task.detail.length; k++) {
        var detailEl = document.createElement("div");
        detailEl.className = CHIP_ID + "-detail";
        detailEl.textContent = String(task.detail[k]);
        chip.appendChild(detailEl);
      }
    }
  }
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
