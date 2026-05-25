# VAULT

A personal video streaming app — a stripped-down, self-hosted Netflix for your own footage. Dark, cinematic UI in front; Node/Express byte-range streamer behind.

Nothing leaves your machine. Videos live in `./videos/` on disk.

## What's in the box

- **Backend** — Express + multer + dotenv. File upload, listing, byte-range streaming (seek works), delete.
- **Frontend** — single `index.html`. Vanilla JS, no build step. Playfair Display + DM Sans, warm gold accents, film-grain overlay, drag-and-drop upload, full-screen player.

## Run it

```bash
npm install
npm start
```

The server boots on `http://localhost:3001` and creates `./videos/` on first run.

Then open the UI — either way works:

- **Easy:** open `http://localhost:3001/` in your browser (the server serves `index.html` at `/`).
- **Or:** double-click `index.html` to open it via `file://` — it'll call the API on `localhost:3001`.

## Upload from the CLI

```bash
curl -F "file=@yourvideo.mp4" http://localhost:3001/upload
```

## API

| Method | Path                  | Purpose                                            |
| ------ | --------------------- | -------------------------------------------------- |
| POST   | `/upload`             | Multipart upload (field name `file`)               |
| GET    | `/videos`             | JSON list — `{ name, size, modified, duration }[]` |
| GET    | `/stream/:filename`   | Streams file with `Range` request support         |
| DELETE | `/videos/:filename`   | Removes the file from disk                         |

## Config

Copy `.env.example` to `.env` to override defaults:

```bash
cp .env.example .env
```

- `PORT` — server port (default `3001`)

## Notes

- Videos are stored locally in `./videos/` (gitignored). Nothing is uploaded anywhere external.
- The frontend uses the video file itself as its own thumbnail (`<video preload="metadata">` seeked to `0.5s`). No ffmpeg needed.
- Filenames are sanitized on upload — uploading the same filename twice overwrites.
- Path-traversal is blocked: `:filename` params are resolved and rejected if they escape `./videos/`.
- Duration is returned as `null` — extracting it would need ffprobe. The UI doesn't display it.

## File layout

```
vault/
├── index.html         # Frontend (single file)
├── server.js          # Express backend
├── package.json
├── .env.example
├── .gitignore
└── videos/            # Created at runtime, gitignored
```
