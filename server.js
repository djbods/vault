require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { promisify } = require('util');
const { spawn } = require('child_process');
const pipeline = promisify(require('stream').pipeline);

// Expand a leading "~" so .env paths like "~/Library/..." work. Node's
// path helpers don't do this automatically.
const expandPath = (p) => {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
};

const PORT = process.env.PORT || 3001;
// LIBRARY_DIR is where finished videos, posters, and subtitles live — can
// point at iCloud Drive or any other location. TORRENT_DIR is the temp
// download cache; keep it on local disk to avoid sync churn (every piece
// write would otherwise trigger an iCloud upload).
const VIDEOS_DIR = expandPath(process.env.LIBRARY_DIR) || path.join(__dirname, 'videos');
const TORRENT_DIR = expandPath(process.env.TORRENT_DIR) || path.join(__dirname, 'torrent-cache');

if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}
if (!fs.existsSync(TORRENT_DIR)) {
  fs.mkdirSync(TORRENT_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
};

const VIDEO_EXTS = new Set(Object.keys(MIME_TYPES));
const SUBTITLE_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const POSTER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const POSTER_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const mimeFor = (filename) => MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// Two-letter ISO language code, defaulting to "en"
const sanitizeLang = (lang) => {
  const m = String(lang || '').toLowerCase().match(/^[a-z]{2,3}$/);
  return m ? m[0] : 'en';
};

// Strip release-group / quality / codec cruft so TMDB has a clean title to search.
// "Project Hail Mary 2026 1080p WEB-DL HEVC ..." -> "Project Hail Mary 2026"
const cleanQueryForTmdb = (filename) => {
  let s = filename.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ');
  const year = s.match(/^(.*?)\s+(?:\(|\[)?(\d{4})(?:\)|\])?(?:\s|$)/);
  if (year) return `${year[1].trim()} ${year[2]}`.trim();
  // Otherwise cut at first known quality / codec / source token.
  s = s.split(/\s+(?:1080p|720p|2160p|480p|4k|uhd|hdr|webrip|web-dl|web|bluray|brrip|bdrip|hdtv|hevc|x264|x265|h264|h265|aac|ac3|dts|atmos|repack|proper|extended|remux)\b/i)[0];
  return s.trim();
};

const findPoster = (videoFilename) => {
  const base = baseNameNoExt(videoFilename);
  for (const ext of POSTER_EXTS) {
    const name = `${base}.poster${ext}`;
    if (fs.existsSync(path.join(VIDEOS_DIR, name))) return name;
  }
  return null;
};

const removeExistingPosters = (videoBaseName) => {
  POSTER_EXTS.forEach((ext) => {
    const p = path.join(VIDEOS_DIR, `${videoBaseName}.poster${ext}`);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  });
};

const sanitize = (name) =>
  name
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

// Reject any path that escapes VIDEOS_DIR — guards against ".." traversal
const resolveSafe = (filename) => {
  const resolved = path.join(VIDEOS_DIR, path.basename(filename));
  if (path.dirname(resolved) !== VIDEOS_DIR) return null;
  return resolved;
};

const baseNameNoExt = (filename) => filename.replace(/\.[^.]+$/, '');

// Treat "Movie.poster.jpg" as a sidecar, not a separate video listing.
const isPosterFile = (name) => /\.poster\.(jpg|jpeg|png|webp)$/i.test(name);

// Minimal SRT → VTT: prepend WEBVTT header, swap timestamp comma for dot.
const srtToVtt = (srt) =>
  'WEBVTT\n\n' + srt.replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

// Uploads land in a local staging area first — we transcode (or remux) into
// VIDEOS_DIR after multer finishes. Keeps the raw upload off iCloud so we
// don't sync the source then immediately sync the transcoded result.
const UPLOAD_STAGING_DIR = path.join(TORRENT_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_STAGING_DIR)) {
  fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_STAGING_DIR),
  filename: (req, file, cb) => {
    const safe = sanitize(file.originalname);
    cb(null, safe || `upload-${Date.now()}.mp4`);
  },
});

const upload = multer({ storage });
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- WebTorrent singleton (ESM dynamic import from CJS) ----------

const webtorrentReady = (async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const client = new WebTorrent();
  client.on('error', (err) => console.error('[webtorrent]', err.message || err));
  return client;
})();

// infoHash → { torrent, mainFileIndex, subtitleIndices, subtitleCache }
const torrentState = new Map();

const detectTorrentFiles = (torrent) => {
  const videos = [];
  const subs = [];
  torrent.files.forEach((file, index) => {
    const ext = path.extname(file.name).toLowerCase();
    if (VIDEO_EXTS.has(ext)) videos.push({ index, length: file.length });
    else if (SUBTITLE_EXTS.has(ext)) subs.push(index);
  });
  videos.sort((a, b) => b.length - a.length);
  return {
    mainFileIndex: videos.length ? videos[0].index : -1,
    subtitleIndices: subs,
  };
};

