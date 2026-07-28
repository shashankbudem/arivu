import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Cpu, RefreshCw, Search, X } from "lucide-react";
import { formatError } from "../../format";
import { AUTO_MODEL_VALUE, isAutoModelId, modelDisplayName } from "./providerCatalog";

export function ModelPickerDialog({
  currentModel,
  baseUrl,
  apiKey,
  providerId,
  includeAuto = true,
  title = "Select model",
  onSelect,
  onClose
}: {
  currentModel: string;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
  includeAuto?: boolean;
  title?: string;
  onSelect: (model: string) => void;
  onClose: () => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => searchRef.current?.focus());
    void loadModels();
  }, []);

  const options = useMemo(
    () =>
      Array.from(new Set([...(includeAuto ? [AUTO_MODEL_VALUE] : []), currentModel, ...models]))
        .filter(Boolean)
        .filter((model) => includeAuto || !isAutoModelId(model)),
    [currentModel, includeAuto, models]
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter((model) => model.toLowerCase().includes(needle)) : options;
  }, [options, query]);
  const manualModel = query.trim();
  const showCustomModelAction = Boolean(error || notice || (manualModel && filtered.length === 0 && !loading));

  async function loadModels() {
    if (!baseUrl.trim()) {
      setModels([]);
      setNotice(null);
      setError("Enter a provider URL to load models, or enter a model ID manually.");
      return;
    }

    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.arivu.listModels({
        activeProviderId: providerId,
        baseUrl,
        apiKey: apiKey?.trim() || undefined
      });
      setModels(result.models);
      if (result.models.length === 0) {
        setNotice("No models were returned by this provider. Enter a model ID manually.");
      }
    } catch (err) {
      setModels([]);
      setError(`${formatError(err)} Enter a model ID manually if this provider does not expose /models.`);
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop">
      <section className="model-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="model-dialog-header">
          <div className="approval-icon">
            <Cpu size={23} />
          </div>
          <div>
            <h2>{title}</h2>
            <p>{baseUrl}</p>
          </div>
          <button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="Close model picker">
            <X size={14} />
          </button>
        </div>
        <div className="model-search-field">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={showCustomModelAction ? "Search or enter model ID" : "Search models"}
            aria-label="Search models"
          />
          <button
            className="icon-button compact-icon-button"
            type="button"
            onClick={() => void loadModels()}
            disabled={loading}
            title="Refresh models"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {error ? <div className="model-dialog-note error-note">{error}</div> : null}
        {!error && notice ? <div className="model-dialog-note">{notice}</div> : null}
        {!error && loading ? <div className="model-dialog-note">Loading available models...</div> : null}
        <div className="model-result-list">
          {filtered.length === 0 && !loading ? <div className="model-empty">No matching models.</div> : null}
          {filtered.map((model) => (
            <button
              key={model}
              className={model === currentModel ? "model-result selected" : "model-result"}
              type="button"
              title={isAutoModelId(model) ? "Automatically pick a model for each prompt." : model}
              onClick={() => onSelect(model)}
            >
              <span>{modelDisplayName(model)}</span>
              {model === currentModel ? <Check size={15} /> : null}
            </button>
          ))}
        </div>
        {showCustomModelAction ? (
          <div className="custom-model-row">
            <button className="secondary-command" type="button" onClick={() => onSelect(manualModel)} disabled={!manualModel}>
              Use custom
            </button>
          </div>
        ) : null}
      </section>
    </div>,
    document.body
  );
}
