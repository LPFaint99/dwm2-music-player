export type OnPlayFn = (
  num: number,
  name: string,
  info: string,
  totalSec: number,
  loopSec: number | null,
) => void;
export type OnStopFn = () => void;
export type OnProgressFn = (pos: number, total: number, loopSec: number | null) => void;

let _onPlay: OnPlayFn | null = null;
let _onStop: OnStopFn | null = null;
let _onProgress: OnProgressFn | null = null;

type PlayTrackFn = (num: number, ids: number[], name: string, btn?: HTMLElement | null) => void;
let _playTrack: PlayTrackFn | null = null;

export function onPlay(fn: OnPlayFn): void {
  _onPlay = fn;
}
export function onStop(fn: OnStopFn): void {
  _onStop = fn;
}
export function onProgress(fn: OnProgressFn): void {
  _onProgress = fn;
}

export function _setPlayTrack(fn: PlayTrackFn): void {
  _playTrack = fn;
}

export function _firePlay(...args: Parameters<OnPlayFn>): void {
  _onPlay?.(...args);
}
export function _fireStop(): void {
  _onStop?.();
}
export function _fireProgress(...args: Parameters<OnProgressFn>): void {
  _onProgress?.(...args);
}
// Auto-advance / sequence playback: there is no source button to highlight,
// so this omits the optional `btn` argument that interactive callers pass.
export function _callPlayTrack(num: number, ids: number[], name: string): void {
  _playTrack?.(num, ids, name);
}
