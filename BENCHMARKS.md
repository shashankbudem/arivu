# Benchmarks

Benchmarks here are **captured from real dev/test sessions**, not designed upfront. Whenever a
session hands the app an interesting task — "work through these ServiceNow TODOs", "fill this
LinkedIn profile", "fix this failing test" — snapshot it as a scenario. Over time the suite becomes
a regression and model-comparison harness whose tasks are exactly the things we actually use the
app for.

Results are **history, not CI gates**: models are nondeterministic, live sites drift, and runs cost
tokens. What CI does verify (in `tests/bench.test.ts`, part of `npm test`) is the harness itself,
against a scripted mock provider — so a scenario that fails is telling you about the app or the
model, never about a broken runner.

## Running

```bash
npm run bench -- list
npm run bench -- run coding-fix-failing-test        # headless CLI run with your configured model
npm run bench -- run all                            # live scenarios are skipped unless --live
npm run bench -- run servicenow-todos --live        # automated: headless Electron app run
npm run bench -- run linkedin-profile --live        # manual: you drive Arivu, harness verifies
```

Flags: `--live` (include live-site scenarios), `--manual` (pause for a human-driven app run),
`--verify-only` (skip setup + app run), `--reset` (restore live state afterwards), `--built` (run
`dist/cli.js` instead of tsx), `--keep` (keep temp workspaces), `--model` / `--base-url`
(compare models without touching your config), `--json`.

Each run writes `benchmarks/results/<scenario>/<timestamp>-<model>.json` (git-ignored) with the
outcome, per-assertion detail, and metrics: wall time, tool calls, tool errors, diff size, token
usage, and browser-task step counts. Exit code is nonzero if any selected scenario failed.

## Capturing a new scenario (~10 minutes)

```bash
npm run bench -- new <id> --kind coding|browser
```

1. Paste the **exact prompt** you used in the dev session into `scenario.json` `task` — verbatim,
   that's the point.
2. Snapshot the environment: coding → starting repo state into `fixture-repo/`; browser → a Python
   verifier in `benchmarks/browser/` plus a git-ignored `<id>.scenario.local.json` with
   instance/credentials (`{{key}}` tokens in the task resolve from it).
3. Encode "what does success look like" as `verify` specs.
4. Validate with `npm run bench -- run <id>`, then commit the scenario directory.

## How runs execute

- **Coding** (`kind: "coding"`): the runner copies the fixture into a temp git workspace and spawns
  the real CLI (`--trust trusted`) under an isolated `ARIVU_DATA_HOME`/`ARIVU_CONFIG_HOME`,
  enforces `bounds.timeoutMs`, then reads the saved session for metrics and runs the verify checks
  in the workspace.
- **Browser, automated** (`execution: "auto"`): the runner spawns the built Electron main with
  `ARIVU_BENCH_TASK` (the env-gated headless entry in `desktop/main/main.ts`, same pattern as the
  smoke modes). The app runs the prompt through the full desktop path — browser tools, task-run
  bookkeeping — under an isolated data home, so the one resulting session carries usage and
  browser-task metrics. Requires `npm run desktop:build` first, and the target service signed in
  once inside Arivu's browser (the Electron profile is shared — close the Arivu app during runs).
- **Browser, manual** (`execution: "manual"` or `--manual`): the harness prints the prompt, you run
  it in Arivu desktop, press Enter, and verification proceeds.

## Verifier contract (browser scenarios)

Python scripts in `benchmarks/browser/`, one per service, honoring:

- Subcommands `capture-baseline`, `verify`, `reset --yes`.
- Exit codes: `0` pass, `1` mismatch, `2` broken setup (becomes outcome `error`, not `fail`).
- Report JSON `{passed, fields: [{section, field, expected, actual, passed}]}` — each field becomes
  a scored assertion (partial credit).

Prefer the service's REST API over DOM scraping (`servicenow_todos_benchmark.py`); use Playwright
only when the UI is the only ground truth (`linkedin_profile_benchmark.py`).

## Live-site policy

Live scenarios are opt-in (`--live`) and auto-skip until their `*.scenario.local.json` exists.
Credentials live only in those git-ignored files. Use dedicated test accounts; a scenario's
verifier must scope itself so it cannot touch anything beyond the benchmark's own records (e.g.
the `BENCH-` prefix in the ServiceNow scenario).
