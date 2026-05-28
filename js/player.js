// Custom Netflix-style player chrome. Owns the <video> element, scrub bar,
// subtitle menu, volume, fullscreen / PiP / AirPlay, resume position, and
// the 95%-watched auto-mark. Internal state stays private; the rest of the
// app interacts via initPlayer / playLocalVideo / playTorrent / resetPlayer.

import {
  cleanName,
  formatTime,
  labelForLang,
  isTouchDevice,
  isTypingTarget,
} from './utils.js';
import {
  API,
  fetchSubtitles,
  fetchVideos,
  patchVideoMetadata,
} from './api.js';

// ---- DOM refs (queried lazily so the module can be imported before DOMContentLoaded)
let playerModal,
  playerEl, playerTitleEl,
  playerCC, subMenu,
  playerPip, playerAirplay,
  playerShell, playerOverlay, playerTap,
  playerCenterBtn, playerPlayBtn,
  playerBack10, playerFwd10,
  playerMute, playerVolSlider,
  playerCurrent, playerDuration,
  playerFs,
  playerScrub, playerBuffer, playerProgress, playerScrubHover, playerThumb, playerTooltip,
  playerSkipBack, playerSkipFwd;

const grabRefs = () => {
  playerModal      = document.getElementById('playerModal');
  playerEl         = document.getElementById('player');
  playerTitleEl    = document.getElementById('playerTitle');
  playerCC         = document.getElementById('playerCC');
  subMenu          = document.getElementById('subMenu');
  playerPip        = document.getElementById('playerPip');
  playerAirplay    = document.getElementById('playerAirplay');
  playerShell      = document.getElementById('playerShell');
  playerOverlay    = document.getElementById('playerOverlay');
  playerTap        = document.getElementById('playerTap');
  playerCenterBtn  = document.getElementById('playerCenterBtn');
  playerPlayBtn    = document.getElementById('playerPlay');
  playerBack10     = document.getElementById('playerBack10');
  playerFwd10      = document.getElementById('playerFwd10');
  playerMute       = document.getElementById('playerMute');
  playerVolSlider  = document.getElementById('playerVolSlider');
  playerCurrent    = document.getElementById('playerCurrent');
  playerDuration   = document.getElementById('playerDuration');
  playerFs         = document.getElementById('playerFs');
  playerScrub      = document.getElementById('playerScrub');
  playerBuffer     = document.getElementById('playerBuffer');
  playerProgress   = document.getElementById('playerProgress');
  playerScrubHover = document.getElementById('playerScrubHover');
  playerThumb      = document.getElementById('playerThumb');
  playerTooltip    = document.getElementById('playerTooltip');
  playerSkipBack   = document.getElementById('playerSkipBack');
  playerSkipFwd    = document.getElementById('playerSkipFwd');
};

// ---- Module-private state
// currentLocalVideo: the filename in the player. Torrents leave this null
// so resume / auto-watched only apply to library files.
let currentLocalVideo = null;
let activeTrackIndex = -1; // -1 = Off
let resumeApplied = false;
let watchedFiredAt = 0;    // de-dup the 95% auto-watched call
let resumeSaveTimer = null;

// Callback for "this file is now watched" — wired by the host app so the
// library can refresh its watched-state grid without player.js knowing
// about the library module.
let onWatchedChange = () => {};

// ---- Subtitle menu
const closeSubMenu = () => {
  subMenu.classList.remove('open');
  playerCC.setAttribute('aria-expanded', 'false');
};

const renderSubMenu = (tracks) => {
  subMenu.innerHTML = '';
  const makeItem = (label, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sub-menu-item';
    btn.role = 'menuitem';
    btn.textContent = label;
    if (idx === activeTrackIndex) btn.classList.add('active');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSubtitle(idx);
      closeSubMenu();
    });
    return btn;
  };
  subMenu.appendChild(makeItem('Off', -1));
  tracks.forEach((t, i) => {
    subMenu.appendChild(makeItem(labelForLang(t.lang) || t.label || `Track ${i + 1}`, i));
  });
};

const selectSubtitle = (idx) => {
  activeTrackIndex = idx;
  const tracks = playerEl.textTracks;
  for (let i = 0; i < tracks.length; i++) {
    tracks[i].mode = i === idx ? 'showing' : 'disabled';
  }
  playerCC.classList.toggle('active', idx >= 0);
  // Re-render so the active dot follows the new selection.
  const items = subMenu.querySelectorAll('.sub-menu-item');
  items.forEach((el, i) => el.classList.toggle('active', (i - 1) === idx));
};

