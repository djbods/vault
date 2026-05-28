// Upload modal: drag-and-drop a video, stage subtitles + poster, then
// commit via /upload (XHR with progress). All staged state lives in
// this module's scope.

import { SUB_LANG_OPTIONS, cleanName, escapeHtml, formatSize } from './utils.js';
import {
  uploadVideo as apiUploadVideo,
  uploadSubtitle,
  uploadPoster,
  tmdbFetchPoster,
} from './api.js';
import { openTmdbPicker } from './tmdb.js';

// ---- DOM refs (queried in initUpload)
let uploadModal,
  dropzone, dropzoneText, dropzoneSub,
  fileInput,
  subtitleStage, subtitleInput, subtitleSummary, subtitlePick, subtitleList,
  posterStage, posterInput, posterName, posterPreview, posterClear, posterPick, posterTmdb,
  uploadActions, uploadCommitBtn,
  progressEl, progressFill, progressName, progressPercent;

// ---- Module-private staged state
let stagedVideo = null;
let stagedSubtitles = []; // [{ file, lang }]
let stagedPoster = null;  // { kind: 'file', file } | { kind: 'tmdb', ... }

// Notify the host when an upload finishes so it can refresh the library.
let onUploaded = () => {};

const closeUploadModal = () => uploadModal.classList.remove('active');

export const resetUploadModal = () => {
  stagedVideo = null;
  stagedSubtitles = [];
  stagedPoster = null;
  fileInput.value = '';
  subtitleInput.value = '';
  posterInput.value = '';
  subtitleStage.style.display = 'none';
  posterStage.style.display = 'none';
  uploadActions.style.display = 'none';
  subtitleSummary.textContent = 'None added';
  subtitleList.innerHTML = '';
  posterName.textContent = 'None selected';
  posterPreview.style.display = 'none';
  posterPreview.src = '';
  posterClear.style.display = 'none';
  progressEl.classList.remove('active');
  progressFill.style.width = '0%';
  dropzoneText.innerHTML = 'Drop a video here, or <span class="dropzone-link">browse</span>';
  dropzoneSub.textContent = 'MP4 · MOV · WEBM · MKV';
  uploadCommitBtn.disabled = false;
  uploadCommitBtn.textContent = 'Upload';
};

const updatePosterSlotUI = () => {
  if (!stagedPoster) {
    posterName.textContent = 'None selected';
    posterPreview.style.display = 'none';
    posterPreview.src = '';
    posterClear.style.display = 'none';
    return;
  }
  if (stagedPoster.kind === 'file') {
    posterName.textContent = stagedPoster.file.name;
    posterPreview.src = URL.createObjectURL(stagedPoster.file);
    posterPreview.style.display = '';
  } else if (stagedPoster.kind === 'tmdb') {
    posterName.textContent = stagedPoster.title ? `TMDB · ${stagedPoster.title}` : 'TMDB poster';
    posterPreview.src = stagedPoster.previewUrl;
    posterPreview.style.display = '';
  }
  posterClear.style.display = '';
};

const renderSubtitleList = () => {
  subtitleList.innerHTML = '';
  if (!stagedSubtitles.length) {
    subtitleSummary.textContent = 'None added';
    return;
  }
  subtitleSummary.textContent =
    `${stagedSubtitles.length} subtitle${stagedSubtitles.length === 1 ? '' : 's'} added`;
  stagedSubtitles.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'sub-row';
    const select = SUB_LANG_OPTIONS.map(([code, label]) =>
      `<option value="${code}" ${entry.lang === code ? 'selected' : ''}>${label} (${code.toUpperCase()})</option>`
    ).join('');
    row.innerHTML = `
      <div class="sub-row-name">${escapeHtml(entry.file.name)}</div>
      <select class="sub-row-lang" data-idx="${idx}">${select}</select>
      <button class="sub-row-remove" type="button" data-idx="${idx}" title="Remove">×</button>
    `;
    subtitleList.appendChild(row);
  });
  subtitleList.querySelectorAll('.sub-row-lang').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const i = Number(e.target.dataset.idx);
      stagedSubtitles[i].lang = e.target.value;
    });
  });
  subtitleList.querySelectorAll('.sub-row-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const i = Number(e.currentTarget.dataset.idx);
      stagedSubtitles.splice(i, 1);
      renderSubtitleList();
    });
  });
};

// Exported so edit.js can reuse the same heuristic when picking a default
// language for a manually-added subtitle.
export const inferLangFromFilename = (filename) => {
  const m = filename.match(/\.([a-z]{2,3})\.[^.]+$/i);
  if (m && SUB_LANG_OPTIONS.find(([c]) => c === m[1].toLowerCase())) return m[1].toLowerCase();
  return 'en';
};

