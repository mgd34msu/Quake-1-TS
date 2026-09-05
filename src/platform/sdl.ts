/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/vid_x.c (GNU GPL v2 or later): the one native
windowing/input/audio backend for this port, bound to the system SDL2 shared
library through bun:ffi. Adapted from ../quake-2-ts/src/platform/sdl.ts,
which already solved every FFI problem this file needs (dlopen table, struct
offsets, window/texture/audio/event pump) -- the symbol table, struct
offsets and event decoding below are carried over unchanged; only the
engine-facing calls (Key_Event's key numbers, IN_Move's math, the window
title, the module this file wires hostClientHooks/inputBackend/sys.ts's key
event pump into) are re-pointed at this engine's modules.

PORTING.md maps linux/win32/svgalib/dos/sun to a single src/platform
implementation of the vid/snd/input interfaces. This file is the shared
device layer vid.ts (VID_*), snd.ts (SNDDMA_*) and this file's own
InputBackend implementation all call into, rather than each opening the
library themselves. glimp.ts (U056, this same unit) shares this file's one
SDL `window` handle for the GL path -- this port runs one refresh at a time,
never software and GL together.

Nothing is dlopen()ed at module load. `SDL_SetBackendEnabled(true)` arms the
backend; VID_Init (this unit's platform/vid.ts) is the only caller, and it is
only ever reached on the client path (Host_Init's `if (!sysState.isDedicated)`
block) -- so a dedicated server, and any test that never calls VID_Init,
never touches libSDL2 unless it asks for it directly (SDL_SetBackendEnabled(true)
in a test).

Two SDL audio DEVICES are opened here, not one: WinQuake's CD audio was a
physically separate analog path from the sound card's digital DMA output
(cd_linux.c never mixes into the software ring at all -- see cd_ogg.ts's own
header for why), so the Ogg-Vorbis replacement for it (cd_ogg.ts) gets its
own SDL_OpenAudioDevice, independent of the one snd.ts's SNDDMA_* uses for
game sound effects, rather than sharing the ring the way quake-2-ts's raw
cinematic audio does (Quake 1 has no S_RawSamples-style mixer entry point to
share -- reported deviation from the quake-2-ts template).

Struct offsets below were read off /usr/include/SDL2 (SDL 2.32) with an
offsetof program; they are ABI-stable across SDL2's lifetime because SDL2
freezes its public struct layouts.
*/

import { dlopen, type Pointer } from "bun:ffi";
import { VID_CalcBlitRect } from "./vid_scale";
import { setKeyEventPump, Sys_Quit } from "./sys";
import { CvarT, Cvar_RegisterVariable } from "../common/cvar";
import { Con_Printf, Con_DPrintf } from "../client/console";
import type { UsercmdT } from "../server/server";
import type { QwUsercmdT } from "../qw/protocol";
import { PITCH, YAW } from "../common/quakedef";
import { noclip_anglehack } from "../common/host_cmd";
import { cl } from "../client/client";
import { in_strafe, in_mlook } from "../client/cl_input";
import { lookstrafe, sensitivity, m_pitch, m_yaw, m_forward, m_side } from "../client/cl_main";
import { V_StopPitchDrift } from "../client/view";
import { hostClientHooks } from "../common/host";
import { inputBackend, type InputBackend } from "../client/input";
import {
  Key_Event,
  K_ALT,
  K_BACKSPACE,
  K_CTRL,
  K_DEL,
  K_DOWNARROW,
  K_END,
  K_ENTER,
  K_ESCAPE,
  K_F1,
  K_F2,
  K_F3,
  K_F4,
  K_F5,
  K_F6,
  K_F7,
  K_F8,
  K_F9,
  K_F10,
  K_F11,
  K_F12,
  K_HOME,
  K_INS,
  K_LEFTARROW,
  K_MOUSE1,
  K_MOUSE2,
  K_MOUSE3,
  K_MWHEELDOWN,
  K_MWHEELUP,
  K_PAUSE,
  K_PGDN,
  K_PGUP,
  K_RIGHTARROW,
  K_SHIFT,
  K_TAB,
  K_UPARROW,
} from "../client/keys";

//=============================================================================
// SDL constants (SDL_video.h, SDL_render.h, SDL_events.h, SDL_audio.h,
// SDL_keycode.h, SDL_mouse.h, SDL_pixels.h)

const SDL_INIT_AUDIO = 0x00000010;
const SDL_INIT_VIDEO = 0x00000020;
const SDL_INIT_NOPARACHUTE = 0x00100000;

const SDL_WINDOWPOS_CENTERED = 0x2fff0000;
const SDL_WINDOW_SHOWN = 0x00000004;
// FULLSCREEN | 0x1000: borderless "desktop" fullscreen. The plain
// FULLSCREEN flag asks for a video-mode change, which Wayland cannot do --
// SDL's wayland backend then leaves the surface in a state some compositors
// eventually flag "not responding". Desktop fullscreen composites at the
// native resolution; SDLVID_Present's explicit dstrect (VID_CalcBlitRect) is
// what fits the mode's own resolution into it when they differ.
const SDL_WINDOW_FULLSCREEN_DESKTOP = 0x00001001;
// window usable with an OpenGL context -- glimp.ts's SDLGL_CreateWindow
const SDL_WINDOW_OPENGL = 0x00000002;

// SDL_GLattr (SDL_video.h): enum order matters, these are index values, not bitflags.
const SDL_GL_DOUBLEBUFFER = 5;
const SDL_GL_DEPTH_SIZE = 6;

const SDL_RENDERER_SOFTWARE = 0x00000001;
const SDL_RENDERER_ACCELERATED = 0x00000002;

// packed ABGR8888: on a little-endian host the bytes in memory are R,G,B,A,
// which is exactly the byte order VID_SetPalette's d_8to24table already
// packs (see vid.ts): `v = (255<<24) + (r<<0) + (g<<8) + (b<<16)`.
const SDL_PIXELFORMAT_ABGR8888 = 376840196;
const SDL_TEXTUREACCESS_STREAMING = 1;

const SDL_QUIT = 0x100;
const SDL_WINDOWEVENT = 0x200;
const SDL_KEYDOWN = 0x300;
const SDL_KEYUP = 0x301;
const SDL_MOUSEMOTION = 0x400;
const SDL_MOUSEBUTTONDOWN = 0x401;
const SDL_MOUSEBUTTONUP = 0x402;
const SDL_MOUSEWHEEL = 0x403;

const SDL_WINDOWEVENT_FOCUS_GAINED = 12;
const SDL_WINDOWEVENT_FOCUS_LOST = 13;
const SDL_WINDOWEVENT_CLOSE = 14;

const SDL_BUTTON_LEFT = 1;
const SDL_BUTTON_MIDDLE = 2;
const SDL_BUTTON_RIGHT = 3;

const AUDIO_S16LSB = 0x8010;

// SDL_Event is a 56-byte union; every member starts with `Uint32 type`.
const SDL_EVENT_SIZE = 56;
// SDL_KeyboardEvent: type 0, state 12, repeat 13, keysym 16 (scancode 16,
// sym 20).
const KEYEVENT_STATE = 12;
const KEYEVENT_REPEAT = 13;
const KEYEVENT_SYM = 20;
// SDL_MouseButtonEvent: button 16, state 17.
const BUTTONEVENT_BUTTON = 16;
// SDL_MouseWheelEvent: x 16, y 20.
const WHEELEVENT_Y = 20;
// SDL_WindowEvent: event 12.
const WINDOWEVENT_EVENT = 12;

// SDL_AudioSpec: freq 0, format 4, channels 6, silence 7, samples 8,
// padding 10, size 12, callback 16, userdata 24 (32 bytes total).
const AUDIOSPEC_SIZE = 32;
const AUDIOSPEC_FREQ = 0;
const AUDIOSPEC_FORMAT = 4;
const AUDIOSPEC_CHANNELS = 6;
const AUDIOSPEC_SAMPLES = 8;

//=============================================================================
// library binding

const symbols = {
  SDL_Init: { args: ["u32"], returns: "i32" },
  SDL_setenv: { args: ["cstring", "cstring", "i32"], returns: "i32" },
  SDL_InitSubSystem: { args: ["u32"], returns: "i32" },
  SDL_QuitSubSystem: { args: ["u32"], returns: "void" },
  SDL_Quit: { args: [], returns: "void" },
  SDL_GetError: { args: [], returns: "cstring" },

  SDL_CreateWindow: { args: ["cstring", "i32", "i32", "i32", "i32", "u32"], returns: "ptr" },
  SDL_DestroyWindow: { args: ["ptr"], returns: "void" },
  SDL_SetWindowTitle: { args: ["ptr", "cstring"], returns: "void" },
  SDL_GetWindowSize: { args: ["ptr", "ptr", "ptr"], returns: "void" },

  SDL_CreateRenderer: { args: ["ptr", "i32", "u32"], returns: "ptr" },
  SDL_DestroyRenderer: { args: ["ptr"], returns: "void" },
  SDL_RenderClear: { args: ["ptr"], returns: "i32" },
  SDL_RenderCopy: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  SDL_RenderPresent: { args: ["ptr"], returns: "void" },

  SDL_CreateTexture: { args: ["ptr", "u32", "i32", "i32", "i32"], returns: "ptr" },
  SDL_DestroyTexture: { args: ["ptr"], returns: "void" },
  SDL_UpdateTexture: { args: ["ptr", "ptr", "ptr", "i32"], returns: "i32" },

  SDL_GL_SetAttribute: { args: ["i32", "i32"], returns: "i32" },
  SDL_GL_CreateContext: { args: ["ptr"], returns: "ptr" },
  SDL_GL_DeleteContext: { args: ["ptr"], returns: "void" },
  SDL_GL_SwapWindow: { args: ["ptr"], returns: "void" },
  SDL_GL_GetProcAddress: { args: ["cstring"], returns: "ptr" },
  SDL_GL_SetSwapInterval: { args: ["i32"], returns: "i32" },

  SDL_PollEvent: { args: ["ptr"], returns: "i32" },
  SDL_PumpEvents: { args: [], returns: "void" },

  SDL_GetRelativeMouseState: { args: ["ptr", "ptr"], returns: "u32" },
  SDL_SetRelativeMouseMode: { args: ["i32"], returns: "i32" },
  SDL_ShowCursor: { args: ["i32"], returns: "i32" },

  SDL_OpenAudioDevice: { args: ["cstring", "i32", "ptr", "ptr", "i32"], returns: "u32" },
  SDL_CloseAudioDevice: { args: ["u32"], returns: "void" },
  SDL_PauseAudioDevice: { args: ["u32", "i32"], returns: "void" },
  SDL_QueueAudio: { args: ["u32", "ptr", "u32"], returns: "i32" },
  SDL_GetQueuedAudioSize: { args: ["u32"], returns: "u32" },
  SDL_ClearQueuedAudio: { args: ["u32"], returns: "void" },
} as const;

type SdlLib = ReturnType<typeof dlopen<typeof symbols>>;

function libraryName(): string {
  switch (process.platform) {
    case "win32":
      return "SDL2.dll";
    case "darwin":
      return "libSDL2.dylib";
    default:
      return "libSDL2-2.0.so.0";
  }
}

let enabled = false;
let library: SdlLib | null = null;
let libraryFailed = false;

export function SDL_SetBackendEnabled(value: boolean): void {
  enabled = value;
}

export function SDL_BackendEnabled(): boolean {
  return enabled;
}

// The only dlopen in the port. Returns null (once, then remembers) when the
// backend is disabled or the system library is missing, so every caller can
// fall back to the headless path instead of dying.
function lib(): SdlLib | null {
  if (!enabled || libraryFailed) return null;
  if (library) return library;
  try {
    library = dlopen(libraryName(), symbols);
    // JS-side env writes (Bun.env/process.env) do not reliably reach the C
    // runtime's getenv(), which is how SDL selects its drivers. Propagate
    // the two driver-selection variables through SDL's own setenv so a test
    // harness setting SDL_VIDEODRIVER=dummy is honored -- without this, test
    // runs open real windows on the host desktop.
    for (const name of ["SDL_VIDEODRIVER", "SDL_AUDIODRIVER"]) {
      const v = process.env[name];
      if (v !== undefined) {
        library.symbols.SDL_setenv(Buffer.from(`${name}\0`), Buffer.from(`${v}\0`), 1);
      }
    }
  } catch (err) {
    libraryFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    Con_Printf("SDL: could not load %s: %s\n", libraryName(), msg);
    return null;
  }
  return library;
}

function sdlError(l: SdlLib): string {
  return l.symbols.SDL_GetError() ?? "";
}

let subsystems = 0;

function initSubsystem(l: SdlLib, flag: number): boolean {
  if (subsystems === 0) {
    // SDL_INIT_NOPARACHUTE: leave signal handling to the host process, the
    // same choice vid_x.c makes when it installs its own SIGINT/SIGTERM
    // handler (TragicDeath) rather than letting SDL install one.
    if (l.symbols.SDL_Init(SDL_INIT_NOPARACHUTE) < 0) {
      Con_Printf("SDL: SDL_Init failed: %s\n", sdlError(l));
      return false;
    }
  }
  if ((subsystems & flag) === 0) {
    if (l.symbols.SDL_InitSubSystem(flag) < 0) {
      Con_Printf("SDL: SDL_InitSubSystem(0x%x) failed: %s\n", flag, sdlError(l));
      return false;
    }
    subsystems |= flag;
  }
  return true;
}

function quitSubsystem(l: SdlLib, flag: number): void {
  if ((subsystems & flag) === 0) return;
  l.symbols.SDL_QuitSubSystem(flag);
  subsystems &= ~flag;
  if (subsystems === 0) l.symbols.SDL_Quit();
}

// C strings for the FFI: bun's "cstring" argument accepts a NUL-terminated
// byte array.
function cstr(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

//=============================================================================
// VIDEO -- vid_x.c's XCreateWindow/XImage surface: a window, a renderer, and
// one streaming texture the 8-bit software framebuffer is expanded into.
// (folds in what quake-2-ts calls swimp.ts: this unit's brief says fold it
// into vid.ts/here rather than keep a third file for a one-call surface.)

let window: Pointer | bigint | null = null;
let renderer: Pointer | bigint | null = null;
let texture: Pointer | bigint | null = null;
let texWidth = 0;
let texHeight = 0;
// the window's/display's real client-area size: equal to texWidth/texHeight
// unless SDL_WINDOW_FULLSCREEN_DESKTOP resized the window out from under a
// smaller requested mode (see SDLVID_Init's comment on why this is queried
// back rather than trusted).
let dispWidth = 0;
let dispHeight = 0;
let rgba = new Uint8Array(0);
let framesPresented = 0;
const dstRectBuf = new Int32Array(4); // reused SDL_Rect (x,y,w,h) for SDL_RenderCopy's dstrect

const winWidthBuf = new Int32Array(1);
const winHeightBuf = new Int32Array(1);

function querySDLWindowSize(win: Pointer | bigint): { width: number; height: number } {
  const l = lib();
  if (!l) return { width: 0, height: 0 };
  l.symbols.SDL_GetWindowSize(win, winWidthBuf, winHeightBuf);
  return { width: winWidthBuf[0], height: winHeightBuf[0] };
}

// glimp.ts needs the real post-creation fullscreen window size for its own
// GL viewport sizing -- see querySDLWindowSize's callers.
export function SDLGL_GetWindowSize(): { width: number; height: number } {
  if (!window) return { width: 0, height: 0 };
  return querySDLWindowSize(window);
}

export function SDLVID_Active(): boolean {
  return texture !== null;
}

// test seam: how many frames reached the window since the mode was set
export function SDLVID_FramesPresented(): number {
  return framesPresented;
}

/*
Expands one 8-bit paletted frame into RGBA8888 bytes. `palette` is the
256-entry padded xRGB table vid.ts's d_8to24table holds, viewed as bytes (4
per index: R,G,B,unused -- see vid.ts's VID_SetPalette). Alpha is forced
opaque. `rowbytes` may exceed `width` -- vid.rowbytes is the C surface
stride, not the visible width.
*/
export function SDLVID_ExpandFrame(buffer: Uint8Array, rowbytes: number, width: number, height: number, palette: Uint8Array, out: Uint8Array): void {
  for (let y = 0; y < height; y++) {
    let src = y * rowbytes;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = buffer[src++] * 4;
      out[dst++] = palette[idx + 0];
      out[dst++] = palette[idx + 1];
      out[dst++] = palette[idx + 2];
      out[dst++] = 255;
    }
  }
}

export function SDLVID_Init(width: number, height: number, fullscreen: boolean): boolean {
  const l = lib();
  if (!l) return false;
  if (!initSubsystem(l, SDL_INIT_VIDEO)) return false;

  SDLVID_Shutdown();

  const flags = SDL_WINDOW_SHOWN | (fullscreen ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
  window = l.symbols.SDL_CreateWindow(cstr("Quake"), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, width, height, flags);
  if (!window) {
    Con_Printf("SDL: SDL_CreateWindow failed: %s\n", sdlError(l));
    return false;
  }

  renderer = l.symbols.SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
  if (!renderer) renderer = l.symbols.SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!renderer) {
    Con_Printf("SDL: SDL_CreateRenderer failed: %s\n", sdlError(l));
    SDLVID_Shutdown();
    return false;
  }

  texture = l.symbols.SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ABGR8888, SDL_TEXTUREACCESS_STREAMING, width, height);
  if (!texture) {
    Con_Printf("SDL: SDL_CreateTexture failed: %s\n", sdlError(l));
    SDLVID_Shutdown();
    return false;
  }

  texWidth = width;
  texHeight = height;
  // SDL_WINDOW_FULLSCREEN_DESKTOP silently resizes the window to the
  // desktop's native resolution regardless of width/height -- query the real
  // post-creation size so SDLVID_Present's blit rect fills the whole surface
  // instead of a corner-anchored rect sized for the requested (smaller)
  // mode. Falls back to the requested size if the query comes back 0x0
  // (e.g. the "dummy" video driver under the test harness).
  if (fullscreen) {
    const actual = querySDLWindowSize(window);
    dispWidth = actual.width > 0 ? actual.width : width;
    dispHeight = actual.height > 0 ? actual.height : height;
  } else {
    dispWidth = width;
    dispHeight = height;
  }
  rgba = new Uint8Array(width * height * 4);
  framesPresented = 0;
  return true;
}

