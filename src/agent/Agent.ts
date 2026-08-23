import crypto from "node:crypto";
import type { ApprovalManager } from "../permissions/ApprovalManager.js";
import { createToolRegistry } from "../tools/registry.js";
import type { ChangeCheckpoint } from "../tools/changeCheckpoint.js";
import type { BrowserTaskModelConfig, BrowserToolController } from "../tools/browserControl.js";
import type { WebSearchProviderProfile } from "../tools/webSearchProvider.js";
import type { Elicitor } from "../tools/elicitation.js";
import type { RuntimeControl } from "../tools/runtimeControl.js";
import { detectWorkspace } from "../workspace.js";
import { chatContentToText, trimChatContent, type ChatContent } from "./content.js";
import { stripFencedCodeBlocks } from "./textualToolCalls.js";
import {
  AUTO_COMPACT_REQUEST_TOKEN_LIMIT,
  MODEL_SUMMARY_PREFIX,
  applyContextCompactionCheckpoint,
  applyModelSummary,
  compactMessagesForModelRequest,
  compactSessionMessages,
  contextMessagesForSession,
  estimateMessageTokens,
  messagesToSummarize
} from "./contextCompaction.js";
import { discoverSkills, readSkill, skillsSystemMessage } from "./skills.js";
import { parseContextLimit } from "../models/contextLimitParser.js";
import { AgentRunAbortedError } from "./types.js";
import type { AgentRunOptions, AgentSession, ChatClient, ChatMessage, ChatRequest, ChatResponse, ToolCall } from "./types.js";
import type { AppConfig } from "../config.js";
import { ensureSessionTitle } from "../sessions/sessionList.js";

const MAX_STEPS = 500;
const SYSTEM_PROMPT_VERSION = 14;
const SYSTEM_PROMPT_SIGNATURE = "You are Arivu";
const WEB_SEARCH_TOOL = "web_search";
const PARALLEL_TOOL_LIMIT = 5;
// Read-only tools with no side effects that are safe to run concurrently within one assistant turn.
// Writes, commands, browser, MCP, and web_search are intentionally excluded and stay sequential.
const PARALLEL_SAFE_TOOLS = new Set([
  "list",
  "read",
  "search",
  "git_status",
  "current_datetime",
  "current_location",
  "list_skills",
  "read_skill",
  "arivu_runtime_status"
]);
const BROWSER_STATE_TOOL = "browser_state";
const BROWSER_TASK_TOOL = "browser_task";
// Desktop sessions steer browser work toward browser_task. Terminal Browser Use sessions opt
// into direct primitives; synthetic current-page refresh still uses screenshot evidence.
const BROWSER_SCREENSHOT_TOOL = "browser_screenshot";
const LOADED_SKILL_PREFIX = "Skill loaded into chat:";
// Models sometimes attempt a tool call as plain text: imitating our textified transcript
// format ("Local tool request:"), or leaking their own chat-template syntax (<tool_call>,
// <function=...>) when the provider fails to parse it server-side. The chat client recovers
// complete, well-formed textual calls into native ones (see textualToolCalls.ts); anything
// that still reaches this guard is unparseable or truncated, so retry with a corrective
// instruction instead of accepting it as a final answer.
const TOOL_MIMICRY_PATTERN = /^\s*Local tool requests?:|<tool_call>|<function=|<minimax:tool_call>|<invoke\s+name=/m;
const MAX_TOOL_MIMICRY_RETRIES = 2;
// A genuinely empty response (no content, no tool calls, nothing filtered out) is usually a
// transient provider-side hiccup rather than a real model/logic problem -- unlike tool mimicry
// above, retrying immediately would likely just hit the same hiccup again, so this waits out a
// plausible recovery window between attempts instead.
const MAX_EMPTY_RESPONSE_RETRIES = 3;
const EMPTY_RESPONSE_RETRY_DELAY_MS = 150_000;
/** Throttle between successive provider requests within one run, to avoid tripping rate limits
 *  on multi-step tasks that make many tool-call round trips in quick succession. Not applied by
 *  default (see AgentOptions.minStepIntervalMs) -- callers opt in explicitly with this value. */
export const DEFAULT_MIN_STEP_INTERVAL_MS = 10_000;
/** A stuck summary call must not stall the run; past this the step proceeds on transient compaction. */
const AUTO_SUMMARY_TIMEOUT_MS = 120_000;
/** After an auto-summary attempt, wait for this much message growth before trying again. */
const AUTO_SUMMARY_RETRY_MESSAGE_GROWTH = 8;
/** Below this many older messages a summary would fold almost nothing; leave it to transient compaction. */
const MIN_AUTO_SUMMARY_MESSAGE_COUNT = 6;
/** Bound provider mistakes without letting a multi-TODO browser run silently terminate early. */
const MAX_BROWSER_CHECKLIST_COMPLETION_RETRIES = 4;
// Some models never internalize a tool rejection: a benchmarked ServiceNow run re-issued one
// invalid browser_task call 45 times, each rejected with the identical guard error, and burned
// most of its three hours doing so. Identical failures are tracked per (tool, error text) for the
// whole run — not per exact arguments, so retrying the same rejected pattern with a different URL
// still counts — and from the second one the model is steered twice over: an inline notice
// appended to the failing tool result, and a transient system instruction on every later step.
const REPEATED_TOOL_FAILURE_THRESHOLD = 2;
/** Identity and display use this much normalized error text; identical prefixes are the same failure. */
const REPEATED_TOOL_FAILURE_ERROR_LIMIT = 400;
/** The transient instruction lists at most this many distinct repeated failures, newest first. */
const REPEATED_TOOL_FAILURE_REPORT_LIMIT = 3;
const RUN_RECOVERY_NOTE_PREFIX = "Run recovery note:";
const RUN_RECOVERY_ERROR_LIMIT = 800;
const RUN_RECOVERY_CHECKLIST_LIMIT = 12_000;

export class Agent {
  private readonly session: AgentSession;
  /** Message count at the last auto-summary attempt; throttles re-attempts to real growth. */
  private autoSummaryFloor = 0;

  constructor(
    private readonly options: {
      client: ChatClient;
      approvals: ApprovalManager;
      cwd: string;
      projectRoot?: string | null;
      model?: string;
      baseUrl?: string;
      webSearchProvider?: WebSearchProviderProfile;
      mcpServers?: AppConfig["mcpServers"];
      scopePolicyRules?: AppConfig["workspacePolicies"][string]["scopeRules"];
      browser?: BrowserToolController;
      browserTaskModel?: BrowserTaskModelConfig;
      runtimeControl?: RuntimeControl;
      /** Terminal Browser Use sessions expose direct browser primitives instead of browser_task. */
      manualBrowserTools?: boolean;
      directEditReview?: boolean;
      /** Appended to the built-in system prompt every run (AppConfig.customSystemPrompt). */
      customInstructions?: string;
      /** Frontend renderer for the ask_user tool's structured questions; omit for headless runs. */
      elicit?: Elicitor;
      contextWindowTokens?: number;
      /**
       * Called when a live request overflows the model's context and the provider names its real
       * limit. Lets the caller record the true window for free, with no extra API calls — the
       * scheduled catalog sync deliberately skips the active model most days.
       */
      onContextWindowObserved?: (tokens: number) => void | Promise<void>;
      /** Test seam for the in-run auto-summary timeout; production uses the default. */
      autoSummaryTimeoutMs?: number;
      /** Test seam for the empty-assistant-response retry delay; production uses the default. */
      emptyResponseRetryDelayMs?: number;
      /** Pause between successive normal main-loop provider requests in this run.
       *  0/undefined (the default) means no delay -- pass DEFAULT_MIN_STEP_INTERVAL_MS or a
       *  custom value to throttle. */
      minStepIntervalMs?: number;
      checkpoint?: ChangeCheckpoint;
      session?: AgentSession;
    }
  ) {
    this.session =
      options.session ?? createSession(options.cwd, options.projectRoot, options.approvals.mode, options.model, options.baseUrl);
  }

  async run(prompt: ChatContent, runOptions: AgentRunOptions = {}): Promise<{ output: string; session: AgentSession }> {
    return this.runWithPreparedSession(prompt, runOptions, "prompt");
  }

  async continue(runOptions: AgentRunOptions = {}): Promise<{ output: string; session: AgentSession }> {
    return this.runWithPreparedSession("", runOptions, "continue");
  }

