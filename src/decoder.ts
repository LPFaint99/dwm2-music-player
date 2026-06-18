import type {
  RomRange,
  ParsedRom,
  Descriptor,
  SeqHeader,
  SimResult,
  ResolvedChannel,
  TlEvent,
  AudioNote,
  ToneNote,
} from './types';

// Bank-0 sound-engine data tables (addresses verified against the disassembly:
// dwm2-disasm/disasm/cobi/bank_000.asm — identical region in cobi and tara ROMs).
const PERIOD_TABLE_ADDR = 0x3b5c; // note→period pointer table (asm: `ld hl, $3b5c; add hl, de`)
const FREQ_TABLE_ADDR = 0x3e13; // short note-frequency table / SoundNoteOn_Short ($3E13)
const NOISE_TABLE_ADDR = 0x38a0; // noise-divisor table (asm: `ld hl, $38a0`)

/** Game Boy square/wave channel frequency: f = 131072 / period. */
const GB_FREQ_NUMERATOR = 131072;

/** Sequence tempo (0..15) → ticks-per-second playback rate (asm tempo nibble). */
const tempoToRate = (tempo: number): number => (60 * (16 - tempo)) / 16;

export function parseRom(rom: Uint8Array): ParsedRom {
  if (rom.length < 0x110000) throw new Error('File too small to be a DWM2 ROM');
  const ranges: RomRange[] = [];
  for (let off = FREQ_TABLE_ADDR; ; off += 4) {
    const base = rom[off];
    if (base === 0xff) break;
    ranges.push({ base, addr: rom[off + 1] | (rom[off + 2] << 8), bank: rom[off + 3] });
    if (ranges.length > 16) throw new Error('Dispatch table not found - wrong ROM?');
  }
  for (const r of ranges)
    if (rom[r.bank * 0x4000] !== r.bank)
      throw new Error('Audio bank check failed - not a DWM2 ROM?');
  const periods: number[] = [];
  for (let i = 0; i < 24; i++)
    periods.push(rom[PERIOD_TABLE_ADDR + i * 2] | (rom[PERIOD_TABLE_ADDR + i * 2 + 1] << 8));
  const noiseTable = Array.from(rom.slice(NOISE_TABLE_ADDR, NOISE_TABLE_ADDR + 16));
  let title = '';
  for (let i = 0x134; i < 0x144; i++)
    if (rom[i] >= 32 && rom[i] < 127) title += String.fromCharCode(rom[i]);
  return { rom, ranges, periods, noiseTable, title: title.trim() };
}

export function noteBankInfo(R: ParsedRom, note: number): RomRange {
  for (let i = R.ranges.length - 1; i >= 0; i--) if (note >= R.ranges[i].base) return R.ranges[i];
  throw new Error('note out of range');
}

export function bankData(R: ParsedRom, bank: number): Uint8Array {
  return R.rom.subarray(bank * 0x4000, (bank + 1) * 0x4000);
}

export function readDescriptor(R: ParsedRom, note: number): Descriptor {
  const { base, addr, bank } = noteBankInfo(R, note);
  const bd = bankData(R, bank);
  const off = addr - 0x4000 + (note - base) * 4;
  return {
    note,
    bank,
    slot: bd[off],
    ctrl: bd[off + 1],
    chanType: bd[off + 1] & 3,
    seqAddr: bd[off + 2] | (bd[off + 3] << 8),
  };
}

export function decodeHeader(bd: Uint8Array, seqAddr: number): SeqHeader {
  const o = seqAddr - 0x4000;
  return {
    tempo: bd[o] & 0x0f,
    duty: bd[o + 1] & 3,
    // envelope byte is stored nibble-swapped (hi/lo reversed); swap back
    envelope: ((bd[o + 2] << 4) | (bd[o + 2] >> 4)) & 0xff,
    timbre: bd[o + 3],
  };
}