export function SDLVID_Shutdown(): void {
  const l = lib();
  if (!l) return;
  if (texture) {
    l.symbols.SDL_DestroyTexture(texture);
    texture = null;
  }
  if (renderer) {
    l.symbols.SDL_DestroyRenderer(renderer);
    renderer = null;
  }
  if (window) {
    l.symbols.SDL_DestroyWindow(window);
    window = null;
  }
  texWidth = 0;
  texHeight = 0;
  dispWidth = 0;
  dispHeight = 0;
  rgba = new Uint8Array(0);
  IN_DeactivateMouse();
  // deliberately NOT quitSubsystem(SDL_INIT_VIDEO): the subsystem stays
  // armed for the life of the process. Tearing it down here would clear the
  // VIDEO bit on every vid_ref/mode change (SDLVID_Init calls this before
  // re-arming), which permanently disables the event pump -- dead
  // keyboard/mouse. Final teardown is process exit.
}

export function SDLVID_Present(buffer: Uint8Array, rowbytes: number, width: number, height: number, palette: Uint8Array): void {
  const l = lib();
  if (!l || !texture || !renderer) return;
  if (width !== texWidth || height !== texHeight) {
    Con_DPrintf("SDLVID_Present: %ix%i frame vs %ix%i texture -- dropped\n", width, height, texWidth, texHeight);
    return;
  }

  SDLVID_ExpandFrame(buffer, rowbytes, width, height, palette, rgba);

  l.symbols.SDL_UpdateTexture(texture, null, rgba, width * 4);
  l.symbols.SDL_RenderClear(renderer); // paints the letterbox bars when dispW/H != texW/H

  const rect = VID_CalcBlitRect(texWidth, texHeight, dispWidth, dispHeight, true);
  dstRectBuf[0] = rect.x;
  dstRectBuf[1] = rect.y;
  dstRectBuf[2] = rect.w;
  dstRectBuf[3] = rect.h;
  l.symbols.SDL_RenderCopy(renderer, texture, null, dstRectBuf);

  l.symbols.SDL_RenderPresent(renderer);
  framesPresented++;
}

