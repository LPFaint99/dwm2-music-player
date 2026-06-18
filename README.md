# DWM2 Music Player

Browser-based music player and SFX explorer for **Dragon Warrior Monsters 2: Cobi's Journey / Tara's Adventure** (GBC, USA).

Decodes the game's sound engine directly from a ROM file - nothing is uploaded anywhere.

## Usage

Drop a `.gbc` ROM onto the page (or click to browse). The player verifies the ROM header, extracts all BGM and SFX sequences, and plays them back through the Web Audio API.

The ROM is cached in IndexedDB so the next visit auto-restores it.

**Controls**

| Action | How |
|---|---|
| Play / stop | Click a track, or press Space |
| Previous / next | ◀◀ / ▶▶ buttons, or ← / → arrow keys |
| Volume | Slider in the Now Playing panel |
| Per-channel mute | Mute bar appears while a track is playing |
| Seek | Click / drag the progress bar |
| Export WAV / MP3 | Buttons in the Now Playing panel (MP3 uses lamejs, loaded on demand) |
| Export MIDI | ↓ MIDI button |
| Sound effects | SFX grid; "all notes" dropdown for unlisted IDs |
| WanderingMaster sequence | Plays all 60 arena-phase cues in order at adjustable pace |

## Build

```sh
npm install
npm run build      # esbuild bundles src/ui.ts → src/ui.js
npm run typecheck  # tsc strict check
```

The TypeScript sources live in `src/` with `src/ui.ts` as the entry point; esbuild bundles them into `src/ui.js` (an ES module), committed as a build artifact so the page works without a build step in the browser.

ROM MD5 (USA) — Cobi: `f71ac6ac4bb335f59bfd2b594d47ab49` · Tara: `8e79dcdee0e15ef069b3f376a0fee37d`
