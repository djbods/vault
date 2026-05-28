// Per-card edit modal: rename, poster (upload / TMDB / remove), subtitle
// add/remove, ffprobe summary + re-process action, watched toggle.
//
// `editing.videoName` is the canonical filename on disk; every action
// keys off it, and after a rename or re-process we update it so
// subsequent panels target the renamed file.

import { SUB_LANG_OPTIONS, cleanName, escapeHtml } from './utils.js';
import {
  API,
  fetchVideos,
  fetchSubtitles,
  probeVideo,
  renameVideo,
  reprocessVideo,
  deleteSubtitle,
  uploadPoster,
  deletePoster,
  uploadSubtitle,
  tmdbFetchPoster,
} from './api.js';
import { openTmdbPicker } from './tmdb.js';
import { inferLangFromFilename } from './upload.js';

// ---- DOM refs (queried in initEdit)
let editModal, editModalSub, editName, editNameSave,
  editPosterPreview, editPosterTmdb, editPosterUpload, editPosterRemove,
  editSubList, editSubInput, editSubLang, editSubPick,
  editProbe, editReprocess,
  editWatched, editWatchedLabel,
  editDetailsSection, editDetails;

// ---- Module-private state
let editing = null;

// Host callbacks for cross-module concerns:
//   onLibraryRefresh — typically loadVideos, called after any mutation
//                       that changes how cards render
//   onWatchedChange  — typically setWatched, called from the watched toggle
let onLibraryRefresh = () => {};
let onWatchedChange = async () => {};

const openEditModalModal = () => editModal.classList.add('active');

const populateEditSubLang = () => {
  if (editSubLang.options.length) return;
  SUB_LANG_OPTIONS.forEach(([code, label]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    editSubLang.appendChild(opt);
  });
};

const renderEditPoster = (videoName, posterUrl) => {
  if (posterUrl) {
    editPosterPreview.innerHTML = `<img src="${API}${posterUrl}?t=${Date.now()}" alt=""/>`;
    editPosterRemove.style.display = '';
  } else {
    editPosterPreview.innerHTML = '<span class="edit-poster-empty">None</span>';
    editPosterRemove.style.display = 'none';
  }
};

const renderEditSubList = (subs) => {
  editSubList.innerHTML = '';
  subs.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'edit-sub-row';
    row.innerHTML = `
      <span class="edit-sub-row-name"></span>
      <span class="edit-sub-row-lang"></span>
      <button class="edit-sub-row-remove" type="button" title="Delete subtitle">×</button>
    `;
    row.querySelector('.edit-sub-row-name').textContent = s.name;
    row.querySelector('.edit-sub-row-lang').textContent = s.label || (s.lang || '').toUpperCase();
    row.querySelector('.edit-sub-row-remove').addEventListener('click', async () => {
      if (!confirm(`Delete subtitle "${s.name}"?`)) return;
      try {
        const r = await deleteSubtitle(editing.videoName, s.name);
        if (!r.ok) throw new Error('Delete failed');
        await refreshEditSubList();
      } catch (err) {
        alert(err.message);
      }
    });
    editSubList.appendChild(row);
  });
};

const refreshEditSubList = async () => {
  const subs = await fetchSubtitles(editing.videoName);
  renderEditSubList(subs);
};

// Pull a probe of the underlying file (audio codec, container, embedded
// subtitle streams) and render a short status line plus a hint for the
// re-process button.
const refreshEditProbe = async () => {
  editProbe.textContent = 'Probing…';
  try {
    const r = await probeVideo(editing.videoName);
    if (!r.ok) {
      editProbe.textContent = 'Could not probe video file.';
      return;
    }
    const p = await r.json();
    const audio = p.audioCodec || 'none';
    const audioClass = p.audioBrowserCompatible ? 'ok' : 'warn';
    const container = p.container.replace('.', '').toUpperCase();
    const containerClass = p.containerBrowserCompatible ? 'ok' : 'warn';
    const extractable = p.embeddedSubtitles.filter((s) => s.extractable);
    const bitmapCount = p.embeddedSubtitles.length - extractable.length;
    const parts = [
      `<span class="${containerClass}">${container}</span> container`,
      `<span class="${audioClass}">${audio.toUpperCase()}</span> audio`,
    ];
    if (p.videoCodec) parts.push(`${p.videoCodec.toUpperCase()} video`);
    let line = parts.join(' · ');
    if (extractable.length) {
      line += `<br/><span class="warn">${extractable.length} embedded subtitle track${extractable.length === 1 ? '' : 's'} not yet extracted</span>`;
    }
    if (bitmapCount) {
      line += `<br/>${bitmapCount} bitmap subtitle track${bitmapCount === 1 ? '' : 's'} (cannot extract)`;
    }
    if (!p.browserCompatible) {
      line += `<br/><span class="warn">Browser cannot play this file as-is — re-process to fix.</span>`;
    }
    editProbe.innerHTML = line;
  } catch {
    editProbe.textContent = 'Could not probe video file.';
  }
};

