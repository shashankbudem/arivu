# linkedin-profile

Wraps the standalone validator in `benchmarks/browser/` (see its README for full setup: venv,
`playwright install chromium`, the persistent signed-in test profile, and the
`linkedin_profile.scenario.local.json` format). The scenario is skipped until that local file
exists.

Runs default to `--manual`: the harness captures the baseline, you perform the task in Arivu
desktop, then it verifies with the Python tool (`--headless`, so the persistent Playwright profile
must already be authenticated). Reset is guarded behind `--reset` **and** an interactive
confirmation.

```bash
npm run bench -- run linkedin-profile --live               # baseline → you drive Arivu → verify
npm run bench -- run linkedin-profile --live --verify-only # just verify current profile state
```

Use a dedicated test account. Automating a personal LinkedIn account is checkpoint- and
ToS-sensitive — that is why this scenario does not use the automated entry.