export function simulate(
  bd: Uint8Array,
  seqAddr: number,
  chanType: number,
  noiseTable: number[],
  maxSteps = 200000,
): SimResult {
  const header = decodeHeader(bd, seqAddr);
  const baseOff = seqAddr - 0x4000;
  // `pc` is the program counter in 16-bit *words* (each opcode is op|param);
  // byte offset = baseOff + pc * 2. Starts at 2 to skip the 4-byte header.
  let pc = 2,
    tick = 0,
    tempo = header.tempo,
    detune = false;
  const timeline: TlEvent[] = [{ tick: 0, kind: 'tempo', value: tempo }];
  const loopSlots: Record<number, { count: number; point: number }> = {};
  // idxA/idxB: the two index registers used by the 0xa9 jump-table opcode.
  let idxA = 0,
    idxB = 0;
  let segRepeat = 0,
    segReturn: number | null = null;
  const firstTick: Record<number, number> = {};
  let end: SimResult['end'] = 'step_cap',
    loopTick: number | null = null;

  for (let step = 0; step < maxSteps; step++) {
    const pos = baseOff + pc * 2;
    if (pos + 1 >= bd.length) {
      end = 'truncated';
      break;
    }
    if (!(pc in firstTick)) firstTick[pc] = tick;
    const op = bd[pos],
      param = bd[pos + 1];
    const evIdx = pc;
    // 0xac (segment-call) carries an extra 16-bit operand, so it is 2 words wide.
    pc += op === 0xac ? 2 : 1;

    // Opcode map: 0x00-0x9f = note/rest/noise; 0xa0-0xbf = control (env, timbre,
    // vibrato, tempo, loops, jump-table); 0xac/0xad = segment call/return;
    // 0xd0-0xef = pitch slide; 0xff = end. param is always the following byte.
    if (op <= 0x9f) {
      const semi = op & 0x0f,
        oct = op >> 4;
      if (chanType === 3) {
        // noise channel: op < 0x10 indexes the ROM noise table, else op is the raw value
        if (op === 0x1f) timeline.push({ tick, kind: 'rest', dur: param });
        else
          timeline.push({
            tick,
            kind: 'noise',
            dur: param,
            value: op < 0x10 ? noiseTable[op] : op,
          });
      } else if (semi >= 0x0c) {
        // semitone nibble 0x0c-0x0f is not a real pitch → treated as a rest
        timeline.push({ tick, kind: 'rest', dur: param });
      } else {
        timeline.push({ tick, kind: 'note', dur: param, semi, oct, detune });
      }
      tick += param;
    } else if (op === 0xa7) {
      timeline.push({ tick, kind: 'tie', dur: param });
      tick += param;
    } else if (op === 0xaf) {
      tempo = param & 0x0f;
      timeline.push({ tick, kind: 'tempo', value: tempo });
    } else if (op === 0xa0) {
      timeline.push({ tick, kind: 'env', vol: param & 0x0f });
    } else if (op === 0xa1) {
      timeline.push({ tick, kind: 'timbre', value: param });
    } else if (op === 0xa3) {
      if (param === 0xfe) timeline.push({ tick, kind: 'vibrato', depth: 0, delay: 0 });
      // vibrato param packs depth in the high nibble, delay in the low nibble
      else
        timeline.push({
          tick,
          kind: 'vibrato',
          depth: (param + 0x10) >> 4,
          delay: (param & 0xf) * 2,
        });
    } else if (op === 0xae) {
      detune = !!(param & 0x10);
    } else if (op === 0xfd) {
      loopSlots[param & 0x0f] = { count: 0, point: pc };
    } else if (op >= 0xb1 && op <= 0xbf) {
      const slot = loopSlots[param & 0x0f];
      if (slot) {
        slot.count++;
        if (slot.count < (op & 0x0f) + 1) pc = slot.point;
      }
    } else if (op === 0xb0) {
      if ((param & 0xf0) === 0xf0) {
        const slot = loopSlots[param & 0x0f];
        if (slot) loopTick = firstTick[slot.point] ?? null;
        end = 'loop';
        break;
      }
    } else if (op === 0xac) {
      const tgt = (bd[pos + 2] | (bd[pos + 3] << 8)) >> 1;
      if (segRepeat === 0) {
        segRepeat = param;
        segReturn = evIdx;
        pc = tgt;
      } else {
        segRepeat--;
        if (segRepeat !== 0) pc = tgt;
      }
    } else if (op === 0xad) {
      if (segReturn !== null) pc = segReturn;
    } else if (op === 0xa9) {
      if (param < 0x80) idxA = param;
      else if (param === 0xf0) idxA = (idxA + 1) & 0xff;
      else if (param === 0xf1) idxA = (idxA - 1) & 0xff;
      else if (param === 0xf2) idxB = (idxB + 1) & 0xff;
      else if (param === 0xf3) idxB = (idxB - 1) & 0xff;
      else if (param === 0xfe || param === 0xff) {
        const idx = param === 0xfe ? idxB : idxA;
        const tbl = baseOff + evIdx * 2 + 2 + idx * 2;
        if (tbl + 1 >= bd.length) {
          end = 'truncated';
          break;
        }
        pc = bd[tbl] | (bd[tbl + 1] << 8);
      } else idxB = (param - 0x80) & 0xff;
    } else if (op >= 0xd0 && op <= 0xef) {
      const slideStep = (op & 0xf) * (op >= 0xe0 ? -1 : 1);
      timeline.push({ tick, kind: 'slide', step: slideStep, speed: Math.max(1, param) });
    } else if (op === 0xff) {
      end = 'end';
      break;
    }
  }
  return { header, timeline, loopTick, end };
}