const refreshEditPoster = async () => {
  // /videos returns the canonical poster URL, including a fresh
  // mtime-based query string. Re-fetch instead of guessing.
  try {
    const list = await fetchVideos();
    const v = list.find((x) => x.name === editing.videoName);
    renderEditPoster(editing.videoName, v && v.poster);
  } catch {}
};

const renderEditDetails = (v) => {
  const overview = v.overview || '';
  const cast = Array.isArray(v.cast) ? v.cast : [];
  const director = v.director || '';
  const year = v.year || '';
  const runtime = v.runtime ? `${v.runtime} min` : '';
  const genres = (v.genres || []).join(', ');
  const rows = [];
  if (director) rows.push(`<div class="edit-details-row"><dt>Director</dt><dd>${escapeHtml(director)}</dd></div>`);
  if (cast.length) rows.push(`<div class="edit-details-row"><dt>Cast</dt><dd>${escapeHtml(cast.join(', '))}</dd></div>`);
  if (year || runtime) {
    const parts = [year, runtime].filter(Boolean).map(escapeHtml).join(' · ');
    rows.push(`<div class="edit-details-row"><dt>Year</dt><dd>${parts}</dd></div>`);
  }
  if (genres) rows.push(`<div class="edit-details-row"><dt>Genres</dt><dd>${escapeHtml(genres)}</dd></div>`);
  const hasAny = overview || rows.length;
  editDetailsSection.style.display = hasAny ? '' : 'none';
  editDetails.innerHTML = (overview ? `<div class="edit-details-overview">${escapeHtml(overview)}</div>` : '') + rows.join('');
};

export const openEditModal = async (videoName) => {
  populateEditSubLang();
  editing = { videoName };
  editModalSub.textContent = cleanName(videoName);
  editName.value = cleanName(videoName);
  editSubLang.value = 'en';
  // Find this video in the most recent /videos response for the poster
  // and the watched/metadata flags.
  const list = await fetchVideos().catch(() => []);
  const v = list.find((x) => x.name === videoName) || {};
  renderEditPoster(videoName, v.poster);
  editWatched.checked = Boolean(v.watched);
  editWatchedLabel.textContent = v.watched ? 'Watched' : 'Not watched';
  renderEditDetails(v);
  const subs = await fetchSubtitles(videoName);
  renderEditSubList(subs);
  refreshEditProbe();
  openEditModalModal();
};

