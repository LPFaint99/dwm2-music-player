import type {
  ParsedRom,
  PlayingState,
  AudioResources,
  AudioNote,
  PlayingChannel,
  ResolvedChannel,
} from './types';
import { BGM_TRACKS } from './catalogues';
import { firstNoteAtOrAfter } from './util';
import { _fireProgress, _callPlayTrack } from './callbacks';

/** SFX loops are rendered/previewed for at most this many seconds. */
export const SFX_MAX_LOOP_SEC = 3;

// Channel type, as stored in the sequence descriptor and the engine's $DD0A
// (disassembly: SoundNoteOnHW in dwm2-disasm/disasm/cobi/bank_000.asm).
const WAVE_CHAN = 2; // 0=square1, 1=square2, 2=wave, 3=noise

// GB wave-channel patch table (asm: Wavetable_30ce, loaded by SoundLoadWaveTable
// $3d8d). 16 waveforms × 16 bytes; each byte holds two 4-bit samples → 32 samples.
const WAVE_BASE = 0x30ce;
const WAVE_COUNT = 16;
const WAVE_BYTES = 16;
const SAMPLES_PER_WAVE = WAVE_BYTES * 2;

// GB noise channel (NR43): white noise clock is 524288 Hz, divided by ratio `r`
// (0 ⇒ 0.5) and 2^(shift+1). 16000 Hz is the reference rate of our synthesized
// 1-second LFSR noise buffer, so playbackRate = noiseHz / NOISE_BUF_REF_HZ.
const GB_NOISE_CLOCK_HZ = 524288;
const NOISE_BUF_REF_HZ = 16000;

// SFX loop expansion: epsilon below which a loop region is treated as empty, and
// a hard cap on repeated passes so a degenerate loop can't spin forever.
const LOOP_EPS = 0.001;
const MAX_LOOP_PASSES = 50;

interface AudioState {
  R: ParsedRom | null;
  audioCtx: AudioContext | null;
  master: GainNode | null;
  analyser: AnalyserNode | null;
  dutyWaves: PeriodicWave[] | null;
  noiseBuf: AudioBuffer | null;
  wavePatches: PeriodicWave[] | null;
  playing: PlayingState | null;
  playingBtn: Element | null;
  rafId: number | null;
}

export const _s: AudioState = {
  R: null,
  audioCtx: null,
  master: null,
  analyser: null,
  dutyWaves: null,
  noiseBuf: null,
  wavePatches: null,
  playing: null,
  playingBtn: null,
  rafId: null,
};

/** Build the 16 GB-style wave-channel patches by FFT-ing each 16-byte wavetable in the ROM. */
function _computeWavePatches(ctx: BaseAudioContext, rom: Uint8Array): PeriodicWave[] {
  const N = SAMPLES_PER_WAVE;
  const wavePatches: PeriodicWave[] = [];
  for (let wi = 0; wi < WAVE_COUNT; wi++) {
    const samples = new Float32Array(N);
    for (let i = 0; i < WAVE_BYTES; i++) {
      const byte = rom[WAVE_BASE + wi * WAVE_BYTES + i];
      // each byte = two 4-bit samples (hi nibble then lo), centered around 7.5
      samples[i * 2] = ((byte >> 4) - 7.5) / 7.5;
      samples[i * 2 + 1] = ((byte & 0xf) - 7.5) / 7.5;
    }
    const re = new Float32Array(N / 2 + 1),
      im = new Float32Array(N / 2 + 1);
    for (let k = 1; k <= N / 2; k++) {
      let rr = 0,
        ii = 0;
      for (let n = 0; n < N; n++) {
        const phi = (2 * Math.PI * k * n) / N;
        rr += samples[n] * Math.cos(phi);
        ii += samples[n] * Math.sin(phi);
      }
      re[k] = (2 * rr) / N;
      im[k] = (2 * ii) / N;
    }
    wavePatches.push(ctx.createPeriodicWave(re, im, { disableNormalization: false }));
  }
  return wavePatches;
}

export function _buildResources(ctx: BaseAudioContext): AudioResources {
  const dutyWaves = [0.125, 0.25, 0.5, 0.75].map((d) => {
    const N = 32,
      re = new Float32Array(N),
      im = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * d);
      im[n] = (2 / (n * Math.PI)) * (1 - Math.cos(n * Math.PI * d));
    }
    return ctx.createPeriodicWave(re, im, { disableNormalization: false });
  });
  const wavePatches = _s.R ? _computeWavePatches(ctx, _s.R.rom) : null;
  // 1 second of 15-bit LFSR white noise (the GB noise channel's polynomial source)
  const noiseLen = ctx.sampleRate;
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  let lfsr = 0x7fff;
  for (let i = 0; i < noiseLen; i++) {
    const bit = (lfsr ^ (lfsr >> 1)) & 1;
    lfsr = (lfsr >> 1) | (bit << 14);
    data[i] = lfsr & 1 ? 0.8 : -0.8;
  }
  return { ctx, dutyWaves, wavePatches, noiseBuf };
}