const applySubtitles = (tracks) => {
  playerEl.querySelectorAll('track').forEach((t) => t.remove());
  activeTrackIndex = -1;
  playerCC.classList.remove('active');
  closeSubMenu();
  if (!tracks || !tracks.length) {
    playerCC.hidden = true;
    subMenu.innerHTML = '';
    return;
  }
  tracks.forEach((t) => {
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.src = t.url;
    el.label = labelForLang(t.lang) || t.label || 'CC';
    el.srclang = t.lang || 'en';
    playerEl.appendChild(el);
  });
  playerCC.hidden = false;
  renderSubMenu(tracks);
  const disableAll = () => {
    for (const tr of playerEl.textTracks) tr.mode = 'disabled';
  };
  disableAll();
  setTimeout(disableAll, 50);
};

// ---- Play / pause + state
const togglePlayPause = () => {
  if (playerEl.paused || playerEl.ended) playerEl.play().catch(() => {});
  else playerEl.pause();
};

const setPlayState = () => {
  const state = playerEl.ended ? 'ended' : playerEl.paused ? 'paused' : 'playing';
  playerShell.dataset.state = state;
  playerPlayBtn.setAttribute('aria-label', state === 'playing' ? 'Pause' : 'Play');
  playerCenterBtn.setAttribute('aria-label', state === 'playing' ? 'Pause' : 'Play');
};

// ---- Seek by N seconds (skip buttons + keyboard + double-tap)
const seekBy = (delta) => {
  if (!Number.isFinite(playerEl.duration)) return;
  playerEl.currentTime = Math.min(
    playerEl.duration,
    Math.max(0, playerEl.currentTime + delta),
  );
};

// ---- Volume
const setMute = (muted) => {
  playerEl.muted = muted;
  if (!muted && playerEl.volume === 0) playerEl.volume = 0.5;
  updateVolumeUI();
};

const updateVolumeUI = () => {
  const v = playerEl.muted ? 0 : playerEl.volume;
  playerVolSlider.value = String(v);
  playerShell.dataset.vol = v === 0 ? 'mute' : v < 0.5 ? 'low' : 'high';
  playerMute.setAttribute('aria-label', v === 0 ? 'Unmute' : 'Mute');
};

// ---- Scrub bar
// Pointer-events so it works for mouse and touch (and respects pen).
// While scrubbing we pause+resume so the audio doesn't stutter through
// every dragged frame.
let scrubbing = false;
let scrubResume = false;

const scrubPositionFromEvent = (e) => {
  const rect = playerScrub.getBoundingClientRect();
  const x = Math.min(rect.right, Math.max(rect.left, e.clientX));
  return (x - rect.left) / rect.width;
};

const updateTooltipForRatio = (ratio) => {
  if (!Number.isFinite(playerEl.duration)) return;
  const rect = playerScrub.getBoundingClientRect();
  const time = ratio * playerEl.duration;
  playerTooltip.textContent = formatTime(time);
  const half = playerTooltip.offsetWidth / 2;
  const minLeft = half + 6;
  const maxLeft = rect.width - half - 6;
  const clamped = Math.min(maxLeft, Math.max(minLeft, ratio * rect.width));
  playerTooltip.style.left = `${clamped}px`;
};

const updateProgress = () => {
  const d = playerEl.duration;
  if (!Number.isFinite(d) || d <= 0) {
    playerProgress.style.width = '0%';
    playerThumb.style.left = '0%';
    return;
  }
  const pct = (playerEl.currentTime / d) * 100;
  playerProgress.style.width = `${pct}%`;
  playerThumb.style.left = `${pct}%`;
  playerCurrent.textContent = formatTime(playerEl.currentTime);
};

const updateBuffer = () => {
  const d = playerEl.duration;
  if (!Number.isFinite(d) || d <= 0 || !playerEl.buffered.length) {
    playerBuffer.style.width = '0%';
    return;
  }
  // Show the buffered range that contains the current playhead.
  let end = 0;
  for (let i = 0; i < playerEl.buffered.length; i++) {
    if (
      playerEl.buffered.start(i) <= playerEl.currentTime &&
      playerEl.buffered.end(i) > end
    ) {
      end = playerEl.buffered.end(i);
    }
  }
  playerBuffer.style.width = `${(end / d) * 100}%`;
};

