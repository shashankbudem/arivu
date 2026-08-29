import { useState, type RefObject } from "react";
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Info,
  MessageSquare,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Server,
  Wrench,
  X
} from "lucide-react";
import { formatBytes, formatError, formatNumber } from "../../format";
import { ModelPickerDialog } from "../models/ModelPickerDialog";
import { modelDisplayName } from "../models/providerCatalog";
import { STANDALONE_PROJECT_VALUE, type ProjectOption } from "../history/projectModel";
import type { CommandOutput, SlashCommandEntry, SlashCommandId } from "../commands/commandTypes";

export function ChatSearchBar({
  inputRef,
  query,
  currentIndex,
  matchCount,
  onQueryChange,
  onPrevious,
  onNext,
  onClose
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  currentIndex: number;
  matchCount: number;
  onQueryChange: (value: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const countLabel = query.trim() ? (matchCount > 0 ? `${currentIndex + 1} / ${matchCount}` : "No matches") : "Find in chat";
  return (
    <div className="chat-search-bar" role="search">
      <Search size={15} />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search chat"
        aria-label="Search chat"
      />
      <span className={matchCount === 0 && query.trim() ? "chat-search-count empty" : "chat-search-count"}>{countLabel}</span>
      <button
        className="icon-button compact-icon-button"
        type="button"
        onClick={onPrevious}
        disabled={matchCount === 0}
        title="Previous match"
      >
        <ChevronLeft size={14} />
      </button>
      <button className="icon-button compact-icon-button" type="button" onClick={onNext} disabled={matchCount === 0} title="Next match">
        <ChevronRight size={14} />
      </button>
      <button className="icon-button compact-icon-button" type="button" onClick={onClose} title="Close search" aria-label="Close search">
        <X size={14} />
      </button>
    </div>
  );
}

export function SendArrowIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 16.25V8.45m0 0-3.15 3.15M12 8.45l3.15 3.15"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function ComposerOptionsMenu({
  state,
  busy,
  canSelectChatProject,
  selectedImageCount,
  selectedFileCount,
  toolsOpen,
  skillsOpen,
  skillCount,
  browserOpen,
  projects,
  onSelectProject,
  onOpenWorkspace,
  onChooseImages,
  onChooseContextFiles,
  onToggleTools,
  onToggleSkills,
  onToggleBrowser,
  onOpenSettings,
  onOpenSkillsSettings,
  browserTaskModelLabel,
  onOpenBrowserTaskModel,
  apiLogCount,
  onOpenApiLog
}: {
  state: DesktopState;
  busy: boolean;
  canSelectChatProject: boolean;
  selectedImageCount: number;
  selectedFileCount: number;
  toolsOpen: boolean;
  skillsOpen: boolean;
  skillCount: number;
  browserOpen: boolean;
  projects: ProjectOption[];
  onSelectProject: (projectRoot: string | null) => void;
  onOpenWorkspace: () => void;
  onChooseImages: () => void;
  onChooseContextFiles: () => void;
  onToggleTools: () => void;
  onToggleSkills: () => void;
  onToggleBrowser: () => void;
  onOpenSettings: () => void;
  onOpenSkillsSettings: () => void;
  browserTaskModelLabel: string;
  onOpenBrowserTaskModel: () => void;
  apiLogCount: number;
  onOpenApiLog: () => void;
}) {
  return (
    <div className="composer-options-menu" role="menu" aria-label="Prompt options">
      {canSelectChatProject ? (
        <div className="composer-option-row">
          <span className="composer-option-label">
            <FolderOpen size={15} />
            Project
          </span>
          <ChatProjectSelector
            selectedProjectRoot={state.projectRoot}
            projects={projects}
            onSelect={onSelectProject}
            onOpenWorkspace={onOpenWorkspace}
          />
        </div>
      ) : null}
      <div className="composer-option-row">
        <span className="composer-option-label">
          <ImageIcon size={15} />
          Images
        </span>
        <ImageAttachButton count={selectedImageCount} disabled={busy} onClick={onChooseImages} />
      </div>
      <div className="composer-option-row">
        <span className="composer-option-label">
          <FileText size={15} />
          Files
        </span>
        <FileAttachButton
          count={selectedFileCount}
          disabled={busy || state.projectRoot === null}
          disabledReason={
            busy ? "Wait for the current response before attaching file context" : "Open a workspace before attaching file context"
          }
          onClick={onChooseContextFiles}
        />
      </div>
      <div className="composer-option-row">
        <span className="composer-option-label">
          <Wrench size={15} />
          Tools
        </span>
        <ToolButton open={toolsOpen} onToggle={onToggleTools} />
      </div>
      <div className="composer-option-row">
        <span className="composer-option-label">
          <Globe size={15} />
          Browser
        </span>
        <div className="browser-option-controls">
          <button
            className={browserOpen ? "composer-tool-button active" : "composer-tool-button"}
            type="button"
            onClick={onToggleBrowser}
            title={browserOpen ? "Hide browser window" : "Show browser window"}
          >
            <Globe size={15} />
            {browserOpen ? "Window open" : "Window"}
          </button>
          <span className="browser-option-note">Agent runs hidden</span>
        </div>
      </div>
      <button className="composer-option-row composer-option-action" type="button" onClick={onOpenBrowserTaskModel}>
        <span className="composer-option-label">
          <Cpu size={15} />
          Browser LLM
        </span>
        <span>{browserTaskModelLabel}</span>
      </button>
      <div className="composer-option-row">
        <span className="composer-option-label">
          <FileText size={15} />
          Skills
        </span>
        <SkillButton open={skillsOpen} count={skillCount} onToggle={onToggleSkills} />
      </div>
      <button className="composer-option-row composer-option-action" type="button" onClick={onOpenSkillsSettings}>
        <span className="composer-option-label">
          <Plus size={15} />
          Add skill
        </span>
        <span>{skillCount} installed</span>
      </button>
      <button className="composer-option-row composer-option-action" type="button" onClick={onOpenApiLog}>
        <span className="composer-option-label">
          <Activity size={15} />
          API log
        </span>
        <span>{apiLogCount} recent</span>
      </button>
      <button className="composer-option-row composer-option-action" type="button" onClick={onOpenSettings}>
        <span className="composer-option-label">
          <Server size={15} />
          MCP
        </span>
        <span>{Object.keys(state.config.mcpServers).length} servers</span>
      </button>
    </div>
  );
}

