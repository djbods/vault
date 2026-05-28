// Torrent tab: add a magnet, render the live torrent grid, watch via the
// player, pause/resume, save-to-library (which transcodes + adds the
// finished file to the library + removes the torrent).

import { escapeHtml, formatSize, formatSpeed, formatEta } from './utils.js';
import {
  API,
  fetchTorrents,
  addTorrentMagnet,
  removeTorrent as apiRemoveTorrent,
  setTorrentPaused,
  saveTorrentToLibrary as apiSaveTorrentToLibrary,
} from './api.js';
import { playTorrent } from './player.js';
import { loadVideos } from './library.js';

// ---- DOM refs (queried in initTorrents)
let torrentGrid, torrentEmpty, magnetInput, addTorrentBtn;

// ---- Module-private poll timer
let torrentPollTimer = null;

// ---- Card render
const renderTorrentCard = (t) => {
  const card = document.createElement('div');
  card.className = 't-card';
  const pct = Math.round((t.progress || 0) * 100);
  const canWatch = (t.progress || 0) > 0.02 && t.mainVideo;
  const canSave = (t.progress || 0) >= 1 && t.mainVideo;
  const isComplete = (t.progress || 0) >= 1;
  const isPaused = Boolean(t.paused);
  // Pause/Resume only makes sense while still downloading; once a
  // torrent is at 100% it's just seeding and the action becomes a no-op.
  const showPauseToggle = !isComplete;
  const statusText = {
    connecting: 'Connecting',
    downloading: 'Downloading',
    stalled: 'Stalled',
    seeding: 'Seeding',
    paused: 'Paused',
  }[t.status] || t.status;

  // Show the ETA stat only while we're actually downloading — paused
  // and stalled torrents would just render "—".
  const showEta = !isComplete && !isPaused && t.etaSeconds != null;

  card.innerHTML = `
    <div class="t-head">
      <h3 class="t-title">${escapeHtml(t.name || t.infoHash)}</h3>
      <span class="t-badge" data-status="${t.status}">${statusText}</span>
    </div>
    <div class="t-progress-wrap">
      <div class="t-progress-label">
        <span>Progress</span>
        <span>${pct}%</span>
      </div>
      <div class="t-progress-bar">
        <div class="t-progress-fill" style="width:${pct}%"></div>
      </div>
    </div>
    <div class="t-stats">
      <div><span class="t-stat-label">DL</span>${formatSpeed(t.downloadSpeed)}</div>
      <div><span class="t-stat-label">Peers</span>${t.numPeers || 0}</div>
      ${t.mainVideo ? `<div><span class="t-stat-label">Size</span>${formatSize(t.mainVideo.length)}</div>` : ''}
      ${showEta ? `<div><span class="t-stat-label">ETA</span>${formatEta(t.etaSeconds)}</div>` : ''}
    </div>
    <div class="t-actions">
      <button class="t-watch" ${canWatch ? '' : 'disabled'}>${canWatch ? 'Watch' : 'Buffering…'}</button>
      ${showPauseToggle ? `<button class="t-pause">${isPaused ? 'Resume' : 'Pause'}</button>` : ''}
      ${canSave ? `<button class="t-save">Save to Library</button>` : ''}
    </div>
    <button class="card-delete" title="Remove torrent">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/>
        <path d="M10 11v6M14 11v6"/>
      </svg>
    </button>
  `;

  card.querySelector('.t-watch').addEventListener('click', () => {
    if (canWatch) playTorrent(t);
  });
  const pauseBtn = card.querySelector('.t-pause');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => onTogglePause(t.infoHash, isPaused, pauseBtn));
  }
  const saveBtn = card.querySelector('.t-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => onSaveToLibrary(t, saveBtn));
  }
  card.querySelector('.card-delete').addEventListener('click', () => onRemoveTorrent(t.infoHash));
  return card;
};

const onTogglePause = async (infoHash, isPaused, btn) => {
  btn.disabled = true;
  try {
    await setTorrentPaused(infoHash, !isPaused);
    loadTorrents();
  } catch (err) {
    alert(`Failed to ${isPaused ? 'resume' : 'pause'}: ${err.message}`);
    btn.disabled = false;
  }
};

export const loadTorrents = async () => {
  try {
    const torrents = await fetchTorrents();
    torrentGrid.innerHTML = '';
    if (!torrents.length) {
      torrentEmpty.style.display = 'flex';
      torrentGrid.style.display = 'none';
    } else {
      torrentEmpty.style.display = 'none';
      torrentGrid.style.display = 'grid';
      torrents.forEach((t) => torrentGrid.appendChild(renderTorrentCard(t)));
    }
  } catch {
    torrentGrid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-dim);font-size:13px;letter-spacing:0.2em;text-transform:uppercase;padding:40px 0;text-align:center;">Cannot reach server at ${API}.</div>`;
  }
};

const onAddTorrent = async () => {
  const magnet = magnetInput.value.trim();
  if (!magnet) return;
  if (!magnet.startsWith('magnet:')) {
    alert('Paste a magnet: URI');
    return;
  }
  addTorrentBtn.disabled = true;
  try {
    await addTorrentMagnet(magnet);
    magnetInput.value = '';
    loadTorrents();
  } catch (err) {
    alert(err.message);
  } finally {
    addTorrentBtn.disabled = false;
  }
};

const onRemoveTorrent = async (infoHash) => {
  if (!confirm('Remove this torrent?')) return;
  try {
    await apiRemoveTorrent(infoHash);
    loadTorrents();
  } catch {
    alert('Failed to remove');
  }
};

const onSaveToLibrary = async (t, btn) => {
  const label = t.mainVideo ? t.mainVideo.name : t.name;
  if (!confirm(`Save "${label}" to your library? The torrent will be removed.`)) return;

  // The server's save-to-library call now includes an ffmpeg pass
  // (audio re-encode + faststart). It blocks until done — typically
  // 1-3 min for a 1-2 GB file. We show a live elapsed counter so the
  // user doesn't think the button has hung.
  btn.disabled = true;
  btn.classList.add('is-working');
  const startedAt = Date.now();
  const fmtMMSS = (totalSec) => {
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${m}:${s}`;
  };
  const render = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    btn.innerHTML = `<span class="spinner"></span>Transcoding ${fmtMMSS(elapsed)}`;
  };
  render();
  const timer = setInterval(render, 1000);

  try {
    await apiSaveTorrentToLibrary(t.infoHash);
    await Promise.all([loadTorrents(), loadVideos()]);
    // On success the torrent card is re-rendered or removed entirely,
    // so we don't need to reset btn state.
  } catch (err) {
    alert('Failed to save: ' + err.message);
    btn.disabled = false;
    btn.classList.remove('is-working');
    btn.textContent = 'Save to Library';
  } finally {
    clearInterval(timer);
  }
};

// Tab-switch hooks: start polling when the torrents view becomes active,
// stop when it leaves. Idempotent.
export const startTorrentPoll = () => {
  loadTorrents();
  if (!torrentPollTimer) torrentPollTimer = setInterval(loadTorrents, 1500);
};

export const stopTorrentPoll = () => {
  if (torrentPollTimer) {
    clearInterval(torrentPollTimer);
    torrentPollTimer = null;
  }
};

export const initTorrents = () => {
  torrentGrid    = document.getElementById('torrentGrid');
  torrentEmpty   = document.getElementById('torrentEmpty');
  magnetInput    = document.getElementById('magnetInput');
  addTorrentBtn  = document.getElementById('addTorrentBtn');

  addTorrentBtn.addEventListener('click', onAddTorrent);
  magnetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onAddTorrent();
  });
};
