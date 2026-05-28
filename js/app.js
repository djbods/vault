// Thin orchestrator. Wires tab switching, modal open / close delegation,
// and the Escape-key dismiss chain, then boots every module.

import { initPlayer, resetPlayer } from './player.js';
import { initTmdb, runTmdbBackfill } from './tmdb.js';
import { initUpload, resetUploadModal } from './upload.js';
import { initEdit } from './edit.js';
import { initLibrary, loadVideos, setWatched, getLibraryCache } from './library.js';
import { initTorrents, startTorrentPoll, stopTorrentPoll } from './torrents.js';

// ---- DOM refs
const uploadModal  = document.getElementById('uploadModal');
const playerModal  = document.getElementById('playerModal');
const posterModal  = document.getElementById('posterModal');
const editModal    = document.getElementById('editModal');
const tabsEl       = document.getElementById('tabs');
const openUploadBtn = document.getElementById('openUpload');

// ---- Tabs
const switchTab = (name) => {
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.getElementById('viewLibrary').classList.toggle('active', name === 'library');
  document.getElementById('viewTorrents').classList.toggle('active', name === 'torrents');
  openUploadBtn.style.display = name === 'library' ? '' : 'none';
  if (name === 'torrents') startTorrentPoll();
  else stopTorrentPoll();
};
tabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) switchTab(btn.dataset.tab);
});

// ---- Modals — open / close delegation
const openModal = (el) => el.classList.add('active');
const closeModal = (el) => {
  el.classList.remove('active');
  if (el === playerModal) {
    resetPlayer();
    // Refresh the library so the Continue Watching shelf reflects the
    // resume position that was just saved (and removes the card if the
    // user watched past 95% / dismissed near the end).
    loadVideos();
  }
  if (el === uploadModal) resetUploadModal();
};

// Any element with [data-close="<modalId>"] dismisses the named modal.
document.addEventListener('click', (e) => {
  const closeTarget = e.target.closest('[data-close]');
  if (closeTarget) {
    e.stopPropagation();
    closeModal(document.getElementById(closeTarget.dataset.close));
  }
});

// Clicking the modal backdrop (the modal element itself, not its content)
// dismisses the modal.
[uploadModal, playerModal, posterModal, editModal].forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });
});

// Escape always dismisses the topmost active modal.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (playerModal.classList.contains('active')) closeModal(playerModal);
  else if (posterModal.classList.contains('active')) closeModal(posterModal);
  else if (editModal.classList.contains('active')) closeModal(editModal);
  else if (uploadModal.classList.contains('active')) closeModal(uploadModal);
});

openUploadBtn.addEventListener('click', () => openModal(uploadModal));

// ---- Boot
initLibrary();
initPlayer({ onWatchedChange: setWatched });
initEdit({ onLibraryRefresh: () => loadVideos(), onWatchedChange: setWatched });
initTmdb();
initUpload({ onUploaded: loadVideos });
initTorrents();

(async () => {
  await loadVideos();
  runTmdbBackfill(getLibraryCache(), loadVideos);
})();