export function ImageAttachButton({ count, disabled, onClick }: { count: number; disabled: boolean; onClick: () => void }) {
  const label = count > 0 ? `Attach images (${count})` : "Attach images";
  return (
    <button
      className={count > 0 ? "composer-tool-button active" : "composer-tool-button"}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <ImageIcon size={15} />
      Images
    </button>
  );
}

export function FileAttachButton({
  count,
  disabled,
  disabledReason,
  onClick
}: {
  count: number;
  disabled: boolean;
  disabledReason: string;
  onClick: () => void;
}) {
  const label = count > 0 ? `Attach file context (${count})` : "Attach file context";
  return (
    <button
      className={count > 0 ? "composer-tool-button active" : "composer-tool-button"}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : label}
      aria-label={label}
    >
      <FileText size={15} />
      Files
    </button>
  );
}

export function ImageAttachmentStrip({ images, onRemove }: { images: ImageAttachment[]; onRemove: (id: string) => void }) {
  return (
    <div className="image-attachment-strip" aria-label="Attached images">
      {images.map((image) => (
        <figure className="image-attachment" key={image.id}>
          <img src={image.dataUrl} alt={image.name} />
          <button type="button" onClick={() => onRemove(image.id)} title="Remove image" aria-label={`Remove ${image.name}`}>
            <X size={12} />
          </button>
        </figure>
      ))}
    </div>
  );
}