const torrentStatus = (torrent) => {
  const hasMetadata = torrent.files && torrent.files.length > 0;
  if (!hasMetadata) return 'connecting';
  if (torrent.progress >= 1) return 'seeding';
  if (torrent.downloadSpeed > 0) return 'downloading';
  return 'stalled';
};

const serializeTorrent = (state) => {
  const { torrent, mainFileIndex, subtitleIndices } = state;
  const mainFile = mainFileIndex >= 0 ? torrent.files[mainFileIndex] : null;
  return {
    infoHash: torrent.infoHash,
    name: torrent.name || torrent.infoHash,
    progress: torrent.progress,
    downloadSpeed: torrent.downloadSpeed,
    numPeers: torrent.numPeers,
    status: torrentStatus(torrent),
    ready: torrent.ready,
    mainVideo: mainFile ? { name: mainFile.name, length: mainFile.length } : null,
    subtitles: subtitleIndices.map((i) => {
      const f = torrent.files[i];
      return { name: f.name, length: f.length };
    }),
  };
};

// ---------- App ----------

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Local videos ----------

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const stagedPath = req.file.path;
  try {
    const targetBase = sanitize(baseNameNoExt(req.file.filename)) || `upload-${Date.now()}`;
    const outPath = await prepareForLibrary(stagedPath, VIDEOS_DIR, targetBase);
    // Pull embedded subtitle tracks out of the source container before we
    // delete the staged file. prepareForLibrary only copies video+audio,
    // so the source is the only place those streams still exist.
    const subtitles = await extractEmbeddedSubtitles(stagedPath, VIDEOS_DIR, targetBase);
    const stat = fs.statSync(outPath);
    res.json({
      name: path.basename(outPath),
      size: stat.size,
      mimetype: 'video/mp4',
      subtitles,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(stagedPath, () => {});
  }
});

app.get('/videos', (req, res) => {
  fs.readdir(VIDEOS_DIR, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(500).json({ error: err.message });
    const files = entries
      .filter((e) => {
        if (!e.isFile() || e.name.startsWith('.')) return false;
        const ext = path.extname(e.name).toLowerCase();
        if (SUBTITLE_EXTS.has(ext)) return false;
        if (isPosterFile(e.name)) return false;
        return VIDEO_EXTS.has(ext);
      })
      .map((e) => {
        const filepath = path.join(VIDEOS_DIR, e.name);
        const stat = fs.statSync(filepath);
        const poster = findPoster(e.name);
        return {
          name: e.name,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          duration: null,
          poster: poster ? `/poster/${encodeURIComponent(poster)}` : null,
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    res.json(files);
  });
});

// Audio codecs that browsers decode natively — these are stream-copied
// straight into the library MP4 with no re-encode. Everything else
// (AC3/EAC3/DTS/TrueHD/etc) gets transcoded to AAC at import time.
const BROWSER_FRIENDLY_AUDIO = new Set([
  'aac', 'mp3', 'opus', 'vorbis', 'flac',
]);

// Probe a media file once and cache the result. Used by prepareForLibrary
// to decide between stream-copy and audio re-encode.
const probeCache = new Map();
const probeFile = (filepath) =>
  new Promise((resolve, reject) => {
    const cached = probeCache.get(filepath);
    if (cached) return resolve(cached);
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_type,codec_name:format=duration',
      '-of', 'json',
      filepath,
    ]);
    let out = '';
    let err = '';
    ff.stdout.on('data', (d) => (out += d.toString()));
    ff.stderr.on('data', (d) => (err += d.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err.trim()}`));
      try {
        const parsed = JSON.parse(out);
        const streams = parsed.streams || [];
        const audio = streams.find((s) => s.codec_type === 'audio');
        const video = streams.find((s) => s.codec_type === 'video');
        const result = {
          audioCodec: audio ? (audio.codec_name || '').toLowerCase() : '',
          videoCodec: video ? (video.codec_name || '').toLowerCase() : '',
          duration: parseFloat((parsed.format || {}).duration) || 0,
        };
        probeCache.set(filepath, result);
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });

// Convert a source video into a browser-ready MP4 in the library. Video is
// always copied (no re-encode → fast, lossless). Audio is copied if already
// browser-friendly, otherwise re-encoded to AAC 256k. HEVC streams get the
// hvc1 tag forced so Chrome/Safari accept the parameter sets in hvcC.
// Writes <targetDir>/<targetBase>.mp4 with +faststart for byte-range play.
const prepareForLibrary = async (srcPath, targetDir, targetBase) => {
  const probe = await probeFile(srcPath).catch(() => ({ audioCodec: '', videoCodec: '' }));
  const audioCodec = probe.audioCodec || '';
  const videoCodec = probe.videoCodec || '';
  const needsAudioTranscode = audioCodec && !BROWSER_FRIENDLY_AUDIO.has(audioCodec);
  const isHevc = videoCodec === 'hevc' || videoCodec === 'h265';

  const outPath = path.join(targetDir, `${targetBase}.mp4`);

  return new Promise((resolve, reject) => {
    const ffArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', '+genpts',
      '-i', srcPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'copy',
      ...(isHevc ? ['-tag:v', 'hvc1'] : []),
      '-c:a', needsAudioTranscode ? 'aac' : 'copy',
      ...(needsAudioTranscode ? ['-b:a', '256k'] : []),
      // +faststart moves moov to the front so the result streams cleanly
      // over byte-range from the first request.
      '-movflags', '+faststart',
      '-y',
      outPath,
    ];

    const startedAt = Date.now();
    const action = needsAudioTranscode ? 'transcode' : 'remux';
    console.log(`[ffmpeg] ${action} ${path.basename(srcPath)} → ${path.basename(outPath)}`);

    const ff = spawn('ffmpeg', ffArgs);
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        // Clean up partial output so we don't leave a corrupted file behind.
        try { fs.unlinkSync(outPath); } catch {}
        return reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 500)}`));
      }
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[ffmpeg] done in ${took}s → ${path.basename(outPath)}`);
      resolve(outPath);
    });
  });
};

// Text-based subtitle codecs that ffmpeg can convert to WebVTT in one pass.
// Bitmap codecs (hdmv_pgs_subtitle, dvd_subtitle, dvb_subtitle, xsub) would
// need OCR — we skip them rather than ship a corrupt VTT.
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text',
]);

// ISO 639-2 → 639-1 for the common cases the player UI has labels for.
// Anything not in the map passes through unchanged (the UI uppercases it).
const LANG_3TO2 = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
  ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no',
  dan: 'da', fin: 'fi', rus: 'ru', pol: 'pl', jpn: 'ja', kor: 'ko',
  chi: 'zh', zho: 'zh', ara: 'ar', hin: 'hi', tur: 'tr', vie: 'vi',
  tha: 'th', ind: 'id', heb: 'he', cze: 'cs', ces: 'cs', gre: 'el',
  ell: 'el', hun: 'hu', rum: 'ro', ron: 'ro', ukr: 'uk',
  nob: 'nb', nno: 'nn',
};
const normalizeLang = (raw) => {
  const m = String(raw || '').toLowerCase().match(/^[a-z]{2,3}$/);
  if (!m) return 'en';
  const v = m[0];
  if (v.length === 2) return v;
  return LANG_3TO2[v] || v;
};

// ffprobe → list of subtitle streams with their codec + language tag.
// Returns [{ index, codec, lang }] where index is the stream's position in
// the subtitle-only stream list (so it can be paired with `-map 0:s:N`).
const probeSubtitleStreams = (filepath) =>
  new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 's',
      '-show_entries', 'stream=index,codec_name:stream_tags=language,title',
      '-of', 'json',
      filepath,
    ]);
    let out = '';
    let err = '';
    ff.stdout.on('data', (d) => (out += d.toString()));
    ff.stderr.on('data', (d) => (err += d.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err.trim()}`));
      try {
        const streams = (JSON.parse(out).streams || []).map((s, i) => ({
          index: i,
          codec: (s.codec_name || '').toLowerCase(),
          lang: normalizeLang((s.tags && s.tags.language) || ''),
        }));
        resolve(streams);
      } catch (e) {
        reject(e);
      }
    });
  });

