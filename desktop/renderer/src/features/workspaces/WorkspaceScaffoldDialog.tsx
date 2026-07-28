import { useState } from "react";
import { FolderPlus, X } from "lucide-react";

export function WorkspaceScaffoldDialog({
  onCancel,
  onCreate
}: {
  onCancel: () => void;
  onCreate: (options: WorkspaceScaffoldOptions) => void;
}) {
  const [options, setOptions] = useState<Required<WorkspaceScaffoldOptions>>({
    initGit: false,
    npmPackage: false,
    typescript: false
  });

  function toggle(key: keyof WorkspaceScaffoldOptions) {
    setOptions((current) => ({
      ...current,
      [key]: !current[key]
    }));
  }

  return (
    <div className="modal-backdrop">
      <section className="approval-dialog workspace-scaffold-dialog" role="dialog" aria-modal="true" aria-label="Create workspace">
        <div className="approval-header">
          <div className="approval-icon paste-icon">
            <FolderPlus size={24} />
          </div>
          <div>
            <h2>Create workspace</h2>
            <p>Choose the starter files to create after selecting a folder.</p>
          </div>
        </div>
        <div className="scaffold-options">
          <label className="check-option">
            <input type="checkbox" checked={options.initGit} onChange={() => toggle("initGit")} />
            <span>
              <strong>Git repository</strong>
              <small>Run git init in the new workspace.</small>
            </span>
          </label>
          <label className="check-option">
            <input type="checkbox" checked={options.npmPackage} onChange={() => toggle("npmPackage")} />
            <span>
              <strong>npm package</strong>
              <small>Create package.json with starter scripts.</small>
            </span>
          </label>
          <label className="check-option">
            <input type="checkbox" checked={options.typescript} onChange={() => toggle("typescript")} />
            <span>
              <strong>TypeScript</strong>
              <small>Create tsconfig.json and src/index.ts.</small>
            </span>
          </label>
        </div>
        <div className="approval-actions">
          <button type="button" className="deny-button" onClick={onCancel}>
            <X size={17} />
            Cancel
          </button>
          <button type="button" className="approve-button" onClick={() => onCreate(options)}>
            <FolderPlus size={17} />
            Create workspace
          </button>
        </div>
      </section>
    </div>
  );
}
