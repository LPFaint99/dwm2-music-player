import type { AudioNote, ToneNote } from './types';
import { _s } from './engine';
import { firstNoteAtOrAfter } from './util';

export function musicRenderPianoRoll(canvas: HTMLCanvasElement): void {
  if (!_s.playing || !canvas) return;
  const W = canvas.clientWidth || 800,
    H = canvas.clientHeight || 100;
  canvas.width = W;
  canvas.height = H;
  const ctx2d = canvas.getContext('2d')!;
  ctx2d.fillStyle = '#0d1117';
  ctx2d.fillRect(0, 0, W, H);

  const hzToMidi = (hz: number) => 69 + 12 * Math.log2(Math.max(1, hz) / 440);
  const { channels, totalSec, loopSec } = _s.playing;

  let minP = 127,
    maxP = 0;
  for (const ch of channels) {
    if (ch.chanType === 3) continue;
    for (const n of ch.notes) {
      const p = Math.round(hzToMidi((n as ToneNote).hz));
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
    }
  }
  if (minP > maxP) return;
  minP = Math.max(0, minP - 2);
  maxP = Math.min(127, maxP + 2);
  const pRange = maxP - minP || 1;

  // looping tracks show the intro plus two loop passes; one-shots show their length
  const displaySec = loopSec !== null ? loopSec + (totalSec - loopSec) * 2 : totalSec;

  const xOf = (t: number) => (t / displaySec) * W;
  const yOf = (p: number) => H - 1 - ((p - minP) / pRange) * (H - 1);
  const noteHeight = Math.max(1, Math.ceil((H - 1) / pRange));
  // indexed by chanType: 0=sq1, 1=sq2, 2=wave, 3=noise
  const COLORS = ['#6ec1ff', '#ffd166', '#7ee08a', '#888888'];

  const draw = (notes: AudioNote[], chanType: number, alpha: number, off: number) => {
    ctx2d.fillStyle = COLORS[chanType];
    ctx2d.globalAlpha = alpha;
    for (const n of notes) {
      const t = n.t + off;
      if (t > displaySec + 0.1) break;
      const x = xOf(t),
        w = Math.max(1, xOf(t + n.dur) - x);
      if (chanType === 3) {
        ctx2d.fillRect(x, H - noteHeight, w, noteHeight);
        continue;
      }
      ctx2d.fillRect(x, yOf(Math.round(hzToMidi((n as ToneNote).hz))), w, noteHeight);
    }
  };

  for (const ch of channels) {
    draw(ch.notes, ch.chanType, 0.9, 0);
    if (ch.loops && ch.loopSec !== null && ch.totalSec > ch.loopSec + 0.01) {
      const li = firstNoteAtOrAfter(ch.notes, ch.loopSec);
      if (li >= 0) draw(ch.notes.slice(li), ch.chanType, 0.4, ch.totalSec - ch.loopSec);
    }
  }
  ctx2d.globalAlpha = 1;

  if (loopSec !== null) {
    ctx2d.strokeStyle = '#ffd166';
    ctx2d.lineWidth = 1;
    ctx2d.setLineDash([3, 3]);
    ctx2d.beginPath();
    ctx2d.moveTo(xOf(loopSec), 0);
    ctx2d.lineTo(xOf(loopSec), H);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
  }
}