export function SDLVID_SetWindowTitle(title: string): void {
  const l = lib();
  if (!l || !window) return;
  l.symbols.SDL_SetWindowTitle(window, cstr(title));
}

//=============================================================================
// GL -- gl_vidlinuxglx.c's glXChooseVisual/glXCreateContext surface: an
// SDL_GLContext bound to the same module-level `window` handle the software
// path's SDLVID_Init uses (this port runs one refresh at a time, never
// software and GL together, so sharing that one handle is safe). glimp.ts is
// this section's only caller.

let glContext: Pointer | bigint | null = null;

export function SDLGL_CreateWindow(width: number, height: number, fullscreen: boolean): boolean {
  const l = lib();
  if (!l) return false;
  if (!initSubsystem(l, SDL_INIT_VIDEO)) return false;

  if (glContext) {
    l.symbols.SDL_GL_DeleteContext(glContext);
    glContext = null;
  }
  SDLVID_Shutdown(); // destroy any previous window (software or GL) first

  l.symbols.SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  l.symbols.SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);

  const flags = SDL_WINDOW_OPENGL | SDL_WINDOW_SHOWN | (fullscreen ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
  window = l.symbols.SDL_CreateWindow(cstr("Quake"), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, width, height, flags);
  if (!window) {
    Con_Printf("SDL: SDL_CreateWindow failed: %s\n", sdlError(l));
    return false;
  }
  return true;
}

