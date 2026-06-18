import { resolveChannel } from './decoder';
import { SFX_COMPANION, SFX_FEATURED } from './catalogues';
import { _s, _buildResources, _scheduleNote, _scheduleSfxChannel } from './engine';
import { firstNoteAtOrAfter, hex2 } from './util';

const SAMPLE_RATE = 44100;
const MASTER_GAIN = 0.3; // matches the live master gain in engine._audioInit
const MP3_FRAME_SIZE = 1152; // samples per MP3 frame (lamejs requirement)
const MAX_LOOP_PASSES = 20000; // guard against a degenerate (zero-length) loop
const SFX_LOOP_EXPORT_SEC = 3; // looping SFX are exported for this many seconds

/** Clamp a float sample in [-1, 1] to a signed 16-bit PCM value. */
function floatToInt16(x: number): number {
  const c = Math.max(-1, Math.min(1, x));
  return c < 0 ? c * 0x8000 : c * 0x7fff;
}

/** Seconds to render a SFX: a fixed window for loops, else its length plus a tail. */
function sfxRenderDuration(meta: { loops: boolean; totalSec: number }): number {
  return meta.loops ? SFX_LOOP_EXPORT_SEC : Math.max(1, meta.totalSec + 0.1);
}

export function _triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function _exportFilename(ext: string): string {
  return `dwm2_bgm${_s.playing!.trackNum}_${_s.playing!.trackName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_')}.${ext}`;
}

async function _renderOffline(durationSec?: number) {
  if (!_s.R || !_s.playing) return null;
  const dur = Math.max(1, durationSec ?? 120);
  const offCtx = new OfflineAudioContext(2, Math.ceil(SAMPLE_RATE * dur), SAMPLE_RATE);
  const res = _buildResources(offCtx);
  const master = offCtx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(offCtx.destination);
  const chanGains: Record<number, GainNode> = {};
  [0, 1, 2, 3].forEach((t) => {
    chanGains[t] = offCtx.createGain();
    chanGains[t].connect(master);
  });
  for (const ch of _s.playing.channels) {
    const { notes, loopSec, totalSec, loops, chanType, duty } = ch;
    const bus = chanGains[chanType];
    const loopIdx = loopSec === null ? -1 : firstNoteAtOrAfter(notes, loopSec);
    let passOffset = 0,
      safety = 0;
    const doPass = (startIdx: number) => {
      for (let i = startIdx; i < notes.length; i++) {
        const when = passOffset + notes[i].t;
        if (when > dur + 0.2) return;
        _scheduleNote(notes[i], when, chanType, duty, bus, res);
      }
    };
    doPass(0);
    if (loops && loopIdx >= 0 && totalSec > loopSec! + 0.01) {
      passOffset += totalSec - loopSec!;
      while (passOffset < dur + 0.5 && safety++ < MAX_LOOP_PASSES) {
        doPass(loopIdx);
        passOffset += totalSec - loopSec!;
      }
    }
  }
  return offCtx.startRendering();
}

function _audioBufferToWav(buffer: AudioBuffer): Uint8Array<ArrayBuffer> {
  const numCh = buffer.numberOfChannels,
    numFrames = buffer.length,
    SR = buffer.sampleRate;
  const blockAlign = numCh * 2,
    dataSize = numFrames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  const writeStr = (o: number, str: string) => {
    for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
  const chans = Array.from({ length: numCh }, (_, i) => buffer.getChannelData(i));
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      v.setInt16(off, floatToInt16(chans[ch][i]), true);
      off += 2;
    }
  }
  return new Uint8Array(ab);
}

export async function musicExportWav(durationSec?: number): Promise<void> {
  if (!_s.R || !_s.playing) return;
  const buf = await _renderOffline(durationSec);
  if (buf)
    _triggerDownload(
      new Blob([_audioBufferToWav(buf)], { type: 'audio/wav' }),
      _exportFilename('wav'),
    );
}

// ── MP3 export ────────────────────────────────────────────────────────────────

