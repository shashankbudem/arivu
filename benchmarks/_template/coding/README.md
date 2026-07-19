# __ID__

Capture checklist (≈10 minutes, see BENCHMARKS.md):

1. Put the repo state the task starts from into `fixture-repo/` (zero-dependency fixtures run fastest — avoid `npm install` if you can).
2. Paste the exact prompt from your dev session into `task` in `scenario.json`.
3. Encode "what does success look like" as `verify` checks (`command`, `fileContains`, `fileEquals`, `fileAbsent`).
4. Validate: `npm run bench -- run __ID__`
5. Delete this checklist, describe the scenario, and commit the directory.
