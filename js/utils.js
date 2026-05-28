// Pure helpers shared across modules. No DOM access, no fetch, no state.

export const SUB_LANG_OPTIONS = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'],
  ['no', 'Norwegian'], ['da', 'Danish'], ['fi', 'Finnish'], ['ru', 'Russian'],
  ['pl', 'Polish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'],
  ['ar', 'Arabic'], ['hi', 'Hindi'], ['tr', 'Turkish'], ['vi', 'Vietnamese'],
  ['th', 'Thai'], ['id', 'Indonesian'], ['he', 'Hebrew'], ['cs', 'Czech'],
  ['el', 'Greek'], ['hu', 'Hungarian'], ['ro', 'Romanian'], ['uk', 'Ukrainian'],
];

const LANG_LABELS = Object.fromEntries(SUB_LANG_OPTIONS);

export const labelForLang = (code) =>
  LANG_LABELS[(code || '').toLowerCase()] || (code || 'CC').toUpperCase();

export const formatSize = (bytes) => {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const formatSpeed = (bps) => {
  if (!bps || bps < 1) return '0 KB/s';
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
};

// Render a torrent ETA in compact form: "—" when unknown,
// "Ns" / "M:SS" / "H:MM:SS" otherwise.
export const formatEta = (seconds) => {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const formatTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

export const cleanName = (filename) => {
  const noExt = filename.replace(/\.[^.]+$/, '');
  return noExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
};

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches;

export const isTypingTarget = (el) => {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
};