  /**
   * Model-generated summary compaction: ask the model to summarize the older conversation, then
   * save that summary as the model's derived working context while preserving every canonical
   * transcript message. Falls back to deterministic compaction if the model call fails or
   * produces nothing usable.
   */
  async summarizeContext(runOptions: AgentRunOptions = {}): Promise<{
    session: AgentSession;
    compacted: boolean;
    compactedMessageCount: number;
    remainingMessageCount: number;
    source: "model" | "deterministic" | "none";
  }> {
    throwIfAborted(runOptions.signal);
    const workingMessages = contextMessagesForSession(this.session);
    const older = messagesToSummarize(workingMessages);
    if (older.length === 0) {
      return {
        session: this.session,
        compacted: false,
        compactedMessageCount: 0,
        remainingMessageCount: workingMessages.filter((message) => message.role !== "system").length,
        source: "none"
      };
    }

    const tokenLimit = requestTokenLimitForContextWindow(this.options.contextWindowTokens);
    try {
      const summaryRequest = compactChatRequestForModel(
        {
          messages: [
            { role: "system", content: SUMMARY_INSTRUCTION },
            { role: "user", content: summaryTranscript(older) }
          ],
          tools: []
        },
        "default",
        tokenLimit
      );
      const response = await this.completeOnce(summaryRequest, { signal: runOptions.signal });
      const summary = chatContentToText(response.message.content).trim();
      if (!summary) {
        throw new Error("Model returned an empty summary.");
      }
      const compactedAt = new Date();
      const result = applyModelSummary(workingMessages, summary, { now: compactedAt });
      if (result.compacted) {
        applyContextCompactionCheckpoint(this.session, result, "model", compactedAt);
        this.touch();
      }
      return {
        session: this.session,
        compacted: result.compacted,
        compactedMessageCount: result.compactedMessageCount,
        remainingMessageCount: result.remainingMessageCount,
        source: result.compacted ? "model" : "none"
      };
    } catch (error) {
      if (error instanceof AgentRunAbortedError) {
        throw error;
      }
      // Deterministic fallback keeps the feature reliable when a provider cannot summarize.
      const compactedAt = new Date();
      const result = compactSessionMessages(workingMessages, { now: compactedAt });
      if (result.compacted) {
        applyContextCompactionCheckpoint(this.session, result, "deterministic", compactedAt);
        this.touch();
      }
      return {
        session: this.session,
        compacted: result.compacted,
        compactedMessageCount: result.compactedMessageCount,
        remainingMessageCount: result.remainingMessageCount,
        source: result.compacted ? "deterministic" : "none"
      };
    }
  }