export function SDLGL_CreateContext(): boolean {
  const l = lib();
  if (!l || !window) return false;

  glContext = l.symbols.SDL_GL_CreateContext(window);
  if (!glContext) {
    Con_Printf("SDL: SDL_GL_CreateContext failed: %s\n", sdlError(l));
    return false;
  }
  return true;
}

export function SDLGL_SwapWindow(): void {
  const l = lib();
  if (!l || !window) return;
  l.symbols.SDL_GL_SwapWindow(window);
}

export function SDLGL_SetSwapInterval(interval: number): void {
  const l = lib();
  if (!l) return;
  l.symbols.SDL_GL_SetSwapInterval(interval);
}

// gl_vidlinuxglx.c resolves its GL entry points through glXGetProcAddress
// once a context is current; SDL_GL_GetProcAddress is this port's portable
// equivalent (the ref_gl unit's qgl.ts is the only caller).
export function SDLGL_GetProcAddress(name: string): Pointer | bigint | null {
  const l = lib();
  if (!l) return null;
  return l.symbols.SDL_GL_GetProcAddress(cstr(name));
}

export function SDLGL_Shutdown(): void {
  const l = lib();
  if (l && glContext) {
    l.symbols.SDL_GL_DeleteContext(glContext);
    glContext = null;
  }
  SDLVID_Shutdown();
}