// ---- Auto-hide overlay
let hideTimer = null;
const showOverlay = () => {
  playerShell.dataset.idle = 'false';
};
const hideOverlayNow = () => {
  // Don't hide while paused / ended, or while a menu is open.
  if (playerEl.paused || playerEl.ended) return;
  if (subMenu.classList.contains('open')) return;
  playerShell.dataset.idle = 'true';
};
const scheduleHideOverlay = (keepOpen = false) => {
  showOverlay();
  if (hideTimer) clearTimeout(hideTimer);
  if (keepOpen) return;
  hideTimer = setTimeout(hideOverlayNow, 3000);
};

// ---- Fullscreen
const toggleFullscreen = () => {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const req = playerShell.requestFullscreen || playerShell.webkitRequestFullscreen;
    if (req) req.call(playerShell).catch(() => {});
    else if (playerEl.webkitEnterFullscreen) playerEl.webkitEnterFullscreen(); // iOS Safari
  }
};

const syncFullscreenState = () => {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  playerShell.dataset.fullscreen = fsEl === playerShell ? 'true' : 'false';
};

// ---- Resume position
// Persist current time every ~5s while playing; restore on load.
const maybeSaveResume = () => {
  if (!currentLocalVideo) return;
  if (!Number.isFinite(playerEl.duration) || playerEl.duration <= 0) return;
  if (playerEl.paused || playerEl.ended) return;
  const now = performance.now();
  if (resumeSaveTimer && now - resumeSaveTimer < 5000) return;
  resumeSaveTimer = now;
  // Within 5s of either end — treat as "no resume" (Netflix behaviour).
  const t = playerEl.currentTime;
  const nearEnd = t > playerEl.duration - 5;
  const nearStart = t < 5;
  const value = (nearEnd || nearStart) ? null : t;
  patchVideoMetadata(currentLocalVideo, { resumePosition: value }).catch(() => {});
};

const maybeMarkWatched = () => {
  if (!currentLocalVideo) return;
  if (!Number.isFinite(playerEl.duration) || playerEl.duration <= 0) return;
  const ratio = playerEl.currentTime / playerEl.duration;
  if (ratio < 0.95) return;
  // De-dup so we don't PATCH on every timeupdate after 95%.
  const now = performance.now();
  if (now - watchedFiredAt < 60_000) return;
  watchedFiredAt = now;
  onWatchedChange(currentLocalVideo, true);
};

const tryApplyResume = (resumeSec) => {
  if (resumeApplied) return;
  if (!Number.isFinite(resumeSec) || resumeSec < 5) return;
  if (!Number.isFinite(playerEl.duration) || playerEl.duration <= 0) return;
  // Don't resume if we'd land within 30s of the end.
  if (resumeSec > playerEl.duration - 30) return;
  playerEl.currentTime = resumeSec;
  resumeApplied = true;
};

// ---- Reset on close
export function resetPlayer() {
  if (document.pictureInPictureElement === playerEl) {
    document.exitPictureInPicture().catch(() => {});
  }
  if (document.fullscreenElement === playerShell) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  }
  // Save one final resume position synchronously-ish before we wipe state.
  if (currentLocalVideo && Number.isFinite(playerEl.duration) && !playerEl.ended) {
    const t = playerEl.currentTime;
    const value = (t < 5 || t > playerEl.duration - 5) ? null : t;
    // Force a save by clearing the debounce.
    resumeSaveTimer = 0;
    patchVideoMetadata(currentLocalVideo, { resumePosition: value }, { keepalive: true })
      .catch(() => {});
  }
  playerEl.pause();
  playerEl.querySelectorAll('track').forEach((t) => t.remove());
  playerEl.removeAttribute('src');
  playerEl.load();
  playerCC.hidden = true;
  playerCC.classList.remove('active');
  closeSubMenu();
  subMenu.innerHTML = '';
  playerShell.dataset.state = 'paused';
  playerShell.dataset.idle = 'false';
  playerShell.dataset.buffering = 'false';
  playerProgress.style.width = '0%';
  playerBuffer.style.width = '0%';
  playerThumb.style.left = '0%';
  playerCurrent.textContent = '0:00';
  playerDuration.textContent = '0:00';
  currentLocalVideo = null;
  resumeApplied = false;
  watchedFiredAt = 0;
  resumeSaveTimer = null;
}

