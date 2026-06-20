# Contributing

This project is an early MVP of a local TUI coding agent. Keep changes small, testable, and biased toward preserving user work.

## Local workflow

```bash
npm install
npm run typecheck
npm test
npm run build
```

Use the linked command for manual testing:

```bash
npm link
arivu
arivu --trust readonly "Reply with exactly OK."
```

## Change standards

- Prefer targeted edits over broad rewrites.
- Add or update tests for behavior changes in config, permissions, tools, sessions, and agent loop logic.
- Keep the TUI usable in both narrow and wide terminals.
- Do not print or commit API keys, local session files, or user workspace contents.
- Preserve one-shot mode when changing the TUI.
- Preserve OpenAI-compatible request behavior unless intentionally changing provider support.

## Review checklist

- Does the change preserve path containment inside the active workspace?
- Does it avoid overwriting files the agent has not read?
- Does it respect `readonly`, `ask`, and `trusted` trust modes?
- Does it still build a working `dist/cli.js` for the linked `arivu` command?
- Are docs updated when behavior, commands, config, or safety policy changes?