  /**
   * In-run compaction: when the working context outgrows the request budget, derive a
   * model-written summary BEFORE the next step. The canonical transcript remains untouched.
   * Deliberately quiet about failure: on timeout or provider error the step proceeds and
   * transient request compaction still bounds the payload — a degraded request beats a stalled
   * run. A user stop still aborts.
   */
  private async maybeAutoSummarizeSession(runOptions: AgentRunOptions): Promise<void> {
    const tokenLimit = requestTokenLimitForContextWindow(this.options.contextWindowTokens) ?? AUTO_COMPACT_REQUEST_TOKEN_LIMIT;
    const workingMessages = contextMessagesForSession(this.session);
    if (estimateMessageTokens(workingMessages) <= tokenLimit) {
      return;
    }
    if (this.autoSummaryFloor > 0 && this.session.messages.length < this.autoSummaryFloor + AUTO_SUMMARY_RETRY_MESSAGE_GROWTH) {
      // A recent attempt already ran (or failed) at this size; wait for real growth so a summary
      // that could not get under the limit does not re-fire on every step.
      return;
    }
    const older = messagesToSummarize(workingMessages);
    if (older.length < MIN_AUTO_SUMMARY_MESSAGE_COUNT) {
      return;
    }
    this.autoSummaryFloor = this.session.messages.length;

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.options.autoSummaryTimeoutMs ?? AUTO_SUMMARY_TIMEOUT_MS);
    const onParentAbort = () => timeoutController.abort();
    if (runOptions.signal?.aborted) {
      onParentAbort();
    } else {
      runOptions.signal?.addEventListener("abort", onParentAbort, { once: true });
    }
    try {
      const summaryRequest = compactChatRequestForModel(
        {
          messages: [
            { role: "system", content: SUMMARY_INSTRUCTION },
            { role: "user", content: summaryTranscript(older) }
          ],
          tools: []
        },
        "default",
        tokenLimit
      );
      // Only the signal is forwarded: without onEvent the summary tokens never stream into the UI.
      const response = await this.completeOnce(summaryRequest, { signal: timeoutController.signal });
      if (response.usage) {
        await runOptions.onUsage?.(response.usage);
      }
      const summary = chatContentToText(response.message.content).trim();
      if (!summary) {
        return;
      }
      const compactedAt = new Date();
      const result = applyModelSummary(workingMessages, summary, { now: compactedAt });
      if (!result.compacted) {
        return;
      }
      applyContextCompactionCheckpoint(this.session, result, "model", compactedAt);
      this.autoSummaryFloor = this.session.messages.length;
      this.touch();
    } catch {
      // A user stop must still stop the run; anything else (timeout, provider failure) falls
      // through to the step, where transient request compaction covers the payload.
      throwIfAborted(runOptions.signal);
    } finally {
      clearTimeout(timer);
      runOptions.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  private async runWithPreparedSession(
    prompt: ChatContent,
    runOptions: AgentRunOptions,
    mode: "prompt" | "continue"
  ): Promise<{ output: string; session: AgentSession }> {
    // A signal that was already stopped never started a turn, so leave the session byte-for-byte
    // unchanged. Once setup or a model/tool step begins, however, the catch below deliberately keeps
    // every completed message so a later Continue can resume from the real partial state.
    throwIfAborted(runOptions.signal);
    const promptAlreadyInSession = runOptions.promptAlreadyInSession === true;
    const existingPromptMessage = promptAlreadyInSession ? this.session.messages.at(-1) : undefined;
    if (promptAlreadyInSession && mode !== "prompt") {
      throw new Error("A saved prompt can only be reused for prompt runs.");
    }
    if (promptAlreadyInSession) {
      if (existingPromptMessage?.role !== "user") {
        throw new Error("The saved prompt must be the last user message.");
      }
      existingPromptMessage.content = trimChatContent(existingPromptMessage.content);
    }
    const workspace = await detectWorkspace(this.options.cwd);
    const skills = await discoverSkills();
    const skillInstruction = skillsSystemMessage(skills);
    const availableSkillNames = skills.map((skill) => skill.name);
    const tools = createToolRegistry({
      workspaceRoot: workspace.root,
      approvals: this.options.approvals,
      webSearchProvider: this.options.webSearchProvider,
      mcpServers: this.options.mcpServers,
      scopePolicyRules: this.options.scopePolicyRules,
      browser: this.options.browser,
      browserTaskModel: this.options.browserTaskModel,
      runtimeControl: this.options.runtimeControl,
      manualBrowserTools: this.options.manualBrowserTools,
      onBrowserTaskProgress: (progress) => {
        void runOptions.onEvent?.({ type: "browser_task_progress", ...progress });
      },
      directEditReview: this.options.directEditReview,
      elicit: this.options.elicit,
      signal: runOptions.signal,
      checkpoint: this.options.checkpoint
    });
    this.options.runtimeControl?.setAvailableToolNames(tools.schemas.map((tool) => tool.name));

    const existingSystem = this.session.messages.find(
      (message) => message.role === "system" && chatContentToText(message.content).includes(SYSTEM_PROMPT_SIGNATURE)
    );
    if (!existingSystem) {
      this.session.messages.unshift({
        role: "system",
        content: systemPrompt(workspace.root, this.options.customInstructions, {
          manualBrowserTools: this.options.manualBrowserTools
        })
      });
      shiftTaskRunMessageIndexes(this.session, 0, 1);
    } else {
      // Rebuild the base prompt from scratch each run so it stays at the current version and reflects
      // the active workspace, rather than accreting appended sentences forever. Separate system
      // messages (loop instructions, loaded skills) are untouched.
      existingSystem.content = systemPrompt(workspace.root, this.options.customInstructions, {
        manualBrowserTools: this.options.manualBrowserTools
      });
    }

    const insertBeforeSavedPrompt = (message: ChatMessage) => {
      if (!promptAlreadyInSession || !existingPromptMessage) {
        this.session.messages.push(message);
        return;
      }
      const promptIndex = this.session.messages.indexOf(existingPromptMessage);
      const insertionIndex = promptIndex >= 0 ? promptIndex : this.session.messages.length;
      this.session.messages.splice(insertionIndex, 0, message);
      shiftTaskRunMessageIndexes(this.session, insertionIndex, 1);
    };

    const loadedSkillNames = loadedSkillNamesForSession(this.session.messages);
    const newlyLoadedSkillMessages = await skillMessagesForNames(runOptions.skillNames ?? [], availableSkillNames, loadedSkillNames);
    for (const message of newlyLoadedSkillMessages) {
      insertBeforeSavedPrompt(message);
      const name = loadedSkillNameFromMessage(message);
      if (name) {
        loadedSkillNames.add(name);
      }
    }

    const attachedSkillMessages = mode === "prompt" ? await skillMessagesForPrompt(prompt, availableSkillNames, loadedSkillNames) : [];
    if (mode === "prompt" && !promptAlreadyInSession) {
      this.session.messages.push({ role: "user", content: trimChatContent(prompt), createdAt: new Date().toISOString() });
      // Freeze a permanent title from the first real user turn so later context compaction
      // (which may drop that message) does not blank the chat list label.
      ensureSessionTitle(this.session);
    }

    const promptText = chatContentToText(prompt);
    const recoveryNotesAtStart = this.session.messages.filter(isRunRecoveryNote);
    // A terse "Continue" must inherit the original browser checklist from conversation history.
    // Otherwise the completion gate disappears exactly when a stopped/failed run needs it most.
    const browserContinuationRequested = mode === "continue" || isBrowserContinuationPrompt(promptText);
    if (!browserContinuationRequested) {
      // Recovery guidance belongs only to a continuation. A new, unrelated prompt must not be
      // biased toward resuming stale work from an earlier failed turn.
      removeRunRecoveryNotes(this.session, recoveryNotesAtStart);
    }
    const browserChecklist = browserChecklistScopeForRun(promptText, this.session.messages, browserContinuationRequested);
    const continuingBrowserRun = browserContinuationRequested && hasRecentBrowserActivity(this.session.messages);
    try {
      throwIfAborted(runOptions.signal);
      let webSearchCalls = 0;
      let browserTaskUsed = continuingBrowserRun;
      let checklistCompletionRetries = 0;
      let checklistMissingIds: string[] = [];
      let rejectedFutureIntent = false;

      const allowedToolNames = runOptions.allowedToolNames ? new Set(runOptions.allowedToolNames) : undefined;
      const toolSchemas = allowedToolNames ? tools.schemas.filter((tool) => allowedToolNames.has(tool.name)) : tools.schemas;
      const initiallyDisabled = await resolveDisabledToolNames(runOptions.disabledToolNames);
      if (
        shouldRefreshBrowserEvidence(prompt, mode, this.session.messages) &&
        !initiallyDisabled.has(BROWSER_STATE_TOOL) &&
        !initiallyDisabled.has(BROWSER_SCREENSHOT_TOOL) &&
        hasTool(toolSchemas, BROWSER_STATE_TOOL) &&
        hasTool(toolSchemas, BROWSER_SCREENSHOT_TOOL)
      ) {
        await refreshBrowserEvidence(tools, runOptions, this.session.messages);
      }

      let mimicryRetries = 0;
      let emptyResponseRetries = 0;
      let previousNormalMainRequestCompleted = false;
      const waitBeforeNextNormalMainRequest = async () => {
        if (!previousNormalMainRequestCompleted || !this.options.minStepIntervalMs) {
          return;
        }
        await delay(this.options.minStepIntervalMs, runOptions.signal);
        previousNormalMainRequestCompleted = false;
      };
      const applySteeringMessages = async () => {
        const messages = (await runOptions.takeSteeringMessages?.()) ?? [];
        if (messages.length === 0) {
          return 0;
        }
        this.session.messages.push(...messages);
        await runOptions.onSteeringMessagesApplied?.(messages);
        return messages.length;
      };
      const repeatedToolFailures: RepeatedToolFailureTracker = { nextOrder: 0, failures: new Map() };
      const emptyResponseRetryDelayMs = this.options.emptyResponseRetryDelayMs ?? EMPTY_RESPONSE_RETRY_DELAY_MS;
      for (let step = 0; step < MAX_STEPS; step += 1) {
        throwIfAborted(runOptions.signal);
        // When the transcript has outgrown the request budget, fold the older conversation into a
        // model-written summary before this step; on failure the transient compaction below copes.
        await this.maybeAutoSummarizeSession(runOptions);
        await applySteeringMessages();
        // Re-resolved every step so in-app tool toggles flipped mid-run take effect at the next
        // model request instead of waiting for the next prompt.
        const disabledToolNames = await resolveDisabledToolNames(runOptions.disabledToolNames);
        // After a web search we only withhold web_search itself (the transient instruction in
        // messagesForStep tells the model to answer from the results). Every other tool stays
        // available so a coding task that searched once can still read and edit files.
        const availableTools = toolSchemas.filter(
          (tool) => !disabledToolNames.has(tool.name) && (webSearchCalls === 0 || tool.name !== WEB_SEARCH_TOOL)
        );
        // Keep the configured pause strictly between normal main-loop requests. Waiting here
        // means tool work happens immediately after its requesting response, and a final answer
        // returns immediately rather than sitting through an unnecessary trailing delay.
        await waitBeforeNextNormalMainRequest();
        const response = await this.complete(
          {
            messages: messagesForStep(contextMessagesForSession(this.session), webSearchCalls, [
              skillInstruction,
              ...attachedSkillMessages,
              browserChecklistInstruction(browserChecklist, checklistMissingIds, checklistCompletionRetries > 0, rejectedFutureIntent),
              toolMimicryInstruction(mimicryRetries),
              repeatedToolFailureInstruction(repeatedToolFailures)
            ]),
            tools: availableTools
          },
          runOptions
        );
        if (response.usage) {
          await runOptions.onUsage?.(response.usage);
        }
        previousNormalMainRequestCompleted = true;
        const toolCalls = allowedToolCalls(response.message.toolCalls, availableTools);
        const message = {
          ...(toolCalls === response.message.toolCalls ? response.message : { ...response.message, toolCalls }),
          // Provider messages have no local transcript timestamp; stamp once when accepted.
          createdAt: response.message.createdAt ?? new Date().toISOString()
        };
        this.session.messages.push(message);

        if (!toolCalls || toolCalls.length === 0) {
          const output = chatContentToText(message.content);
          if (output.trim().length === 0) {
            // Distinguish the two very different causes of an empty turn so the failure is
            // actionable: (a) the model DID call tools, but every one was filtered out because it
            // isn't available this step (disabled tool, hallucinated name, or web_search withheld
            // after a search) — nothing could run; versus (b) the provider genuinely returned no
            // content and no tool calls (a provider hiccup or a model that stopped early).
            const requestedCalls = response.message.toolCalls ?? [];
            if (requestedCalls.length > 0) {
              const availableNames = new Set(availableTools.map((tool) => tool.name));
              const droppedNames = [...new Set(requestedCalls.map((call) => call.name).filter((name) => !availableNames.has(name)))];
              throw new Error(
                `Model returned an empty assistant response: it only called tools that are not available this turn (${droppedNames.join(
                  ", "
                )}), so nothing ran. Those tools are disabled or were withheld for this step — ask the model to use an available tool or answer directly.`
              );
            }
            if (emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
              emptyResponseRetries += 1;
              // Drop the empty turn so neither the saved session nor the retried request carries
              // it forward -- the next attempt should look identical to this one, not "answer
              // the same prompt again, but there's now an empty assistant turn in the history."
              this.session.messages.pop();
              // Preserve the existing ordering for empty-response recovery: the configured
              // main-request throttle is observed before its dedicated retry backoff. This also
              // consumes the pending interval so the next loop does not wait twice.
              await waitBeforeNextNormalMainRequest();
              // The wait below can run for minutes with no other activity -- tell the UI why,
              // so it doesn't read as a hang worth cancelling.
              await runOptions.onEvent?.({
                type: "empty_response_retry",
                // Counts total attempts (matching the "N times in a row" wording in the final
                // error below), not retries -- so "2 of 4" here and "4 times in a row" later
                // describe the same run instead of reading like two different budgets.
                attempt: emptyResponseRetries + 1,
                maxAttempts: MAX_EMPTY_RESPONSE_RETRIES + 1,
                delayMs: emptyResponseRetryDelayMs
              });
              await delay(emptyResponseRetryDelayMs, runOptions.signal);
              continue;
            }
            throw new Error(
              `Model returned an empty assistant response ${MAX_EMPTY_RESPONSE_RETRIES + 1} times in a row, ${emptyResponseRetryDelayMs / 60_000} minutes apart: the provider returned no content and no tool calls every time. This is usually a provider-side hiccup or a model that stopped early — check the API request log to see the raw response, or select another model/provider.`
            );
          }
          // Only treat the pattern as mimicry when the model truly emitted no native tool
          // calls; a response whose calls were merely filtered out as disallowed is not one.
          // Fenced code is excluded so a final answer QUOTING tool-call syntax is not retried.
          if (
            !response.message.toolCalls?.length &&
            availableTools.length > 0 &&
            TOOL_MIMICRY_PATTERN.test(stripFencedCodeBlocks(output)) &&
            mimicryRetries < MAX_TOOL_MIMICRY_RETRIES
          ) {
            mimicryRetries += 1;
            // Drop the mimicking turn so neither the saved session nor the next request keeps
            // it; the transient corrective instruction handles the retry.
            this.session.messages.pop();
            continue;
          }
          // A steering message may arrive while the provider is producing what it believes is a
          // final response. Keep that response in the transcript, append the user's new direction,
          // and take another model step instead of ending the run underneath the user.
          if ((await applySteeringMessages()) > 0) {
            emptyResponseRetries = 0;
            continue;
          }
          const incompleteChecklistIds =
            browserTaskUsed && browserChecklist ? browserChecklist.ids.filter((id) => !outputMarksTodoComplete(output, id)) : [];
          const promisesMoreBrowserWork = browserTaskUsed && outputPromisesFurtherBrowserWork(output);
          if ((incompleteChecklistIds.length > 0 || promisesMoreBrowserWork) && !outputReportsExternalBlocker(output)) {
            // A reply without a native tool call ends the run. Future-tense narration such as
            // "Let me create the remaining variables" is therefore not progress; reject it just
            // like an incomplete checklist final and explicitly demand the next real tool call.
            this.session.messages.pop();
            if (checklistCompletionRetries >= MAX_BROWSER_CHECKLIST_COMPLETION_RETRIES) {
              const missing = incompleteChecklistIds.length > 0 ? ` Missing: TODO ${incompleteChecklistIds.join(", TODO ")}.` : "";
              throw new Error(
                `Browser run did not reach a verified final after ${MAX_BROWSER_CHECKLIST_COMPLETION_RETRIES} corrective retries.${missing} The partial browser transcript was preserved so Continue can resume after inspecting current state.`
              );
            }
            checklistCompletionRetries += 1;
            checklistMissingIds = incompleteChecklistIds;
            rejectedFutureIntent = promisesMoreBrowserWork;
            continue;
          }
          emptyResponseRetries = 0;
          removeRunRecoveryNotes(this.session, recoveryNotesAtStart);
          this.touch();
          return {
            output,
            session: this.session
          };
        }

        // A step with real tool calls means this incident is over -- an unrelated empty
        // response later in the run deserves its own fresh retry budget, not a shared one.
        emptyResponseRetries = 0;
        if (toolCalls.some((call) => call.name === BROWSER_TASK_TOOL)) {
          browserTaskUsed = true;
        }
        // The corrective future-intent notice did its job once the model emitted a real tool call.
        rejectedFutureIntent = false;
        webSearchCalls += await this.executeToolCalls(toolCalls, tools, runOptions, repeatedToolFailures);
      }

      const output = `Stopped after reaching the maximum tool-call depth (${MAX_STEPS} steps). Continue to resume from here.`;
      this.session.messages.push({ role: "assistant", content: output, createdAt: new Date().toISOString() });
      this.touch();
      return {
        output,
        session: this.session
      };
    } catch (error) {
      const aborted = error instanceof AgentRunAbortedError || runOptions.signal?.aborted === true;
      // Never roll an in-progress turn back. Reads are useful continuation evidence too, and a user
      // Stop is precisely when browser side effects may already exist. Remove only an unsendable
      // empty assistant shell, repair any tool call interrupted before its result was recorded, then
      // leave a compact durable instruction explaining how the next run must resume safely.
      removeTrailingEmptyAssistant(this.session.messages);
      repairDanglingToolCalls(this.session.messages, error);
      appendRunRecoveryNote(this.session.messages, error, aborted, browserChecklist);
      this.touch();
      throw error;
    }
  }

  /**
   * Execute an assistant turn's tool calls, running consecutive read-only calls concurrently while
   * keeping writes, commands, and other side-effecting calls strictly sequential and ordered. Tool
   * result messages are always appended in the original call order to keep the tool protocol valid.
   * Returns the number of web_search calls executed.
   */
  private async executeToolCalls(
    toolCalls: NonNullable<ChatMessage["toolCalls"]>,
    tools: { execute(name: string, args: unknown): Promise<string> },
    runOptions: AgentRunOptions,
    repeatedFailures: RepeatedToolFailureTracker
  ): Promise<number> {
    let webSearchCalls = 0;
    let index = 0;
    while (index < toolCalls.length) {
      throwIfAborted(runOptions.signal);
      const start = index;
      if (isParallelSafeTool(toolCalls[start]!.name)) {
        while (index < toolCalls.length && isParallelSafeTool(toolCalls[index]!.name)) {
          index += 1;
        }
        const batch = toolCalls.slice(start, index);
        const results = await this.runToolCallBatch(batch, tools, runOptions);
        // Failure tracking happens here at append time, not inside the concurrent workers, so
        // repeat counts and their inline notices always follow the original call order.
        for (let offset = 0; offset < batch.length; offset += 1) {
          const call = batch[offset]!;
          const result = results[offset]!;
          this.appendToolResult(call, noteRepeatedToolFailure(repeatedFailures, call.name, result));
          // Append first: Desktop's event recorder persists the shared session while handling this
          // event, so the matching transcript result must already be present on disk at that point.
          await runOptions.onEvent?.({ type: "tool_result", toolCallId: call.id, name: call.name, result });
        }
      } else {
        const call = toolCalls[start]!;
        const result = await this.runSingleToolCall(call, tools, runOptions);
        this.appendToolResult(call, noteRepeatedToolFailure(repeatedFailures, call.name, result));
        await runOptions.onEvent?.({ type: "tool_result", toolCallId: call.id, name: call.name, result });
        if (call.name === WEB_SEARCH_TOOL) {
          webSearchCalls += 1;
        }
        index += 1;
      }
    }
    return webSearchCalls;
  }

  private async runToolCallBatch(
    batch: NonNullable<ChatMessage["toolCalls"]>,
    tools: { execute(name: string, args: unknown): Promise<string> },
    runOptions: AgentRunOptions
  ): Promise<string[]> {
    if (batch.length === 1) {
      return [await this.runSingleToolCall(batch[0]!, tools, runOptions)];
    }
    const results = new Array<string>(batch.length);
    let next = 0;
    const workerCount = Math.min(PARALLEL_TOOL_LIMIT, batch.length);
    const worker = async () => {
      for (;;) {
        const current = next;
        next += 1;
        if (current >= batch.length) {
          return;
        }
        results[current] = await this.runSingleToolCall(batch[current]!, tools, runOptions);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  private async runSingleToolCall(
    call: ToolCall,
    tools: { execute(name: string, args: unknown): Promise<string> },
    runOptions: AgentRunOptions
  ): Promise<string> {
    await runOptions.onEvent?.({ type: "tool_call", call });
    return tools.execute(call.name, call.arguments);
  }

  private appendToolResult(call: ToolCall, result: string) {
    this.session.messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: result,
      createdAt: new Date().toISOString()
    });
  }

  private async complete(request: ChatRequest, runOptions: AgentRunOptions): Promise<ChatResponse> {
    const tokenLimit = requestTokenLimitForContextWindow(this.options.contextWindowTokens);
    const compactedRequest = compactChatRequestForModel(request, "default", tokenLimit);
    try {
      return await this.completeOnce(compactedRequest, runOptions);
    } catch (error) {
      if (!isContextLengthError(error)) {
        throw error;
      }
      // The provider just told us the model's real window in its rejection. Record it before
      // retrying: it is the only free, always-fresh source of truth for the active model.
      this.reportObservedContextWindow(error);
      return this.completeOnce(compactChatRequestForModel(request, "aggressive", tokenLimit), runOptions);
    }
  }

  private reportObservedContextWindow(error: unknown) {
    const sink = this.options.onContextWindowObserved;
    if (!sink) {
      return;
    }
    const tokens = parseContextLimit(error instanceof Error ? error.message : String(error));
    if (!tokens) {
      return;
    }
    // Never let bookkeeping break the retry that the user is actually waiting on.
    void Promise.resolve(sink(tokens)).catch(() => undefined);
  }

  private async completeOnce(request: ChatRequest, runOptions: AgentRunOptions): Promise<ChatResponse> {
    const callOptions = { signal: runOptions.signal };
    if (!this.options.client.stream) {
      return this.options.client.complete(request, callOptions);
    }

    return this.options.client.stream(
      request,
      async (event) => {
        if (event.type === "content_delta") {
          await runOptions.onEvent?.({
            type: "assistant_delta",
            delta: event.delta
          });
          return;
        }

        await runOptions.onEvent?.({
          type: "tool_call_delta",
          toolCallId: event.id,
          index: event.index,
          name: event.name,
          argumentsDelta: event.argumentsDelta,
          argumentsText: event.argumentsText
        });
      },
      callOptions
    );
  }

  private touch() {
    this.session.updatedAt = new Date().toISOString();
  }
}

function createSession(
  cwd: string,
  projectRoot: string | null | undefined,
  trustMode: AgentSession["trustMode"],
  model?: string,
  baseUrl?: string
): AgentSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomBytes(4).toString("hex"),
    cwd,
    projectRoot: projectRoot ?? null,
    trustMode,
    model,
    baseUrl,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function systemPrompt(workspaceRoot: string, customInstructions?: string, options: { manualBrowserTools?: boolean } = {}) {
  const browserInstructions = options.manualBrowserTools
    ? [
        "This terminal session uses Browser Use direct browser primitives with an external Chrome session. It is a visible browser target, not Arivu's hidden desktop browser.",
        "Use browser_open for an exact URL or a search. It creates an agent tab by default; call browser_state, then browser_select_tab when continuing a known tab.",
        "For page interaction, call browser_snapshot first, then browser_click, browser_type, browser_scroll, or browser_select_option. Element indexes are valid only for the snapshot that returned them; take a fresh snapshot after navigation, scrolling, or any DOM-changing action.",
        "Use browser_screenshot only when actual pixels matter. If a visual-only control cannot be addressed from a snapshot, use browser_screenshot followed by browser_click_at, then verify with a fresh snapshot.",
        "browser_task is unavailable in this terminal backend. Do not start a nested Browser Use agent; Arivu remains the only model and action loop.",
        "For browser requests containing multiple TODOs, artifacts, or acceptance checks, maintain an explicit checklist and make sequential direct browser calls. Keep each action independently verifiable rather than attempting an entire multi-page workflow at once.",
        "For a browser create or update, carry the complete required field/value checklist through the direct interactions. Never submit a partial record intending to repair it later, and inspect the current page before repeating a create action.",
        "For current browser, latest page, active tab, or user-changed browser questions, call browser_state first and inspect the intended tab with browser_snapshot in the same turn. Do not answer from older browser evidence."
      ]
    : [
        "Use Arivu browser tools as hidden/background tools by default. Use visible browser mode only when the user explicitly asks to see a separate browser window.",
        "For screenshot or visual browser checks, prefer Chrome DevTools MCP through mcp_list_tools and mcp_call_tool when it is configured; fall back to browser_screenshot only when Chrome tooling is unavailable.",
        "To act on a page (click, type, fill, scroll, or select options), delegate to browser_task with a clear natural-language instruction; the low-level manual browser click/type/scroll tools are currently disabled.",
        "Do not call browser_screenshot merely before or after browser_task. The delegated task observes the page itself and returns snapshotAfter; use screenshots only when actual pixels are part of the request or text evidence is inadequate.",
        "Do not copy numeric DOM element indices from browser_state or browser_screenshot into a later browser_task instruction. Indices are snapshot-local and may change when Page Agent starts or after navigation; describe exact labels, element types/ids, and values so the browser agent resolves the current index itself.",
        "To load an explicit URL, use browser_open. browser_task is scoped inside page content and cannot control the address bar: never ask it to clear, type, or paste a URL. When browser_open is disallowed, navigate through visible page links or Back controls instead.",
        'When continuing a visible browser page, call browser_state first and pass mode:"visible" plus that visible tabId to every browser_open. Omitting mode opens the hidden background browser; do that only when hidden execution is intentional.',
        "For browser requests containing multiple TODOs, artifacts, or acceptance checks, maintain an explicit checklist and use as many sequential browser_task calls as needed within this run. Give each call one independently verifiable artifact or a small homogeneous batch; do not put an entire multi-page workflow into one delegated call.",
        "For every browser_task that creates or updates a record, copy the artifact's complete required field/value checklist into the instruction, including order, flags, reference table, and parent when specified. Never omit a required field because its index is not yet known, and never submit a partial record intending to repair it later.",
        "After every browser_task call, inspect success, data, trace, and snapshotAfter. Continue from recoverable partial progress, but do not repeat a completed create action; inspect exact names or record ids first to avoid duplicates.",
        "When browser_task reports an infrastructure failure, call arivu_runtime_status before considering a model change. Use arivu_select_browser_model only with a configured candidate and only when the user requested the change or the failure is clearly endpoint, credential, rate-limit, or network infrastructure, not when the page task itself was misunderstood.",
        "Use arivu_set_tool_state only for an explicit user request or to contain a tool that is clearly malfunctioning. Prefer run scope; use session scope only when the condition should survive later prompts in this chat.",
        "A new executable tool cannot be installed silently. Use arivu_propose_mcp_server to create a disabled review item in Settings > Integrations; never include secret values in its command, arguments, or environment keys.",
        "If browser_task reports popupOpened or says that a new tab/popup opened, call browser_state and continue on its activeTabId. Do not repeat the action that opened the popup.",
        "If browser_task rejects a direct-URL instruction, use browser_open only when that exact URL came from current browser evidence. Never feed browser_open a guessed or constructed endpoint; otherwise call browser_state and navigate through the exact visible tab, link, Back control, or related-list New button.",
        "For current browser, latest page, active tab, or user-changed browser questions, call browser_state first, then inspect the active or intended tab with browser_screenshot in the same turn before answering. Do not answer from older browser evidence."
      ];

  return [
    "You are Arivu, a local CLI coding agent.",
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    "Inspect the repo before editing. Prefer small, targeted changes.",
    "For current or recent information, use web_search once, then answer from the retrieved results.",
    "Use current_datetime for exact local date or time questions.",
    "Use current_location for approximate timezone-level location context; do not treat it as GPS or IP-based location.",
    "Read files before editing them. Use edit for exact string replacements in existing files.",
    "Use apply_patch for larger multi-hunk edits when possible.",
    "Use write_file only for new files or explicit full replacements.",
    "Run relevant tests or checks after edits when practical.",
    "For multi-step coding tasks, include a short `Plan:` section with 2-6 checklist or numbered items when it helps the user track the work.",
    ...browserInstructions,
    'For a browser run whose original prompt labels multiple "TODO N" sections, any assistant reply without a native tool call ends the whole run. Do not emit progress summaries between TODOs. The final answer must include one explicit "TODO N: complete — <verification>" line for every original TODO; otherwise keep using tools.',
    "For ServiceNow custom-combobox fields, click the exact suggestion and verify the displayed selection. Do not describe typing filter text as if it commits the value.",
    'In ServiceNow, the persistent header action labeled "Create favorite for ..." is not an open overlay. Do not ask the browser agent to close a dialog unless current browser evidence includes a visible role=dialog (or an explicit dialog title and controls).',
    "For ServiceNow related lists, use the actual New button (value=sysverb_new) for child records and the row's Open record link for edits. Do not substitute Preview, list context menus, filter breadcrumbs, or field labels.",
    'For ServiceNow Question Choices, if the related list and its New button are already visible, use that exact value=sysverb_new button directly. Never ask the browser agent to click the "Question Choices" menu or Show/Hide List first, and never describe the button as "Add New".',
    "For a variable inside an existing ServiceNow Multi-Row Variable Set, open that Variable Set record and use its Variables related-list New button. Set the child's own requested Type (for example Multi Line Text) and keep the Variable Set as its parent. Never represent an MRVS child by creating a catalog-item variable whose Type is Multi Row Variable Set.",
    "For ServiceNow record URLs, use exact observed hrefs and sys_ids; never infer an endpoint from a label. Catalog items use sc_cat_item.do, variables use item_option_new.do, and question choices use question_choice.do.",
    "Do not report a browser workflow complete from clicks or a delegated success flag alone. Verify every requested acceptance item from current browser state, and keep working through unchecked items before answering.",
    "Do not use emojis in assistant replies.",
    `The active workspace root is ${workspaceRoot}.`,
    `(Arivu system prompt v${SYSTEM_PROMPT_VERSION}.)`,
    ...(customInstructions?.trim()
      ? ["", "--- User-configured custom instructions (Settings > Custom system prompt) ---", customInstructions.trim()]
      : [])
  ].join("\n");
}

async function skillMessagesForNames(
  skillNames: string[],
  availableSkillNames: string[],
  alreadyLoadedSkillNames: Set<string>
): Promise<ChatMessage[]> {
  const available = new Set(availableSkillNames);
  const requested = Array.from(
    new Set(
      skillNames
        .map((name) => normalizeSkillRequestName(name))
        .filter((name): name is string => Boolean(name))
        .filter((name) => available.has(name))
        .filter((name) => !alreadyLoadedSkillNames.has(name))
    )
  );

  const messages = await Promise.all(
    requested.map(async (name) => {
      const skill = await readSkill(name);
      return {
        role: "system" as const,
        content: [`${LOADED_SKILL_PREFIX} ${skill.name}`, `Path: ${skill.path}`, skill.content].join("\n")
      };
    })
  );
  return messages;
}

async function skillMessagesForPrompt(
  prompt: ChatContent,
  availableSkillNames: string[],
  alreadyLoadedSkillNames = new Set<string>()
): Promise<ChatMessage[]> {
  const text = chatContentToText(prompt);
  const requested = new Set(
    Array.from(text.matchAll(/\$([a-zA-Z0-9._-]+)/g))
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name) && availableSkillNames.includes(name))
      .filter((name) => !alreadyLoadedSkillNames.has(name))
  );

