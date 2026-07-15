# Browser-agent benchmark validators

These scripts independently verify what a browser agent changed and restore the test
account for the next run. They do not contain credentials and use a dedicated persistent
Chromium profile under the ignored `output/playwright/` directory.

## LinkedIn profile benchmark

Create an isolated Python environment and install Chromium:

```bash
python3 -m venv .venv-browser-bench
.venv-browser-bench/bin/pip install -r benchmarks/browser/requirements.txt
.venv-browser-bench/bin/playwright install chromium
```

Copy and edit the scenario. Do not put secrets in it:

```bash
cp benchmarks/browser/linkedin_profile.scenario.example.json linkedin_profile.scenario.local.json
```

Capture the clean test-account values before running an agent. The first headed run opens
LinkedIn and waits up to five minutes for manual sign-in or a checkpoint. Login cookies are
then reused from the ignored browser-profile directory.

```bash
.venv-browser-bench/bin/python benchmarks/browser/linkedin_profile_benchmark.py \
  capture-baseline --scenario linkedin_profile.scenario.local.json
```

After the agent edits the profile, verify the configured values. Exit code `0` means every
field matched and exit code `1` means at least one mismatch. A machine-readable report is
written to `output/playwright/linkedin-benchmark/result.json`.

```bash
.venv-browser-bench/bin/python benchmarks/browser/linkedin_profile_benchmark.py \
  verify --scenario linkedin_profile.scenario.local.json
```

Restore the exact values captured before the run. Reset requires an explicit flag and then
reads every field back to verify the cleanup:

```bash
.venv-browser-bench/bin/python benchmarks/browser/linkedin_profile_benchmark.py \
  reset --scenario linkedin_profile.scenario.local.json --yes
```

The example covers the intro modal. Additional sections use the same schema. Locator specs
support `label`, `role` plus `name`, `css`, `placeholder`, or `test_id`; field kinds support
`input` (the default), `textarea`, `select`, `checkbox`, and read-only `text`. Prefer labels
and roles over CSS because LinkedIn class names change frequently.

Use only a dedicated test account. A reset writes to LinkedIn just like an agent run, so
inspect the captured baseline before using `--yes`. Reset also refuses to run if the
scenario name or resolved LinkedIn profile URL differs from the captured baseline.
