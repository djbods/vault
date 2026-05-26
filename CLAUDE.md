# CLAUDE.md — Vault (Personal Cinema)

Read this file at the start of every session before touching code. It's the
canonical reference for what vault is, how the pieces fit together, and the
conventions to respect.

---

## What this is

A self-hosted, single-user Netflix for your own footage. No cloud, no auth,
no signup. The whole app is two files on disk:

- `server.js` — Express server: byte-range streaming, library management,
  torrent ingestion, ffmpeg pipeline, TMDB proxy.
- `index.html` — Single-file frontend: vanilla JS, no build step, no
  framework. All UI, state, and API calls live inside this file.

Library files live in a configurable directory (defaults to `./videos`, can
point at iCloud Drive). Torrents download into a separate local cache.

---

## How to run

```bash
npm install
npm start            # node server.js
# or
npm run dev          # node --watch server.js
```

Server listens on `http://localhost:3001`. The same origin serves the UI at
`/` and the API everywhere else. Opening `index.html` via `file://` also
works — the frontend talks to `http://localhost:3001` explicitly.

Requires `ffmpeg` + `ffprobe` on `$PATH` (Homebrew: `brew install ffmpeg`).

---

## Tech stack

| Layer    | Tech                                                          |
|----------|---------------------------------------------------------------|
| Server   | Node + Express 4, multer (uploads), webtorrent v3, dotenv     |
| Media    | ffmpeg / ffprobe (spawned as child processes)                 |
| Frontend | Vanilla JS in a single `index.html`, no bundler               |
| Fonts    | Playfair Display (display) + DM Sans (body) from Google Fonts |
| Storage  | Plain filesystem — videos, posters, subtitles as sidecars     |
| External | TMDB API (optional, for poster + metadata lookup)             |

No database. No build pipeline. No client framework. Keep it that way unless
there's a concrete reason to break the rule.

---

## File layout

```
vault/
├── server.js              # Express server (≈1250 lines, one file)
├── index.html             # Entire frontend (≈2920 lines, one file)
├── package.json
├── .env                   # Local overrides (gitignored)
├── .env.example           # Documented env vars
├── .gitignore
├── README.md              # Human-facing intro (currently stale vs reality)
├── CLAUDE.md              # ← this file
├── videos/                # Default LIBRARY_DIR (created at boot, gitignored)
└── torrent-cache/         # Default TORRENT_DIR (gitignored)
```

Library sidecars (in `LIBRARY_DIR`, alongside each video):
- `<base>.mp4`            — the video itself (always `.mp4` after import)
- `<base>.poster.<ext>`   — JPG / PNG / WEBP poster
- `<base>.<lang>.vtt`     — subtitle file per language (`<base>.en.vtt`,
  `<base>.es.vtt`); duplicates get numeric suffixes (`.en2.vtt`)

Staging area (inside `TORRENT_DIR/uploads`): raw uploads land here first so
the un-transcoded source isn't synced to iCloud, then are deleted once
`prepareForLibrary` has written the final `.mp4`.

---

## Environment variables

All optional. See `.env.example` for the full annotated version.