//=============================================================================
// INPUT -- vid_x.c's GetEvent (keyboard/mouse to Key_Event) plus its
// IN_Init/IN_Shutdown/IN_Commands/IN_Move/IN_ClearStates. Installs itself as
// `inputBackend.current` at module load (below) and wires
// hostClientHooks.inInit/inShutdown/inCommands, since this is the module
// PORTING.md assigns every in_*.c backend to.

// SDLK_* -> the K_* numbers keys.h expects. Printable ASCII (space through
// '~') passes through unmapped, exactly as vid_x.c's XLateKey does after its
// switch -- keys.c's console reads those key numbers as characters. Quake 1
// has no keypad key constants at all (grepped keys.h: no K_KP_*), unlike
// quake-2-ts's template, so no SDLK_KP_* entries are mapped here; a numpad
// key falls through to "not printable ASCII" and is dropped, same as an
// unmapped function key.
const keymap = new Map<number, number>([
  [9, K_TAB], // SDLK_TAB
  [13, K_ENTER], // SDLK_RETURN
  [27, K_ESCAPE],
  [8, K_BACKSPACE], // SDLK_BACKSPACE -> 127
  [127, K_DEL], // SDLK_DELETE -> 148
  [1073741906, K_UPARROW],
  [1073741905, K_DOWNARROW],
  [1073741904, K_LEFTARROW],
  [1073741903, K_RIGHTARROW],
  [1073742050, K_ALT], // SDLK_LALT
  [1073742054, K_ALT], // SDLK_RALT
  [1073742048, K_CTRL], // SDLK_LCTRL
  [1073742052, K_CTRL], // SDLK_RCTRL
  [1073742049, K_SHIFT], // SDLK_LSHIFT
  [1073742053, K_SHIFT], // SDLK_RSHIFT
  [1073741882, K_F1],
  [1073741883, K_F2],
  [1073741884, K_F3],
  [1073741885, K_F4],
  [1073741886, K_F5],
  [1073741887, K_F6],
  [1073741888, K_F7],
  [1073741889, K_F8],
  [1073741890, K_F9],
  [1073741891, K_F10],
  [1073741892, K_F11],
  [1073741893, K_F12],
  [1073741897, K_INS],
  [1073741902, K_PGDN],
  [1073741899, K_PGUP],
  [1073741898, K_HOME],
  [1073741901, K_END],
  [1073741896, K_PAUSE],
]);

export function SDL_KeyToQuake(sym: number): number {
  const mapped = keymap.get(sym);
  if (mapped !== undefined) return mapped;
  if (sym >= 32 && sym <= 126) return sym; // "normal keys should be passed as lowercased ascii" -- keys.h
  return 0;
}

const eventBuf = new Uint8Array(SDL_EVENT_SIZE);
const eventView = new DataView(eventBuf.buffer);
const relX = new Int32Array(1);
const relY = new Int32Array(1);

let mouse_avail = false;
let mouse_active = false;
let mouse_x = 0;
let mouse_y = 0;
let old_mouse_x = 0;
let old_mouse_y = 0;
let windowActive = true;

// vid_x.c's own cvars (IN_Init: `Cvar_RegisterVariable (&_windowed_mouse);
// Cvar_RegisterVariable (&m_filter);`), not quake-2-ts's -- _windowed_mouse
// gates whether the mouse is captured while windowed (its whole point under
// X11's manual warp-to-center scheme); SDL's SDL_SetRelativeMouseMode is the
// portable stand-in for that warp-to-center + delta-from-center dance, so
// this cvar now gates SDL_SetRelativeMouseMode instead of an XGrabPointer
// call, and only while not fullscreen (fullscreen always captures: there is
// nowhere else for the pointer to usefully go).
export const _windowed_mouse = new CvarT("_windowed_mouse", "0", true);
export const m_filter = new CvarT("m_filter", "0", true);