  const messages = await Promise.all(
    Array.from(requested).map(async (name) => {
      const skill = await readSkill(name);
      return {
        role: "system" as const,
        content: [`Skill attached: ${skill.name}`, `Path: ${skill.path}`, skill.content].join("\n")
      };
    })
  );
  return messages;
}

function normalizeSkillRequestName(value: string) {
  const name = value.trim().replace(/^[$/]+/, "");
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "";
}

function loadedSkillNamesForSession(messages: ChatMessage[]) {
  return new Set(messages.map(loadedSkillNameFromMessage).filter((name): name is string => Boolean(name)));
}

function loadedSkillNameFromMessage(message: ChatMessage) {
  if (message.role !== "system") {
    return undefined;
  }
  const text = chatContentToText(message.content);
  const match = new RegExp(`^${escapeRegExp(LOADED_SKILL_PREFIX)}\\s+([^\\n]+)`).exec(text);
  return match?.[1]?.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shiftTaskRunMessageIndexes(session: AgentSession, insertionIndex: number, amount: number) {
  for (const run of session.taskRuns ?? []) {
    if (run.userMessageIndex >= insertionIndex) {
      run.userMessageIndex += amount;
    }
  }
}

/**
 * Ensure the tail of the transcript is a valid tool protocol after a run failed mid-flight. When an
 * error is thrown while an assistant turn's tool calls are still being executed, some tool-result
 * messages may be missing — leaving an assistant message with `toolCalls` that the provider will
 * reject on the next request ("tool_calls without matching tool results"). Append a synthetic error
 * result for each unsatisfied call so the transcript stays sendable while still recording that the
 * work happened. No-op when every tool call already has a result (the common provider-error case,
 * where the failure was in the model request itself, between fully-formed turns).
 */
function removeTrailingEmptyAssistant(messages: ChatMessage[]) {
  const tail = messages.at(-1);
  if (tail?.role === "assistant" && !tail.toolCalls?.length && chatContentToText(tail.content).trim().length === 0) {
    messages.pop();
  }
}

function repairDanglingToolCalls(messages: ChatMessage[], error: unknown) {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.toolCalls?.length) {
      assistantIndex = index;
      break;
    }
    // A user/system message after the last tool-calling assistant means that turn is already closed.
    if (message?.role === "user" || message?.role === "assistant") {
      return;
    }
  }
  const assistant = assistantIndex >= 0 ? messages[assistantIndex] : undefined;
  if (!assistant?.toolCalls?.length) {
    return;
  }
  const satisfied = new Set(
    messages
      .slice(assistantIndex + 1)
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => message.toolCallId)
  );
  const detail = compactRunErrorDetail(error);
  for (const call of assistant.toolCalls) {
    if (satisfied.has(call.id)) {
      continue;
    }
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: `Tool "${call.name}" did not finish: the run was interrupted by an error before its result was recorded (${detail}).`
    });
  }
}