- `PORT` — defaults to `3001`.
- `LIBRARY_DIR` — where finished videos + sidecars live. Defaults to
  `./videos`. Leading `~` is expanded. Point at iCloud Drive for cross-Mac
  sync (disable "Optimize Mac Storage" or files get dehydrated to
  placeholders that can't stream).
- `TORRENT_DIR` — where in-progress torrents download to. **Keep this
  local.** Every piece write triggers an iCloud upload otherwise.
- `TMDB_API_KEY` — enables `/tmdb/*` routes (poster search + fetch). Without
  it those routes return 503 and the UI silently hides TMDB buttons.

---

## Server architecture (server.js)

### Route map

```
GET    /                                 → serves index.html
POST   /upload                           → multipart file → ffmpeg → library
GET    /videos                           → list library files (with poster paths)
GET    /videos/:filename/probe           → codec / container / sub stream info
POST   /videos/:filename/reprocess       → re-run ffmpeg pipeline on an existing file
GET    /stream/:filename                 → byte-range video stream
POST   /videos/:filename/rename          → rename video + all sidecars
DELETE /videos/:filename                 → remove video + all sidecars
POST   /upload-subtitles                 → upload SRT/VTT, write as <base>.<lang>.vtt
GET    /subtitles/:filename              → list subtitles for a video
DELETE /subtitles/:videoName/:subName    → remove one subtitle sidecar
GET    /stream-subtitle/:filename        → serve VTT (auto-converts SRT)
GET    /poster/:filename                 → serve poster image
POST   /upload-poster                    → upload poster sidecar
DELETE /poster/:videoName                → remove poster sidecar
GET    /tmdb/status                      → { configured: bool }
GET    /tmdb/suggest-query               → clean a filename → search string
GET    /tmdb/search                      → proxy TMDB /search/movie
POST   /tmdb/fetch-poster                → download poster from TMDB, write sidecar
POST   /torrent                          → add magnet, returns torrent state
GET    /torrents                         → list active torrents
GET    /torrent/:infoHash/stream         → byte-range stream of main video file
GET    /torrent/:infoHash/subtitles/:f   → serve subtitle from torrent (SRT → VTT)
POST   /torrent/:infoHash/save-to-library → ffmpeg the torrent into LIBRARY_DIR
DELETE /torrent/:infoHash                → remove torrent + wipe its store
```

### Library import pipeline (`prepareForLibrary`)

Runs on every upload and every torrent save-to-library:

1. `ffprobe` for video + audio codec.
2. Spawn `ffmpeg`:
   - Video: always `-c:v copy` (no re-encode, fast, lossless).
   - Audio: `copy` if codec is in `BROWSER_FRIENDLY_AUDIO`
     (`aac`, `mp3`, `opus`, `vorbis`, `flac`); otherwise re-encode to
     `aac 256k`.
   - HEVC: add `-tag:v hvc1` so Chrome/Safari accept the hvcC params.
   - Always `-movflags +faststart` so byte-range plays from the first
     request.
3. Output is always `<base>.mp4` regardless of input container.

### Subtitle extraction (`extractEmbeddedSubtitles`)

Runs after every import. `ffprobe` lists subtitle streams; each
text-codec stream (`subrip`/`srt`/`ass`/`ssa`/`mov_text`/`webvtt`/`text`) is
extracted to `<base>.<lang>.vtt`. Bitmap codecs (PGS / DVB / DVD / xsub)
need OCR — they're logged and skipped. Existing sidecar files are
preserved (manual uploads + torrent siblings win over embedded streams).

### Torrent flow

- One `WebTorrent` singleton (`webtorrentReady`), created via dynamic
  `import()` from CJS.
- `torrentState` map: `infoHash → { torrent, mainFileIndex,
  subtitleIndices, subtitleCache, savingToLibrary }`.
- On `metadata`/`ready`, the largest video file is auto-selected as the
  main file; sibling `.srt`/`.vtt` files are also selected; everything
  else is deselected (saves bandwidth on multi-file torrents).
- `pipeTorrentRange` handles byte-range streaming with explicit cleanup —
  browser aborts must not crash the WebTorrent client (it would wipe all
  in-progress downloads).
- Save-to-library: only when `progress >= 1`. Runs `prepareForLibrary`
  + writes subtitle sidecars + extracts embedded subs from the source +
  removes the torrent with `destroyStore: true`.
- `process.on('unhandledRejection' | 'uncaughtException', …)` is wired
  up specifically to keep the WebTorrent client alive on flaky stream
  errors. Don't remove these handlers.

### Path safety

- `resolveSafe(filename)` — `path.basename` strip + dirname check; rejects
  anything that escapes `LIBRARY_DIR`. Use this for every `:filename`
  param. Never trust raw user input as a filesystem path.
- `sanitize(name)` — replaces anything outside `[a-zA-Z0-9._\- ]` with `_`,
  collapses whitespace. Used for display-name → on-disk-name.

---

## Frontend architecture (index.html)

Single file, single `<script>` tag at the bottom. Logically divided by
`// ----` comment headers:

```
DOM refs → State → Helpers → Tabs → Modals → Upload staging →
TMDB picker → Edit modal → Hover preview → Player + subtitles →
Library → Torrents → Boot
```

Key sections:

- **Tabs** — two top-level views: Library (`#viewLibrary`) and Torrents
  (`#viewTorrents`). Toggled by adding `.active` to one `.view` at a time.
- **Upload modal** — drag-and-drop or browse. Stages poster + subtitle
  selections in memory, posts them sequentially after the video upload
  succeeds.
- **TMDB picker modal** — shared between the upload flow and the edit
  modal. Search → grid of results → "Use this poster" downloads via
  `/tmdb/fetch-poster`.
- **Edit modal** — per-card. Rename, poster (upload / TMDB / remove),
  subtitle add/remove, re-process video file (shows codec/container
  probe + a "Re-process" action that runs `/videos/:filename/reprocess`).
- **Hover preview** — Netflix-style: card expands to 16:9 landscape on
  hover, video starts muted at 0.5s; `attachAnchorOnHover` flips the
  expansion anchor to left/right when the card is near a grid edge so it
  doesn't overflow.
- **Player modal** — `<video controls>` with native browser chrome, plus
  a custom in-frame title bar and CC dropdown (`#playerCC` + `#subMenu`)
  for multi-language subtitle switching. The bigger Netflix-style player
  is planned but not built yet.
- **Library grid** — `#grid`, currently `repeat(auto-fill, minmax(250px,
  1fr))`. Portrait poster cards (`aspect-ratio: 2/3` at rest) that expand
  to landscape on hover.
- **Torrent cards** — `.t-card` with progress bar, DL speed, peers, size,
  Watch button (enabled at 2%+ progress), Save-to-library button (only
  at 100%). Polled list every few seconds.

---

## Design system

| Token            | Value                       | Use                              |
|------------------|-----------------------------|----------------------------------|
| `--bg`           | `#08070a`                   | Page background                  |
| `--bg-elevated`  | `#111017`                   | Modals, cards                    |
| `--surface`      | `rgba(255,255,255,0.035)`   | Glass surfaces                   |
| `--gold`         | `#d4a04a`                   | Primary accent — CTAs, highlights |
| `--gold-soft`    | `#e7c280`                   | Button text                      |
| `--gold-deep`    | `#a3782f`                   | Pressed / hover-darker states    |
| `--text`         | `#f3eee5`                   | Primary text                     |
| `--text-dim`     | `#9a948a`                   | Secondary text                   |
| `--text-faint`   | `#5e5a55`                   | Tertiary / labels                |
| `--danger`       | `#c0584a`                   | Destructive actions              |

Background uses two radial gradients + an SVG film-grain overlay
(`body::before` / `body::after`). Don't strip these — they're the look.

Fonts:
- `Playfair Display` — brand wordmark + headings.
- `DM Sans` — everything else.

Aesthetic principles:
- **Warm gold, not amber.** Vault's gold (`#d4a04a`) is dimmer and more
  brown than the portfolio's amber. Don't accidentally cross-pollinate.
- **No bright accents.** No blue, purple, green. The whole palette is
  warm neutrals + gold.
- **Subtle, not loud.** Glow + grain should feel like film, not LEDs.

---

## Things Claude should always do

1. Read this file first on every new session.
2. Branch off `master` for each feature/fix (`feat/*`, `fix/*`, `improve/*`,
   `docs/*`, `style/*`). Don't commit to `master`.
3. Use `git -C ~/vault …` from any other working directory — vault is
   not the primary CWD.
4. Use `resolveSafe(filename)` for any new route that touches the
   filesystem.
5. When adding a new sidecar file convention, follow `<base>.<suffix>.<ext>`
   and teach `rename`, `delete`, and `/videos` about it.
6. Test changes against an actual library file — codec / container
   edge cases bite hard.
7. Keep server.js and index.html as single files. Resist the urge to
   split into modules / introduce a bundler.

## Things Claude should never do

- Add a database, ORM, or auth system without asking. This is single-user
  by design.
- Add React / Vue / any client framework. The frontend is vanilla on
  purpose.
- Remove the `unhandledRejection` / `uncaughtException` handlers in
  `server.js` — they keep the WebTorrent client alive through flaky
  network errors.
- Re-encode video on every import. Stream-copy video, transcode audio
  only when needed.
- Point `TORRENT_DIR` at iCloud (it'll trash upstream bandwidth).
- Hardcode an API base into the frontend other than the existing
  `const API = 'http://localhost:3001'` — if it needs to change, change
  it there.

---

## Known gaps / future work

- Stock `<video controls>` chrome — a custom Netflix-style player with
  larger scrub bar, subtitle/audio menus, keyboard shortcuts, and mobile
  gestures is planned (next session).
- No "watched" indicator yet (in progress this session).
- No torrent pause/resume + no download ETA (in progress this session).
- No genre / category filtering — "Your Library" heading planned to be
  replaced with TMDB-derived genre filter pills (in progress this
  session).
- Card grid sizing isn't tuned for mobile yet (in progress this session).
- TMDB search returns title/year/overview/poster but doesn't persist
  metadata. Once we start storing TMDB metadata for genre filtering,
  consider also storing overview + year + runtime for richer cards.
- README is stale vs the actual feature set. Worth a refresh once the
  current session lands.

---

*Last updated: 2026-05-26 — Initial CLAUDE.md after feat branches were
fast-forwarded into master.*