export function _buildWavePatches(): void {
  if (!_s.audioCtx || !_s.R) return;
  _s.wavePatches = _computeWavePatches(_s.audioCtx, _s.R.rom);
}

export function _audioInit(): void {
  if (_s.audioCtx) return;
  _s.audioCtx = new (window.AudioContext || window.webkitAudioContext!)();
  _s.master = _s.audioCtx.createGain();
  _s.master.gain.value = 0.3;
  _s.analyser = _s.audioCtx.createAnalyser();
  _s.analyser.fftSize = 1024;
  _s.analyser.smoothingTimeConstant = 0.15;
  _s.master.connect(_s.analyser);
  _s.analyser.connect(_s.audioCtx.destination);
  const res = _buildResources(_s.audioCtx);
  _s.dutyWaves = res.dutyWaves;
  _s.wavePatches = res.wavePatches;
  _s.noiseBuf = res.noiseBuf;
}

export function _scheduleNote(
  ev: AudioNote,
  when: number,
  chanType: number,
  duty: number,
  bus: AudioNode,
  res?: AudioResources,
): void {
  const ctx = res ? res.ctx : _s.audioCtx!;
  const dutyW = res ? res.dutyWaves : _s.dutyWaves!;
  const waveP = res ? res.wavePatches : _s.wavePatches;
  const noiseB = res ? res.noiseBuf : _s.noiseBuf!;
  const g = ctx.createGain();
  const amp = ev.gain * (chanType === WAVE_CHAN ? 0.5 : 0.8);
  const dur = Math.max(ev.dur, 0.02);
  g.gain.setValueAtTime(amp, when);
  g.gain.linearRampToValueAtTime(amp * 0.35, when + dur * 0.9);
  g.gain.linearRampToValueAtTime(0.0001, when + dur);
  g.connect(bus);
  let src: AudioBufferSourceNode | OscillatorNode;
  if (ev.kind === 'noise') {
    const bufSrc = ctx.createBufferSource();
    bufSrc.buffer = noiseB;
    bufSrc.loop = true;
    const shift = ev.nr43 >> 4,
      ratio = ev.nr43 & 7;
    const hz = GB_NOISE_CLOCK_HZ / (ratio || 0.5) / Math.pow(2, shift + 1);
    bufSrc.playbackRate.value = Math.min(4, Math.max(0.05, hz / NOISE_BUF_REF_HZ));
    src = bufSrc;
  } else {
    const osc = ctx.createOscillator();
    const patch =
      chanType === WAVE_CHAN && waveP && ev.timbre != null && ev.timbre !== 0xff
        ? waveP[ev.timbre & 0xf]
        : dutyW[chanType === WAVE_CHAN ? 2 : duty];
    osc.setPeriodicWave(patch);
    osc.frequency.value = ev.hz;
    if (ev.endHz && Math.abs(ev.endHz - ev.hz) > 0.5) {
      osc.frequency.setValueAtTime(ev.hz, when);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, ev.endHz), when + dur);
    }
    if (ev.vib && ev.vib.depth > 0) {
      const lfo = ctx.createOscillator(),
        lfoG = ctx.createGain();
      lfo.type = 'sine';
      lfo.frequency.value = 6;
      lfoG.gain.value = 0;
      lfoG.gain.setValueAtTime(0, when);
      lfoG.gain.setValueAtTime(ev.hz * ev.vib.depth * 0.003, when + ev.vib.delay);
      lfo.connect(lfoG);
      lfoG.connect(osc.frequency);
      lfo.start(when);
      lfo.stop(when + dur + 0.02);
    }
    src = osc;
  }
  src.connect(g);
  src.start(when);
  src.stop(when + dur + 0.02);
}

/**
 * Schedule one SFX channel onto `bus`, starting at `t0`. Non-looping channels play
 * through once; looping channels play their intro then repeat the loop body until `maxSec`.
 * Pass `res` to render into an OfflineAudioContext, omit it to play live.
 */
