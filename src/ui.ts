import {
  musicParseRom,
  musicPlayTrack,
  musicStopMusic,
  musicPlaySfx,
  musicSetVolume,
  musicCurrentPos,
  musicSeekTo,
  musicGetCurrentTrack,
  musicSetChanMute,
  musicGetChanTypes,
  musicGetAnalyser,
  musicExportWav,
  musicExportMp3,
  musicExportMidi,
  musicSfxMeta,
  musicExportSfxWav,
  musicExportSfxMp3,
  musicRenderPianoRoll,
  BGM_TRACKS,
  bgmTrackByNum,
  SFX_FEATURED,
  SFX_COMPANION,
  WM_SEQUENCE,
  BGM_IDS,
  STOP_IDS,
  COMPANION_IDS,
  LAST_VALID_NOTE,
  onPlay,
  onStop,
  onProgress,
  CHAN_NAMES,
  hex2,
} from './music';
import type { WmEntry } from './types';

/* ── DOM lookup helpers ──────────────────────────────────────────────────────── */
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const $i = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const $s = (id: string): HTMLSelectElement => document.getElementById(id) as HTMLSelectElement;
const $c = (id: string): HTMLCanvasElement => document.getElementById(id) as HTMLCanvasElement;
const $b = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;

const dropEl = $('drop');
const fileEl = $i('file');

/** Default export duration (s) for looping tracks, and the tail added for one-shots. */
const LOOPED_EXPORT_SEC = 120,
  EXPORT_TAIL_SEC = 2;

/* ── IDB persistence: cache the dropped ROM in the shared 'dwm2' store ──────── */
const _IDB_NAME = 'dwm2',
  _IDB_STORE = 'rom',
  _IDB_KEY = 'cobi-rom';

function _idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(_IDB_STORE)) db.createObjectStore(_IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDBOpenDBRequest failed'));
  });
}

async function _idbSave(bytes: Uint8Array, name: string): Promise<void> {
  try {
    const db = await _idbOpen();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(_IDB_STORE, 'readwrite');
      tx.objectStore(_IDB_STORE).put({ bytes, name }, _IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDBTransaction failed'));
    });
    db.close();
  } catch (e) {
    console.warn('[dwm2-music] ROM save failed:', e);
  }
}

async function _idbLoad(): Promise<{ bytes: Uint8Array; name: string } | null> {
  try {
    const db = await _idbOpen();
    const rec = await new Promise<{ bytes: Uint8Array; name: string } | null>((resolve, reject) => {
      const tx = db.transaction(_IDB_STORE, 'readonly');
      const g = tx.objectStore(_IDB_STORE).get(_IDB_KEY);
      g.onsuccess = () =>
        resolve((g.result as { bytes: Uint8Array; name: string } | undefined) ?? null);
      g.onerror = () => reject(g.error ?? new Error('IDBRequest failed'));
    });
    db.close();
    return rec;
  } catch (e) {
    console.warn('[dwm2-music] ROM restore failed:', e);
    return null;
  }
}

/* ── ROM load / restore ────────────────────────────────────────────────────── */

let _trkBtns: { num: number; btn: HTMLButtonElement }[] = [];

function _applyRom(
  bytes: ArrayBuffer | Uint8Array,
  displayName: string,
  { persist, autoPlay }: { persist: boolean; autoPlay: boolean },
): boolean {
  const result = musicParseRom(bytes);
  if (!result.ok) {
    $('droperr').textContent = '✗ ' + result.error;
    return false;
  }
  if (persist)
    void _idbSave(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), displayName);
  $('romname').textContent = `${displayName} - "${result.title}"`;
  dropEl.style.display = 'none';
  $('ui').classList.add('ready');
  buildUi();
  if (autoPlay) {
    const t = BGM_TRACKS[0];
    musicPlayTrack(t.num, t.ids, t.name, _trkBtns[0]?.btn || null);
  }
  return true;
}

function loadRom(buf: ArrayBuffer, fname: string): void {
  _applyRom(buf, fname, { persist: true, autoPlay: true });
}

void (async function tryRestoreRom() {
  const rec = await _idbLoad();
  if (rec?.bytes)
    _applyRom(rec.bytes, (rec.name || 'ROM') + ' (restored)', { persist: false, autoPlay: true });
})();

/* ── Progress bar ──────────────────────────────────────────────────────────── */

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function setProgress(pos: number, total: number, loopSec: number | null): void {
  const pct = total > 0 ? Math.min(pos / total, 1) * 100 : 0;
  $('progressfill').style.width = pct + '%';
  $('progressthumb').style.left = pct + '%';
  $('timecur').textContent = fmtTime(pos);
  $('timetot').textContent = fmtTime(total);
  const tick = $('looptick');
  if (loopSec !== null && total > 0) {
    tick.style.left = (loopSec / total) * 100 + '%';
    tick.style.display = '';
  } else {
    tick.style.display = 'none';
  }
}