// Run ffmpeg once to extract a single subtitle stream into a VTT file.
const extractOneSubtitle = (srcPath, streamIndex, outPath) =>
  new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', srcPath,
      '-map', `0:s:${streamIndex}`,
      '-c:s', 'webvtt',
      '-y',
      outPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d.toString()));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(outPath); } catch {}
        return reject(new Error(`ffmpeg subtitle exit ${code}: ${stderr.trim().slice(0, 300)}`));
      }
      resolve(outPath);
    });
  });

// Pull all text-based subtitle streams out of `srcPath` and write them
// next to the library file as `<base>.<lang>.vtt`. Duplicate languages
// get numeric suffixes (`.en.vtt`, `.en2.vtt`). Existing sidecar files
// are preserved — we never overwrite a manual upload or torrent-sibling
// subtitle. Best-effort: failures on individual streams log and skip.
const extractEmbeddedSubtitles = async (srcPath, targetDir, targetBase) => {
  let streams = [];
  try {
    streams = await probeSubtitleStreams(srcPath);
  } catch (e) {
    console.warn(`[subs] probe failed for ${path.basename(srcPath)}: ${e.message}`);
    return [];
  }
  const written = [];
  const usedNames = new Set();
  for (const s of streams) {
    if (!TEXT_SUBTITLE_CODECS.has(s.codec)) {
      console.log(`[subs] skip stream ${s.index} (${s.codec}) — not text-based`);
      continue;
    }
    // Find a non-colliding filename for this language.
    let suffix = '';
    let n = 1;
    let targetName;
    while (true) {
      targetName = `${targetBase}.${s.lang}${suffix}.vtt`;
      const exists = fs.existsSync(path.join(targetDir, targetName)) || usedNames.has(targetName);
      if (!exists) break;
      n += 1;
      suffix = String(n);
    }
    const targetPath = path.join(targetDir, targetName);
    try {
      await extractOneSubtitle(srcPath, s.index, targetPath);
      usedNames.add(targetName);
      written.push(targetName);
      console.log(`[subs] extracted ${s.lang} (${s.codec}) → ${targetName}`);
    } catch (e) {
      console.warn(`[subs] extract failed for stream ${s.index}: ${e.message}`);
    }
  }
  return written;
};

