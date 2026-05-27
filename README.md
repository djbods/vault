# VAULT

A self-hosted, single-user Netflix for your own footage. No cloud, no
auth, no signup. Dark, cinematic UI in front; Node/Express +
WebTorrent + ffmpeg behind. Two files on disk — `server.js` and
`index.html`.

Nothing leaves your machine. Library files live wherever you point
`LIBRARY_DIR` (defaults to `./videos/`); iCloud Drive works if you
want cross-Mac sync.

## What's in the box

- **Library** — drag-and-drop upload, hover preview, portrait poster
  cards that bloom into a 16:9 landscape on hover, genre filter pills,
  per-card edit modal (rename, poster swap, subtitle add/remove,
  re-process video).
- **Continue Watching shelf** — horizontal row above the grid for
  films you're partway through, with a progress bar and "Xh Ym left"
  on each card.
- **Custom player** — Netflix-style chrome over `<video>`. Scrub bar
  with hover preview + buffered range, ±10s skip, volume slider,
  subtitles menu, PiP, AirPlay, fullscreen, resume from last
  position, 95%-watched auto-mark, mobile double-tap skip,
  keyboard shortcuts (space, ←/→, J/K/L, F, M, 0-9, Esc).
- **Torrents** — paste a magnet URI, the largest video file gets
  selected automatically and streams over HTTP as it downloads;
  "Save to Library" runs the import pipeline once complete.
- **ffmpeg import pipeline** — every file (upload or torrent) is
  remuxed to `.mp4` with `+faststart`, video stream-copied (no
  re-encode), audio re-encoded only when the browser can't decode
  it natively. Embedded subtitle tracks are extracted to `.vtt`
  sidecars.
- **TMDB integration** — pick a poster from a search modal, auto-pull
  genres / year / runtime / overview / cast / director from the same
  TMDB id, and on first library load auto-match untagged files by
  filename when confidence is high. Disable cleanly by leaving
  `TMDB_API_KEY` unset.
- **Subtitles** — manual `.srt` / `.vtt` upload (auto-converted to
  VTT) plus automatic extraction of text-codec embedded tracks on
  every import.

## Run it

```bash
npm install
npm start
# or
npm run dev          # node --watch server.js
```

Requires `ffmpeg` + `ffprobe` on `$PATH` (Homebrew: `brew install ffmpeg`).

The server boots on `http://localhost:3001` and creates `LIBRARY_DIR`
and `TORRENT_DIR` on first run. Open `http://localhost:3001/` in a
browser — the same origin serves the UI and the API.

## Config

Copy `.env.example` → `.env` to override defaults. All values are
optional.

- `PORT` — server port (default `3001`)
- `LIBRARY_DIR` — where finished videos + sidecars live (default
  `./videos`). Leading `~` is expanded. Point at iCloud Drive for
  cross-Mac sync, but disable "Optimize Mac Storage" or files get
  dehydrated to placeholders that can't stream.
- `TORRENT_DIR` — where in-progress torrents download (default
  `./torrent-cache`). **Keep this local** — every piece write would
  trigger an iCloud upload otherwise.
- `TMDB_API_KEY` — enables `/tmdb/*` routes (poster search, fetch,
  auto-backfill). Without it those routes return 503 and the UI
  hides the TMDB buttons.

## Library files on disk

Each video has a base name (the filename minus extension). Sidecars
share that base:

```
LIBRARY_DIR/
├── My Film.mp4              # the video itself (always .mp4 after import)
├── My Film.poster.jpg       # poster (jpg / png / webp)
├── My Film.en.vtt           # subtitle, one per language (en, es, ja, …)
├── My Film.en2.vtt          # numeric suffix for duplicates
└── .vault-library.json      # single sidecar for per-video metadata
```

`.vault-library.json` holds the watched flag, genres, year, runtime,
overview, cast, director, resume position, duration, last-played
timestamp, and TMDB id keyed by filename.

## API

Mostly self-documenting from the source, but the routes that
matter:

| Method | Path                                       | Purpose                                              |
| ------ | ------------------------------------------ | ---------------------------------------------------- |
| GET    | `/`                                        | Serves `index.html`                                  |
| GET    | `/videos`                                  | Library listing with all metadata fields             |
| GET    | `/stream/:filename`                        | Byte-range video stream                              |
| POST   | `/upload`                                  | Multipart upload (field name `file`)                 |
| POST   | `/videos/:filename/reprocess`              | Re-run ffmpeg pipeline + extract embedded subs       |
| PATCH  | `/videos/:filename/metadata`               | Update watched / genres / tmdbId / resumePosition / duration |
| POST   | `/videos/:filename/rename`                 | Rename video + all sidecars                          |
| DELETE | `/videos/:filename`                        | Remove video + all sidecars                          |
| GET    | `/poster/:filename`                        | Serve poster image                                   |
| POST   | `/upload-poster`                           | Upload poster sidecar                                |
| DELETE | `/poster/:videoName`                       | Remove poster sidecar                                |
| GET    | `/subtitles/:filename`                     | List subtitles for a video                           |
| POST   | `/upload-subtitles`                        | Upload SRT/VTT subtitle                              |
| GET    | `/stream-subtitle/:filename`               | Serve VTT (auto-converts SRT)                        |
| GET    | `/tmdb/status`                             | `{ configured: bool }`                               |
| GET    | `/tmdb/search?q=`                          | TMDB movie search proxy                              |
| POST   | `/tmdb/fetch-poster`                       | Download poster from TMDB + persist metadata         |
| POST   | `/tmdb/save-metadata`                      | Pull TMDB details for an existing tmdbId             |
| POST   | `/tmdb/backfill`                           | Auto-match untagged library files to TMDB            |
| POST   | `/torrent`                                 | Add magnet, returns torrent state                    |
| GET    | `/torrents`                                | List active torrents                                 |
| GET    | `/torrent/:infoHash/stream`                | Byte-range stream of the main video file             |
| POST   | `/torrent/:infoHash/save-to-library`       | ffmpeg the torrent into LIBRARY_DIR                  |
| DELETE | `/torrent/:infoHash`                       | Remove torrent + wipe its store                      |

## CLI upload

```bash
curl -F "file=@yourvideo.mp4" http://localhost:3001/upload
```

## File layout

```
vault/
├── server.js              # Express server (~1400 lines, one file)
├── index.html             # Entire frontend (~3000 lines, one file)
├── package.json
├── .env                   # Local overrides (gitignored)
├── .env.example
├── .gitignore
├── README.md              # ← you are here
├── CLAUDE.md              # architectural reference for contributors
├── videos/                # default LIBRARY_DIR (gitignored)
└── torrent-cache/         # default TORRENT_DIR (gitignored)
```

## Notes

- No database, no auth, no build step, no client framework. This is
  by design — single-user, single-machine.
- Path traversal is blocked: every `:filename` param is resolved
  against `LIBRARY_DIR` and rejected if it escapes.
- Filenames are sanitized on upload (anything outside
  `[a-zA-Z0-9._\- ]` becomes `_`). Same name twice = overwrite.
- See `CLAUDE.md` for architectural detail (import pipeline,
  metadata schema, torrent flow, design tokens, contributor rules).