export function FileAttachmentStrip({ files, onRemove }: { files: ContextFileAttachment[]; onRemove: (id: string) => void }) {
  return (
    <div className="file-attachment-strip" aria-label="Attached file context">
      <span className="skill-context-label">
        <FileText size={13} />
        Files
      </span>
      {files.map((file) => (
        <span
          className="file-context-chip"
          key={file.id}
          title={`${file.path} - ${formatBytes(file.size)} - ${formatNumber(file.lineCount)} lines`}
        >
          <FileText size={13} />
          <span>{file.path}</span>
          <small>{file.truncated ? "truncated" : `${formatNumber(file.lineCount)} lines`}</small>
          <button type="button" onClick={() => onRemove(file.id)} title={`Remove ${file.name}`} aria-label={`Remove ${file.name}`}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

export function SkillContextStrip({
  loadedSkills,
  pendingSkills,
  onRemovePending
}: {
  loadedSkills: SkillSummary[];
  pendingSkills: SkillSummary[];
  onRemovePending: (name: string) => void;
}) {
  return (
    <div className="skill-context-strip" aria-label="Chat skills">
      <span className="skill-context-label">
        <FileText size={13} />
        Skills
      </span>
      {loadedSkills.map((skill) => (
        <span className="skill-context-chip loaded" key={`loaded-${skill.name}`} title={`Loaded in chat: $${skill.name}`}>
          <Check size={12} />${skill.name}
        </span>
      ))}
      {pendingSkills.map((skill) => (
        <span className="skill-context-chip pending" key={`pending-${skill.name}`} title={`Queued for next prompt: $${skill.name}`}>
          <span>${skill.name}</span>
          <button type="button" onClick={() => onRemovePending(skill.name)} aria-label={`Remove $${skill.name}`}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

export function ToolButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="composer-tools-region tool-popover-root">
      <button
        className={open ? "composer-tool-button active" : "composer-tool-button"}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title="Available tools"
      >
        <Wrench size={15} />
        Tools
      </button>
    </div>
  );
}

export function SkillButton({ open, count, onToggle }: { open: boolean; count: number; onToggle: () => void }) {
  const label = count === 1 ? "Show 1 skill" : `Show ${count} skills`;
  return (
    <div className="composer-skills-region skill-popover-root">
      <button
        className={open ? "composer-tool-button active" : "composer-tool-button"}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={label}
      >
        <FileText size={15} />
        Skills
      </button>
    </div>
  );
}

export function SlashCommandMenu({
  commands,
  selectedIndex,
  query,
  onSelect,
  onHighlight
}: {
  commands: SlashCommandEntry[];
  selectedIndex: number;
  query: string;
  onSelect: (command: SlashCommandEntry) => void;
  onHighlight: (index: number) => void;
}) {
  return (
    <div id="slash-command-menu" className="slash-command-menu" role="listbox" aria-label="Slash commands">
      <div className="slash-command-heading">
        <strong>Slash commands</strong>
        <span>{commands.length > 0 ? `${commands.length}` : "No match"}</span>
      </div>
      <div className="slash-command-list">
        {commands.length === 0 ? (
          <div className="slash-command-empty">No command matches /{query}</div>
        ) : (
          commands.map((command, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={command.id}
                id={`slash-command-${command.id}`}
                className={selected ? "slash-command-row selected" : "slash-command-row"}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={Boolean(command.disabledReason)}
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onSelect(command)}
              >
                <span className="slash-command-icon" aria-hidden="true">
                  <SlashCommandIcon id={command.id} />
                </span>
                <span className="slash-command-copy">
                  <span className="slash-command-title">
                    <code>/{command.command}</code>
                    <strong>{command.title}</strong>
                  </span>
                  <span>{command.disabledReason ?? command.description}</span>
                  {command.detail ? <small>{command.detail}</small> : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export function SlashCommandIcon({ id }: { id: SlashCommandId }) {
  if (id === "compact") {
    return <Scissors size={15} />;
  }
  if (id === "summarize") {
    return <MessageSquare size={15} />;
  }
  if (id === "tools") {
    return <Wrench size={15} />;
  }
  if (id === "skills") {
    return <FileText size={15} />;
  }
  if (id === "browser") {
    return <Globe size={15} />;
  }
  if (id === "loop") {
    return <RefreshCw size={15} />;
  }
  if (id === "worktree") {
    return <GitBranch size={15} />;
  }
  return <Info size={15} />;
}

export function CommandOutputPanel({ output, onClose }: { output: CommandOutput; onClose: () => void }) {
  return (
    <section className="command-output-panel" aria-label={output.title} aria-live="polite">
      <div className="command-output-heading">
        <div>
          <strong>{output.title}</strong>
          {output.subtitle ? <span>{output.subtitle}</span> : null}
        </div>
        <button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="Close command output">
          <X size={14} />
        </button>
      </div>
      <dl className="command-output-grid">
        {output.rows.map((row) => (
          <div key={row.label} className="command-output-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ToolPanel({ tools, onToggleTool }: { tools: ToolSummary[]; onToggleTool: (name: string, disabled: boolean) => void }) {
  const offCount = tools.filter((tool) => tool.disabled).length;
  return (
    <div className="composer-tools-region tool-popover" role="dialog" aria-label="Available tools">
      <div className="tool-popover-heading">
        <strong>Available tools</strong>
        <span>{offCount > 0 ? `${tools.length - offCount} of ${tools.length} on` : tools.length}</span>
      </div>
      <div className="tool-list">
        {tools.length === 0 ? (
          <div className="tool-empty">No tools loaded.</div>
        ) : (
          tools.map((tool) => (
            <article key={tool.name} className={tool.disabled ? "tool-row tool-row-off" : "tool-row"}>
              <div className="tool-row-top">
                <code>{tool.name}</code>
                <span className={`tool-status ${tool.disabled ? "blocked" : tool.status}`}>{tool.disabled ? "Off" : tool.statusLabel}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!tool.disabled}
                  aria-label={tool.disabled ? `Turn ${tool.name} on` : `Turn ${tool.name} off`}
                  title={tool.disabled ? `Turn ${tool.name} on` : `Turn ${tool.name} off`}
                  className={tool.disabled ? "tool-toggle" : "tool-toggle on"}
                  onClick={() => onToggleTool(tool.name, !tool.disabled)}
                >
                  <span className="tool-toggle-knob" aria-hidden="true" />
                </button>
              </div>
              <p>{tool.description}</p>
              {tool.scopeLabels.length > 0 ? (
                <div className="tool-scope-list" aria-label={`${tool.name} workspace scope rules`}>
                  {tool.scopeLabels.map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              ) : null}
              {tool.parameters.length > 0 ? <span className="tool-params">{tool.parameters.join(", ")}</span> : null}
            </article>
          ))
        )}
      </div>
      <div className="tool-popover-footnote">Switches save instantly and apply from the agent's next step, even mid-run.</div>
    </div>
  );
}

export function ChatProjectSelector({
  selectedProjectRoot,
  projects,
  onSelect,
  onOpenWorkspace
}: {
  selectedProjectRoot: string | null;
  projects: ProjectOption[];
  onSelect: (projectRoot: string | null) => void;
  onOpenWorkspace: () => void;
}) {
  return (
    <div className="chat-project-selector" title="Project for this new chat">
      <FolderOpen size={15} />
      <select
        aria-label="Project for this new chat"
        value={selectedProjectRoot ?? STANDALONE_PROJECT_VALUE}
        onChange={(event) => onSelect(event.target.value === STANDALONE_PROJECT_VALUE ? null : event.target.value)}
      >
        <option value={STANDALONE_PROJECT_VALUE}>No project</option>
        {projects.map((project) => (
          <option key={project.projectRoot} value={project.projectRoot}>
            {project.name}
          </option>
        ))}
      </select>
      <button
        className="icon-button compact-icon-button"
        type="button"
        onClick={onOpenWorkspace}
        title="Open workspace"
        aria-label="Open workspace"
      >
        <FolderOpen size={15} />
      </button>
    </div>
  );
}

export function SkillPanel({
  skills,
  skillsRoot,
  loadedSkillNames,
  pendingSkillNames,
  onLoadSkill,
  onRefresh,
  onAddSkill
}: {
  skills: SkillSummary[];
  skillsRoot: string;
  loadedSkillNames: string[];
  pendingSkillNames: string[];
  onLoadSkill: (skill: SkillSummary) => void;
  onRefresh: () => void;
  onAddSkill: () => void;
}) {
  return (
    <div className="composer-skills-region skill-popover" role="dialog" aria-label="Available skills">
      <div className="tool-popover-heading">
        <strong>Available skills</strong>
        <span>{skills.length}</span>
      </div>
      <div className="skill-list">
        {skills.length === 0 ? (
          <div className="tool-empty">No skills installed.</div>
        ) : (
          skills.map((skill) => {
            const loaded = loadedSkillNames.includes(skill.name);
            const pending = pendingSkillNames.includes(skill.name);
            return (
              <article key={skill.name} className={loaded || pending ? "skill-row active" : "skill-row"}>
                <div className="tool-row-top">
                  <code>${skill.name}</code>
                  <button
                    className={loaded || pending ? "skill-load-button active" : "skill-load-button"}
                    type="button"
                    onClick={() => onLoadSkill(skill)}
                    disabled={loaded}
                    aria-label={`${loaded ? "Loaded" : pending ? "Queued" : "Load"} $${skill.name}`}
                  >
                    {loaded ? "Loaded" : pending ? "Queued" : "Load"}
                  </button>
                </div>
                <strong>{skill.title}</strong>
                {skill.description ? <p>{skill.description}</p> : null}
                <span className="skill-path" title={skill.path}>
                  {skill.path}
                </span>
              </article>
            );
          })
        )}
      </div>
      <div className="skill-popover-actions">
        <span title={skillsRoot}>{skillsRoot || "Global skills directory"}</span>
        <button className="secondary-command" type="button" onClick={onRefresh}>
          <RefreshCw size={15} />
          Refresh
        </button>
        <button className="secondary-command" type="button" onClick={onAddSkill}>
          <Plus size={15} />
          Add skill
        </button>
      </div>
    </div>
  );
}

export function ModelSwitcher({
  state,
  busy,
  onSaved,
  onError,
  onOpen
}: {
  state: DesktopState;
  busy: boolean;
  onSaved: (state: DesktopState) => void;
  onError: (message: string) => void;
  onOpen?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const modelLabel = modelDisplayName(state.config.model);

  async function selectModel(nextModel: string) {
    if (!nextModel || saving) {
      return;
    }
    if (nextModel === state.config.model) {
      setOpen(false);
      return;
    }

    setSaving(true);
    try {
      const next = await window.arivu.saveConfig({ model: nextModel });
      onSaved(next);
      setOpen(false);
    } catch (err) {
      const message = formatError(err);
      onError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="model-switcher">
      <button
        className="model-dialog-trigger"
        type="button"
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
        disabled={busy || saving}
        title="Switch model"
        aria-label={`Switch model. Current model: ${modelLabel}`}
      >
        <Cpu size={15} />
        <span>{modelLabel}</span>
        <Search size={13} />
      </button>
      {open ? (
        <ModelPickerDialog
          currentModel={state.config.model}
          baseUrl={state.config.baseUrl}
          onSelect={(model) => void selectModel(model)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
