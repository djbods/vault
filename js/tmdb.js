// TMDB integration: poster picker modal, search, fetch, auto-backfill on
// boot, and the global "looking up film details" status toast.
//
// Shared between the upload modal (stage a poster) and the edit modal
// (apply a poster to an existing file). Callers pass an onCommit callback
// when opening the picker — the picker doesn't know about either flow.

import { escapeHtml, cleanName } from './utils.js';
import {
  tmdbStatus,
  tmdbSearch,
  tmdbSuggestQuery,
  tmdbFetchPoster,
  tmdbBackfill,
} from './api.js';

// ---- DOM refs (queried in initTmdb)
let posterModal, posterModalSub, tmdbQuery, tmdbSearchBtn, tmdbResults,
  posterActions, posterCommit, statusToast, statusToastText;

// ---- Module-private state
// Memoised so we don't hit /tmdb/status on every poster click.
let tmdbReady = null;
// Set in openTmdbPicker; { onCommit(picked) } where picked is
// { tmdbId, posterPath, previewUrl, title }.
let posterContext = null;
// Currently-highlighted search result.
let stagedTmdbPoster = null;
let statusToastHideTimer = null;

// ---- Status toast (also used by other long-running operations later)
export const showStatusToast = (text, { state = 'running', autoHideMs = 0 } = {}) => {
  if (statusToastHideTimer) { clearTimeout(statusToastHideTimer); statusToastHideTimer = null; }
  statusToastText.textContent = text;
  statusToast.dataset.state = state;
  statusToast.hidden = false;
  // Defer the visibility flip a tick so the transition runs.
  requestAnimationFrame(() => { statusToast.dataset.visible = 'true'; });
  if (autoHideMs > 0) {
    statusToastHideTimer = setTimeout(hideStatusToast, autoHideMs);
  }
};

export const hideStatusToast = () => {
  statusToast.dataset.visible = 'false';
  setTimeout(() => { if (statusToast.dataset.visible !== 'true') statusToast.hidden = true; }, 300);
};

// ---- TMDB
export const ensureTmdbStatus = async () => {
  if (tmdbReady !== null) return tmdbReady;
  tmdbReady = await tmdbStatus();
  return tmdbReady;
};

const renderTmdbResults = (results) => {
  tmdbResults.innerHTML = '';
  stagedTmdbPoster = null;
  posterActions.style.display = 'none';
  if (!results.length) {
    tmdbResults.innerHTML = `<div class="tmdb-empty">No matches. Try a different title.</div>`;
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'tmdb-results';
  results.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'tmdb-card';
    card.innerHTML = `
      ${m.posterUrl
        ? `<img class="tmdb-poster" src="${m.posterUrl}" alt="" loading="lazy"/>`
        : `<div class="tmdb-poster"></div>`}
      <div class="tmdb-meta">
        <div class="t-name">${escapeHtml(m.title || 'Untitled')}</div>
        <div>${escapeHtml(m.year || '—')}</div>
      </div>
    `;
    card.addEventListener('click', () => {
      grid.querySelectorAll('.tmdb-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      stagedTmdbPoster = {
        tmdbId: m.id,
        posterPath: m.posterPath,
        previewUrl: m.posterUrl,
        title: m.title,
      };
      posterActions.style.display = stagedTmdbPoster.posterPath ? 'flex' : 'none';
    });
    grid.appendChild(card);
  });
  tmdbResults.appendChild(grid);
};

const runTmdbSearch = async () => {
  const q = tmdbQuery.value.trim();
  if (!q) return;
  tmdbResults.innerHTML = `<div class="tmdb-empty">Searching…</div>`;
  posterActions.style.display = 'none';
  try {
    const data = await tmdbSearch(q);
    renderTmdbResults(data.results || []);
  } catch (err) {
    tmdbResults.innerHTML = `<div class="tmdb-empty">${escapeHtml(err.message)}</div>`;
  }
};

// Open the poster picker. `filename` is used to seed the search query
// (cleaned via the server's /tmdb/suggest-query). `onCommit` receives
// the chosen `{ tmdbId, posterPath, previewUrl, title }` when the user
// hits "Use this poster". `subtitle` is the small caption above the
// search box — typically "Update poster for <name>" or
// "Search The Movie Database".
export const openTmdbPicker = async (filename, { onCommit, subtitle } = {}) => {
  const ok = await ensureTmdbStatus();
  if (!ok) {
    alert('TMDB is not configured. Add TMDB_API_KEY to .env and restart the server.');
    return;
  }
  posterContext = { onCommit };
  posterModalSub.textContent = subtitle || 'Search The Movie Database';
  tmdbResults.innerHTML = '';
  posterActions.style.display = 'none';
  stagedTmdbPoster = null;
  // Prefill cleaned query from filename
  try {
    if (filename) {
      const data = await tmdbSuggestQuery(filename);
      tmdbQuery.value = data.query || cleanName(filename);
    } else {
      tmdbQuery.value = '';
    }
  } catch {
    tmdbQuery.value = filename ? cleanName(filename) : '';
  }
  posterModal.classList.add('active');
  if (tmdbQuery.value) runTmdbSearch();
  setTimeout(() => tmdbQuery.focus(), 50);
};

// Background auto-backfill: only worth firing when at least one library
// file is missing tmdbId, so the host passes in its libraryCache and a
// reload callback for the success path.
export const runTmdbBackfill = async (libraryCache, onMatched) => {
  if (!(await ensureTmdbStatus())) return;
  if (!libraryCache.some((v) => !v.tmdbId)) return;
  showStatusToast('Looking up film details…');
  try {
    const { ok, body: summary } = await tmdbBackfill();
    if (!ok) {
      showStatusToast(summary.error || 'TMDB lookup failed', { state: 'done', autoHideMs: 4000 });
      return;
    }
    if (summary.matched > 0) {
      if (onMatched) await onMatched();
      const word = summary.matched === 1 ? 'film' : 'films';
      showStatusToast(`Matched ${summary.matched} ${word} to TMDB`, { state: 'done', autoHideMs: 3500 });
    } else if (summary.candidates > 0) {
      showStatusToast('No confident TMDB matches', { state: 'done', autoHideMs: 3000 });
    } else {
      hideStatusToast();
    }
  } catch {
    showStatusToast('TMDB lookup unavailable', { state: 'done', autoHideMs: 3000 });
  }
};

export const initTmdb = () => {
  posterModal      = document.getElementById('posterModal');
  posterModalSub   = document.getElementById('posterModalSub');
  tmdbQuery        = document.getElementById('tmdbQuery');
  tmdbSearchBtn    = document.getElementById('tmdbSearchBtn');
  tmdbResults      = document.getElementById('tmdbResults');
  posterActions    = document.getElementById('posterActions');
  posterCommit     = document.getElementById('posterCommit');
  statusToast      = document.getElementById('statusToast');
  statusToastText  = document.getElementById('statusToastText');

  tmdbSearchBtn.addEventListener('click', runTmdbSearch);
  tmdbQuery.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTmdbSearch();
  });

  posterCommit.addEventListener('click', async () => {
    if (!stagedTmdbPoster || !posterContext) return;
    posterCommit.disabled = true;
    try {
      await posterContext.onCommit(stagedTmdbPoster);
      posterModal.classList.remove('active');
    } catch (err) {
      alert(err.message);
    } finally {
      posterCommit.disabled = false;
    }
  });
};