function IN_ActivateMouse(): void {
  const l = lib();
  if (!l || !mouse_avail || mouse_active) return;
  l.symbols.SDL_SetRelativeMouseMode(1);
  // drain whatever relative motion piled up while the mouse was released
  l.symbols.SDL_GetRelativeMouseState(relX, relY);
  mouse_x = 0;
  mouse_y = 0;
  mouse_active = true;
}

function IN_DeactivateMouse(): void {
  const l = lib();
  if (!l || !mouse_active) return;
  l.symbols.SDL_SetRelativeMouseMode(0);
  mouse_active = false;
}

function wantMouseCapture(fullscreen: boolean): boolean {
  if (!windowActive) return false;
  if (fullscreen) return true; // see _windowed_mouse's header comment
  return !!_windowed_mouse.value;
}

// this port's own module-scope fullscreen flag, set by vid.ts on every mode
// change (there is no `vid.fullscreen` field on viddef_t to read it back
// from -- see vid.ts's own header on the added vid_fullscreen cvar).
let currentlyFullscreen = false;
export function SDL_SetFullscreenHint(fullscreen: boolean): void {
  currentlyFullscreen = fullscreen;
}

/*
IN_Init -- vid_x.c:1132. `-nomouse` disables the mouse outright, same as the
C (IN_Init still registers the two cvars either way, matching the C's own
order: the Cvar_RegisterVariable calls precede the -nomouse check).
*/
export function IN_Init(): void {
  Cvar_RegisterVariable(_windowed_mouse);
  Cvar_RegisterVariable(m_filter);

  setKeyEventPump(SDL_PumpInput);

  mouse_x = 0;
  mouse_y = 0;
  old_mouse_x = 0;
  old_mouse_y = 0;

  const l = lib();
  mouse_avail = l !== null && initSubsystem(l, SDL_INIT_VIDEO);
}

export function IN_Shutdown(): void {
  IN_DeactivateMouse();
  mouse_avail = false;
  setKeyEventPump(null);
}

/*
IN_Commands -- vid_x.c's own IN_Commands polls mouse_buttonstate once a
frame and diffs it against mouse_oldbuttonstate to synthesize Key_Event
calls; this backend delivers mouse buttons directly from SDL's own
button-down/button-up events instead (SDL_PumpInput below), so there is
nothing left to poll here. Repurposed as this port's per-frame mouse-capture
gate instead (vid_x.c has no such gate: X11's grab is driven entirely by the
_windowed_mouse cvar's edge in GetEvent; SDL's relative-mouse-mode needs an
explicit enable/disable call, which host.c's per-frame `IN_Commands` is the
only interface entry point left to make it from).
*/
export function IN_Commands(): void {
  if (!mouse_avail) return;
  if (wantMouseCapture(currentlyFullscreen)) IN_ActivateMouse();
  else IN_DeactivateMouse();
}

/*
IN_Move -- vid_x.c:1163, ported verbatim including the pitch clamp inside
this function (not just CL_AdjustAngles's own -70/80 clamp) and the
noclip_anglehack upmove branch.

QW/client/vid_x.c:1071 has the same function with a byte-identical body over
QW's own usercmd_t. The three fields either body writes are the three both
structs have, so one body serves both entry points (IN_Move / IN_MoveQw)
rather than being duplicated the way the two C trees duplicate it.
*/
interface InMoveCmd {
  forwardmove: number;
  sidemove: number;
  upmove: number;
}

export function IN_Move(cmd: UsercmdT): void {
  IN_Move_(cmd);
}

export function IN_MoveQw(cmd: QwUsercmdT): void {
  IN_Move_(cmd);
}

function IN_Move_(cmd: InMoveCmd): void {
  const l = lib();
  if (!l || !mouse_active) return;

  l.symbols.SDL_GetRelativeMouseState(relX, relY);
  mouse_x += relX[0];
  mouse_y += relY[0];

  if (m_filter.value) {
    mouse_x = (mouse_x + old_mouse_x) * 0.5;
    mouse_y = (mouse_y + old_mouse_y) * 0.5;
  }

  old_mouse_x = mouse_x;
  old_mouse_y = mouse_y;

  mouse_x *= sensitivity.value;
  mouse_y *= sensitivity.value;

  if (in_strafe.state & 1 || (lookstrafe.value && in_mlook.state & 1)) cmd.sidemove += m_side.value * mouse_x;
  else cl.viewangles[YAW] -= m_yaw.value * mouse_x;

  if (in_mlook.state & 1) V_StopPitchDrift();

  if (in_mlook.state & 1 && !(in_strafe.state & 1)) {
    cl.viewangles[PITCH] += m_pitch.value * mouse_y;
    if (cl.viewangles[PITCH] > 80) cl.viewangles[PITCH] = 80;
    if (cl.viewangles[PITCH] < -70) cl.viewangles[PITCH] = -70;
  } else {
    if (in_strafe.state & 1 && noclip_anglehack) cmd.upmove -= m_forward.value * mouse_y;
    else cmd.forwardmove -= m_forward.value * mouse_y;
  }

  mouse_x = 0;
  mouse_y = 0;
}

