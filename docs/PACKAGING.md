# Packaging & Release

Arivu ships two artifacts: the **npm CLI/TUI package** and the **Electron desktop app**.

## Prerequisites

Install dev dependencies first (the packaging toolchain is in `devDependencies`):

```
npm install
```

## npm CLI package

The CLI is published from `dist/` (built by `npm run build`).

```
npm run build          # emits dist/cli.js
npm publish            # prepublishOnly re-runs the build
```

Package metadata (name, bin, repository, license, keywords) lives in `package.json`. The published
tarball contains only `dist/` (see the `files` field).

## Desktop app (electron-builder)

Configuration lives in `electron-builder.yml`. Builds first run `npm run desktop:build` to produce
`dist-desktop/`, then package with electron-builder:

```
npm run dist          # current platform, installers in release/
npm run dist:mac      # macOS dmg + zip
npm run dist:win      # Windows nsis
npm run dist:linux    # AppImage + deb
npm run dist:dir      # unpacked app (fast, for local smoke testing)
```

Output goes to `release/`.

### macOS signing & notarization

`build/notarize.cjs` runs as the electron-builder `afterSign` hook. It is a no-op unless all three
environment variables are set, so unsigned local builds still succeed:

```
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password
export APPLE_TEAM_ID="XXXXXXXXXX"
# Code-signing identity (from your Developer ID Application certificate):
export CSC_LINK="/path/to/DeveloperID.p12"                 # or base64 via CSC_LINK
export CSC_KEY_PASSWORD="..."
npm run dist:mac
```

Hardened-runtime entitlements are in `build/entitlements.mac.plist` (JIT + shelling out to local
tools). Adjust if you tighten the sandbox.

### Windows / Linux signing

Set `CSC_LINK`/`CSC_KEY_PASSWORD` (Windows Authenticode) or GPG keys (deb) via the standard
electron-builder environment variables. See the electron-builder docs for the full matrix.

## Release checklist

1. Bump `version` in `package.json`.
2. `npm run typecheck && npm test && npm run build && npm run desktop:build`.
3. `npm run dist` for the desktop installers (with signing env set for a public release).
4. `npm publish` for the CLI.
5. Attach the `release/` installers to the GitHub release.