let _seeking = false;

(function wireProgressBar() {
  const bar = $('progressbar');

  function posFromEvent(e: PointerEvent): number {
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  bar.addEventListener('pointerdown', (e) => {
    bar.setPointerCapture(e.pointerId);
    _seeking = true;
    const p = musicCurrentPos();
    if (p) {
      const pct = posFromEvent(e);
      setProgress(pct * p.total, p.total, p.loopSec);
    }
  });
  bar.addEventListener('pointermove', (e) => {
    if (!_seeking) return;
    const p = musicCurrentPos();
    if (p) {
      const pct = posFromEvent(e);
      setProgress(pct * p.total, p.total, p.loopSec);
    }
  });
  bar.addEventListener('pointerup', (e) => {
    if (!_seeking) return;
    _seeking = false;
    const p = musicCurrentPos();
    if (p) musicSeekTo(posFromEvent(e) * p.total);
  });
})();

/* ── Music callbacks ───────────────────────────────────────────────────────── */

onProgress((pos, total, loopSec) => {
  if (_seeking) return;
  setProgress(pos, total, loopSec);
});

onPlay((num, name, info, totalSec, loopSec) => {
  $('stopbtn').textContent = '■ Stop';
  $('nowplaying').textContent = `track ${num}: ${name}`;
  $('trackinfo').textContent = info;
  $('progresswrap').style.display = '';
  setProgress(0, totalSec ?? 0, loopSec ?? null);
  buildMuteBar(musicGetChanTypes());
  $('scope').style.display = '';
  if (!_scopeRaf) _drawScope();
  const exportRow = $('exportrow');
  exportRow.style.display = 'flex';
  // default export length: a fixed window for looping tracks, else the track
  // length plus a short tail so the final notes aren't clipped
  $i('expdur').value = String(
    loopSec !== null ? LOOPED_EXPORT_SEC : Math.ceil(totalSec) + EXPORT_TAIL_SEC,
  );
  const pr = $c('pianoroll');
  pr.style.display = '';
  requestAnimationFrame(() => musicRenderPianoRoll(pr));
});

onStop(() => {
  $('stopbtn').textContent = '▶ Play';
  $('nowplaying').textContent = '-';
  $('trackinfo').textContent = '';
  $('progresswrap').style.display = 'none';
  $('mutebar').style.display = 'none';
  $('scope').style.display = 'none';
  $('pianoroll').style.display = 'none';
  $('exportrow').style.display = 'none';
  if (_scopeRaf) {
    cancelAnimationFrame(_scopeRaf);
    _scopeRaf = null;
  }
});

/* ── Track list UI ─────────────────────────────────────────────────────────── */

/** True if `id` is a plain SFX shown standalone in the picker (not a BGM, stop, or companion id). */
function _isStandaloneSfx(id: number): boolean {
  return !BGM_IDS.has(id) && !STOP_IDS.has(id) && !COMPANION_IDS.has(id);
}

function buildUi(): void {
  const list = $('tracks');
  list.innerHTML = '';
  _trkBtns = [];
  for (const { num, ids, name } of BGM_TRACKS) {
    const b = document.createElement('button');
    b.className = 'trk';
    b.innerHTML =
      `<span class="num">${num}</span><span class="name">${name}</span>` +
      `<span class="tag">${ids.length}ch</span>`;
    b.onclick = () => musicPlayTrack(num, ids, name, b);
    list.appendChild(b);
    _trkBtns.push({ num, btn: b });
  }
  const grid = $('sfxgrid');
  grid.innerHTML = '';
  for (const { id, label } of SFX_FEATURED) {
    const b = document.createElement('button');
    b.className = 'sfx';
    const meta = musicSfxMeta(id);
    const chTag =
      meta.channels > 1
        ? ` <span style="color:var(--dim);font-size:10px">${meta.channels}ch</span>`
        : '';
    const loopTag = meta.loops
      ? ' <span style="color:var(--accent2);font-size:10px" title="loops">↺</span>'
      : '';
    b.innerHTML = `<span class="id">${hex2(id)}</span> ${label}${chTag}${loopTag}`;
    b.onclick = () => {
      // restart the flash animation: remove the class, force a reflow, re-add it
      b.classList.remove('flash');
      void b.offsetWidth;
      b.classList.add('flash');
      musicPlaySfx(id);
      const sel = $s('sfxsel');
      if (sel && _isStandaloneSfx(id)) sel.value = String(id);
    };
    grid.appendChild(b);
  }
  const sel = $s('sfxsel');
  sel.innerHTML = '';
  for (let id = 0x06; id <= LAST_VALID_NOTE; id++) {
    if (!_isStandaloneSfx(id)) continue;
    const group = SFX_COMPANION[id];
    const o = document.createElement('option');
    o.value = String(id);
    o.textContent = hex2(id) + (group ? ` (${group.length}-ch)` : '');
    sel.appendChild(o);
  }
  $('sfxplay').onclick = () => musicPlaySfx(+sel.value);
  sel.onchange = () => musicPlaySfx(+sel.value);
}

function playByIndex(idx: number): void {
  if (!_trkBtns.length) return;
  const i = ((idx % _trkBtns.length) + _trkBtns.length) % _trkBtns.length;
  _trkBtns[i].btn.click();
}

/** Index of the playing track in `_trkBtns`, or -1 if nothing is playing. */
function currentTrkIndex(): number {
  const cur = musicGetCurrentTrack();
  if (!cur) return -1;
  return _trkBtns.findIndex((t) => t.num === cur.num);
}

/** Transport actions shared by the on-screen buttons and the keyboard shortcuts. */
function togglePlayStop(): void {
  if (musicGetCurrentTrack()) musicStopMusic();
  else playByIndex(Math.max(0, currentTrkIndex())); // nothing playing → start at track 0
}
function playPrev(): void {
  playByIndex(currentTrkIndex() - 1);
}
function playNext(): void {
  playByIndex(currentTrkIndex() + 1);
}

/* ── Controls wiring ───────────────────────────────────────────────────────── */

dropEl.onclick = () => fileEl.click();
fileEl.onchange = () => {
  const f = fileEl.files?.[0];
  if (f) void f.arrayBuffer().then((b) => loadRom(b, f.name));
};
['dragover', 'dragenter'].forEach((t) =>
  dropEl.addEventListener(t, (e) => {
    e.preventDefault();
    dropEl.classList.add('hover');
  }),
);
['dragleave', 'drop'].forEach((t) =>
  dropEl.addEventListener(t, (e) => {
    e.preventDefault();
    dropEl.classList.remove('hover');
  }),
);
dropEl.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files[0];
  if (f) void f.arrayBuffer().then((b) => loadRom(b, f.name));
});