// in_win.c's IN_ModeChanged (input.ts's own header: called by the video
// backend after a mode/resize change). vid_x.c has no such call (X11's
// window is created once at whatever fixed size VID_Init picked); this
// port's vid_ref/vid_mode/vid_fullscreen switch calls it so a resize doesn't
// leave a stale relative-mouse-mode grab pointed at the old window.
export function IN_ModeChanged(): void {
  IN_DeactivateMouse();
}

// in_win.c:780's IN_ClearStates: drop whatever motion accumulated while the
// mouse was inactive.
export function IN_ClearStates(): void {
  if (mouse_active) {
    mouse_x = 0;
    mouse_y = 0;
  }
}

const inputBackendImpl: InputBackend = { IN_Init, IN_Shutdown, IN_Commands, IN_Move, IN_MoveQw, IN_ModeChanged, IN_ClearStates };
inputBackend.current = inputBackendImpl;
hostClientHooks.inInit = IN_Init;
hostClientHooks.inShutdown = IN_Shutdown;
hostClientHooks.inCommands = IN_Commands;

/*
SDL_PumpInput -- vid_x.c's Sys_SendKeyEvents/GetEvent: drain the OS event
queue, turning it into Key_Event calls. Registered as sys.ts's key-event-pump
hook by IN_Init above.

Key-repeat events (SDL's own OS-level auto-repeat) are dropped here rather
than forwarded: vid_x.c calls `XAutoRepeatOff(x_disp)` at VID_Init, so the
reference engine never sees repeated KeyPress events for a held key in the
first place -- keys.c's own key_repeats-based "ignore most autorepeats"
logic exists for other platforms (Win32) that don't disable OS repeat.
*/
export function SDL_PumpInput(): void {
  const l = lib();
  if (!l) return;
  if ((subsystems & SDL_INIT_VIDEO) === 0) return;

  while (l.symbols.SDL_PollEvent(eventBuf) !== 0) {
    const type = eventView.getUint32(0, true);
    switch (type) {
      case SDL_KEYDOWN:
      case SDL_KEYUP: {
        if (eventBuf[KEYEVENT_REPEAT] !== 0) break;
        const key = SDL_KeyToQuake(eventView.getInt32(KEYEVENT_SYM, true));
        if (key !== 0) Key_Event(key, eventBuf[KEYEVENT_STATE] !== 0);
        break;
      }
      case SDL_MOUSEBUTTONDOWN:
      case SDL_MOUSEBUTTONUP: {
        const down = type === SDL_MOUSEBUTTONDOWN;
        // vid_x.c's GetEvent: button 1 (left) -> K_MOUSE1, button 3 (right)
        // -> K_MOUSE2, button 2 (middle) -> K_MOUSE3 (its `b` local, then
        // `K_MOUSE1 + b`) -- the conventional Quake mouse-button numbering.
        switch (eventBuf[BUTTONEVENT_BUTTON]) {
          case SDL_BUTTON_LEFT:
            Key_Event(K_MOUSE1, down);
            break;
          case SDL_BUTTON_RIGHT:
            Key_Event(K_MOUSE2, down);
            break;
          case SDL_BUTTON_MIDDLE:
            Key_Event(K_MOUSE3, down);
            break;
          default:
            break;
        }
        break;
      }
      case SDL_MOUSEWHEEL: {
        // JACK: Intellimouse(c) Mouse Wheel Support (keys.h's own comment on
        // K_MWHEELUP/DOWN) -- the wheel has no up event of its own, so a
        // press+release pair is synthesized per notch.
        const y = eventView.getInt32(WHEELEVENT_Y, true);
        if (y > 0) {
          Key_Event(K_MWHEELUP, true);
          Key_Event(K_MWHEELUP, false);
        } else if (y < 0) {
          Key_Event(K_MWHEELDOWN, true);
          Key_Event(K_MWHEELDOWN, false);
        }
        break;
      }
      case SDL_WINDOWEVENT: {
        const ev = eventBuf[WINDOWEVENT_EVENT];
        if (ev === SDL_WINDOWEVENT_FOCUS_GAINED) SDL_AppActivate(true);
        else if (ev === SDL_WINDOWEVENT_FOCUS_LOST) SDL_AppActivate(false);
        else if (ev === SDL_WINDOWEVENT_CLOSE) Sys_Quit();
        break;
      }
      case SDL_QUIT:
        // vid_x.c has no window-close event at all (X11's WM_DELETE_WINDOW
        // handling is a whole separate Atom dance the reference engine never
        // installed); Sys_Quit is the nearest faithful reaction to "the user
        // asked the OS to close the game", matching sys_linux.c's own
        // Sys_Quit on SIGINT/SIGTERM (TragicDeath).
        Sys_Quit();
        break;
      default:
        break;
    }
  }
}

export function SDL_AppActivate(active: boolean): void {
  windowActive = active;
  if (!active) IN_DeactivateMouse();
}

export function SDL_WindowActive(): boolean {
  return windowActive;
}

//=============================================================================
// AUDIO -- snd_linux.c's /dev/dsp surface, replaced by SDL's push-mode
// queue. No callback is installed (SDL_AudioSpec.callback = NULL), so
// nothing here runs on SDL's audio thread and the mixer keeps its
// single-threaded C shape.

let audioDevice = 0;
let audioBytesQueued = 0;