// Browser-compatible audio codecs (matches BROWSER_FRIENDLY_AUDIO) and the
// MP4-in-a-browser-friendly-container constraint. Used by /probe so the
// edit modal can show why a file might not play.
const BROWSER_FRIENDLY_CONTAINERS = new Set(['.mp4', '.m4v', '.webm']);

// Quick health-check for an existing library file. Reports container, video
// + audio codec, embedded subtitle streams, and whether the browser is
// likely to be able to play the file as-is. Used by the edit modal to
// decide whether to surface the "Re-process" action.
app.get('/videos/:filename/probe', async (req, res) => {
  const filepath = resolveSafe(req.params.filename);
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const [base, subs] = await Promise.all([
      probeFile(filepath),
      probeSubtitleStreams(filepath).catch(() => []),
    ]);
    const ext = path.extname(filepath).toLowerCase();
    const audioOk = !base.audioCodec || BROWSER_FRIENDLY_AUDIO.has(base.audioCodec);
    const containerOk = BROWSER_FRIENDLY_CONTAINERS.has(ext);
    res.json({
      container: ext,
      videoCodec: base.videoCodec,
      audioCodec: base.audioCodec,
      audioBrowserCompatible: audioOk,
      containerBrowserCompatible: containerOk,
      browserCompatible: audioOk && containerOk,
      embeddedSubtitles: subs.map((s) => ({
        codec: s.codec,
        lang: s.lang,
        extractable: TEXT_SUBTITLE_CODECS.has(s.codec),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-run an already-imported file through prepareForLibrary (fixes audio /
// container) and extractEmbeddedSubtitles (pulls embedded tracks out as
// VTT sidecars). For existing library files that bypassed the new import
// pipeline. Output is always <base>.mp4 — if the source extension differs,
// the original is removed once the new MP4 is in place.
app.post('/videos/:filename/reprocess', async (req, res) => {
  const filepath = resolveSafe(req.params.filename);
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const base = baseNameNoExt(path.basename(filepath));
  const oldExt = path.extname(filepath).toLowerCase();
  // Write to a hidden temp filename in the same directory so renameSync
  // is atomic (same volume — iCloud rejects cross-volume renames). The
  // leading dot also keeps it out of /videos listings while in progress.
  const tempBase = `.${base}.reprocess-${Date.now()}`;
  const tempPath = path.join(VIDEOS_DIR, `${tempBase}.mp4`);
  let writtenSubs = [];
  let probeBefore = null;
  let probeAfter = null;

  try {
    probeBefore = await probeFile(filepath).catch(() => null);
    // Extract subs from the source first — we delete it later, so this
    // is the only chance to read its subtitle streams.
    writtenSubs = await extractEmbeddedSubtitles(filepath, VIDEOS_DIR, base);
    // Re-encode/remux into the temp MP4 (always .mp4 output).
    await prepareForLibrary(filepath, VIDEOS_DIR, tempBase);
    // Drop the original. If oldExt was already .mp4 the rename below
    // will overwrite it — but unlink first is safer in case the user
    // is mid-stream (the browser will error and retry).
    try { fs.unlinkSync(filepath); } catch {}
    const finalPath = path.join(VIDEOS_DIR, `${base}.mp4`);
    fs.renameSync(tempPath, finalPath);
    // Bust ffprobe cache so the next /probe reflects the new file.
    probeCache.delete(filepath);
    probeCache.delete(finalPath);
    probeAfter = await probeFile(finalPath).catch(() => null);
    res.json({
      name: path.basename(finalPath),
      before: probeBefore,
      after: probeAfter,
      subtitlesAdded: writtenSubs,
    });
  } catch (err) {
    // Best-effort cleanup of the temp file if ffmpeg failed partway.
    try { fs.unlinkSync(tempPath); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/:filename', (req, res) => {
  const filepath = resolveSafe(req.params.filename);
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const stat = fs.statSync(filepath);
  const fileSize = stat.size;
  // Native byte-range only — files are pre-conditioned at import time so
  // they're guaranteed browser-decodable, no live transcoding needed.
  const range = req.headers.range;
  const contentType = mimeFor(filepath);

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    fs.createReadStream(filepath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filepath).pipe(res);
  }
});

// Rename a library video plus all its sidecars (poster, subtitle files).
// Body: { newName } — extension is preserved from the existing file, so
// callers send the desired display name without an extension.
app.post('/videos/:filename/rename', (req, res) => {
  const filepath = resolveSafe(req.params.filename);
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const requested = String((req.body && req.body.newName) || '').trim();
  if (!requested) return res.status(400).json({ error: 'newName required' });

  const oldBase = baseNameNoExt(path.basename(filepath));
  const oldExt = path.extname(filepath);
  const cleanedBase = sanitize(baseNameNoExt(requested));
  if (!cleanedBase || cleanedBase.includes('/') || cleanedBase.includes('..')) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  if (cleanedBase === oldBase) {
    return res.json({ name: path.basename(filepath), renamed: [] });
  }

  const newVideoName = `${cleanedBase}${oldExt}`;
  const newVideoPath = resolveSafe(newVideoName);
  if (!newVideoPath) return res.status(400).json({ error: 'Invalid path' });
  if (fs.existsSync(newVideoPath)) {
    return res.status(409).json({ error: 'A file with that name already exists' });
  }

  try {
    fs.renameSync(filepath, newVideoPath);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Rename all sidecars (posters + subtitles) that share the old base.
  const renamed = [path.basename(newVideoPath)];
  const entries = fs.readdirSync(VIDEOS_DIR);
  for (const n of entries) {
    if (!n.startsWith(oldBase + '.')) continue;
    const ext = path.extname(n).toLowerCase();
    const isSidecar = SUBTITLE_EXTS.has(ext) || isPosterFile(n);
    if (!isSidecar) continue;
    const newName = cleanedBase + n.slice(oldBase.length);
    const fromPath = resolveSafe(n);
    const toPath = resolveSafe(newName);
    if (!fromPath || !toPath || fs.existsSync(toPath)) continue;
    try {
      fs.renameSync(fromPath, toPath);
      renamed.push(newName);
    } catch {}
  }

  res.json({ name: path.basename(newVideoPath), renamed });
});

app.delete('/videos/:filename', (req, res) => {
  const filepath = resolveSafe(req.params.filename);
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const base = baseNameNoExt(path.basename(filepath));
  fs.unlink(filepath, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    fs.readdir(VIDEOS_DIR, (readErr, entries) => {
      if (!readErr && entries) {
        entries
          .filter((n) => {
            if (!n.startsWith(base + '.')) return false;
            return (
              SUBTITLE_EXTS.has(path.extname(n).toLowerCase()) || isPosterFile(n)
            );
          })
          .forEach((n) => {
            const sidecar = resolveSafe(n);
            if (sidecar) fs.unlink(sidecar, () => {});
          });
      }
      res.json({ deleted: req.params.filename });
    });
  });
});

// ---------- Subtitles (local) ----------

app.post('/upload-subtitles', memUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const videoName = req.body && req.body.videoName;
  if (!videoName) return res.status(400).json({ error: 'videoName required' });

  const videoPath = resolveSafe(videoName);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const origExt = path.extname(req.file.originalname).toLowerCase();
  if (origExt !== '.srt' && origExt !== '.vtt') {
    return res.status(400).json({ error: 'Only .srt or .vtt accepted' });
  }

  const lang = sanitizeLang(req.body && req.body.lang);
  const base = baseNameNoExt(path.basename(videoPath));
  const targetName = `${base}.${lang}.vtt`;
  const targetPath = resolveSafe(targetName);
  if (!targetPath) return res.status(400).json({ error: 'Invalid path' });

  let content = req.file.buffer.toString('utf-8');
  if (origExt === '.srt') content = srtToVtt(content);
  else if (!/^WEBVTT/.test(content)) content = 'WEBVTT\n\n' + content;

  fs.writeFile(targetPath, content, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ name: targetName, lang, videoName: path.basename(videoPath) });
  });
});

app.get('/subtitles/:filename', (req, res) => {
  const videoPath = resolveSafe(req.params.filename);
  if (!videoPath) return res.status(400).json({ error: 'Invalid path' });
  const base = baseNameNoExt(path.basename(videoPath));
  fs.readdir(VIDEOS_DIR, (err, entries) => {
    if (err) return res.status(500).json({ error: err.message });
    const subs = entries
      .filter(
        (n) =>
          SUBTITLE_EXTS.has(path.extname(n).toLowerCase()) &&
          n.startsWith(base + '.')
      )
      .map((n) => {
        const middle = n.slice(base.length + 1, n.length - path.extname(n).length);
        const lang = (middle.split('.').filter(Boolean)[0] || 'en').toLowerCase();
        return {
          name: n,
          url: `/stream-subtitle/${encodeURIComponent(n)}`,
          label: lang.toUpperCase(),
          lang,
        };
      });
    res.json(subs);
  });
});

// Delete one sidecar subtitle file. The :subName must share the video's
// base name to guard against deleting unrelated files via path tricks.
app.delete('/subtitles/:videoName/:subName', (req, res) => {
  const videoPath = resolveSafe(req.params.videoName);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }
  const subPath = resolveSafe(req.params.subName);
  if (!subPath || !fs.existsSync(subPath)) {
    return res.status(404).json({ error: 'Subtitle not found' });
  }
  const subBase = path.basename(subPath);
  if (!SUBTITLE_EXTS.has(path.extname(subBase).toLowerCase())) {
    return res.status(400).json({ error: 'Not a subtitle file' });
  }
  const videoBase = baseNameNoExt(path.basename(videoPath));
  if (!subBase.startsWith(videoBase + '.')) {
    return res.status(400).json({ error: 'Subtitle does not belong to this video' });
  }
  fs.unlink(subPath, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: subBase });
  });
});

app.get('/stream-subtitle/:filename', (req, res) => {
  const filepath = resolveSafe(req.params.filename);
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const ext = path.extname(filepath).toLowerCase();
  if (!SUBTITLE_EXTS.has(ext)) {
    return res.status(400).json({ error: 'Not a subtitle file' });
  }
  res.set('Content-Type', 'text/vtt; charset=utf-8');
  if (ext === '.srt') {
    return res.send(srtToVtt(fs.readFileSync(filepath, 'utf-8')));
  }
  fs.createReadStream(filepath).pipe(res);
});

// ---------- Posters ----------

app.get('/poster/:filename', (req, res) => {
  const filepath = resolveSafe(req.params.filename);
  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!isPosterFile(req.params.filename)) {
    return res.status(400).json({ error: 'Not a poster file' });
  }
  const ext = path.extname(filepath).toLowerCase();
  const mime = POSTER_MIME[ext];
  if (!mime) return res.status(400).json({ error: 'Unsupported image type' });
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'public, max-age=300');
  fs.createReadStream(filepath).pipe(res);
});