function appendRunRecoveryNote(messages: ChatMessage[], error: unknown, aborted: boolean, checklist: BrowserChecklistScope | undefined) {
  const lines = [
    `${RUN_RECOVERY_NOTE_PREFIX} The immediately preceding agent run ${aborted ? "was stopped by the user" : "failed before it finished"}.`,
    aborted ? undefined : `Failure: ${compactRunErrorDetail(error)}`,
    checklist ? `Original browser completion scope remains: ${checklist.ids.map((id) => `TODO ${id}`).join(", ")}.` : undefined,
    checklist ? durableChecklistExcerpts(checklist) : undefined,
    "All preceding assistant tool calls and tool results are durable partial-work evidence. On continuation, inspect those results and current external state, keep successful side effects, and resume only unfinished work. Never repeat a successful create/update merely because the prior run stopped."
  ].filter((line): line is string => Boolean(line));
  const content = lines.join("\n");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isRunRecoveryNote(message)) {
      // Keep one stable marker instead of accumulating an immortal system message per failure.
      // Updating in place also leaves every task-run userMessageIndex untouched.
      message.content = content;
      return;
    }
  }
  messages.push({ role: "system", content });
}

function isRunRecoveryNote(message: ChatMessage) {
  return message.role === "system" && chatContentToText(message.content).startsWith(RUN_RECOVERY_NOTE_PREFIX);
}