function openAudioDevice(freq: number, channels: number, samplebits: number): { freq: number; channels: number; device: number } | null {
  const l = lib();
  if (!l) return null;
  if (samplebits !== 16 && samplebits !== 8) return null;
  if (!initSubsystem(l, SDL_INIT_AUDIO)) return null;

  const desired = new Uint8Array(AUDIOSPEC_SIZE);
  const obtained = new Uint8Array(AUDIOSPEC_SIZE);
  const dv = new DataView(desired.buffer);
  dv.setInt32(AUDIOSPEC_FREQ, freq, true);
  dv.setUint16(AUDIOSPEC_FORMAT, samplebits === 16 ? AUDIO_S16LSB : 0x0008 /* AUDIO_U8 */, true);
  desired[AUDIOSPEC_CHANNELS] = channels;
  dv.setUint16(AUDIOSPEC_SAMPLES, 512, true);

  // allowed_changes = 0: take the format asked for or nothing, so the DMA
  // ring layout the mixer writes stays valid.
  const dev = l.symbols.SDL_OpenAudioDevice(null, 0, desired, obtained, 0);
  if (dev === 0) {
    Con_Printf("SDL: SDL_OpenAudioDevice failed: %s\n", sdlError(l));
    return null;
  }

  l.symbols.SDL_PauseAudioDevice(dev, 0);
  const ov = new DataView(obtained.buffer);
  return { freq: ov.getInt32(AUDIOSPEC_FREQ, true), channels: obtained[AUDIOSPEC_CHANNELS], device: dev };
}

export function SDLSND_Open(freq: number, channels: number, samplebits: number): { freq: number; channels: number } | null {
  const opened = openAudioDevice(freq, channels, samplebits);
  if (!opened) return null;
  audioDevice = opened.device;
  audioBytesQueued = 0;
  return { freq: opened.freq, channels: opened.channels };
}

export function SDLSND_Active(): boolean {
  return audioDevice !== 0;
}

export function SDLSND_Close(): void {
  const l = lib();
  if (!l || audioDevice === 0) return;
  l.symbols.SDL_PauseAudioDevice(audioDevice, 1);
  l.symbols.SDL_ClearQueuedAudio(audioDevice);
  l.symbols.SDL_CloseAudioDevice(audioDevice);
  audioDevice = 0;
  audioBytesQueued = 0;
  quitSubsystem(l, SDL_INIT_AUDIO);
}

export function SDLSND_Queue(bytes: Uint8Array): void {
  const l = lib();
  if (!l || audioDevice === 0 || bytes.length === 0) return;
  if (l.symbols.SDL_QueueAudio(audioDevice, bytes, bytes.length) === 0) audioBytesQueued += bytes.length;
}

// bytes the device has actually consumed, which is what stands in for
// snd_linux.c's SNDCTL_DSP_GETOPTR play-cursor ioctl.
export function SDLSND_ConsumedBytes(): number {
  const l = lib();
  if (!l || audioDevice === 0) return 0;
  return audioBytesQueued - l.symbols.SDL_GetQueuedAudioSize(audioDevice);
}

export function SDLSND_QueuedBytes(): number {
  const l = lib();
  if (!l || audioDevice === 0) return 0;
  return l.symbols.SDL_GetQueuedAudioSize(audioDevice);
}

//=============================================================================
// A SECOND audio device, for cd_ogg.ts's Ogg-Vorbis music -- see this file's
// header comment on why CD music does not share the sound-effects ring.

let cdAudioDevice = 0;
let cdAudioBytesQueued = 0;

export function SDLCD_Open(freq: number, channels: number): { freq: number; channels: number } | null {
  const opened = openAudioDevice(freq, channels, 16);
  if (!opened) return null;
  cdAudioDevice = opened.device;
  cdAudioBytesQueued = 0;
  return { freq: opened.freq, channels: opened.channels };
}

export function SDLCD_Active(): boolean {
  return cdAudioDevice !== 0;
}

export function SDLCD_Close(): void {
  const l = lib();
  if (!l || cdAudioDevice === 0) return;
  l.symbols.SDL_PauseAudioDevice(cdAudioDevice, 1);
  l.symbols.SDL_ClearQueuedAudio(cdAudioDevice);
  l.symbols.SDL_CloseAudioDevice(cdAudioDevice);
  cdAudioDevice = 0;
  cdAudioBytesQueued = 0;
  quitSubsystem(l, SDL_INIT_AUDIO);
}

export function SDLCD_Queue(bytes: Uint8Array): void {
  const l = lib();
  if (!l || cdAudioDevice === 0 || bytes.length === 0) return;
  if (l.symbols.SDL_QueueAudio(cdAudioDevice, bytes, bytes.length) === 0) cdAudioBytesQueued += bytes.length;
}

export function SDLCD_QueuedBytes(): number {
  const l = lib();
  if (!l || cdAudioDevice === 0) return 0;
  return l.symbols.SDL_GetQueuedAudioSize(cdAudioDevice);
}

// test seam: forget the loaded library and every device handle, so a suite
// can bring the backend up and down inside one process.
export function SDL_ResetBackendForTests(): void {
  SDLSND_Close();
  SDLCD_Close();
  SDLGL_Shutdown();
  SDLVID_Shutdown();
  const l = library;
  if (l && subsystems !== 0) {
    l.symbols.SDL_Quit();
    subsystems = 0;
  }
  enabled = false;
  libraryFailed = false;
  mouse_avail = false;
  mouse_active = false;
  windowActive = true;
  currentlyFullscreen = false;
}