export function _scheduleSfxChannel(
  ch: ResolvedChannel,
  t0: number,
  maxSec: number,
  bus: AudioNode,
  res?: AudioResources,
): void {
  if (!ch.notes.length) return;
  if (!ch.loops || ch.loopSec === null) {
    for (const ev of ch.notes) _scheduleNote(ev, t0 + ev.t, ch.chanType, ch.duty, bus, res);
    return;
  }
  const loopLen = ch.totalSec - ch.loopSec;
  const loopIdx = loopLen > LOOP_EPS ? firstNoteAtOrAfter(ch.notes, ch.loopSec) : -1;
  // intro: notes before the loop point play once
  for (const ev of loopIdx >= 0 ? ch.notes.slice(0, loopIdx) : ch.notes)
    _scheduleNote(ev, t0 + ev.t, ch.chanType, ch.duty, bus, res);
  if (loopIdx < 0 || loopLen <= LOOP_EPS) return;
  // loop body: replay notes from the loop point, shifted by `offset`, until maxSec
  const loopNotes = ch.notes.slice(loopIdx);
  let offset = 0,
    safety = 0;
  while (ch.loopSec + offset < maxSec && safety++ < MAX_LOOP_PASSES) {
    for (const ev of loopNotes) {
      const rel = ev.t + offset;
      if (rel > maxSec) break;
      _scheduleNote(ev, t0 + rel, ch.chanType, ch.duty, bus, res);
    }
    offset += loopLen;
  }
}

export function _calcPos(): { pos: number; total: number; loopSec: number | null } | null {
  if (!_s.playing || !_s.audioCtx) return null;
  const elapsed = Math.max(0, _s.audioCtx.currentTime - _s.playing.startCtxTime);
  const { totalSec, loopSec } = _s.playing;
  let pos: number;
  if (loopSec !== null) {
    const loopLen = totalSec - loopSec;
    pos =
      elapsed < loopSec
        ? elapsed
        : loopLen > 0
          ? loopSec + ((elapsed - loopSec) % loopLen)
          : elapsed % totalSec;
  } else {
    pos = Math.min(elapsed, totalSec);
  }
  return { pos, total: totalSec, loopSec };
}

export function _startProgressLoop(): void {
  if (_s.rafId !== null) return;
  function tick() {
    if (!_s.playing) {
      _s.rafId = null;
      return;
    }
    const p = _calcPos();
    if (p) _fireProgress(p.pos, p.total, p.loopSec);
    _s.rafId = requestAnimationFrame(tick);
  }
  _s.rafId = requestAnimationFrame(tick);
}

export function _stopProgressLoop(): void {
  if (_s.rafId !== null) {
    cancelAnimationFrame(_s.rafId);
    _s.rafId = null;
  }
}

function _autoAdvance(): void {
  if (!_s.playing) return;
  const idx = BGM_TRACKS.findIndex((t) => t.num === _s.playing!.trackNum);
  const next = BGM_TRACKS[(idx + 1) % BGM_TRACKS.length];
  _callPlayTrack(next.num, next.ids, next.name);
}

export function _makeTickFn(channels: PlayingChannel[], gainNode: GainNode): () => void {
  // Schedule notes that start within this many seconds of `now` each tick.
  const HORIZON = 2.0;
  return function tick() {
    // True only while these channels are still the live track (not a stale tick
    // left over from a track change), so we don't mutate the new track's state.
    const isActivePlayback = !!_s.playing && channels === _s.playing.channels;
    const limit = _s.audioCtx!.currentTime + HORIZON;
    for (const ch of channels) {
      while (!ch.done) {
        if (ch.idx >= ch.notes.length) {
          if (ch.loops && ch.loopSec !== null && ch.loopIdx >= 0) {
            ch.passOffset += ch.totalSec - ch.loopSec;
            ch.idx = ch.loopIdx;
          } else {
            ch.done = true;
            break;
          }
        }
        const ev = ch.notes[ch.idx];
        const when = ch.passOffset + ev.t;
        if (when > limit) break;
        const actualWhen = Math.max(when, _s.audioCtx!.currentTime);
        _scheduleNote(ev, actualWhen, ch.chanType, ch.duty, ch.bus || gainNode);
        if (isActivePlayback)
          _s.playing!.lastEndTime = Math.max(_s.playing!.lastEndTime, actualWhen + ev.dur + 0.1);
        ch.idx++;
      }
    }
    if (
      isActivePlayback &&
      channels.every((c) => c.done) &&
      _s.audioCtx!.currentTime >= _s.playing!.lastEndTime
    ) {
      _autoAdvance();
    }
  };
}