export const initEdit = ({
  onLibraryRefresh: onLibraryRefreshCb,
  onWatchedChange: onWatchedChangeCb,
} = {}) => {
  editModal           = document.getElementById('editModal');
  editModalSub        = document.getElementById('editModalSub');
  editName            = document.getElementById('editName');
  editNameSave        = document.getElementById('editNameSave');
  editPosterPreview   = document.getElementById('editPosterPreview');
  editPosterTmdb      = document.getElementById('editPosterTmdb');
  editPosterUpload    = document.getElementById('editPosterUpload');
  editPosterRemove    = document.getElementById('editPosterRemove');
  editSubList         = document.getElementById('editSubList');
  editSubInput        = document.getElementById('editSubInput');
  editSubLang         = document.getElementById('editSubLang');
  editSubPick         = document.getElementById('editSubPick');
  editProbe           = document.getElementById('editProbe');
  editReprocess       = document.getElementById('editReprocess');
  editWatched         = document.getElementById('editWatched');
  editWatchedLabel    = document.getElementById('editWatchedLabel');
  editDetailsSection  = document.getElementById('editDetailsSection');
  editDetails         = document.getElementById('editDetails');

  if (onLibraryRefreshCb) onLibraryRefresh = onLibraryRefreshCb;
  if (onWatchedChangeCb) onWatchedChange = onWatchedChangeCb;

  editWatched.addEventListener('change', async () => {
    if (!editing) return;
    const next = editWatched.checked;
    editWatchedLabel.textContent = next ? 'Watched' : 'Not watched';
    await onWatchedChange(editing.videoName, next);
  });

  editReprocess.addEventListener('click', async () => {
    if (!editing) return;
    if (!confirm('Re-process this video?\n\nThis re-encodes audio if needed and extracts embedded subtitles. It can take a while for large files.')) return;
    editReprocess.disabled = true;
    const originalLabel = editReprocess.textContent;
    editReprocess.textContent = 'Re-processing…';
    try {
      const body = await reprocessVideo(editing.videoName);
      // The video filename may have changed (.mkv → .mp4). Track the
      // new name so subsequent edit-modal actions target it.
      editing.videoName = body.name;
      editModalSub.textContent = cleanName(body.name);
      editName.value = cleanName(body.name);
      await Promise.all([refreshEditSubList(), refreshEditProbe(), refreshEditPoster()]);
      onLibraryRefresh();
      const addedMsg = body.subtitlesAdded && body.subtitlesAdded.length
        ? ` Extracted ${body.subtitlesAdded.length} subtitle${body.subtitlesAdded.length === 1 ? '' : 's'}.`
        : '';
      alert(`Re-process complete.${addedMsg}`);
    } catch (err) {
      alert(err.message);
    } finally {
      editReprocess.disabled = false;
      editReprocess.textContent = originalLabel;
    }
  });

  editNameSave.addEventListener('click', async () => {
    if (!editing) return;
    const newName = editName.value.trim();
    if (!newName || newName === cleanName(editing.videoName)) return;
    editNameSave.disabled = true;
    try {
      const body = await renameVideo(editing.videoName, newName);
      editing.videoName = body.name;
      editModalSub.textContent = cleanName(body.name);
      editName.value = cleanName(body.name);
      // Sidecars (poster + subs) were renamed too — refresh both panels.
      await Promise.all([refreshEditPoster(), refreshEditSubList()]);
      onLibraryRefresh();
    } catch (err) {
      alert(err.message);
    } finally {
      editNameSave.disabled = false;
    }
  });

  editPosterUpload.addEventListener('click', () => {
    if (!editing) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        await uploadPoster(file, editing.videoName);
        await refreshEditPoster();
        onLibraryRefresh();
      } catch (err) {
        alert(err.message);
      }
    });
    input.click();
  });

  editPosterTmdb.addEventListener('click', () => {
    if (!editing) return;
    // Edit-flow commit: write the selected poster straight to the file
    // and refresh both the inline preview and the library grid. The
    // edit modal stays open underneath the picker.
    const targetVideoName = editing.videoName;
    openTmdbPicker(targetVideoName, {
      subtitle: `Update poster for ${cleanName(targetVideoName)}`,
      onCommit: async (picked) => {
        await tmdbFetchPoster(picked.posterPath, targetVideoName);
        if (editing && editing.videoName === targetVideoName) {
          await refreshEditPoster();
        }
        onLibraryRefresh();
      },
    });
  });

  editPosterRemove.addEventListener('click', async () => {
    if (!editing) return;
    if (!confirm('Remove the current poster?')) return;
    try {
      await deletePoster(editing.videoName);
      await refreshEditPoster();
      onLibraryRefresh();
    } catch (err) {
      alert(err.message);
    }
  });

  editSubPick.addEventListener('click', () => editSubInput.click());
  editSubInput.addEventListener('change', async () => {
    if (!editing) return;
    const file = editSubInput.files && editSubInput.files[0];
    if (!file) return;
    // Prefer a language tag inferred from the filename if it matches
    // a known option; otherwise use the selected dropdown value.
    const inferred = inferLangFromFilename(file.name);
    const lang = inferred !== 'en' ? inferred : editSubLang.value;
    try {
      await uploadSubtitle(file, editing.videoName, lang);
      await refreshEditSubList();
    } catch (err) {
      alert(err.message);
    } finally {
      editSubInput.value = '';
    }
  });
};
