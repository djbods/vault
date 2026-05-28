// Library grid + Continue Watching shelf + genre filter pills.
// Owns: libraryCache, selectedGenres, hover-preview lifecycle,
// anchor-on-hover edge detection, and the loadVideos fetch+render cycle.

import { cleanName, escapeHtml, formatSize } from './utils.js';
import {
  API,
  fetchVideos,
  deleteVideo as apiDeleteVideo,
  patchVideoMetadata,
} from './api.js';
import { playLocalVideo } from './player.js';
import { openEditModal } from './edit.js';

// ---- DOM refs (queried in initLibrary)
let gridEl, libraryEmpty, genreBarEl,
  continueShelfEl, continueShelfRowEl, continueShelfCountEl;

// ---- Module state
let libraryCache = [];

// Genre filter state — Set of selected genre names. Empty set means
// "show everything". Persisted to localStorage so the user's last filter
// sticks across reloads.
const GENRE_STORAGE_KEY = 'vault.selectedGenres';
const selectedGenres = new Set(
  (() => {
    try {
      const raw = localStorage.getItem(GENRE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  })()
);

const persistGenres = () => {
  try {
    localStorage.setItem(GENRE_STORAGE_KEY, JSON.stringify([...selectedGenres]));
  } catch {}
};

// ---- Watched / resume helpers exported for use by player + edit
// PATCH the per-video metadata sidecar. Called by the edit modal's
// watched toggle and by the player's 95%-watched / 'ended' auto-mark.
// Always refreshes the grid so the corner badge updates.
export const setWatched = async (videoName, watched) => {
  try {
    await patchVideoMetadata(videoName, { watched });
    loadVideos();
  } catch (err) {
    console.warn('setWatched failed', err);
  }
};

const onDeleteVideoClick = async (filename) => {
  if (!confirm(`Delete "${cleanName(filename)}"?`)) return;
  const res = await apiDeleteVideo(filename);
  if (res.ok) loadVideos();
  else alert('Failed to delete');
};

const computeProgress = (video) => {
  if (video.watched) return null;
  const resume = Number(video.resumePosition);
  const duration = Number(video.duration);
  if (!Number.isFinite(resume) || resume <= 0) return null;
  if (!Number.isFinite(duration) || duration <= 0) {
    return { pct: null, remaining: null };
  }
  const pct = Math.max(0, Math.min(100, (resume / duration) * 100));
  const remainingSec = Math.max(0, duration - resume);
  return { pct, remaining: remainingSec };
};

const formatRemaining = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h left` : `${h}h ${r}m left`;
};

// ---- Hover preview (Netflix-style)
const HOVER_DELAY_MS = 600;
const attachHoverPreview = (card, video, streamUrl) => {
  let timer = null;
  let previewVid = null;
  const start = () => {
    if (previewVid) return;
    previewVid = document.createElement('video');
    previewVid.className = 'preview-video';
    previewVid.src = streamUrl;
    previewVid.muted = true;
    previewVid.playsInline = true;
    previewVid.preload = 'auto';
    previewVid.addEventListener('loadedmetadata', () => {
      if (!previewVid) return;
      const seekTo = Math.min(60, (previewVid.duration || 0) * 0.1);
      try { previewVid.currentTime = seekTo; } catch {}
    });
    previewVid.addEventListener('canplay', () => {
      if (!previewVid) return;
      previewVid.play().then(() => {
        if (previewVid) previewVid.classList.add('playing');
      }).catch(() => {});
    });
    card.querySelector('.card-media').appendChild(previewVid);
  };
  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (previewVid) {
      try { previewVid.pause(); } catch {}
      previewVid.remove();
      previewVid = null;
    }
  };
  card.addEventListener('mouseenter', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(start, HOVER_DELAY_MS);
  });
  card.addEventListener('mouseleave', stop);
};

// Decide which edge the card should expand from so it never overflows
// the grid. Runs synchronously on mouseenter so the class is applied
// before the hover transition starts.
const HOVER_EXPAND_RATIO = 8 / 3; // 16:9 at portrait height ÷ 2:3 slot width
const GRID_EDGE_PADDING = 8;
const attachAnchorOnHover = (card, slot) => {
  card.addEventListener('mouseenter', () => {
    const slotRect = slot.getBoundingClientRect();
    const gridRect = gridEl.getBoundingClientRect();
    const slotCenter = slotRect.left + slotRect.width / 2;
    const halfExpanded = (slotRect.width * HOVER_EXPAND_RATIO) / 2;
    card.classList.remove('anchor-left', 'anchor-right');
    if (slotCenter - halfExpanded < gridRect.left + GRID_EDGE_PADDING) {
      card.classList.add('anchor-left');
    } else if (slotCenter + halfExpanded > gridRect.right - GRID_EDGE_PADDING) {
      card.classList.add('anchor-right');
    }
  });
};

// ---- Card render
const renderCard = (video, opts = {}) => {
  const { inShelf = false } = opts;
  const slot = document.createElement('div');
  slot.className = 'card-slot' + (inShelf ? ' card-slot--shelf' : '');
  const card = document.createElement('div');
  card.className = 'card' + (video.watched ? ' card--watched' : '');
  const streamUrl = `${API}/stream/${encodeURIComponent(video.name)}`;
  const posterHtml = video.poster
    ? `<img class="poster-img" src="${API}${video.poster}" alt="" loading="lazy"/>`
    : `<video src="${streamUrl}#t=0.5" preload="metadata" muted playsinline></video>`;
  const watchedBadge = video.watched
    ? `<div class="card-watched-badge"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>Watched</div>`
    : '';
  const progress = computeProgress(video);
  const progressBar = progress && progress.pct != null
    ? `<div class="card-progress"><div class="card-progress-fill" style="width:${progress.pct.toFixed(1)}%"></div></div>`
    : '';
  card.innerHTML = `
    <div class="card-media">
      ${posterHtml}
      ${watchedBadge}
      ${progressBar}
      <div class="card-play">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </div>
    </div>
    <button class="card-edit" title="Edit">
      <svg viewBox="0 0 24 24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="14" rx="2"/>
        <circle cx="9" cy="10" r="1.6"/>
        <path d="m21 15-5-5L5 21"/>
      </svg>
    </button>
    <button class="card-delete" title="Delete">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/>
        <path d="M10 11v6M14 11v6"/>
      </svg>
    </button>
    <div class="card-info">
      <h3 class="card-title">${cleanName(video.name)}</h3>
      <div class="card-meta">
        ${video.year ? `<span>${video.year}</span>` : ''}
        ${video.year && (video.genres || []).length ? `<span class="dot"></span>` : ''}
        ${(video.genres || []).length ? `<span>${escapeHtml(video.genres[0])}</span>` : ''}
        ${(video.year || (video.genres || []).length) ? `<span class="dot"></span>` : ''}
        <span class="card-meta-size">${
          progress && progress.remaining != null
            ? formatRemaining(progress.remaining)
            : (progress ? 'Continue' : formatSize(video.size))
        }</span>
      </div>
    </div>
  `;
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-delete') || e.target.closest('.card-edit')) return;
    playLocalVideo(video.name);
  });
  card.querySelector('.card-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    onDeleteVideoClick(video.name);
  });
  card.querySelector('.card-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(video.name);
  });
  // Shelf cards live in a horizontally-scrolling, overflow-clipped row
  // so the bloom-into-landscape transform and autoplay preview would
  // either get hidden or push the card outside its slot. The grid
  // hover handlers also measure against gridEl, which doesn't apply
  // to the shelf row — skip both.
  if (!inShelf) {
    attachHoverPreview(card, video, streamUrl);
    attachAnchorOnHover(card, slot);
  }
  slot.appendChild(card);
  return slot;
};

// ---- Genre pills + library / shelf renderers
const renderGenrePills = (videos) => {
  // Build the union of genres present in the current library, sorted
  // alphabetically so the pill order is stable. Filters that point
  // at a genre no longer in the library are dropped silently.
  const genres = new Set();
  videos.forEach((v) => (v.genres || []).forEach((g) => genres.add(g)));
  const list = [...genres].sort((a, b) => a.localeCompare(b));
  for (const g of [...selectedGenres]) {
    if (!genres.has(g)) selectedGenres.delete(g);
  }

  genreBarEl.innerHTML = '';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'genre-pill genre-pill--all' + (selectedGenres.size === 0 ? ' active' : '');
  all.textContent = 'All';
  all.addEventListener('click', () => {
    selectedGenres.clear();
    persistGenres();
    renderGenrePills(libraryCache);
    renderLibrary();
  });
  genreBarEl.appendChild(all);

  list.forEach((g) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'genre-pill' + (selectedGenres.has(g) ? ' active' : '');
    btn.textContent = g;
    btn.addEventListener('click', () => {
      if (selectedGenres.has(g)) selectedGenres.delete(g);
      else selectedGenres.add(g);
      persistGenres();
      renderGenrePills(libraryCache);
      renderLibrary();
    });
    genreBarEl.appendChild(btn);
  });
};

const renderContinueShelf = () => {
  // In-progress = has a non-trivial resume marker and not flagged watched.
  // Sorted by lastPlayedAt desc so the most recently touched film is on
  // the left. Cap to 12 to keep the row tidy.
  const inProgress = libraryCache
    .filter((v) => !v.watched && Number(v.resumePosition) > 0)
    .sort((a, b) => {
      const ta = Date.parse(a.lastPlayedAt || a.modified || 0);
      const tb = Date.parse(b.lastPlayedAt || b.modified || 0);
      return tb - ta;
    })
    .slice(0, 12);

  if (!inProgress.length) {
    continueShelfEl.hidden = true;
    continueShelfRowEl.innerHTML = '';
    return;
  }
  continueShelfEl.hidden = false;
  continueShelfCountEl.textContent =
    inProgress.length === 1 ? '1 film' : `${inProgress.length} films`;
  continueShelfRowEl.innerHTML = '';
  inProgress.forEach((v) => continueShelfRowEl.appendChild(renderCard(v, { inShelf: true })));
};

const renderLibrary = () => {
  const matches = selectedGenres.size === 0
    ? libraryCache
    : libraryCache.filter((v) =>
        (v.genres || []).some((g) => selectedGenres.has(g))
      );
  gridEl.innerHTML = '';
  renderContinueShelf();
  if (!libraryCache.length) {
    libraryEmpty.style.display = 'flex';
    gridEl.style.display = 'none';
    return;
  }
  libraryEmpty.style.display = 'none';
  gridEl.style.display = 'grid';
  if (!matches.length) {
    gridEl.innerHTML = `<div class="grid-empty-msg">No films in this selection.</div>`;
    return;
  }
  matches.forEach((v) => gridEl.appendChild(renderCard(v)));
};

export const loadVideos = async () => {
  try {
    libraryCache = await fetchVideos();
    renderGenrePills(libraryCache);
    renderLibrary();
  } catch {
    gridEl.innerHTML = `<div style="grid-column:1/-1;color:var(--text-dim);font-size:13px;letter-spacing:0.2em;text-transform:uppercase;padding:40px 0;text-align:center;">Cannot reach server at ${API}. Start it with <code style="color:var(--gold)">npm start</code>.</div>`;
  }
};

// Read-only access to the cached video list, used by the TMDB backfill
// to decide whether any file is missing a tmdbId. Returning the live
// array (not a copy) is intentional — callers only read.
export const getLibraryCache = () => libraryCache;

export const initLibrary = () => {
  gridEl                = document.getElementById('grid');
  libraryEmpty          = document.getElementById('libraryEmpty');
  genreBarEl            = document.getElementById('genreBar');
  continueShelfEl       = document.getElementById('continueShelf');
  continueShelfRowEl    = document.getElementById('continueShelfRow');
  continueShelfCountEl  = document.getElementById('continueShelfCount');
};
