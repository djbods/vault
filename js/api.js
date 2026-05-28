// All HTTP calls to the vault backend. No DOM, no state.

// Use the origin the page was loaded from so the API base matches the host
// the browser sees. Falls back to localhost when opened via file:// so the
// dev flow keeps working. The AirPlay receiver fetches stream URLs itself,
// so "localhost" would resolve to the TV — using origin avoids that.
const API = location.protocol === 'http:' || location.protocol === 'https:'
  ? location.origin
  : 'http://localhost:3001';

export { API };

const asJson = async (res, fallbackMsg = `HTTP ${res.status}`) => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || fallbackMsg);
  }
  return res.json();
};

// ---- Videos

export const fetchVideos = () => fetch(`${API}/videos`).then((r) => r.json());

export const deleteVideo = (filename) =>
  fetch(`${API}/videos/${encodeURIComponent(filename)}`, { method: 'DELETE' });

export const renameVideo = (filename, newName) =>
  fetch(`${API}/videos/${encodeURIComponent(filename)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName }),
  }).then((r) => asJson(r, 'Rename failed'));

export const reprocessVideo = (filename) =>
  fetch(`${API}/videos/${encodeURIComponent(filename)}/reprocess`, { method: 'POST' })
    .then((r) => asJson(r, 'Re-process failed'));

export const probeVideo = (filename) =>
  fetch(`${API}/videos/${encodeURIComponent(filename)}/probe`);

export const patchVideoMetadata = (filename, patch, { keepalive = false } = {}) =>
  fetch(`${API}/videos/${encodeURIComponent(filename)}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    keepalive,
  }).then((r) => asJson(r));

// Multipart upload via XHR so the caller can drive a progress UI.
// onProgress receives a number in [0, 1].
export const uploadVideo = (file, onProgress) =>
  new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
      } else {
        reject(new Error('Upload failed: ' + xhr.responseText));
      }
    });
    xhr.addEventListener('error', () =>
      reject(new Error('Upload failed — is the server running?'))
    );
    xhr.open('POST', `${API}/upload`);
    xhr.send(formData);
  });

// ---- Subtitles

export const fetchSubtitles = async (videoName) => {
  try {
    const r = await fetch(`${API}/subtitles/${encodeURIComponent(videoName)}`);
    return r.ok ? r.json() : [];
  } catch {
    return [];
  }
};

export const uploadSubtitle = (file, videoName, lang) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('videoName', videoName);
  if (lang) formData.append('lang', lang);
  return fetch(`${API}/upload-subtitles`, { method: 'POST', body: formData })
    .then((r) => asJson(r, 'Subtitle upload failed'));
};

export const deleteSubtitle = (videoName, subName) =>
  fetch(
    `${API}/subtitles/${encodeURIComponent(videoName)}/${encodeURIComponent(subName)}`,
    { method: 'DELETE' }
  );

// ---- Posters

export const uploadPoster = (file, videoName) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('videoName', videoName);
  return fetch(`${API}/upload-poster`, { method: 'POST', body: formData })
    .then((r) => asJson(r, 'Poster upload failed'));
};

export const deletePoster = (videoName) =>
  fetch(`${API}/poster/${encodeURIComponent(videoName)}`, { method: 'DELETE' });

// ---- TMDB

export const tmdbStatus = async () => {
  try {
    const r = await fetch(`${API}/tmdb/status`);
    const data = await r.json();
    return Boolean(data.configured);
  } catch {
    return false;
  }
};

export const tmdbSearch = (q) =>
  fetch(`${API}/tmdb/search?q=${encodeURIComponent(q)}`).then((r) => asJson(r));

export const tmdbSuggestQuery = (filename) =>
  fetch(`${API}/tmdb/suggest-query?filename=${encodeURIComponent(filename)}`)
    .then((r) => r.json());

export const tmdbFetchPoster = (posterPath, videoName, tmdbId) =>
  fetch(`${API}/tmdb/fetch-poster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ posterPath, videoName, tmdbId }),
  }).then((r) => asJson(r, 'TMDB poster fetch failed'));

// Returns { ok, body } so the caller can show either a success or error
// summary without re-parsing the response twice.
export const tmdbBackfill = async () => {
  const r = await fetch(`${API}/tmdb/backfill`, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, body };
};

// ---- Torrents

export const fetchTorrents = () => fetch(`${API}/torrents`).then((r) => r.json());

export const addTorrentMagnet = (magnet) =>
  fetch(`${API}/torrent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet }),
  }).then((r) => asJson(r, 'Failed to add torrent'));

export const removeTorrent = (infoHash) =>
  fetch(`${API}/torrent/${infoHash}`, { method: 'DELETE' });

export const setTorrentPaused = (infoHash, paused) => {
  const action = paused ? 'pause' : 'resume';
  return fetch(`${API}/torrent/${infoHash}/${action}`, { method: 'POST' })
    .then((r) => asJson(r, `Failed to ${action}`));
};

export const saveTorrentToLibrary = (infoHash) =>
  fetch(`${API}/torrent/${infoHash}/save-to-library`, { method: 'POST' })
    .then((r) => asJson(r));