app.post('/upload-poster', memUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const videoName = req.body && req.body.videoName;
  if (!videoName) return res.status(400).json({ error: 'videoName required' });

  const videoPath = resolveSafe(videoName);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }

  let ext = path.extname(req.file.originalname).toLowerCase();
  if (!POSTER_EXTS.includes(ext)) {
    const inferred = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
    }[req.file.mimetype];
    if (!inferred) return res.status(400).json({ error: 'Only JPG / PNG / WEBP accepted' });
    ext = inferred;
  }

  const base = baseNameNoExt(path.basename(videoPath));
  removeExistingPosters(base);
  const targetName = `${base}.poster${ext}`;
  const targetPath = resolveSafe(targetName);
  if (!targetPath) return res.status(400).json({ error: 'Invalid path' });

  fs.writeFile(targetPath, req.file.buffer, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      name: targetName,
      videoName: path.basename(videoPath),
      url: `/poster/${encodeURIComponent(targetName)}`,
    });
  });
});

app.delete('/poster/:videoName', (req, res) => {
  const videoPath = resolveSafe(req.params.videoName);
  if (!videoPath) return res.status(400).json({ error: 'Invalid path' });
  const base = baseNameNoExt(path.basename(videoPath));
  removeExistingPosters(base);
  res.json({ ok: true });
});