function removeRunRecoveryNotes(session: AgentSession, notes: ChatMessage[]) {
  const noteSet = new Set(notes);
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (!noteSet.has(session.messages[index]!)) {
      continue;
    }
    session.messages.splice(index, 1);
    for (const run of session.taskRuns ?? []) {
      if (run.userMessageIndex > index) {
        run.userMessageIndex -= 1;
      }
    }
  }
}

function durableChecklistExcerpts(checklist: BrowserChecklistScope) {
  const lines = ["Original browser checklist requirements (preserved for continuation):"];
  let remaining = RUN_RECOVERY_CHECKLIST_LIMIT - lines[0]!.length;
  for (const excerpt of checklist.excerpts) {
    if (remaining <= 0) {
      break;
    }
    const line = `- ${excerpt}`.slice(0, remaining);
    lines.push(line);
    remaining -= line.length + 1;
  }
  return lines.join("\n");
}

function compactRunErrorDetail(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|password)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, RUN_RECOVERY_ERROR_LIMIT);
}

function isBrowserContinuationPrompt(prompt: string) {
  const text = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  return /^(?:please\s+)?(?:continue|resume|proceed|keep going|go on)(?:\s+(?:the|this|from|with|where|working)\b.*)?[.!?]*$/.test(text);
}

function browserChecklistScopeForRun(
  prompt: string,
  messages: ChatMessage[],
  browserContinuationRequested = isBrowserContinuationPrompt(prompt)
): BrowserChecklistScope | undefined {
  const direct = browserChecklistScope(prompt);
  if (direct || !browserContinuationRequested) {
    return direct;
  }

  // Prefer the most recent explicit user checklist. If compaction already folded that prompt, its
  // model summary is the next-best durable source. Assistant completion prose is deliberately not
  // searched because it may mention only the subset it happened to finish.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" && message?.role !== "system") {
      continue;
    }
    const text = chatContentToText(message.content);
    if (message.role === "system" && !text.startsWith(MODEL_SUMMARY_PREFIX) && !text.startsWith(RUN_RECOVERY_NOTE_PREFIX)) {
      continue;
    }
    const inherited = browserChecklistScope(text);
    if (inherited) {
      return inherited;
    }
  }
  return undefined;
}

function shouldRefreshBrowserEvidence(prompt: ChatContent, mode: "prompt" | "continue", messages: ChatMessage[]) {
  if (mode !== "prompt") {
    return false;
  }

  const text = chatContentToText(prompt).toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }
  // An explicit browser_task request is already an observe/act loop and returns
  // snapshotAfter. A synthetic screenshot before it adds latency, can race the
  // BrowserView compositor, and supplies snapshot-local indices that must not be
  // copied into the delegated instruction.
  if (/\bbrowser_task\b/.test(text)) {
    return false;
  }

  const hasBrowserSubject = /\b(browser|chrome|tab|tabs|website|web site|webpage|web page|portal)\b/.test(text);
  const hasCurrentPageSubject =
    /\b(current|latest|active|opened|open|visible|loaded)\s+(?:page|site)\b/.test(text) ||
    /\b(?:page|site)\s+(?:opened|open|visible|loaded)\b/.test(text);
  const browserTarget = "(?:browser|tab|tabs|website|web site|webpage|web page|portal)";
  const currentPageTarget = "(?:current|latest|active|opened|open|visible|loaded)\\s+(?:page|site)";
  const asksForCurrentBrowser =
    /\b(can you see|do you see|look at|what is on|what's on|what is in|what's in)\b/.test(text) ||
    new RegExp(`\\b(?:check|inspect)\\s+(?:the\\s+)?(?:current|latest|active|opened|open|visible|loaded)?\\s*${browserTarget}\\b`).test(
      text
    ) ||
    new RegExp(`\\b(?:check|inspect)\\s+(?:the\\s+)?${currentPageTarget}\\b`).test(text) ||
    /\b(current|latest|active|opened|open|visible|loaded)\s+(?:browser|tab|page|website|web site|webpage|web page|site|portal)\b/.test(
      text
    ) ||
    /\b(?:browser|tab|page|website|web site|webpage|web page|site|portal)\s+(?:opened|open|visible|loaded)\b/.test(text);
  if ((hasBrowserSubject || hasCurrentPageSubject) && asksForCurrentBrowser) {
    return true;
  }

  const browserTaskContinuation =
    /\b(logged in|i have logged|i'm logged|login|continue|proceed|done|fire up|request instance|open instance|instance)\b/.test(text);
  // These continuation words are noisy, so gate the synthetic refresh on there being recent browser
  // activity and on not having already spent a synthetic refresh in the last few messages.
  return browserTaskContinuation && hasRecentBrowserActivity(messages) && !hasRecentSyntheticBrowserRefresh(messages);
}