export function resolveChannel(R: ParsedRom, noteId: number): ResolvedChannel | null {
  const desc = readDescriptor(R, noteId);
  if (desc.seqAddr < 0x4000 || desc.seqAddr >= 0x8000) return null;
  const bd = bankData(R, desc.bank);
  const sim = simulate(bd, desc.seqAddr, desc.chanType, R.noiseTable);
  let rate = tempoToRate(sim.header.tempo);
  let lastTick = 0,
    lastSec = 0,
    vol = sim.header.envelope >> 4;
  const isWave = desc.chanType === 2;
  let wavTimbre = sim.header.timbre;
  let slideStep = 0,
    slideSpeed = 1;
  let vibDepth = 0,
    vibDelay = 0;
  const secAt = (t: number) => lastSec + (t - lastTick) / rate;
  const notes: AudioNote[] = [];
  let loopSec: number | null = null,
    maxEnd = 0;
  for (const ev of sim.timeline) {
    if (sim.loopTick !== null && loopSec === null && ev.tick >= sim.loopTick)
      loopSec = secAt(sim.loopTick);
    const t = secAt(ev.tick);
    if (ev.kind === 'tempo') {
      lastSec = t;
      lastTick = ev.tick;
      rate = tempoToRate(ev.value);
    } else if (ev.kind === 'env') {
      vol = ev.vol;
    } else if (ev.kind === 'timbre') {
      wavTimbre = ev.value;
    } else if (ev.kind === 'slide') {
      slideStep = ev.step;
      slideSpeed = ev.speed;
    } else if (ev.kind === 'vibrato') {
      vibDepth = ev.depth;
      vibDelay = ev.delay / rate;
    } else if (ev.kind === 'note') {
      const p = R.periods[ev.semi + (ev.detune ? 12 : 0)] >> ev.oct;
      if (p > 0) {
        const hz = GB_FREQ_NUMERATOR / p;
        const note: ToneNote = { t, dur: ev.dur / rate, kind: 'tone', hz, gain: vol / 15 };
        if (isWave) note.timbre = wavTimbre;
        if (slideStep !== 0) {
          const endP = p - slideStep * Math.floor(ev.dur / slideSpeed);
          note.endHz = GB_FREQ_NUMERATOR / Math.max(1, endP);
        }
        if (vibDepth > 0) note.vib = { depth: vibDepth, delay: vibDelay };
        notes.push(note);
      }
      maxEnd = Math.max(maxEnd, t + ev.dur / rate);
    } else if (ev.kind === 'noise') {
      notes.push({ t, dur: ev.dur / rate, kind: 'noise', nr43: ev.value, gain: vol / 15 });
      maxEnd = Math.max(maxEnd, t + ev.dur / rate);
    } else if (ev.kind === 'tie') {
      if (notes.length) notes[notes.length - 1].dur += ev.dur;
      maxEnd = Math.max(maxEnd, t + ev.dur / rate);
    } else if (ev.kind === 'rest') {
      maxEnd = Math.max(maxEnd, t + ev.dur / rate);
    }
  }
  if (sim.loopTick !== null && loopSec === null) loopSec = secAt(sim.loopTick);
  return {
    noteId,
    chanType: desc.chanType,
    duty: sim.header.duty,
    notes,
    totalSec: maxEnd,
    loopSec,
    loops: sim.end === 'loop',
  };
}
