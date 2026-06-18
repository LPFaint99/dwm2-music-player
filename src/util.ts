import type { AudioNote } from './types';

/** Channel-type display names, indexed by chanType (0=sq1, 1=sq2, 2=wave, 3=noise). */
export const CHAN_NAMES = ['sq1', 'sq2', 'wave', 'noise'] as const;

/** Format a note/SFX id as a 2-digit uppercase hex string with a `$` prefix, e.g. `$0A`. */
export const hex2 = (id: number): string => '$' + id.toString(16).toUpperCase().padStart(2, '0');

/** Index of the first note at or after `sec` (e.g. a loop point or seek target), or -1 if none. */
export const firstNoteAtOrAfter = (notes: AudioNote[], sec: number): number =>
  notes.findIndex((n) => n.t >= sec - 1e-6);