function hasRecentBrowserActivity(messages: ChatMessage[]) {
  return messages.slice(-16).some((message) => {
    if (message.role === "tool" && message.name?.startsWith("browser_")) {
      return true;
    }
    return message.toolCalls?.some((call) => call.name.startsWith("browser_")) ?? false;
  });
}

function hasRecentSyntheticBrowserRefresh(messages: ChatMessage[]) {
  return messages
    .slice(-8)
    .some(
      (message) =>
        message.role === "tool" &&
        (message.toolCallId?.startsWith(`${BROWSER_STATE_TOOL}_`) === true ||
          message.toolCallId?.startsWith(`${BROWSER_SCREENSHOT_TOOL}_`) === true)
    );
}

async function refreshBrowserEvidence(
  tools: { execute(name: string, args: unknown): Promise<string> },
  runOptions: AgentRunOptions,
  messages: ChatMessage[]
) {
  const stateResult = await executeSyntheticToolCall(tools, runOptions, messages, {
    id: syntheticToolCallId(BROWSER_STATE_TOOL),
    name: BROWSER_STATE_TOOL,
    arguments: {}
  });
  // If reading state failed, do not spend a second synthetic call chasing a screenshot.
  if (isToolErrorResult(stateResult)) {
    return;
  }
  await executeSyntheticToolCall(tools, runOptions, messages, {
    id: syntheticToolCallId(BROWSER_SCREENSHOT_TOOL),
    name: BROWSER_SCREENSHOT_TOOL,
    arguments: browserScreenshotArgsFromStateResult(stateResult)
  });
}

function isToolErrorResult(result: string) {
  return result.startsWith("Error:");
}

async function executeSyntheticToolCall(
  tools: { execute(name: string, args: unknown): Promise<string> },
  runOptions: AgentRunOptions,
  messages: ChatMessage[],
  call: ToolCall
) {
  messages.push({ role: "assistant", content: "", toolCalls: [call], createdAt: new Date().toISOString() });
  await runOptions.onEvent?.({ type: "tool_call", call });
  const result = await tools.execute(call.name, call.arguments);
  await runOptions.onEvent?.({
    type: "tool_result",
    toolCallId: call.id,
    name: call.name,
    result
  });
  messages.push({
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: result,
    createdAt: new Date().toISOString()
  });
  return result;
}

function syntheticToolCallId(name: string) {
  return `${name}_${crypto.randomUUID()}`;
}

function browserScreenshotArgsFromStateResult(result: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const state = parseJsonRecord(result);
  const activeMode = stringField(state, "activeMode");
  if (activeMode === "visible") {
    args.mode = "visible";
    const visible = recordField(state, "visible");
    const tabId = stringField(visible, "activeTabId") ?? stringField(visible, "id") ?? firstBrowserTabId(visible);
    if (tabId) {
      args.tabId = tabId;
    }
  } else if (activeMode === "background") {
    args.mode = "background";
  }
  return args;
}

function parseJsonRecord(value: string) {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function recordField(record: Record<string, unknown> | undefined, key: string) {
  return asRecord(record?.[key]);
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstBrowserTabId(record: Record<string, unknown> | undefined) {
  const tabs = record?.tabs;
  if (!Array.isArray(tabs)) {
    return undefined;
  }
  return tabs
    .map(asRecord)
    .map((tab) => stringField(tab, "id"))
    .find((id): id is string => Boolean(id));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasTool(tools: ChatRequest["tools"], name: string) {
  return tools.some((tool) => tool.name === name);
}

async function resolveDisabledToolNames(source: AgentRunOptions["disabledToolNames"]): Promise<Set<string>> {
  if (!source) {
    return new Set();
  }
  return new Set(typeof source === "function" ? await source() : source);
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new AgentRunAbortedError();
  }
}

/** Waits out ms, rejecting immediately (instead of after the full delay) if the run is cancelled. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentRunAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isParallelSafeTool(name: string) {
  return PARALLEL_SAFE_TOOLS.has(name);
}

/** Share of a model's real context window the request may occupy before transient compaction. */
export const CONTEXT_BUDGET_FRACTION = 0.9;
/** Never leave the model less than this much room to answer, however small its window is. */
const MIN_RESPONSE_RESERVE_TOKENS = 1_024;
const MIN_REQUEST_TOKEN_LIMIT = 2_000;

/**
 * Converts a model's context window into the request-token budget that triggers transient compaction.
 *
 * The reserve is a clamp, not a floor. The previous `Math.max(4_000, …)` floor inverted the intent:
 * on a 4,096-token model it produced a 4,000-token budget — 97.6% of the window, leaving ~96 tokens
 * to answer with. Taking `min(fraction, window - reserve)` instead means the fraction is honored on
 * every real-world window and only tightens where the fraction is physically unsafe (below ~10k).
 */
function requestTokenLimitForContextWindow(contextWindowTokens: number | undefined): number | undefined {
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return undefined;
  }
  const budget = Math.min(Math.floor(contextWindowTokens * CONTEXT_BUDGET_FRACTION), contextWindowTokens - MIN_RESPONSE_RESERVE_TOKENS);
  return Math.max(MIN_REQUEST_TOKEN_LIMIT, budget);
}

const SUMMARY_INSTRUCTION = [
  "You are compacting a coding-assistant conversation to free up context. Write a brief that lets the assistant continue seamlessly.",
  "Use short bullet sections, and include a section ONLY when the transcript actually has content for it:",
  "- Goal and constraints: what the user wants, plus any limits or preferences they stated.",
  "- Decisions: choices already made, and rejected alternatives that must not be relitigated.",
  "- Files and code: exact paths touched and their current state (edited, created, reverted, pending).",
  "- Commands and results: what was run and its outcome. Keep the error text of FAILING commands verbatim; summarize passing ones in a few words.",
  "- Browser and web: URLs or apps worked in, what was found or done there, and exact names or ids of anything created.",
  "- Pending: open TODOs, blockers, and unverified assumptions.",
  "- Next step: the single concrete action to take next.",
  "Do not invent details or add commentary; only summarize what is present.",
  'Write plain prose and bullets only — never tool-call syntax (no "Local tool request:" lines, no <tool_call> blocks).'
].join("\n");

function summaryTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return `Tool ${message.name ?? "result"}: ${chatContentToText(message.content)}`;
      }
      const text = chatContentToText(message.content).trim();
      const toolCalls = message.toolCalls?.length ? `\n[tool calls: ${message.toolCalls.map((call) => call.name).join(", ")}]` : "";
      const role = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
      return `${role}: ${text}${toolCalls}`;
    })
    .join("\n\n");
}

function messagesForStep(
  messages: ChatMessage[],
  webSearchCalls: number,
  skillInstructions: Array<ChatMessage | undefined>
): ChatMessage[] {
  const transientInstructions = [...skillInstructions, webSearchInstruction(webSearchCalls)].filter((message): message is ChatMessage =>
    Boolean(message)
  );
  if (transientInstructions.length === 0) {
    return messages;
  }

  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystem === -1) {
    return [...messages, ...transientInstructions];
  }
  return [...messages.slice(0, firstNonSystem), ...transientInstructions, ...messages.slice(firstNonSystem)];
}

function toolMimicryInstruction(mimicryRetries: number): ChatMessage | undefined {
  if (mimicryRetries === 0) {
    return undefined;
  }

  return {
    role: "system",
    content: [
      'Your previous reply wrote a tool invocation as plain text (a "Local tool request:" block, <tool_call>/<function=...>, or <minimax:tool_call>/<invoke ...> template syntax). Text like that executes nothing and may have been truncated.',
      "Invoke the tool now with a real native tool call. Do not describe or narrate the call in text."
    ].join("\n")
  };
}

type RepeatedToolFailure = {
  name: string;
  error: string;
  count: number;
  /** Monotonic recency marker so the instruction can list the newest offenders first. */
  order: number;
};

type RepeatedToolFailureTracker = {
  nextOrder: number;
  failures: Map<string, RepeatedToolFailure>;
};

