# servicenow-todos

The app works through three TODO tasks in a **live ServiceNow instance** (a free
[Personal Developer Instance](https://developer.servicenow.com) works). Ground truth and reset use
the REST Table API (`benchmarks/browser/servicenow_todos_benchmark.py`, stdlib-only Python); the
agent under test only ever drives the UI.

## One-time setup

1. Create `servicenow_todos.scenario.local.json` **in this directory** (git-ignored):

   ```json
   {
     "instance_url": "https://devNNNNN.service-now.com",
     "username": "admin",
     "password": "…",
     "table": "task",
     "prefix": "BENCH-"
   }
   ```

2. In the instance, create two seed tasks the scenario mutates (any state/priority):
   - `BENCH-Renew-license`
   - `BENCH-Update-runbook`

3. Sign in to the instance once inside Arivu's browser — the automated bench run shares that
   Electron profile, so the session must already exist. Close the Arivu desktop app before an
   automated run (two Electron instances sharing one profile can conflict).

## Running

```bash
npm run bench -- run servicenow-todos --live          # capture-baseline → app run → verify
npm run bench -- run servicenow-todos --live --reset  # …then restore the seed tasks via the API
npm run bench -- run servicenow-todos --live --manual # you drive Arivu yourself; harness verifies
```

The verifier only reads/writes records whose short description starts with the configured prefix,
so it cannot touch anything else in the instance.
