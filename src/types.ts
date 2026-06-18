export interface RomRange {
  base: number;
  addr: number;
  bank: number;
}
export interface ParsedRom {
  rom: Uint8Array;
  ranges: RomRange[];
  periods: number[];
  noiseTable: number[];
  title: string;
}
export interface Descriptor {
  note: number;
  bank: number;
  slot: number;
  ctrl: number;
  chanType: number;
  seqAddr: number;
}
export interface SeqHeader {
  tempo: number;
  duty: number;
  envelope: number;
  timbre: number;
}

export type TlTempo = { tick: number; kind: 'tempo'; value: number };
export type TlNote = {
  tick: number;
  kind: 'note';
  dur: number;
  semi: number;
  oct: number;
  detune: boolean;
};
export type TlNoise = { tick: number; kind: 'noise'; dur: number; value: number };
export type TlRest = { tick: number; kind: 'rest'; dur: number };
export type TlTie = { tick: number; kind: 'tie'; dur: number };
export type TlEnv = { tick: number; kind: 'env'; vol: number };
export type TlTimbre = { tick: number; kind: 'timbre'; value: number };
export type TlVibrato = { tick: number; kind: 'vibrato'; depth: number; delay: number };
export type TlSlide = { tick: number; kind: 'slide'; step: number; speed: number };
export type TlEvent =
  | TlTempo
  | TlNote
  | TlNoise
  | TlRest
  | TlTie
  | TlEnv
  | TlTimbre
  | TlVibrato
  | TlSlide;

export interface SimResult {
  header: SeqHeader;
  timeline: TlEvent[];
  loopTick: number | null;
  end: 'step_cap' | 'truncated' | 'loop' | 'end';
}

export interface Vibrato {
  depth: number;
  delay: number;
}
export interface ToneNote {
  t: number;
  dur: number;
  kind: 'tone';
  hz: number;
  gain: number;
  timbre?: number;
  endHz?: number;
  vib?: Vibrato;
}
export interface NoiseNote {
  t: number;
  dur: number;
  kind: 'noise';
  nr43: number;
  gain: number;
}
export type AudioNote = ToneNote | NoiseNote;

export interface ResolvedChannel {
  noteId: number;
  chanType: number;
  duty: number;
  notes: AudioNote[];
  totalSec: number;
  loopSec: number | null;
  loops: boolean;
}
export interface PlayingChannel extends ResolvedChannel {
  idx: number;
  passOffset: number;
  done: boolean;
  loopIdx: number;
  bus: GainNode;
}
export interface PlayingState {
  channels: PlayingChannel[];
  gain: GainNode;
  chanGains: Record<number, GainNode>;
  trackNum: number;
  trackName: string;
  trackIds: number[];
  startCtxTime: number;
  totalSec: number;
  loopSec: number | null;
  lastEndTime: number;
  timer: number | null;
}
export interface AudioResources {
  ctx: BaseAudioContext;
  dutyWaves: PeriodicWave[];
  wavePatches: PeriodicWave[] | null;
  noiseBuf: AudioBuffer;
}

export interface BgmTrack {
  num: number;
  ids: number[];
  name: string;
}
export interface SfxEntry {
  id: number;
  label: string;
}
export interface WmEntry {
  slot: number;
  // Overloaded on purpose: a numeric SFX id, `null` for a visual-only slot, or a
  // `'bgm<n>'` sentinel meaning "play BGM track <n>" (see WM_SEQUENCE / ui.ts).
  id: number | string | null;
  label: string;
}

export interface LameEncoder {
  encodeBuffer(left: Int16Array, right: Int16Array): Int8Array;
  flush(): Int8Array;
}
export interface LameJs {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameEncoder;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    lamejs?: LameJs;
  }
}
