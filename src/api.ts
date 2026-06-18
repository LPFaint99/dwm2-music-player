import type { ResolvedChannel, PlayingChannel, BgmTrack } from './types';
import { parseRom, resolveChannel } from './decoder';
import { BGM_TRACKS, SFX_COMPANION, bgmTrackByNum } from './catalogues';
import {
  _s,
  _audioInit,
  _buildWavePatches,
  _calcPos,
  _startProgressLoop,
  _stopProgressLoop,
  _makeTickFn,
  _scheduleSfxChannel,
  SFX_MAX_LOOP_SEC,
} from './engine';
import { CHAN_NAMES, firstNoteAtOrAfter } from './util';
import { _firePlay, _fireStop, _setPlayTrack, onPlay, onStop } from './callbacks';

// How often (ms) the note-scheduling tick fires while a track plays.
const TICK_INTERVAL_MS = 300;
// Lead time (s) added before scheduling starts, so the first notes aren't late.
const PLAY_LEAD_SEC = 0.12,
  SEEK_LEAD_SEC = 0.08,
  SFX_LEAD_SEC = 0.03;
// Fade-out time constant (s) and node-disconnect delay (ms) when stopping/seeking.
const STOP_FADE_TC = 0.05,
  STOP_DISCONNECT_MS = 400,
  SEEK_FADE_TC = 0.03,
  SEEK_DISCONNECT_MS = 300;

/** Ramp `gain` to silence, then disconnect it after the ramp has audibly finished. */
function _fadeOutAndDisconnect(gain: GainNode, timeConstSec: number, delayMs: number): void {
  gain.gain.setTargetAtTime(0, _s.audioCtx!.currentTime, timeConstSec);
  setTimeout(() => gain.disconnect(), delayMs);
}

/** (Re)start the periodic note-scheduling loop for `channels` onto `gain`. */
function _startTickLoop(channels: PlayingChannel[], gain: GainNode): void {
  const tickFn = _makeTickFn(channels, gain);
  tickFn();
  _s.playing!.timer = setInterval(tickFn, TICK_INTERVAL_MS);
}

/** Play a BGM catalogue entry, optionally highlighting the triggering button. */
function playTrackEntry(t: BgmTrack, btn?: HTMLElement | null): void {
  musicPlayTrack(t.num, t.ids, t.name, btn);
}

export function musicParseRom(
  bytes: ArrayBufferLike | Uint8Array,
): { ok: true; title: string } | { ok: false; error: string } {
  try {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    _s.R = parseRom(arr);
    _buildWavePatches();
    return { ok: true, title: _s.R.title };
  } catch (e) {
    _s.R = null;
    return { ok: false, error: (e as Error).message };
  }
}

export function musicSetVolume(v: number): void {
  if (_s.master) _s.master.gain.value = v;
}

export function musicStopMusic(): void {
  if (!_s.playing || !_s.audioCtx) return;
  _stopProgressLoop();
  if (_s.playing.timer !== null) clearInterval(_s.playing.timer);
  _fadeOutAndDisconnect(_s.playing.gain, STOP_FADE_TC, STOP_DISCONNECT_MS);
  _s.playing = null;
  if (_s.playingBtn) {
    _s.playingBtn.classList.remove('playing');
    _s.playingBtn = null;
  }
  _fireStop();
}

export function musicPlayTrack(
  num: number,
  ids: number[],
  name: string,
  btn?: HTMLElement | null,
): void {
  _audioInit();
  const wasSuspended = _s.audioCtx!.state !== 'running';
  void _s.audioCtx!.resume();
  musicStopMusic();
  if (!_s.R) return;
  const gain = _s.audioCtx!.createGain();
  gain.connect(_s.master!);
  const chanGains: Record<number, GainNode> = {};
  [0, 1, 2, 3].forEach((t) => {
    chanGains[t] = _s.audioCtx!.createGain();
    chanGains[t].connect(gain);
  });
  const t0 = _s.audioCtx!.currentTime + PLAY_LEAD_SEC;
  const channels: PlayingChannel[] = (
    ids.map((id) => resolveChannel(_s.R!, id)).filter(Boolean) as ResolvedChannel[]
  ).map((ch) => ({
    ...ch,
    idx: 0,
    passOffset: t0,
    done: !ch.notes.length,
    loopIdx: ch.loopSec === null ? 0 : firstNoteAtOrAfter(ch.notes, ch.loopSec),
    bus: chanGains[ch.chanType],
  }));
  const loops = channels.some((c) => c.loops);
  const total = channels.length ? Math.max(...channels.map((c) => c.totalSec)) : 0;
  const loopSec = channels.find((c) => c.loopSec !== null)?.loopSec ?? null;
  _s.playing = {
    channels,
    gain,
    chanGains,
    trackNum: num,
    trackName: name,
    trackIds: ids,
    startCtxTime: t0,
    totalSec: total,
    loopSec,
    lastEndTime: t0,
    timer: null,
  };
  _startTickLoop(channels, gain);
  if (btn) {
    btn.classList.add('playing');
    _s.playingBtn = btn;
  }
  _startProgressLoop();
  const info =
    `${channels.length} channels` +
    ` (${channels.map((c) => CHAN_NAMES[c.chanType]).join('+')})` +
    ` · ${total.toFixed(0)} s/pass · ${loops ? 'loops forever' : 'one-shot'}`;
  _firePlay(num, name, info, total, loopSec);

  // If the context started suspended, notes were scheduled against a frozen
  // clock and won't sound. Once it actually resumes, replay the track from the
  // top (only if it's still the current one) so timing is correct.
  if (wasSuspended) {
    const onStateChange = () => {
      if (_s.audioCtx!.state !== 'running') return;
      _s.audioCtx!.removeEventListener('statechange', onStateChange);
      if (_s.playing && _s.playing.trackNum === num) musicPlayTrack(num, ids, name, btn);
    };
    _s.audioCtx!.addEventListener('statechange', onStateChange);
  }
}