// ---------- TMDB proxy (poster lookup) ----------

app.get('/tmdb/status', (req, res) => {
  res.json({ configured: Boolean(TMDB_API_KEY) });
});

app.get('/tmdb/suggest-query', (req, res) => {
  const filename = (req.query.filename || '').trim();
  if (!filename) return res.status(400).json({ error: 'filename required' });
  res.json({ query: cleanQueryForTmdb(filename) });
});

app.get('/tmdb/search', async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(503).json({
      error: 'TMDB_API_KEY not configured. Add it to .env to enable poster lookup.',
    });
  }
  const raw = String(req.query.q || '').trim();
  if (!raw) return res.status(400).json({ error: 'q required' });

  // TMDB matches poorly when the year is embedded in the title, but well when
  // passed as a separate `year` filter. Pull a trailing 4-digit year out.
  let title = raw;
  let year = String(req.query.year || '').trim();
  const trailingYear = raw.match(/^(.*?)\s+(?:\(|\[)?(\d{4})(?:\)|\])?\s*$/);
  if (!year && trailingYear) {
    title = trailingYear[1].trim();
    year = trailingYear[2];
  }

  try {
    const params = new URLSearchParams({
      query: title,
      include_adult: 'false',
      language: 'en-US',
      page: '1',
      api_key: TMDB_API_KEY,
    });
    if (year) params.set('year', year);
    const r = await fetch(`https://api.themoviedb.org/3/search/movie?${params.toString()}`);
    if (!r.ok) return res.status(r.status).json({ error: `TMDB ${r.status}` });
    const data = await r.json();
    const results = (data.results || []).slice(0, 12).map((m) => ({
      id: m.id,
      title: m.title,
      year: m.release_date ? m.release_date.slice(0, 4) : null,
      overview: m.overview,
      posterPath: m.poster_path,
      posterUrl: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
    }));
    res.json({ query: raw, title, year: year || null, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/tmdb/fetch-poster', async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(503).json({ error: 'TMDB_API_KEY not configured' });
  }
  const { videoName, posterPath } = req.body || {};
  if (!videoName) return res.status(400).json({ error: 'videoName required' });
  if (!posterPath || !/^\/[\w./-]+\.(jpg|jpeg|png|webp)$/i.test(posterPath)) {
    return res.status(400).json({ error: 'Valid posterPath required' });
  }
  const videoPath = resolveSafe(videoName);
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }
  try {
    const r = await fetch(`https://image.tmdb.org/t/p/w780${posterPath}`);
    if (!r.ok) return res.status(r.status).json({ error: `Fetch ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());

    let ext = path.extname(posterPath).toLowerCase();
    if (!POSTER_EXTS.includes(ext)) ext = '.jpg';
    const base = baseNameNoExt(path.basename(videoPath));
    removeExistingPosters(base);
    const targetName = `${base}.poster${ext}`;
    const targetPath = resolveSafe(targetName);
    if (!targetPath) return res.status(400).json({ error: 'Invalid path' });
    fs.writeFileSync(targetPath, buf);
    res.json({
      name: targetName,
      videoName: path.basename(videoPath),
      url: `/poster/${encodeURIComponent(targetName)}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Torrents ----------

app.post('/torrent', async (req, res) => {
  const magnet = req.body && req.body.magnet;
  if (!magnet || typeof magnet !== 'string' || !magnet.trim().startsWith('magnet:')) {
    return res.status(400).json({ error: 'magnet URI required' });
  }
  try {
    const client = await webtorrentReady;
    const existing = await client.get(magnet);
    if (existing && torrentState.has(existing.infoHash)) {
      return res.json(serializeTorrent(torrentState.get(existing.infoHash)));
    }

    const torrent = client.add(magnet, { path: TORRENT_DIR });
    // webtorrent v3 doesn't always populate infoHash synchronously from add() —
    // poll briefly so we can key the state map correctly.
    const waitForInfoHash = async () => {
      const start = Date.now();
      while (!torrent.infoHash && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await waitForInfoHash();
    if (!torrent.infoHash) {
      return res.status(504).json({ error: 'Timed out waiting for infoHash' });
    }
    if (torrentState.has(torrent.infoHash)) {
      return res.json(serializeTorrent(torrentState.get(torrent.infoHash)));
    }
    const state = {
      torrent,
      mainFileIndex: -1,
      subtitleIndices: [],
      subtitleCache: new Map(),
    };
    torrentState.set(torrent.infoHash, state);

    const onReady = () => {
      if (state.mainFileIndex !== -1) return; // already ran
      const { mainFileIndex, subtitleIndices } = detectTorrentFiles(torrent);
      state.mainFileIndex = mainFileIndex;
      state.subtitleIndices = subtitleIndices;
      const keep = new Set([mainFileIndex, ...subtitleIndices]);
      torrent.files.forEach((file, i) => {
        if (keep.has(i)) file.select();
        else file.deselect();
      });
      console.log(
        `[torrent] ready: ${torrent.name} — main=${
          mainFileIndex >= 0 ? torrent.files[mainFileIndex].name : 'none'
        }, subs=${subtitleIndices.length}`
      );
    };
    torrent.on('ready', onReady);
    torrent.on('metadata', onReady);
    // 'ready'/'metadata' may have already fired before listeners were attached
    if (torrent.files && torrent.files.length) onReady();

    torrent.on('error', (err) => {
      console.error(`[torrent ${torrent.infoHash}]`, err.message || err);
    });

    res.json(serializeTorrent(state));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/torrents', async (req, res) => {
  try {
    await webtorrentReady;
    res.json(Array.from(torrentState.values()).map(serializeTorrent));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const pipeTorrentRange = (file, res, req, range, fileSize, contentType) => {
  let stream;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    stream = file.createReadStream({ start, end });
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    stream = file.createReadStream();
  }

  // Browser aborts (player close, seek, navigation) tear the response down.
  // Without explicit cleanup, the source stream emits 'error' and crashes the
  // process, taking the WebTorrent client + all download progress with it.
  const cleanup = () => {
    try { stream.destroy(); } catch {}
  };
  res.on('close', cleanup);
  stream.on('error', (e) => {
    if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.warn('[torrent stream]', e.message || e);
    }
    cleanup();
  });
  stream.pipe(res);
};

app.get('/torrent/:infoHash/stream', async (req, res) => {
  try {
    await webtorrentReady;
    const state = torrentState.get(req.params.infoHash);
    if (!state || state.mainFileIndex < 0) {
      return res.status(404).json({ error: 'Torrent or main file not ready' });
    }
    const file = state.torrent.files[state.mainFileIndex];
    pipeTorrentRange(file, res, req, req.headers.range, file.length, mimeFor(file.name));
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/torrent/:infoHash/subtitles/:filename', async (req, res) => {
  try {
    await webtorrentReady;
    const state = torrentState.get(req.params.infoHash);
    if (!state) return res.status(404).json({ error: 'Torrent not found' });

    const target = req.params.filename;
    const idx = state.subtitleIndices.find((i) => {
      const n = state.torrent.files[i].name;
      return n === target || path.basename(n) === target;
    });
    if (idx === undefined) return res.status(404).json({ error: 'Subtitle not found' });

    const file = state.torrent.files[idx];
    const ext = path.extname(file.name).toLowerCase();

    let cached = state.subtitleCache.get(target);
    if (!cached) {
      const ab = await file.arrayBuffer();
      cached = Buffer.from(ab);
      state.subtitleCache.set(target, cached);
    }

    if (ext === '.srt') {
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      return res.send(srtToVtt(cached.toString('utf-8')));
    }
    if (ext === '.vtt') {
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      return res.send(cached);
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(cached);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detect a 2-3 letter language tag in a subtitle filename ("Sintel.en.srt" → "en").
const detectLang = (subName) => {
  const m = subName.match(/\.([a-z]{2,3})\.[^.]+$/i);
  return m ? m[1].toLowerCase() : 'en';
};

app.post('/torrent/:infoHash/save-to-library', async (req, res) => {
  try {
    const client = await webtorrentReady;
    const state = torrentState.get(req.params.infoHash);
    if (!state) return res.status(404).json({ error: 'Not found' });
    if (state.mainFileIndex < 0) {
      return res.status(400).json({ error: 'No video file detected in torrent' });
    }
    if (state.torrent.progress < 1) {
      return res.status(400).json({ error: 'Torrent not complete' });
    }
    if (state.savingToLibrary) {
      return res.status(409).json({ error: 'Already saving' });
    }
    state.savingToLibrary = true;

    const videoFile = state.torrent.files[state.mainFileIndex];
    const sourcePath = path.join(state.torrent.path, videoFile.path);
    if (!fs.existsSync(sourcePath)) {
      state.savingToLibrary = false;
      return res.status(500).json({ error: `Torrent file not found on disk: ${sourcePath}` });
    }

    // Build a safe library basename — output is always .mp4 regardless of
    // input container; prepareForLibrary adds the extension.
    const cleanedBase = sanitize(baseNameNoExt(videoFile.name)) || `torrent-${req.params.infoHash}`;
    if (cleanedBase.includes('/') || cleanedBase.includes('..')) {
      state.savingToLibrary = false;
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Transcode (or remux) the source into VIDEOS_DIR. Audio is converted
    // to AAC if the source codec isn't browser-friendly; video is always
    // stream-copied. HEVC gets the hvc1 tag.
    const videoDest = await prepareForLibrary(sourcePath, VIDEOS_DIR, cleanedBase);

    // Copy sibling .srt/.vtt files first, converting SRT → VTT and tagging
    // with the language detected from the filename.
    const videoBase = baseNameNoExt(path.basename(videoDest));
    const writtenSubs = [];
    for (const idx of state.subtitleIndices) {
      const sub = state.torrent.files[idx];
      const ext = path.extname(sub.name).toLowerCase();
      if (ext !== '.srt' && ext !== '.vtt') continue;
      const lang = detectLang(sub.name);
      const targetName = `${videoBase}.${lang}.vtt`;
      const targetPath = resolveSafe(targetName);
      if (!targetPath) continue;
      let buf = state.subtitleCache.get(sub.name);
      if (!buf) {
        const ab = await sub.arrayBuffer();
        buf = Buffer.from(ab);
      }
      const text = buf.toString('utf-8');
      const out = ext === '.srt' ? srtToVtt(text) : /^WEBVTT/.test(text) ? text : 'WEBVTT\n\n' + text;
      fs.writeFileSync(targetPath, out);
      writtenSubs.push(targetName);
    }

    // Then pull any embedded subtitle tracks from the source container.
    // Sibling files (above) win on language collisions because they're
    // already on disk by the time extractEmbeddedSubtitles checks.
    const embedded = await extractEmbeddedSubtitles(sourcePath, VIDEOS_DIR, videoBase);
    writtenSubs.push(...embedded);

    // Remove the torrent + wipe its on-disk store
    try {
      await client.remove(req.params.infoHash, { destroyStore: true });
    } catch {
      // best-effort: still drop from state
    }
    torrentState.delete(req.params.infoHash);

    res.json({ ok: true, name: path.basename(videoDest), subtitles: writtenSubs });
  } catch (err) {
    const state = torrentState.get(req.params.infoHash);
    if (state) state.savingToLibrary = false;
    res.status(500).json({ error: err.message });
  }
});

app.delete('/torrent/:infoHash', async (req, res) => {
  try {
    const client = await webtorrentReady;
    const infoHash = req.params.infoHash;
    if (!torrentState.has(infoHash)) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      await client.remove(infoHash, { destroyStore: true });
    } catch (e) {
      // best-effort: still drop from state
    }
    torrentState.delete(infoHash);
    res.json({ removed: infoHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keep the server alive on any unhandled async error from middleware,
// torrent streams, or third-party libs. Losing the WebTorrent client mid-download
// wipes all progress; logging beats crashing.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', (err && err.message) || err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', (err && err.message) || err);
});

app.listen(PORT, () => {
  console.log(`VAULT server running at http://localhost:${PORT}`);
  console.log(`Library:      ${VIDEOS_DIR}`);
  console.log(`Torrent temp: ${TORRENT_DIR}`);
});
