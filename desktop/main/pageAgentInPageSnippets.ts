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
  '- Checkboxes: checked=true in the browser state means the box is already ON; checked=false means OFF. Clicking toggles it. Never click a checkbox to "verify" or "ensure" its state — click only when its current state differs from what the task needs.',
  "- Native <select> elements: use select_dropdown_option with the visible option text. Clicking a <select> element does nothing useful.",
  "- Autocomplete/reference inputs (search-as-you-type fields): after input_text a suggestion list usually appears — the correct next action is to click the matching suggestion (new elements are marked with *[). The typed text alone does not commit the value.",
  '- Lines like "(N more plain text lines omitted)" mean long non-interactive text was shortened to save space. All interactive [index] elements are still listed.'
].join("\n");

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
 * own history (the core interpolates the fields unconditionally). The system
 * instruction above is the real fix; this removes the confusing artifact when a
 * model ignores it anyway.
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
})`;

/**
 * Condenses page-agent's ExecutionResult.history into a bounded, human-readable
 * trace plus a token total, returned to the supervising agent in the tool result.
 * This is the visibility the raw extension logs provide (per-step action, output,
 * goal, usage) without shipping rawRequest/rawResponse payloads across the bridge.
 */
export const BUILD_TRACE_SNIPPET = String.raw`(function(history) {
  var MAX_ENTRIES = 30;
  var MAX_ENTRY_CHARS = 220;
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
      var goal =
        event.reflection && event.reflection.next_goal && event.reflection.next_goal !== "(not recorded)"
          ? " | goal: " + String(event.reflection.next_goal).replace(/\s+/g, " ")
          : "";
      var inputPart = input && input !== "undefined" ? " " + input : "";
      entries.push(("step " + (event.stepIndex + 1) + ": " + name + inputPart + " -> " + output + goal).slice(0, MAX_ENTRY_CHARS));
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