let _lameReady = false;
function _loadLame(): Promise<void> {
  if (_lameReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    sc.onload = () => {
      _lameReady = true;
      resolve();
    };
    sc.onerror = () => reject(new Error('lamejs failed to load - check your internet connection'));
    document.head.appendChild(sc);
  });
}

function _audioBufferToMp3(buffer: AudioBuffer, kbps = 128): Uint8Array<ArrayBuffer> {
  const N = buffer.length,
    SR = buffer.sampleRate;
  const leftFloat = buffer.getChannelData(0);
  const rightFloat = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : leftFloat;
  const leftPcm = new Int16Array(N),
    rightPcm = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    leftPcm[i] = floatToInt16(leftFloat[i]);
    rightPcm[i] = floatToInt16(rightFloat[i]);
  }
  const enc = new window.lamejs!.Mp3Encoder(2, SR, kbps);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < N; i += MP3_FRAME_SIZE) {
    const b = enc.encodeBuffer(
      leftPcm.subarray(i, i + MP3_FRAME_SIZE),
      rightPcm.subarray(i, i + MP3_FRAME_SIZE),
    );
    if (b.length) chunks.push(new Uint8Array(b));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export async function musicExportMp3(durationSec?: number): Promise<void> {
  if (!_s.R || !_s.playing) return;
  await _loadLame();
  const buf = await _renderOffline(durationSec);
  if (buf)
    _triggerDownload(
      new Blob([_audioBufferToMp3(buf)], { type: 'audio/mpeg' }),
      _exportFilename('mp3'),
    );
}

// ── SFX export ────────────────────────────────────────────────────────────────

export function musicSfxMeta(id: number): { loops: boolean; channels: number; totalSec: number } {
  if (!_s.R) return { loops: false, channels: 1, totalSec: 0 };
  const ids = SFX_COMPANION[id] || [id];
  let loops = false,
    maxSec = 0;
  for (const cid of ids) {
    const ch = resolveChannel(_s.R, cid);
    if (!ch) continue;
    if (ch.loops) loops = true;
    if (ch.totalSec > maxSec) maxSec = ch.totalSec;
  }
  return { loops, channels: ids.length, totalSec: maxSec };
}

async function _renderSfxOffline(id: number, maxSec: number): Promise<AudioBuffer | null> {
  if (!_s.R) return null;
  const offCtx = new OfflineAudioContext(2, Math.ceil(SAMPLE_RATE * maxSec), SAMPLE_RATE);
  const res = _buildResources(offCtx);
  const master = offCtx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(offCtx.destination);
  const ids = SFX_COMPANION[id] || [id];
  for (const cid of ids) {
    const ch = resolveChannel(_s.R, cid);
    if (ch) _scheduleSfxChannel(ch, 0, maxSec, master, res);
  }
  return offCtx.startRendering();
}

function _sfxExportFilename(id: number, ext: string): string {
  const entry = SFX_FEATURED.find((e) => e.id === id);
  const slug = entry ? entry.label.replace(/[^a-z0-9]/gi, '_') : 'sfx';
  return `dwm2_sfx_${hex2(id)}_${slug}.${ext}`;
}

export async function musicExportSfxWav(id: number): Promise<void> {
  if (!_s.R) return;
  const meta = musicSfxMeta(id);
  const buf = await _renderSfxOffline(id, sfxRenderDuration(meta));
  if (buf)
    _triggerDownload(
      new Blob([_audioBufferToWav(buf)], { type: 'audio/wav' }),
      _sfxExportFilename(id, 'wav'),
    );
}

export async function musicExportSfxMp3(id: number): Promise<void> {
  if (!_s.R) return;
  await _loadLame();
  const meta = musicSfxMeta(id);
  const buf = await _renderSfxOffline(id, sfxRenderDuration(meta));
  if (buf)
    _triggerDownload(
      new Blob([_audioBufferToMp3(buf)], { type: 'audio/mpeg' }),
      _sfxExportFilename(id, 'mp3'),
    );
}