// ---- Opening the player

const openPlayerModal = () => playerModal.classList.add('active');

export const playLocalVideo = async (filename) => {
  currentLocalVideo = filename;
  resumeApplied = false;
  watchedFiredAt = 0;
  resumeSaveTimer = null;
  playerEl.src = `${API}/stream/${encodeURIComponent(filename)}`;
  playerTitleEl.textContent = cleanName(filename);
  openPlayerModal();
  setPlayState();
  updateVolumeUI();
  // Subtitles + resume position fetched in parallel.
  let resumeSec = null;
  try {
    const [subs, list] = await Promise.all([
      fetchSubtitles(filename),
      fetchVideos().catch(() => []),
    ]);
    const tracks = subs.map((s) => ({
      url: `${API}${s.url}`,
      label: s.label,
      lang: s.lang,
    }));
    applySubtitles(tracks);
    const v = list.find((x) => x.name === filename);
    if (v && typeof v.resumePosition === 'number') resumeSec = v.resumePosition;
  } catch {
    applySubtitles([]);
  }
  // Apply resume position once metadata is in. `loadedmetadata` may
  // have fired before we got here, so try once now and once on the
  // event for safety.
  const apply = () => tryApplyResume(resumeSec);
  if (playerEl.readyState >= 1) apply();
  playerEl.addEventListener('loadedmetadata', apply, { once: true });
  playerEl.play().catch(() => {});
  scheduleHideOverlay();
};

export const playTorrent = (t) => {
  currentLocalVideo = null;
  resumeApplied = true; // disable resume for torrents
  playerEl.src = `${API}/torrent/${t.infoHash}/stream`;
  playerTitleEl.textContent = cleanName((t.mainVideo && t.mainVideo.name) || t.name);
  openPlayerModal();
  setPlayState();
  updateVolumeUI();
  const tracks = (t.subtitles || []).map((s) => ({
    url: `${API}/torrent/${t.infoHash}/subtitles/${encodeURIComponent(s.name)}`,
    label: (s.name.match(/\.([a-z]{2,3})\.[^.]+$/i) || [, 'CC'])[1].toUpperCase(),
    lang: (s.name.match(/\.([a-z]{2,3})\.[^.]+$/i) || [, 'en'])[1].toLowerCase(),
  }));
  applySubtitles(tracks);
  playerEl.play().catch(() => {});
  scheduleHideOverlay();
};

