/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/vid_win.c's VID_MenuDraw/VID_MenuKey (GNU GPL v2 or
later) -- the video options submenu `vid_menudrawfn`/`vid_menukeyfn` point
at (client/vid.ts's `vidMenuHooks`, wired by src/platform/vid.ts's own
VID_Init). vid_x.c and gl_vidlinuxglx.c never define these two functions at
all (X11 has no hardware mode list to build a menu screen from); vid_win.c
is the one C file that does, and its version is a DOS/VESA-era grid of
`modedescs[]` entries read off `XF86VidMode`/`ChangeDisplaySettings`-style
mode enumeration that has no equivalent here (this port's own resolution
list is the flat `VID_MODES` table src/platform/vid.ts declares per that
unit's own "RULING: adopt q2ts's flat mode table" -- there is no live
hardware mode enumeration to draw a grid from).

This is therefore this port's OWN video menu layout, not a line-for-line
port of vid_win.c's grid: a simple cursor-selectable list (video mode /
fullscreen / renderer / apply), drawn entirely with client/menu.ts's own
M_Print/M_DrawCheckbox/M_DrawCharacter/M_DrawTextBox primitives -- the same
ones M_Options_Draw (client/menu.ts) already uses for its own slider/
checkbox rows -- per this unit's brief ("drawn with Quake 1's M_* helpers").
Adapted in STRUCTURE from ../quake-2-ts/src/platform/vid_menu.ts (the
lazy-require of client/menu.ts to break the menu<->vid_menu value cycle,
the Apply-action idea), not in its widget framework: quake-2-ts's vid_menu.ts
is built on qmenu.ts's generic MenuframeworkS/MenulistS/MenusliderS widget
objects, which this port has no equivalent of (Quake 1's menu.c draws every
screen by hand, with no shared widget layer) -- see client/menu.ts's own
M_Options_Draw/M_Options_Key for the idiom this file matches instead.

Deviations from PORTING.md / the C source:
- vid_win.c's mode-grid rows/columns, `VID_ROW_SIZE`, `modedescs[].iscur`
  highlighting via `M_PrintWhite`, and its Apply/OK/Cancel three-button
  bottom row have no counterpart: this file's own three adjustable rows plus
  one Apply action is a new, simpler layout for the new flat mode table.
- No "restart required" banner: unlike vid_win.c (whose mode change truly
  needs a DirectX/VESA mode switch the user must confirm), this port's
  Apply action calls `VID_CheckChanges()` synchronously and the new mode is
  visible immediately -- see vid.ts's own header on why there is no
  per-frame poll of `vid_ref.modified` yet.
- Value cycle with src/platform/vid.ts (this file reads `VID_MODES`/
  `vid_mode`/`vid_fullscreen`/`vid_ref`/`VID_CheckChanges`/`registeredNames`;
  vid.ts imports `VID_MenuDraw`/`VID_MenuKey` to wire `vidMenuHooks`) is
  safe: every read of vid.ts's exports here happens inside a function body
  (VID_MenuDraw/VID_MenuKey/adjustCursorValue), never at this module's own
  top level, so it does not matter which of the two files' module bodies
  finishes evaluating first (PORTING.md's import-cycle rule's usual `require()`
  escape hatch is not needed for a pure function-reference cycle like this
  one -- see client/menu.ts <-> client/keys.ts for the same shape already
  landed).
*/

import { getRenderer } from "../client/render";
import type { QpicT } from "../common/wad";
import { Sys_Error } from "./sys";
import { host } from "../common/host";
import { Cvar_Set, Cvar_SetValue } from "../common/cvar";
import { S_LocalSound } from "../client/snd_dma";
import { M_DrawCharacter, M_DrawCheckbox, M_DrawTransPic, M_Menu_Options_f, M_Print } from "../client/menu";
import { K_DOWNARROW, K_ENTER, K_ESCAPE, K_LEFTARROW, K_RIGHTARROW, K_UPARROW } from "../client/keys";
import { VID_CheckChanges, VID_MODES, vid_fullscreen, vid_mode, vid_ref } from "./vid";

function cachePic(path: string): QpicT {
  const p = getRenderer().Draw_CachePic(path);
  if (p === null) Sys_Error("vid_menu: couldn't load %s", path);
  return p;
}

// row index -> y coordinate, same 8px-per-row convention as client/menu.ts's
// M_Options_Draw. A gap separates the three adjustable rows from Apply, the
// same visual grouping M_Options_Draw uses before its own "Video Options" row.
const ROW_MODE = 0;
const ROW_FULLSCREEN = 1;
const ROW_RENDERER = 2;
const ROW_APPLY = 3;
const ROWS = [32, 40, 48, 64];

let cursor = 0;

export function VID_MenuDraw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));

  M_Print(16, ROWS[ROW_MODE], "           Video mode");
  const mode = VID_MODES[Math.trunc(vid_mode.value)];
  M_Print(220, ROWS[ROW_MODE], mode ? mode.description : "?");

  M_Print(16, ROWS[ROW_FULLSCREEN], "           Fullscreen");
  M_DrawCheckbox(220, ROWS[ROW_FULLSCREEN], vid_fullscreen.value !== 0);

  M_Print(16, ROWS[ROW_RENDERER], "             Renderer");
  M_Print(220, ROWS[ROW_RENDERER], vid_ref.string);

  M_Print(16, ROWS[ROW_APPLY], "                Apply");

  M_DrawCharacter(200, ROWS[cursor], 12 + (Math.trunc(host.realtime * 4) & 1));
}

function adjustCursorValue(dir: number): void {
  switch (cursor) {
    case ROW_MODE: {
      let m = Math.trunc(vid_mode.value) + dir;
      if (m < 0) m = VID_MODES.length - 1;
      if (m >= VID_MODES.length) m = 0;
      Cvar_SetValue("vid_mode", m);
      break;
    }
    case ROW_FULLSCREEN:
      Cvar_SetValue("vid_fullscreen", vid_fullscreen.value !== 0 ? 0 : 1);
      break;
    case ROW_RENDERER:
      Cvar_Set("vid_ref", vid_ref.string === "soft" ? "gl" : "soft");
      break;
    case ROW_APPLY:
      VID_CheckChanges();
      break;
    default:
      break;
  }
}

export function VID_MenuKey(key: number): void {
  switch (key) {
    case K_ESCAPE:
      M_Menu_Options_f();
      return;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      cursor = (cursor - 1 + ROWS.length) % ROWS.length;
      return;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      cursor = (cursor + 1) % ROWS.length;
      return;

    case K_LEFTARROW:
      S_LocalSound("misc/menu3.wav");
      adjustCursorValue(-1);
      return;

    case K_RIGHTARROW:
      S_LocalSound("misc/menu3.wav");
      adjustCursorValue(1);
      return;

    case K_ENTER:
      S_LocalSound("misc/menu1.wav");
      adjustCursorValue(1);
      return;

    default:
      return;
  }
}

// test seam: menu.ts's M_ToggleMenu_f resets menuState on close, but this
// module's own cursor is private state client/menu.ts never reaches --
// exposed so a suite can assert/reset it without exporting a mutable let.
export function VID_MenuCursor(): number {
  return cursor;
}
export function VID_MenuSetCursorForTests(row: number): void {
  cursor = row;
}
