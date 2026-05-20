# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm run scan -- <dir>     # Scan directory for .md files and build search index
npm run search -- <dir> <query>  # Search indexed markdown files from CLI
npm run serve -- <dir>    # Start web UI on port 3000 (--port to override)
npm test                  # Run all tests (Node.js native test runner)
npm run test:watch        # Run tests in watch mode
```

All three main commands (`scan`, `search`, `serve`) take a directory as first argument. The project has no build step — it's plain ESM Node.js executed directly.

## Architecture

**Pipeline:** scanner → indexer → search (or server)

**scanner.js** — Walks a directory tree recursively with `fs/promises`, skipping dot-directories. Returns `[{ path, mtimeMs, size }]` for every `.md` file found. Purely filesystem; no content parsing.

**indexer.js** — Takes the scanner output, reads each file, parses YAML frontmatter with `gray-matter`, and builds a `MiniSearch` index. Returns `{ index, bodies }` where `bodies` is a `Map<path, body>` used by the search and server modules to extract context snippets. (MiniSearch stores indexed fields internally but doesn't expose the raw body text in search results, so the Map bridges that gap.) Fields indexed: `title` (boost 3x), `tags` (boost 2x), `body` (boost 1x). All support prefix search. Stored fields: `path`, `filename`, `title`, `tags`, `date`, `mtimeMs`.

**search.js** — `search(index, bodies, query)` — Queries the MiniSearch index and returns up to 20 results with relevance-sorted snippets. Uses the `bodies` Map to extract context around the first match. Returns `[{ id, score, title, filename, tags, date, snippet, ... }]`.

**server.js** — Starts an Express server with two routes: `GET /` (self-contained HTML/JS search page) and `GET /search?q=` (JSON API). The HTML is embedded directly in the server file — no templates or static assets.

**index.js** — CLI entry point using `commander`. Three subcommands: `scan`, `search`, `serve`. Each rebuilds the index from scratch (no caching).

## Conventions

**Frontmatter:** Every markdown file should have YAML frontmatter with `title`, `tags` (array), and `date` (YYYY-MM-DD). Files without frontmatter still work but get a title derived from the filename.

```
---
title: My Note Title
tags: [topic, subtopic]
date: 2026-05-18
---
```

**File naming:** Use `YYYY-MM-DD-descriptive-slug.md` for dated notes (e.g., `2026-05-18-meeting-notes.md`). Other files use a descriptive kebab-case name.

**Modules:** Each source file exports a single primary function and has no side effects. This keeps the scanner/indexer/search pipeline composable and testable in isolation.

**Tests:** Node.js native test runner (`node:test` + `node:assert`). Tests live in `test/` and operate on the real `docs/` directory — no mocks, no fixtures. The `docs/` directory doubles as sample data for tests and as a working directory user notes.
