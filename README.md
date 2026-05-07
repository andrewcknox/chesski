# Chesski

Chesski is a local chess repertoire trainer built with React, TypeScript, Vite, and IndexedDB.

It supports:

- repertoire training with spaced repetition
- auto-generated opening lines from player books, Lichess databases, and engine checks
- imported player PGNs for "steal their openings" study
- local username/password account vault for token and study data snapshots
- chess history cloze cards
- PGN game review against your repertoire
- multiple standard or siloed repertoire projects

## Download (Windows)

1. Go to the [Releases](https://github.com/andrewcknox/chesski/releases) page
2. Download `CheskiSetup.exe` from the latest release
3. Run it — next, next, finish
4. Double-click the **Chesski** desktop icon

A small terminal window will appear while Chesski is running (this is the local server). Your browser opens automatically. Close the terminal to stop Chesski.

## Run Locally (developers)

```bash
npm install
npm run dev
```

The app uses a Lichess API token for opening explorer calls. The token is stored locally in browser IndexedDB.

## Build

```bash
npm run build
```

## Build Windows Installer (locally)

Requires [Inno Setup 6](https://jrsoftware.org/isdl.php) installed.

```bash
npm run build:exe        # builds Vite app + packages Chesski.exe
iscc installer\chesski.iss   # produces release\CheskiSetup.exe
```

Releases are built automatically by GitHub Actions when you push a `v*` tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```
