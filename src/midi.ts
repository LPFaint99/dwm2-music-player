import type { AudioNote, ToneNote } from './types';
import { _s } from './engine';
import { firstNoteAtOrAfter } from './util';
import { _triggerDownload, _exportFilename } from './export';

export function musicExportMidi(): void {
  if (!_s.R || !_s.playing) return;
  const TPQ = 480,
    TEMPO_US = 500000;

  function varLen(n: number): number[] {
    const b = [n & 0x7f];
    n >>= 7;
    while (n > 0) {
      b.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    return b;
  }

  function buildTrack(deltaEvs: { delta: number; bytes: number[] }[]): Uint8Array {
    const data: number[] = [];
    for (const ev of deltaEvs) {
      data.push(...varLen(ev.delta), ...ev.bytes);
    }
    data.push(0, 0xff, 0x2f, 0x00);
    const chunk = new Uint8Array(8 + data.length);
    new DataView(chunk.buffer).setUint32(4, data.length, false);
    chunk.set([0x4d, 0x54, 0x72, 0x6b]);
    chunk.set(data, 8);
    return chunk;
  }

  const hzToMidi = (hz: number) =>
    Math.max(0, Math.min(127, Math.round(69 + 12 * Math.log2(Math.max(1, hz) / 440))));
  const secToTick = (s: number) => Math.round((s * TPQ * 1e6) / TEMPO_US);

  const tempoTrack = buildTrack([
    {
      delta: 0,
      bytes: [0xff, 0x51, 0x03, (TEMPO_US >> 16) & 0xff, (TEMPO_US >> 8) & 0xff, TEMPO_US & 0xff],
    },
  ]);

  // Indexed by chanType (0=sq1, 1=sq2, 2=wave, 3=noise):
  // GM programs (80=square lead, 88=lead 8; -1 = no program → drums) and
  // MIDI channels (channel 9 is the GM percussion channel for noise).
  const PROGS = [80, 80, 88, -1];
  const MIDI_CH = [0, 1, 2, 9];
  const DRUM_NOTE = 42; // GM "closed hi-hat" — stand-in for the noise channel
  const MAX_LOOP_PASSES = 1000; // guard against a degenerate (zero-length) loop

  const noteTracks = _s.playing.channels.map((ch) => {
    const { notes, chanType, loopSec, totalSec, loops } = ch;
    const exportDur = totalSec * (loops ? 3 : 1);
    const miCh = MIDI_CH[chanType];
    const raw: { tick: number; bytes: number[] }[] = [];

    if (PROGS[chanType] >= 0) raw.push({ tick: 0, bytes: [0xc0 | miCh, PROGS[chanType]] });

    const sched = (notesArr: AudioNote[], offsetSec: number) => {
      for (const n of notesArr) {
        const t0 = n.t + offsetSec;
        if (t0 > exportDur + 0.1) break;
        const t1 = Math.min(t0 + n.dur, exportDur);
        const tk0 = secToTick(t0),
          tk1 = secToTick(t1);
        const vel = Math.max(1, Math.round(n.gain * 90));
        if (chanType === 3) {
          raw.push({ tick: tk0, bytes: [0x99, DRUM_NOTE, vel] });
          raw.push({ tick: tk1, bytes: [0x89, DRUM_NOTE, 0] });
        } else {
          const p = hzToMidi((n as ToneNote).hz);
          raw.push({ tick: tk0, bytes: [0x90 | miCh, p, vel] });
          raw.push({ tick: tk1, bytes: [0x80 | miCh, p, 0] });
        }
      }
    };

    if (loops && loopSec !== null && totalSec > loopSec + 0.01) {
      const li = firstNoteAtOrAfter(notes, loopSec);
      sched(li >= 0 ? notes.slice(0, li) : notes, 0);
      const ln = li >= 0 ? notes.slice(li) : notes;
      const ll = totalSec - loopSec;
      let off = 0,
        safety = 0;
      while (loopSec + off < exportDur && safety++ < MAX_LOOP_PASSES) {
        sched(ln, off);
        off += ll;
      }
    } else {
      sched(notes, 0);
    }

    raw.sort((a, b) => a.tick - b.tick);
    const deltaEvs: { delta: number; bytes: number[] }[] = [];
    let lastTick = 0;
    for (const ev of raw) {
      deltaEvs.push({ delta: ev.tick - lastTick, bytes: ev.bytes });
      lastTick = ev.tick;
    }
    return buildTrack(deltaEvs);
  });

  const allChunks = [tempoTrack, ...noteTracks];
  const hdr = new Uint8Array(14);
  const hv = new DataView(hdr.buffer);
  hdr.set([0x4d, 0x54, 0x68, 0x64]);
  hv.setUint32(4, 6, false);
  hv.setUint16(8, 1, false);
  hv.setUint16(10, 1 + noteTracks.length, false);
  hv.setUint16(12, TPQ, false);

  const out = new Uint8Array(hdr.length + allChunks.reduce((s, t) => s + t.length, 0));
  let p = 0;
  out.set(hdr, p);
  p += hdr.length;
  for (const t of allChunks) {
    out.set(t, p);
    p += t.length;
  }

  _triggerDownload(new Blob([out], { type: 'audio/midi' }), _exportFilename('mid'));
}
