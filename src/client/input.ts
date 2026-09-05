/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/input.h (GNU GPL v2 or later).

input.h -- external (non-keyboard) input devices

Deviations from PORTING.md / the C source:
- The IN_* free functions become the `InputBackend` interface plus the
  `inputBackend` holder: WinQuake links exactly one of in_win.c / in_dos.c /
  in_sun.c / in_null.c, and PORTING.md maps all of them to one implementation
  inside src/platform/sdl.ts (U056), which installs itself here.
- `IN_ModeChanged` is in_win.c's, not input.h's, and is called only from
  vid_win.c on a mode change. It is a member here because src/platform/vid.ts
  needs the same call after an SDL window resize and there is no other place a
  backend-owned entry point can live.
- Callers may need the null case (a dedicated server installs no backend), so
  the holder is `{ current: InputBackend | null }` rather than a getter that
  errors; host.c calls IN_Init/IN_Shutdown/IN_Commands/IN_Move unconditionally
  in a client build only.
*/

import type { UsercmdT } from "../server/server";

export interface InputBackend {
  IN_Init(): void;

  IN_Shutdown(): void;

  // oportunity for devices to stick commands on the script buffer
  IN_Commands(): void;

  // add additional movement on top of the keyboard move cmd
  IN_Move(cmd: UsercmdT): void;

  // in_win.c; vid_win.c calls it after a video mode change
  IN_ModeChanged(): void;

  // restores all button and position states to defaults
  IN_ClearStates(): void;
}

export const inputBackend: { current: InputBackend | null } = { current: null };