const stageVideo = (file) => {
  if (!file) return;
  stagedVideo = file;
  dropzoneText.textContent = file.name;
  dropzoneSub.textContent = formatSize(file.size);
  subtitleStage.style.display = 'flex';
  posterStage.style.display = 'flex';
  uploadActions.style.display = 'flex';
};

// Drives the upload-progress UI strip; delegates the XHR to api.js.
const runVideoUpload = (file) => {
  progressEl.classList.add('active');
  progressName.textContent = cleanName(file.name) || 'Uploading';
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';
  return apiUploadVideo(file, (ratio) => {
    const pct = ratio * 100;
    progressFill.style.width = `${pct}%`;
    progressPercent.textContent = `${Math.round(pct)}%`;
  });
};

const applyStagedPoster = (poster, videoName) => {
  if (poster.kind === 'file') return uploadPoster(poster.file, videoName);
  if (poster.kind === 'tmdb') return tmdbFetchPoster(poster.posterPath, videoName, poster.tmdbId);
};

const onUploadCommit = async () => {
  if (!stagedVideo) return;
  uploadCommitBtn.disabled = true;
  try {
    const uploaded = await runVideoUpload(stagedVideo);
    if (uploaded && uploaded.name) {
      for (const entry of stagedSubtitles) {
        await uploadSubtitle(entry.file, uploaded.name, entry.lang);
      }
      if (stagedPoster) {
        await applyStagedPoster(stagedPoster, uploaded.name);
      }
    }
    closeUploadModal();
    onUploaded();
  } catch (err) {
    alert(err.message || 'Upload failed');
    uploadCommitBtn.disabled = false;
    progressEl.classList.remove('active');
  }
};

export const initUpload = ({ onUploaded: onUploadedCb } = {}) => {
  uploadModal      = document.getElementById('uploadModal');
  dropzone         = document.getElementById('dropzone');
  dropzoneText     = document.getElementById('dropzoneText');
  dropzoneSub      = document.getElementById('dropzoneSub');
  fileInput        = document.getElementById('fileInput');
  subtitleStage    = document.getElementById('subtitleStage');
  subtitleInput    = document.getElementById('subtitleInput');
  subtitleSummary  = document.getElementById('subtitleSummary');
  subtitlePick     = document.getElementById('subtitlePick');
  subtitleList     = document.getElementById('subtitleList');
  posterStage      = document.getElementById('posterStage');
  posterInput      = document.getElementById('posterInput');
  posterName       = document.getElementById('posterName');
  posterPreview    = document.getElementById('posterPreview');
  posterClear      = document.getElementById('posterClear');
  posterPick       = document.getElementById('posterPick');
  posterTmdb       = document.getElementById('posterTmdb');
  uploadActions    = document.getElementById('uploadActions');
  uploadCommitBtn  = document.getElementById('commitUpload');
  progressEl       = document.getElementById('progress');
  progressFill     = document.getElementById('progressFill');
  progressName     = document.getElementById('progressName');
  progressPercent  = document.getElementById('progressPercent');

  if (onUploadedCb) onUploaded = onUploadedCb;

  // Dropzone
  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) stageVideo(file);
  });
  fileInput.addEventListener('change', (e) => stageVideo(e.target.files[0]));

  // Subtitle picker
  subtitlePick.addEventListener('click', () => subtitleInput.click());
  subtitleInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      stagedSubtitles.push({ file, lang: inferLangFromFilename(file.name) });
    });
    subtitleInput.value = '';
    renderSubtitleList();
  });

  // Poster picker (file / clear / TMDB)
  posterPick.addEventListener('click', () => posterInput.click());
  posterInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    stagedPoster = { kind: 'file', file };
    updatePosterSlotUI();
  });
  posterClear.addEventListener('click', () => {
    stagedPoster = null;
    posterInput.value = '';
    updatePosterSlotUI();
  });
  posterTmdb.addEventListener('click', () => {
    openTmdbPicker(stagedVideo ? stagedVideo.name : '', {
      onCommit: (picked) => {
        stagedPoster = {
          kind: 'tmdb',
          tmdbId: picked.tmdbId,
          posterPath: picked.posterPath,
          previewUrl: picked.previewUrl,
          title: picked.title,
        };
        updatePosterSlotUI();
      },
    });
  });

  // Commit
  uploadCommitBtn.addEventListener('click', onUploadCommit);
};