/**
 * Track identical failing tool results across the run and, from the second identical failure on,
 * append an inline corrective notice to the failing result itself — right where the model is
 * reading. Counts are cumulative for the run, not consecutive: the pathological pattern this
 * catches interleaves the same rejected call with otherwise productive steps.
 */
function noteRepeatedToolFailure(tracker: RepeatedToolFailureTracker, name: string, result: string): string {
  if (!isToolErrorResult(result)) {
    return result;
  }
  const error = result.replace(/\s+/g, " ").trim().slice(0, REPEATED_TOOL_FAILURE_ERROR_LIMIT);
  const key = `${name}\n${error}`;
  const entry = tracker.failures.get(key) ?? { name, error, count: 0, order: 0 };
  entry.count += 1;
  entry.order = tracker.nextOrder;
  tracker.nextOrder += 1;
  tracker.failures.set(key, entry);
  if (entry.count < REPEATED_TOOL_FAILURE_THRESHOLD) {
    return result;
  }
  return [
    result,
    `Repeated failure: ${name} has returned this exact error ${entry.count} times in this run. Repeating the call unchanged is expected to fail the same way every time. Follow the remediation in the error text above, or change the arguments, tool, or approach before calling again.`
  ].join("\n\n");
}

/**
 * Transient step instruction naming the run's repeated identical tool failures. The inline notice
 * on a failing result eventually scrolls into compaction; this one is rebuilt for every later
 * request and stays pinned with the leading system messages, the way the checklist and mimicry
 * instructions do.
 */
function repeatedToolFailureInstruction(tracker: RepeatedToolFailureTracker): ChatMessage | undefined {
  const repeated = Array.from(tracker.failures.values())
    .filter((failure) => failure.count >= REPEATED_TOOL_FAILURE_THRESHOLD)
    .sort((a, b) => b.order - a.order)
    .slice(0, REPEATED_TOOL_FAILURE_REPORT_LIMIT);
  if (repeated.length === 0) {
    return undefined;
  }
  return {
    role: "system",
    content: [
      "Repeated failing tool calls detected in this run:",
      ...repeated.map((failure) => `- ${failure.name} failed ${failure.count} times with the identical error: ${failure.error}`),
      "A tool call that already failed will fail the same way again if repeated unchanged. Never re-issue one of these calls as-is: apply the remediation the error describes, or use different arguments, another tool, or another approach."
    ].join("\n")
  };
}

type BrowserChecklistScope = {
  ids: string[];
  excerpts: string[];
};

function browserChecklistScope(prompt: string): BrowserChecklistScope | undefined {
  const matches = Array.from(prompt.matchAll(/\bTODO\s*#?\s*(\d+)\b/gi)).flatMap((match) =>
    match.index === undefined || !match[1] ? [] : [{ id: match[1], index: match.index }]
  );
  const uniqueIds = Array.from(new Set(matches.map((match) => match.id)));
  if (uniqueIds.length < 2) {
    return undefined;
  }
  const excerpts = matches.map((match, index) =>
    prompt
      .slice(match.index, matches[index + 1]?.index ?? prompt.length)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_600)
  );
  return { ids: uniqueIds, excerpts };
}

function browserChecklistInstruction(
  checklist: BrowserChecklistScope | undefined,
  missingIds: string[],
  includeExcerpts: boolean,
  rejectedFutureIntent: boolean
): ChatMessage | undefined {
  if (!checklist && !rejectedFutureIntent) {
    return undefined;
  }
  const lines = ["A reply without a native tool call ends this entire run. Do not send a progress summary between browser actions."];
  if (checklist) {
    lines.push(
      `Original browser completion gate: ${checklist.ids.map((id) => `TODO ${id}`).join(", ")}.`,
      `Keep using tools until every original TODO is verified. The final must contain one line "TODO N: complete — <verification>" for each of: ${checklist.ids.join(", ")}.`
    );
    if (missingIds.length > 0) {
      lines.push(
        `Your previous no-tool reply was rejected because these original checklist items were not explicitly complete: ${missingIds
          .map((id) => `TODO ${id}`)
          .join(", ")}. Resume from current browser state now.`
      );
    }
    if (includeExcerpts) {
      lines.push("Original checklist excerpts:", ...checklist.excerpts.map((excerpt) => `- ${excerpt}`));
    }
  }
  if (rejectedFutureIntent) {
    lines.push(
      'Your previous no-tool reply only announced a future action (for example, "Let me create the remaining items"). That reply executed nothing and was rejected. Invoke the next native browser tool now, or report a concrete external blocker.'
    );
  }
  return { role: "system", content: lines.join("\n") };
}

function outputMarksTodoComplete(output: string, id: string): boolean {
  // Scan EVERY line that mentions this TODO id, not just the first. A model that writes
  // "TODO 1: in progress" earlier and "TODO 1: complete — verified" later has completed it; keying
  // off the first mention alone would reject that final and force a spurious completion retry.
  const lines = output.matchAll(new RegExp(`^\\s*(?:[-*|]\\s*)?TODO\\s*#?\\s*${escapeRegExp(id)}\\b[^\\n]*$`, "gim"));
  for (const match of lines) {
    const line = match[0];
    if (
      /\b(?:complete|completed|done|verified|passed)\b/i.test(line) &&
      !/\b(?:blocked|failed|incomplete|pending|unverified|not\s+complete)\b/i.test(line)
    ) {
      return true;
    }
  }
  return false;
}

function outputReportsExternalBlocker(output: string): boolean {
  return /\b(?:captcha|requires?\s+your\s+(?:input|approval)|please\s+(?:unlock|confirm)|blocked\s+on\s+(?:external|user))\b/i.test(output);
}

function outputPromisesFurtherBrowserWork(output: string) {
  const text = stripFencedCodeBlocks(output).replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }
  const action =
    "add|create|update|edit|delete|remove|fix|submit|save|verify|inspect|check|open|navigate|click|select|fill|enter|type|upload|download|continue|resume|proceed|retry|finish|complete";
  return (
    new RegExp(
      `\\b(?:let me|i(?:'ll| will| need to| am going to|'m going to)|now i can|next[, ]+i(?:'ll| will))\\s+(?:now\\s+)?(?:${action})\\b`,
      "i"
    ).test(text) ||
    /\b(?:switching|moving)\s+to\s+(?:another\s+)?(?:browser|browser_open|browser_task|tool|approach|page|tab)\b/i.test(text)
  );
}

function webSearchInstruction(webSearchCalls: number): ChatMessage | undefined {
  if (webSearchCalls === 0) {
    return undefined;
  }

  return {
    role: "system",
    content: [
      "You already have web_search results for this user request.",
      "Answer now using those results and cite source names or URLs when relevant.",
      "Do not call web_search again for this request."
    ].join("\n")
  };
}

/**
 * Tool JSON-Schemas ride along on every request but are not part of `messages`, so the compaction
 * estimate never saw them. The old 40% headroom absorbed that silently; a 90% budget does not, so
 * they are charged against the budget explicitly. Same chars/4 heuristic the message estimator uses.
 */
function estimateToolSchemaTokens(tools: ChatRequest["tools"]): number {
  if (!tools || tools.length === 0) {
    return 0;
  }
  return Math.ceil(JSON.stringify(tools).length / 4);
}

function compactChatRequestForModel(request: ChatRequest, mode: "default" | "aggressive" = "default", tokenLimit?: number): ChatRequest {
  // Only chargeable against a real, known window. Leaving `undefined` alone preserves the
  // conservative 48k default that compactMessagesForModelRequest applies for unknown models.
  const messageTokenLimit =
    tokenLimit === undefined ? undefined : Math.max(MIN_REQUEST_TOKEN_LIMIT, tokenLimit - estimateToolSchemaTokens(request.tools));
  const result = compactMessagesForModelRequest(
    request.messages,
    mode === "aggressive"
      ? {
          force: true,
          recentMessageCount: 4,
          entryCharacterLimit: 350,
          recentEntryCharacterLimit: 3_000,
          activeUserMessageCharacterLimit: 16_000,
          tokenLimit: messageTokenLimit
        }
      : { tokenLimit: messageTokenLimit }
  );
  if (!result.compacted) {
    return request;
  }
  return {
    ...request,
    messages: result.messages
  };
}

function isContextLengthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(maximum context length|context length|reduce the length of the messages|too many tokens|exceeded[^.]*token|messages resulted in \d+ tokens)/i.test(
    message
  );
}

function allowedToolCalls(toolCalls: ChatMessage["toolCalls"], availableTools: ChatRequest["tools"]) {
  if (!toolCalls || toolCalls.length === 0) {
    return toolCalls;
  }
  const available = new Set(availableTools.map((tool) => tool.name));
  return toolCalls.filter((call) => available.has(call.name));
}
