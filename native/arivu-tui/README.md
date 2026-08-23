# Arivu native TUI

Arivu's interactive terminal is a native Rust application built with the same
core stack as Grok Build's TUI: Ratatui, Crossterm, and Grok's pinned
`xai-ratatui-inline` viewport engine.

The Rust process owns terminal input and presentation. The existing TypeScript
runtime remains responsible for models, tools, sessions, approvals, browser
tasks, and context management. They exchange typed newline-delimited JSON over
an authenticated loopback socket created for each launch.
