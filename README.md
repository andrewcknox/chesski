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

## Run Locally

```bash
npm install
npm run dev
```

The app uses a Lichess API token for opening explorer calls. The token is stored locally in browser IndexedDB.

## Build

```bash
npm run build
```
