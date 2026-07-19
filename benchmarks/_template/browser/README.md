# __ID__

Capture checklist (see BENCHMARKS.md):

1. Paste the exact prompt from your dev session into `task`; use `{{key}}` tokens for instance URLs/names — they resolve from the git-ignored `__ID__.scenario.local.json`.
2. Write (or reuse) a Python verifier in `benchmarks/browser/` honoring the contract: `capture-baseline` / `verify` / `reset --yes`, exit 0/1/2, report JSON `{passed, fields:[{section, field, expected, actual, passed}]}`. Prefer the service's REST API over DOM scraping (see `servicenow_todos_benchmark.py`); use Playwright only when the UI is the only ground truth (see `linkedin_profile_benchmark.py`).
3. Create `__ID__.scenario.local.json` with credentials/instance details (git-ignored automatically).
4. Sign in to the target service once inside Arivu's browser — automated runs share that Electron profile. Close the Arivu app during automated runs.
5. Validate: `npm run bench -- run __ID__ --live` (add `--manual` to drive the app yourself, `--reset` to restore state).
6. Delete this checklist, describe the scenario, and commit the directory (never the `.local.json`).