// ---- Init: query DOM refs, wire every event listener
export function initPlayer({ onWatchedChange: onWatchedChangeCb } = {}) {
  grabRefs();
  if (onWatchedChangeCb) onWatchedChange = onWatchedChangeCb;

  // Subtitle menu
  playerCC.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!playerEl.textTracks.length) return;
    const isOpen = subMenu.classList.toggle('open');
    playerCC.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    scheduleHideOverlay(true); // keep overlay open while menu is up
  });

  document.addEventListener('click', (e) => {
    if (!subMenu.classList.contains('open')) return;
    if (e.target.closest('#subMenu') || e.target.closest('#playerCC')) return;
    closeSubMenu();
  });

  // Play / pause
  playerPlayBtn.addEventListener('click', togglePlayPause);
  playerCenterBtn.addEventListener('click', togglePlayPause);

  playerEl.addEventListener('play',  () => { setPlayState(); scheduleHideOverlay(); });
  playerEl.addEventListener('pause', () => { setPlayState(); showOverlay(); });
  playerEl.addEventListener('ended', () => {
    setPlayState();
    showOverlay();
    if (currentLocalVideo) onWatchedChange(currentLocalVideo, true);
  });

  // Skip ±10s
  playerBack10.addEventListener('click', () => seekBy(-10));
  playerFwd10.addEventListener('click', () => seekBy(10));

  // Volume
  playerMute.addEventListener('click', () => setMute(!playerEl.muted));
  playerVolSlider.addEventListener('input', () => {
    playerEl.volume = parseFloat(playerVolSlider.value) || 0;
    playerEl.muted = playerEl.volume === 0;
    updateVolumeUI();
  });
  playerEl.addEventListener('volumechange', updateVolumeUI);

  // Scrub bar
  playerScrub.addEventListener('pointermove', (e) => {
    if (!Number.isFinite(playerEl.duration)) return;
    const ratio = scrubPositionFromEvent(e);
    playerScrub.classList.add('is-hovered');
    playerScrubHover.style.width = `${ratio * 100}%`;
    updateTooltipForRatio(ratio);
  });

  playerScrub.addEventListener('pointerleave', () => {
    if (!scrubbing) playerScrub.classList.remove('is-hovered');
  });

  playerScrub.addEventListener('pointerdown', (e) => {
    if (!Number.isFinite(playerEl.duration)) return;
    scrubbing = true;
    scrubResume = !playerEl.paused;
    if (scrubResume) playerEl.pause();
    playerScrub.classList.add('is-scrubbing');
    playerScrub.setPointerCapture(e.pointerId);
    const ratio = scrubPositionFromEvent(e);
    playerEl.currentTime = ratio * playerEl.duration;
    updateTooltipForRatio(ratio);
    scheduleHideOverlay(true);
  });

  playerScrub.addEventListener('pointermove', (e) => {
    if (!scrubbing) return;
    const ratio = scrubPositionFromEvent(e);
    playerEl.currentTime = ratio * playerEl.duration;
    updateTooltipForRatio(ratio);
  });

  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    playerScrub.classList.remove('is-scrubbing');
    try { playerScrub.releasePointerCapture(e.pointerId); } catch {}
    if (scrubResume) playerEl.play().catch(() => {});
    scrubResume = false;
    scheduleHideOverlay();
  };
  playerScrub.addEventListener('pointerup', endScrub);
  playerScrub.addEventListener('pointercancel', endScrub);

  // Time + buffer display
  playerEl.addEventListener('loadedmetadata', () => {
    playerDuration.textContent = formatTime(playerEl.duration);
    updateProgress();
    // Persist the duration to the sidecar on first playback so the
    // Continue Watching shelf can render an accurate progress bar
    // without re-probing every file server-side. Fire-and-forget.
    if (currentLocalVideo && Number.isFinite(playerEl.duration) && playerEl.duration > 0) {
      patchVideoMetadata(currentLocalVideo, { duration: playerEl.duration }).catch(() => {});
    }
  });

  playerEl.addEventListener('timeupdate', () => {
    updateProgress();
    updateBuffer();
    maybeSaveResume();
    maybeMarkWatched();
  });
  playerEl.addEventListener('progress', updateBuffer);
  playerEl.addEventListener('seeked', updateBuffer);

  // Buffering spinner
  playerEl.addEventListener('waiting', () => { playerShell.dataset.buffering = 'true'; });
  playerEl.addEventListener('playing', () => { playerShell.dataset.buffering = 'false'; });
  playerEl.addEventListener('canplay',  () => { playerShell.dataset.buffering = 'false'; });

  // Auto-hide overlay
  ['pointermove', 'pointerdown', 'touchstart'].forEach((ev) => {
    playerShell.addEventListener(ev, () => scheduleHideOverlay());
  });
  playerOverlay.addEventListener('pointermove', () => scheduleHideOverlay(true));
  playerOverlay.addEventListener('pointerleave', () => scheduleHideOverlay());

  // Tap to toggle play (desktop click on stage)
  let tapClickTimer = null;
  playerTap.addEventListener('click', () => {
    if (isTouchDevice()) return; // mobile uses touch handlers below
    if (tapClickTimer) {
      clearTimeout(tapClickTimer);
      tapClickTimer = null;
      toggleFullscreen();
    } else {
      tapClickTimer = setTimeout(() => {
        tapClickTimer = null;
        togglePlayPause();
      }, 220);
    }
  });

  // Mobile: tap to toggle overlay, double-tap left/right to skip
  let lastTapAt = 0;
  let lastTapX = 0;
  playerTap.addEventListener('touchend', (e) => {
    if (e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const now = performance.now();
    const dx = Math.abs(t.clientX - lastTapX);
    const dt = now - lastTapAt;
    if (dt < 350 && dx < 80) {
      // Double-tap — skip ±10s based on which half of the screen
      const rect = playerShell.getBoundingClientRect();
      const isLeft = t.clientX - rect.left < rect.width / 2;
      seekBy(isLeft ? -10 : 10);
      (isLeft ? playerSkipBack : playerSkipFwd).classList.remove('show');
      void (isLeft ? playerSkipBack : playerSkipFwd).offsetWidth;
      (isLeft ? playerSkipBack : playerSkipFwd).classList.add('show');
      setTimeout(() => {
        (isLeft ? playerSkipBack : playerSkipFwd).classList.remove('show');
      }, 600);
      lastTapAt = 0;
      e.preventDefault();
      return;
    }
    lastTapAt = now;
    lastTapX = t.clientX;
    // Single tap: toggle overlay visibility (Netflix-on-mobile pattern).
    if (playerShell.dataset.idle === 'true') {
      scheduleHideOverlay();
    } else if (!playerEl.paused && !playerEl.ended) {
      hideOverlayNow();
    }
  });

  // Fullscreen
  playerFs.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', syncFullscreenState);
  document.addEventListener('webkitfullscreenchange', syncFullscreenState);

  // Picture-in-Picture
  if (document.pictureInPictureEnabled && !playerEl.disablePictureInPicture) {
    playerPip.hidden = false;
    playerPip.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement === playerEl) {
          await document.exitPictureInPicture();
        } else {
          await playerEl.requestPictureInPicture();
        }
      } catch (err) {
        console.warn('PiP toggle failed', err);
      }
    });
    playerEl.addEventListener('enterpictureinpicture', () => {
      playerPip.classList.add('active');
      playerPip.setAttribute('aria-pressed', 'true');
    });
    playerEl.addEventListener('leavepictureinpicture', () => {
      playerPip.classList.remove('active');
      playerPip.setAttribute('aria-pressed', 'false');
    });
  }

  // AirPlay (Safari only). Feature-detect the WebKit-prefixed picker
  // before showing the button.
  if (
    typeof window.WebKitPlaybackTargetAvailabilityEvent !== 'undefined' &&
    typeof playerEl.webkitShowPlaybackTargetPicker === 'function'
  ) {
    playerEl.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      playerAirplay.hidden = e.availability !== 'available';
    });
    playerEl.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
      playerAirplay.classList.toggle('active', !!playerEl.webkitCurrentPlaybackTargetIsWireless);
    });
    playerAirplay.addEventListener('click', () => {
      try {
        playerEl.webkitShowPlaybackTargetPicker();
      } catch (err) {
        console.warn('AirPlay picker failed', err);
      }
    });
  }

  // Keyboard shortcuts — only active while the player modal is open.
  document.addEventListener('keydown', (e) => {
    if (!playerModal.classList.contains('active')) return;
    if (isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key;
    if (key === ' ' || key === 'k' || key === 'K') {
      e.preventDefault();
      togglePlayPause();
    } else if (key === 'ArrowLeft' || key === 'j' || key === 'J') {
      e.preventDefault();
      seekBy(e.shiftKey ? -30 : key.toLowerCase() === 'j' ? -10 : -5);
    } else if (key === 'ArrowRight' || key === 'l' || key === 'L') {
      e.preventDefault();
      seekBy(e.shiftKey ? 30 : key.toLowerCase() === 'l' ? 10 : 5);
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      playerEl.volume = Math.min(1, playerEl.volume + 0.05);
      if (playerEl.muted) playerEl.muted = false;
    } else if (key === 'ArrowDown') {
      e.preventDefault();
      playerEl.volume = Math.max(0, playerEl.volume - 0.05);
    } else if (key === 'm' || key === 'M') {
      e.preventDefault();
      setMute(!playerEl.muted);
    } else if (key === 'f' || key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (key === 'c' || key === 'C') {
      if (playerEl.textTracks.length) {
        e.preventDefault();
        // Cycle Off → 0 → 1 → … → Off
        const next = activeTrackIndex + 1 >= playerEl.textTracks.length ? -1 : activeTrackIndex + 1;
        selectSubtitle(next);
      }
    } else if (key === 'i' || key === 'I') {
      if (!playerPip.hidden) {
        e.preventDefault();
        playerPip.click();
      }
    } else if (/^[0-9]$/.test(key) && Number.isFinite(playerEl.duration)) {
      e.preventDefault();
      playerEl.currentTime = (parseInt(key, 10) / 10) * playerEl.duration;
    }
  });

  // Initial volume UI sync (player may load with cached volume).
  updateVolumeUI();
}