$('stopbtn').onclick = togglePlayStop;
$('prevbtn').onclick = playPrev;
$('nextbtn').onclick = playNext;
$i('vol').oninput = (e) => musicSetVolume((e.target as HTMLInputElement).valueAsNumber / 100);

async function _doExport(
  btnId: string,
  label: string,
  exportFn: (dur: number) => Promise<void>,
): Promise<void> {
  const btn = $b(btnId);
  const status = $('expstatus');
  const dur = Math.max(1, +$i('expdur').value || 120);
  btn.disabled = true;
  btn.textContent = 'rendering…';
  status.textContent = '';
  try {
    await exportFn(dur);
  } catch (e) {
    status.textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('expwav').onclick = () => _doExport('expwav', '↓ WAV', musicExportWav);
$('expmp3').onclick = () => _doExport('expmp3', '↓ MP3', musicExportMp3);
$('expmidi').onclick = () => {
  if (musicGetCurrentTrack()) musicExportMidi();
};

/* ── SFX export ────────────────────────────────────────────────────────────── */

async function _doSfxExport(
  btnId: string,
  label: string,
  fn: (id: number) => Promise<void>,
): Promise<void> {
  const btn = $b(btnId);
  const id = +$s('sfxsel').value;
  if (!id) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await fn(id);
  } catch (e) {
    console.error('SFX export:', e);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$('sfxwav').onclick = () => _doSfxExport('sfxwav', '↓ WAV', musicExportSfxWav);
$('sfxmp3').onclick = () => _doSfxExport('sfxmp3', '↓ MP3', musicExportSfxMp3);

/* ── Keyboard shortcuts ────────────────────────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === ' ') {
    e.preventDefault();
    togglePlayStop();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    playPrev();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    playNext();
  }
});

/* ── Oscilloscope ──────────────────────────────────────────────────────────── */

let _scopeRaf: number | null = null;
function _drawScope(): void {
  const analyser = musicGetAnalyser();
  const canvas = $c('scope');
  if (!analyser || !canvas || canvas.style.display === 'none') {
    _scopeRaf = null;
    return;
  }
  const W = canvas.width,
    H = canvas.height;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#0d1117';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = '#6ec1ff';
  c.lineWidth = 1.5;
  c.beginPath();
  const stride = Math.max(1, Math.floor(buf.length / W));
  for (let i = 0; i < W; i++) {
    const y = (buf[i * stride] / 255) * H;
    if (i === 0) c.moveTo(i, y);
    else c.lineTo(i, y);
  }
  c.stroke();
  _scopeRaf = requestAnimationFrame(_drawScope);
}

/* ── WanderingMaster sequence playback ─────────────────────────────────────── */

let _wmRunning = false,
  _wmAbort = false,
  _wmTimer: number | null = null;

// Hold time (ms, before the user's pace divisor) for each kind of WM phase.
const WM_VISUAL_MS = 300, // visual-only slot
  WM_SFX_LOOP_MS = 2000, // a looping SFX (no natural end)
  WM_SFX_MIN_MS = 600, // floor for a short one-shot SFX
  WM_SFX_TAIL_MS = 350; // extra tail after a one-shot SFX
// Hold time per embedded BGM track, keyed by the WmEntry 'bgm<n>' sentinel.
const WM_BGM_HOLD_MS: Record<string, number> = { bgm22: 4500, bgm20: 5000 };

function _wmDelay(ms: number): Promise<void> {
  return new Promise((r) => {
    _wmTimer = setTimeout(r, ms);
  });
}

/** Abort a running WM sequence and cancel its pending delay. */
function _wmStop(): void {
  _wmAbort = true;
  if (_wmTimer) {
    clearTimeout(_wmTimer);
    _wmTimer = null;
  }
}

/** Run one WM phase (visual / embedded BGM / SFX) and wait its pace-scaled hold time. */
async function _runWmPhase(s: WmEntry, status: HTMLElement, pace: () => number): Promise<void> {
  const hold = (ms: number) => _wmDelay(Math.round(ms / pace()));
  if (s.id === null) {
    status.textContent = `Phase ${s.slot}: visual only`;
    await hold(WM_VISUAL_MS);
  } else if (typeof s.id === 'string') {
    // 'bgm<n>' sentinel → play full BGM track <n>, hold, then stop it
    status.textContent = `Phase ${s.slot}: ${s.label}`;
    const t = bgmTrackByNum(+s.id.slice(3));
    if (t) musicPlayTrack(t.num, t.ids, t.name);
    await hold(WM_BGM_HOLD_MS[s.id] ?? WM_SFX_LOOP_MS);
    if (!_wmAbort) musicStopMusic();
  } else {
    status.textContent = `Phase ${s.slot}: ${hex2(s.id)} - ${s.label}`;
    musicPlaySfx(s.id);
    const meta = musicSfxMeta(s.id);
    const ms = meta.loops
      ? WM_SFX_LOOP_MS
      : Math.max(WM_SFX_MIN_MS, Math.round(meta.totalSec * 1000) + WM_SFX_TAIL_MS);
    await hold(ms);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const wmbtn = document.getElementById('wmbtn');
  if (!wmbtn) return;
  wmbtn.onclick = async () => {
    if (_wmRunning) {
      _wmStop();
      return;
    }
    _wmRunning = true;
    _wmAbort = false;
    const btn = $('wmbtn');
    const status = $('wmstatus');
    const fill = $('wmfill');
    btn.textContent = '■ Stop';

    const pace = () => Math.max(0.1, +$i('wmpace').value);

    for (let i = 0; i < WM_SEQUENCE.length; i++) {
      if (_wmAbort) break;
      fill.style.width = (i / WM_SEQUENCE.length) * 100 + '%';
      await _runWmPhase(WM_SEQUENCE[i], status, pace);
    }

    if (!_wmAbort) fill.style.width = '100%';
    _wmRunning = false;
    btn.textContent = '▶ Play all';
    status.textContent = _wmAbort ? 'Stopped' : 'Complete!';
    _wmAbort = false;
  };
});

/* ── Per-channel mute bar ──────────────────────────────────────────────────── */

function buildMuteBar(chanTypes: number[]): void {
  const bar = $('mutebar');
  bar.innerHTML = '';
  bar.style.display = 'flex';
  chanTypes
    .slice()
    .sort()
    .forEach((ct) => {
      const btn = document.createElement('button');
      btn.className = 'mute';
      btn.textContent = CHAN_NAMES[ct];
      let muted = false;
      btn.onclick = () => {
        muted = !muted;
        btn.style.opacity = muted ? '0.3' : '1';
        btn.style.textDecoration = muted ? 'line-through' : '';
        musicSetChanMute(ct, muted);
      };
      bar.appendChild(btn);
    });
}