_setPlayTrack(musicPlayTrack);

export function musicPlaySfx(id: number): void {
  _audioInit();
  void _s.audioCtx!.resume();
  if (!_s.R) return;
  const ids = SFX_COMPANION[id] || [id];
  const t0 = _s.audioCtx!.currentTime + SFX_LEAD_SEC;
  for (const cid of ids) {
    const ch = resolveChannel(_s.R, cid);
    if (ch) _scheduleSfxChannel(ch, t0, SFX_MAX_LOOP_SEC, _s.master!);
  }
}

export const musicCurrentPos = (): { pos: number; total: number; loopSec: number | null } | null =>
  _calcPos();
export const musicGetAnalyser = (): AnalyserNode | null => _s.analyser;

export function musicGetCurrentTrack(): { num: number; name: string; ids: number[] } | null {
  if (!_s.playing) return null;
  return { num: _s.playing.trackNum, name: _s.playing.trackName, ids: _s.playing.trackIds };
}

export function musicSeekTo(targetSec: number): void {
  if (!_s.playing || !_s.R || !_s.audioCtx) return;
  _stopProgressLoop();
  if (_s.playing.timer !== null) clearInterval(_s.playing.timer);
  const oldGain = _s.playing.gain;
  _fadeOutAndDisconnect(oldGain, SEEK_FADE_TC, SEEK_DISCONNECT_MS);
  const t0 = _s.audioCtx.currentTime + SEEK_LEAD_SEC;
  const newGain = _s.audioCtx.createGain();
  newGain.connect(_s.master!);
  if (_s.playing.chanGains) {
    Object.values(_s.playing.chanGains).forEach((cg) => {
      try {
        cg.disconnect(_s.playing!.gain);
      } catch {
        /* already disconnected */
      }
      cg.connect(newGain);
    });
  }
  for (const ch of _s.playing.channels) {
    const { loopSec, totalSec, loops, notes } = ch;
    let seekPos: number;
    if (loops && loopSec !== null && targetSec >= loopSec) {
      const loopLen = totalSec - loopSec;
      seekPos = loopLen > 0 ? loopSec + ((targetSec - loopSec) % loopLen) : loopSec;
    } else {
      seekPos = Math.min(Math.max(0, targetSec), totalSec);
    }
    ch.passOffset = t0 - seekPos;
    const fi = firstNoteAtOrAfter(notes, seekPos);
    ch.idx = fi < 0 ? notes.length : fi;
    ch.done = !notes.length;
  }
  _s.playing.gain = newGain;
  _s.playing.startCtxTime = t0 - targetSec;
  _s.playing.lastEndTime = t0;
  _startTickLoop(_s.playing.channels, newGain);
  _startProgressLoop();
}

export function musicSetChanMute(chanType: number, muted: boolean): void {
  if (_s.playing?.chanGains?.[chanType]) _s.playing.chanGains[chanType].gain.value = muted ? 0 : 1;
}

export function musicGetChanTypes(): number[] {
  if (!_s.playing) return [];
  return [...new Set(_s.playing.channels.map((c) => c.chanType))];
}

export function musicInitFromRom(romBytes: Uint8Array): void {
  const result = musicParseRom(romBytes);
  if (!result.ok) return;

  const bar = document.getElementById('music-bar');
  if (!bar) return;

  const sel = document.getElementById('music-track') as HTMLSelectElement | null;
  if (sel && !sel.options.length) {
    sel.innerHTML =
      '<option value="">♪ track</option>' +
      BGM_TRACKS.map((t) => `<option value="${t.num}">${t.num}. ${t.name}</option>`).join('');
    sel.onchange = () => {
      const t = bgmTrackByNum(+sel.value);
      if (t) playTrackEntry(t);
    };
  }

  const btn = document.getElementById('music-play-btn');
  if (btn) {
    btn.onclick = () => {
      if (_s.playing) musicStopMusic();
      else {
        const t = sel ? bgmTrackByNum(+sel.value) : null;
        if (t) playTrackEntry(t);
      }
    };
  }

  const vol = document.getElementById('music-vol') as HTMLInputElement | null;
  if (vol) vol.oninput = () => musicSetVolume(+vol.value / 100);

  onPlay((num, name) => {
    if (btn) btn.textContent = '■';
    const now = document.getElementById('music-now');
    if (now) now.textContent = name;
    if (sel) sel.value = String(num);
  });
  onStop(() => {
    if (btn) btn.textContent = '▶';
    const now = document.getElementById('music-now');
    if (now) now.textContent = '';
  });

  bar.style.display = 'inline-flex';

  if (!_s.playing) playTrackEntry(BGM_TRACKS[0]);
}

export function musicAutoplayIfReady(): void {
  const bar = document.getElementById('music-bar');
  if (!bar || bar.style.display !== 'inline-flex') return;
  if (!_s.playing && BGM_TRACKS[0]) playTrackEntry(BGM_TRACKS[0]);
}
