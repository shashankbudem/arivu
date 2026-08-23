import { useState } from "react";
import { formatError } from "../../format";

export function FirstRunOnboarding({
  initialBaseUrl,
  initialModel,
  initialTrustMode,
  onStateUpdated,
  onDismiss
}: {
  initialBaseUrl: string;
  initialModel: string;
  initialTrustMode: TrustMode;
  onStateUpdated: (state: DesktopState) => void;
  onDismiss: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [model, setModel] = useState(initialModel);
  const [apiKey, setApiKey] = useState("");
  const [trustMode, setTrustMode] = useState<TrustMode>(initialTrustMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DoctorReport | null>(null);

  const canSubmit = baseUrl.trim().length > 0 && model.trim().length > 0 && apiKey.trim().length > 0 && !busy;
  const verified = report ? (report.summary.fail ?? 0) === 0 : false;

  async function saveAndVerify() {
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const patch = { baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim(), trustMode };
      const nextState = await window.arivu.saveConfig(patch);
      onStateUpdated(nextState);
      const doctorReport = await window.arivu.runDoctor(patch);
      setReport(doctorReport);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="onboarding-dialog" role="dialog" aria-modal="true" aria-label="Set up Arivu">
        <header className="onboarding-header">
          <h2>Welcome to Arivu</h2>
          <p>Connect an OpenAI-compatible model to get started. You can change this later in Settings.</p>
        </header>
        <label>
          <span>Base URL</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
        </label>
        <label>
          <span>Model</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1" />
        </label>
        <label>
          <span>API key</span>
          <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="sk-..." />
        </label>
        <label>
          <span>Approval mode</span>
          <select value={trustMode} onChange={(event) => setTrustMode(event.target.value as TrustMode)}>
            {trustMode === "readonly" ? <option value="readonly">Readonly (legacy)</option> : null}
            <option value="ask">Manual</option>
            <option value="trusted">Auto — Automatically approve routine actions</option>
            <option value="bypass">Bypass — Do not ask approval at all</option>
          </select>
        </label>
        {error ? <p className="onboarding-error">{error}</p> : null}
        {report ? (
          <ul className="onboarding-checks">
            {report.checks.map((check) => (
              <li key={check.id} className={`onboarding-check onboarding-check-${check.status}`}>
                <strong>{check.label}</strong>: {check.message}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="onboarding-actions">
          <button type="button" className="onboarding-skip" onClick={onDismiss}>
            Skip for now
          </button>
          {verified ? (
            <button type="button" className="onboarding-primary" onClick={onDismiss}>
              Start using Arivu
            </button>
          ) : (
            <button type="button" className="onboarding-primary" onClick={() => void saveAndVerify()} disabled={!canSubmit}>
              {busy ? "Verifying…" : "Save & verify"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
