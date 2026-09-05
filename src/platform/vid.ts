/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/vid_x.c and WinQuake/gl_vidlinuxglx.c (GNU GPL v2 or
later): VID_Init/VID_Shutdown/VID_Update/VID_SetPalette/VID_ShiftPalette/
VID_SetMode/D_BeginDirectRect/D_EndDirectRect -- the `VidBackend`
implementation src/client/vid.ts declares -- plus the one thing neither C
file has at all: a runtime switch between the software and OpenGL
refreshes (`vid_ref`, PORTING.md's "Runtime and build" section, the one
added cvar) and the mode table/fullscreen-fit machinery that switch needs.
Adapted from ../quake-2-ts/src/platform/vid.ts's VID_CheckChanges/
VID_LoadRefresh shape, re-pointed at this engine's `Renderer`/`ModelLoaderHooks`
seam instead of a dlopen'd refresh DLL (both refreshes are statically linked
here, same as quake-2-ts's).

Folds in what quake-2-ts calls swimp.ts (the 8-bit-buffer-to-SDL-texture
surface): this unit's brief says fold it into vid.ts or say so -- SWimp_* in
quake-2-ts is a five-function file (Init/SetMode/SetPalette/Shutdown/
BeginFrame/EndFrame) that exists only because that port's refresh loads
through a `refimport_t`/`refexport_t` boundary neither renderer here needs;
VID_Init/VID_Update/VID_SetPalette below do that surface's whole job.

THE REGISTRY (what ref_soft/U060 and ref_gl/U071 must call):

  import { registerRenderer } from "../platform/vid";
  registerRenderer("soft", () => mySoftRenderer as Renderer);   // ref_soft
  registerRenderer("gl", () => myGlRenderer as Renderer);       // ref_gl, reads glimp.ts's glimpHolder.current for its GL context

Neither renderer is landed yet, so the registry starts empty: `vid_ref soft`
(the default) with nothing registered fails VID_CheckChanges with
`Sys_Error("vid_ref %s not available (registered: %s)", ...)`, listing
whatever IS registered (nothing, in a build with neither renderer linked).
Every test in this unit registers a fake renderer under "soft" to exercise
the switch without a real one; `Sys_Error` throws `SysError`, so a test can
assert it rather than crash the process.

WHY THERE IS NO Renderer.Shutdown (a documented gap, not an oversight):
render.ts's `Renderer` interface has no teardown method -- Quake 1 never
switches refreshes at runtime in the original engine (GLQUAKE is a
compile-time #define), so no C file ever needed one. A live vid_ref switch
here therefore cannot ask the outgoing renderer to free anything; it only
(a) tears down this file's own platform resources (the SDL window/texture,
or glimp.ts's GL context) and (b) drops the `re.current`/model-hook
references. Any Hunk memory the outgoing renderer allocated (surface cache,
GL texture handles the driver itself must still free through the OS/driver
process teardown) is simply abandoned -- which is exactly what already
happens to every OTHER Hunk allocation in this port between one
Host_ClearMemory and the next (PORTING.md's zone.c ruling: `Hunk_Alloc*`
never frees piecemeal). A vid_ref switch is therefore no less "leaky" than a
level change already is; it is a documented follow-up for whichever unit
lands second (ref_soft or ref_gl) to note anything genuinely OS-owned (e.g.
a GL texture name) that would want an explicit free on the way out.

Deviations from PORTING.md / the C source:
- The mode table (`VID_MODES`) has no vid_x.c/gl_vidlinuxglx.c equivalent at
  all (X11's window is created once at a fixed size; gl_vidlinuxglx.c reads
  a numeric width/height off `-width`/`-height` with no table). Per this
  unit's brief ("RULING: adopt q2ts's flat mode table ... exposed through
  vidMenuHooks"), `VID_MODES` is quake-2-ts's own 21-entry table verbatim
  (320x240 through 3840x2160); `vid_mode` (index into it) and
  `vid_fullscreen` are this port's own added cvars alongside `vid_ref` --
  three new cvars total, all necessary for `vid_ref` to have anything to
  select a resolution/window state from. vid_x.c's own `-width`/`-height`/
  `-winsize` command-line parms still override the table's pick for this
  session, exactly as vid_x.c: `if ((pnum=COM_CheckParm("-width"))) ...`.
  `-window` (gl_vidlinuxglx.c's parm; vid_x.c has none, being always
  windowed) forces windowed regardless of `vid_fullscreen`'s value.
  `-mode` does not exist in either C file and is not invented here.
- `vid.conwidth`/`vid.conheight`: vid_x.c's software path sets both equal to
  `vid.width`/`vid.height` (no `-conwidth`/`-conheight` parms in that file --
  those are gl_vidlinuxglx.c-only, and that file's own version additionally
  clamps to a multiple of 8 and a 320x200 floor for the GL console/HUD
  resolution). This port keeps vid_x.c's simpler always-equal assignment for
  both renderers; `-conwidth`/`-conheight` are not ported (documented gap,
  follow-up for whichever GL unit wants console/HUD decoupled from render
  resolution).
- `vid.fullbright = 256 - LittleLong(*((int*)vid.colormap + 2048))` (both C
  files, identical line): the colormap byte block is little-endian already
  (COM_LoadHunkFile has no endian-swap step of its own in this port), so
  this reads as a plain `DataView.getInt32(8192, true)` at the fixed byte
  offset `2048 * 4`.
- `d_8to24table`'s packing (gl_vidlinuxglx.c's VID_SetPalette: `v = (255<<24)
  + (r<<0) + (g<<8) + (b<<16)`) is R,G,B,A in increasing byte address on a
  little-endian host -- exactly `SDL_PIXELFORMAT_ABGR8888`'s memory layout
  (sdl.ts's texture format) and exactly the padded-xRGB shape
  `SDLVID_ExpandFrame` already expects, so `d_8to24table`'s own
  `ArrayBuffer` is reused as that palette directly (`new Uint8Array(
  d_8to24table.buffer)`) rather than building a second copy. Unlike
  gl_vidlinuxglx.c, index 255's alpha byte is NOT masked to 0 here: that
  mask exists only so a GL *texture* using palette index 255 as a chroma-key
  color reads as transparent, which is ref_gl's own texture-upload path
  (not landed), not this file's framebuffer-to-window blit, which always
  wants every index opaque.
- `st2d_8to16table`/`xlib_rgb16`/the X11 `XStoreColors`/8-bit `PseudoColor`
  path, and the `d_15to8table` nearest-color search gl_vidlinuxglx.c builds
  for 3dfx paletted-texture emulation, have no counterpart: this port's
  window is always presented through an RGBA streaming texture (sdl.ts),
  never an indexed X11 visual, so no 15/16-bit intermediate table is needed.
- `VID_SetMode(modenum, palette)`: render.h/vid.h declare it for "resetting
  to mode 0 ... on memory allocation failures", but grepping the whole
  WinQuake tree shows no caller outside vid_win.c/vid_dos.c/vid_svgalib.c
  themselves (DOS/Win32/SVGAlib's own low-memory recovery path) -- vid_x.c
  and gl_vidlinuxglx.c never define or call it, and no client/server file
  calls it either. Implemented here as a thin re-run of the mode-table
  lookup + platform re-init (so the interface member is not silently absent),
  but unreached in this port's call graph; documented rather than dropped,
  since VidBackend declares it.
- `VID_HandlePause`: "called only on Win32, when pause happens" (vid.h) --
  no-op, matching every non-Win32 backend.
- `VID_LockBuffer`/`VID_UnlockBuffer`: "real functions on Win32, empty macros
  everywhere else" (quakedef.h) -- no-ops.
- `D_BeginDirectRect`/`D_EndDirectRect`: vid_x.c's own bodies are empty
  ("direct drawing of the 'accessing disk' icon isn't supported under
  Linux") -- ported as the same no-ops, not invented.
- SDL is armed (`SDL_SetBackendEnabled(true)`) from inside this file's own
  `VID_Init`, not from src/main.ts (out of this unit's SCOPE): `VID_Init` is
  only ever reached through `hostClientHooks.vidInit`, which host.ts already
  calls only `if (!sysState.isDedicated)`, so a dedicated server never arms
  the backend regardless. Follow-up: main.ts could additionally arm it
  earlier for symmetry with quake-2-ts's own main.ts, but nothing in this
  port's call graph needs that today.
*/

import { d_8to24table, vid, vidBackend, type VidBackend, vidMenuHooks, VrectT } from "../client/vid";
import { Sys_Error } from "./sys";
import { qw } from "../common/quakedef";
import { S_Init } from "../client/snd_dma";
import { hostClientHooks, host_colormap } from "../common/host";
import { COM_CheckParm, Q_atoi, com_argc, com_argv } from "../common/common";
import { CvarT, Cvar_RegisterVariable, Cvar_Set } from "../common/cvar";
import { Cmd_AddCommand } from "../common/cmd";
import { Con_Printf } from "../client/console";
import { scrState } from "../client/screen_types";
import { re, type Renderer } from "../client/render";
import { setModelLoaderHooks } from "../common/model";
import { inputBackend } from "../client/input";
import { SDL_BackendEnabled, SDL_SetBackendEnabled, SDLVID_Init, SDLVID_Present, SDLVID_SetWindowTitle, SDLVID_Shutdown, SDL_SetFullscreenHint } from "./sdl";
import { CreateGLimp, glimpHolder } from "./glimp";
import { VID_MenuDraw, VID_MenuKey } from "./vid_menu";
// ref_soft's own r_main.ts (R_Init, registerRenderer, hostClientHooks.rInit)
// has not landed; this one import is a live exception to this unit's
// original "do not import from src/ref_soft" scoping, made explicit by
// .orch/followups.md's own directive to this unit ("allocate
// rState.d_pzbuffer ... and the surface-cache heap, call D_InitCaches(heap,
// size) as vid_x.c does"): d_local.ts's own header table says exactly this
// -- "D_InitCaches by src/platform/vid.ts" -- there is no other module that
// can hand the software rasterizer its z-buffer/surface-cache memory the
// way vid_x.c's ResetFrameBuffer does. r_shared.ts is a pure types/state
// leaf (no imports back into src/platform), so this creates no cycle.
import { rState } from "../ref_soft/r_shared";

// d_iface.h: `#define WARP_WIDTH 320` / `#define WARP_HEIGHT 200`. Neither
// ref_soft/ref_gl has landed to own d_iface.h's port yet; declared here
// since VID_Init is the one C function that assigns them.
const WARP_WIDTH = 320;
const WARP_HEIGHT = 200;

//=============================================================================
// the flat mode table -- see file header ("RULING: adopt q2ts's flat mode
// table"). Index order matches quake-2-ts's own table exactly.

class VidmodeT {
  constructor(
    public description: string,
    public width: number,
    public height: number,
  ) {}
}

export const VID_MODES: readonly VidmodeT[] = [
  new VidmodeT("Mode 0: 320x240", 320, 240),
  new VidmodeT("Mode 1: 400x300", 400, 300),
  new VidmodeT("Mode 2: 512x384", 512, 384),
  new VidmodeT("Mode 3: 640x480", 640, 480),
  new VidmodeT("Mode 4: 800x600", 800, 600),
  new VidmodeT("Mode 5: 960x720", 960, 720),
  new VidmodeT("Mode 6: 1024x768", 1024, 768),
  new VidmodeT("Mode 7: 1152x864", 1152, 864),
  new VidmodeT("Mode 8: 1280x720", 1280, 720),
  new VidmodeT("Mode 9: 1280x960", 1280, 960),
  new VidmodeT("Mode 10: 1366x768", 1366, 768),
  new VidmodeT("Mode 11: 1440x900", 1440, 900),
  new VidmodeT("Mode 12: 1600x900", 1600, 900),
  new VidmodeT("Mode 13: 1600x1200", 1600, 1200),
  new VidmodeT("Mode 14: 1920x1080", 1920, 1080),
  new VidmodeT("Mode 15: 1920x1200", 1920, 1200),
  new VidmodeT("Mode 16: 2048x1536", 2048, 1536),
  new VidmodeT("Mode 17: 2560x1080", 2560, 1080),
  new VidmodeT("Mode 18: 2560x1440", 2560, 1440),
  new VidmodeT("Mode 19: 3440x1440", 3440, 1440),
  new VidmodeT("Mode 20: 3840x2160", 3840, 2160),
];

export function VID_GetModeInfo(mode: number): { width: number; height: number } | null {
  if (mode < 0 || mode >= VID_MODES.length) return null;
  return { width: VID_MODES[mode].width, height: VID_MODES[mode].height };
}

// PORTING.md's "Runtime and build" cvar, plus the two this port needs to
// give it a resolution/window state to select (see file header).
export const vid_ref = new CvarT("vid_ref", "soft", true);
export const vid_mode = new CvarT("vid_mode", "3", true); // index 3 = 640x480
export const vid_fullscreen = new CvarT("vid_fullscreen", "0", true);

//=============================================================================
// the renderer registry

type RendererName = "soft" | "gl";

// keyed by plain string (not RendererName) so a lookup against the
// free-form vid_ref.string needs no `as` cast; registerRenderer/
// unregisterRenderer are the only writers and narrow their own `name`
// parameter to RendererName for every future caller (ref_soft/ref_gl).
const registry = new Map<string, () => Renderer>();

export function registerRenderer(name: RendererName, factory: () => Renderer): void {
  registry.set(name, factory);
}

// test seam: undo a test's own registerRenderer("soft", ...) call so later
// suites see the same empty registry this file starts with.
export function unregisterRenderer(name: RendererName): void {
  registry.delete(name);
}

// test seam: read back whatever is registered under `name` (real or a
// test's fake) before a test overwrites the entry, so it can restore the
// exact previous factory afterward instead of deleting a real registration
// a real renderer module (main.ts imports both) may have made earlier in
// this same process.
export function getRegisteredRenderer(name: RendererName): (() => Renderer) | null {
  return registry.get(name) ?? null;
}

let activeRendererKind: RendererName | null = null;

//=============================================================================
// VID_SetPalette / VID_ShiftPalette

export function VID_SetPalette(palette: Uint8Array): void {
  const table = d_8to24table;
  for (let i = 0; i < 256; i++) {
    const r = palette[i * 3 + 0];
    const g = palette[i * 3 + 1];
    const b = palette[i * 3 + 2];
    table[i] = (255 << 24) + (r << 0) + (g << 8) + (b << 16);
  }
}

export function VID_ShiftPalette(palette: Uint8Array): void {
  VID_SetPalette(palette);
}

//=============================================================================
// mode selection: the table lookup plus vid_x.c's -width/-height/-winsize
// command-line overrides and gl_vidlinuxglx.c's -window.

function resolveMode(): { width: number; height: number; fullscreen: boolean } {
  const info = VID_GetModeInfo(Math.trunc(vid_mode.value)) ?? { width: VID_MODES[3].width, height: VID_MODES[3].height };
  let width = info.width;
  let height = info.height;
  let fullscreen = vid_fullscreen.value !== 0;

  let pnum = COM_CheckParm("-winsize");
  if (pnum) {
    if (pnum >= com_argc - 2) Sys_Error("VID: -winsize <width> <height>\n");
    width = Q_atoi(com_argv[pnum + 1]);
    height = Q_atoi(com_argv[pnum + 2]);
    if (!width || !height) Sys_Error("VID: Bad window width/height\n");
  }
  pnum = COM_CheckParm("-width");
  if (pnum) {
    if (pnum >= com_argc - 1) Sys_Error("VID: -width <width>\n");
    width = Q_atoi(com_argv[pnum + 1]);
    if (!width) Sys_Error("VID: Bad window width\n");
  }
  pnum = COM_CheckParm("-height");
  if (pnum) {
    if (pnum >= com_argc - 1) Sys_Error("VID: -height <height>\n");
    height = Q_atoi(com_argv[pnum + 1]);
    if (!height) Sys_Error("VID: Bad window height\n");
  }
  if (COM_CheckParm("-window")) fullscreen = false;

  return { width, height, fullscreen };
}

//=============================================================================
// VID_Update -- the software framebuffer's own presentation path (the
// GL renderer, when it lands, presents through glimp.ts's EndFrame instead;
// see render.ts's header table on why VID_Update is a software-only call
// site: screen.c's SCR_UpdateScreen calls it, gl_screen.c calls
// GL_EndRendering).

export function VID_Update(rects: VrectT | null): void {
  void rects; // vid_x.c's own VID_Update also ignores the rect list under MITSHM and always blits the whole framebuffer
  if (!vid.buffer) return;
  const palette = new Uint8Array(d_8to24table.buffer);
  SDLVID_Present(vid.buffer, vid.rowbytes, vid.width, vid.height, palette);
}

//=============================================================================
// VID_CheckChanges -- this unit's own addition (see file header): apply the
// current vid_ref/vid_mode/vid_fullscreen cvars, switching renderers if
// vid_ref changed and/or the window if the mode/fullscreen state changed.
// Called once from VID_Init and again by `vid_restart`/the video menu's
// Apply action -- there is no per-frame poll of `vid_ref.modified` anywhere
// in this port yet (screen.ts/host.ts, both outside this unit's SCOPE, would
// need to add one); until one exists, a change only takes effect through
// one of those two explicit call sites, not merely by setting the cvar.

function teardownActiveRenderer(): void {
  // vid_x.c's ResetFrameBuffer: `if (d_pzbuffer) { D_FlushCaches();
  // Hunk_FreeToHighMark(...); d_pzbuffer = NULL; }` before allocating the
  // next mode's buffers.
  re.current?.D_FlushCaches();
  rState.d_pzbuffer = null;

  // render.ts's Renderer.Shutdown -- this port's own addition (see its
  // doc comment): lets the outgoing renderer release what it owns (the GL
  // renderer's qgl function table and masked palette byte) before this
  // function drops re.current and tears down the platform-level context.
  re.current?.Shutdown?.();

  if (activeRendererKind === "gl") {
    glimpHolder.current?.Shutdown();
    glimpHolder.current = null;
  } else if (activeRendererKind === "soft") {
    SDLVID_Shutdown();
  }
  activeRendererKind = null;
  re.current = null;
}

/*
`runRInit` defaults true (vid_restart, the video menu's Apply, and the
gl-fallback recursion below all want it) but is passed false from VID_Init:
host.ts's Host_Init calls `hostClientHooks.vidInit` and, several lines
later, `hostClientHooks.rInit` itself as two separate steps (matching
vid_x.c's VID_Init and r_main.c's R_Init being two separate C functions
Host_Init calls in sequence) -- if VID_Init's own call into this function
also triggered R_Init, the very first boot would run it twice.
*/
export function VID_CheckChanges(runRInit: boolean = true): void {
  // Both screen.c's (WinQuake screen.c:SCR_UpdateScreen, QW screen.c/
  // gl_screen.c likewise) return early while `scr_disabled_for_loading` is
  // set, which is how the C keeps a Con_Printf issued mid-mode-change from
  // recursing into a refresh that is not there. This function has exactly
  // that window: `teardownActiveRenderer()` below drops `re.current`, and
  // glimp.ts's GLimp_SetMode Con_Printf's the mode it is about to try before
  // it can know whether the attempt fails -- with the console initialized and
  // the client not signed on, console.ts's Con_Printf calls SCR_UpdateScreen,
  // whose getRenderer() would throw "No renderer is loaded". Set for the whole
  // switch and restored to whatever a real loading plaque had left it as.
  const savedScrDisabled = scrState.scr_disabled_for_loading;
  scrState.scr_disabled_for_loading = true;
  try {
    VID_CheckChanges_(runRInit);
  } finally {
    scrState.scr_disabled_for_loading = savedScrDisabled;
  }
}

function VID_CheckChanges_(runRInit: boolean): void {
  const name = vid_ref.string;
  const factory = registry.get(name);
  if (!factory) {
    const registered = Array.from(registry.keys()).join(", ") || "(none)";
    Sys_Error("vid_ref %s not available (registered: %s)", vid_ref.string, registered);
  }

  const { width, height, fullscreen } = resolveMode();

  teardownActiveRenderer();
  inputBackend.current?.IN_ModeChanged();

  vid.width = width;
  vid.height = height;
  vid.rowbytes = width;
  vid.buffer = new Uint8Array(width * height);
  vid.conwidth = width; // vid_x.c: `vid.conwidth = vid.width; vid.conheight = vid.height;`
  vid.conheight = height;

  if (name === "gl") {
    SDL_SetFullscreenHint(fullscreen);
    const glimp = CreateGLimp();
    if (!glimp.Init() || !glimp.SetMode(width, height, fullscreen)) {
      glimp.Shutdown();
      if (vid_ref.string === "soft") Sys_Error("Couldn't fall back to software refresh!");
      Con_Printf("vid_ref gl: mode set failed, falling back to soft\n");
      // quake-2-ts's VID_CheckChanges does the same thing on a failed
      // refresh load: print, put the cvar back to "soft", keep running.
      // Cvar_Set is a no-op with a "variable not found" print if vid_ref has
      // not been linked into cvar_vars yet -- VID_Init always registers it
      // before any switch can happen in normal use, but the direct field
      // write covers that case anyway, so a silent no-op can never turn this
      // into an infinite VID_CheckChanges recursion.
      Cvar_Set("vid_ref", "soft");
      if (vid_ref.string !== "soft") {
        vid_ref.string = "soft";
        vid_ref.value = 0;
      }
      VID_CheckChanges_(runRInit);
      return;
    }
    glimpHolder.current = glimp;
    activeRendererKind = "gl";
  } else {
    SDL_SetFullscreenHint(fullscreen);
    if (!SDLVID_Init(width, height, fullscreen) && SDL_BackendEnabled()) {
      if (vid_ref.string === "soft") Sys_Error("Couldn't fall back to software refresh!");
      Con_Printf("vid_ref soft: window/texture creation failed, falling back to soft\n");
    }
    activeRendererKind = "soft";
  }

  re.current = factory();
  setModelLoaderHooks(re.current.modelHooks);

  // vid_x.c's ResetFrameBuffer/ResetSharedFrameBuffers: the z-buffer and
  // surface-cache heap are sized off the mode's resolution and handed to
  // the rasterizer through D_InitCaches, which vid_x.c calls directly (not
  // through R_Init) -- see the file header and this file's rState import
  // comment. gl_vidlinuxglx.c's own VID_Init has no equivalent call at all
  // (GL uses hardware depth buffering, no software z-buffer/surface cache),
  // so this is software-only, unlike the buffer/window setup above it.
  if (name !== "gl") {
    rState.d_pzbuffer = new Int16Array(width * height);
    const cacheSize = re.current.D_SurfaceCacheForRes(width, height);
    re.current.D_InitCaches(new Uint8Array(cacheSize), cacheSize);
  }

  if (runRInit) hostClientHooks.rInit?.();
}

export function VID_Restart_f(): void {
  VID_CheckChanges();
}

//=============================================================================
// VidBackend

export function VID_Init(palette: Uint8Array): void {
  SDL_SetBackendEnabled(true);

  Cvar_RegisterVariable(vid_ref);
  Cvar_RegisterVariable(vid_mode);
  Cvar_RegisterVariable(vid_fullscreen);
  Cmd_AddCommand("vid_restart", VID_Restart_f);

  // `+vid_ref gl` on the command line cannot pick the renderer: the "+"
  // arguments only run once something executes `stuffcmds`, which quake.rc
  // does long after Host_Init has called VID_Init and a renderer has already
  // been created. `-vid_ref <name>` is the pre-init parm form WinQuake uses
  // for every option VID_Init/Host_Init must see before the console exists
  // (`-dedicated`, `-mem`, and vid_x.c's own `-width`/`-height`/`-winsize`
  // read below); vid_ref is this port's own added cvar, so the parm that
  // seeds it is the port's own convention too. `vid_restart` after setting
  // the cvar stays the runtime path.
  const refParm = COM_CheckParm("-vid_ref");
  if (refParm) {
    if (refParm >= com_argc - 1) Sys_Error("VID: -vid_ref <name>\n");
    Cvar_Set("vid_ref", com_argv[refParm + 1]);
  }

  vid.maxwarpwidth = WARP_WIDTH;
  vid.maxwarpheight = WARP_HEIGHT;
  vid.colormap = host_colormap;
  if (vid.colormap) {
    const view = new DataView(vid.colormap.buffer, vid.colormap.byteOffset, vid.colormap.byteLength);
    vid.fullbright = 256 - view.getInt32(2048 * 4, true);
  }
  vid.numpages = 2;

  VID_SetPalette(palette);

  vidMenuHooks.vid_menudrawfn = VID_MenuDraw;
  vidMenuHooks.vid_menukeyfn = VID_MenuKey;

  SDLVID_SetWindowTitle("Quake");

  VID_CheckChanges(false); // see VID_CheckChanges's own header comment on `runRInit`

  // QW's linux video drivers (vid_x.c:371, gl_vidlinuxglx.c:606,
  // gl_vidlinux_svga.c:600) call S_Init() from inside VID_Init, which is why
  // QW's own Host_Init has `// S_Init (); // S_Init is now done as part of
  // VID. Sigh.` where WinQuake's Host_Init calls it. This one VID_Init serves
  // both binaries, so the call is made here only when qw.active; WinQuake's
  // Host_Init keeps making it itself. The C makes it the first statement of
  // VID_Init; here it is the last, because the audio device this port opens
  // lives behind the same SDL backend `SDL_SetBackendEnabled(true)` above
  // arms. Ordering against Draw_Init/SCR_Init/R_Init -- the only ordering
  // either Host_Init depends on -- is unchanged: all three still follow.
  if (qw.active) S_Init();
}

export function VID_Shutdown(): void {
  Con_Printf("VID_Shutdown\n");
  teardownActiveRenderer();
  vid.buffer = null;
  vid.width = 0;
  vid.height = 0;
  vid.rowbytes = 0;
}

// see file header: unreached in this port's call graph, ported for
// interface parity only.
export function VID_SetMode(modenum: number, palette: Uint8Array): number {
  const info = VID_GetModeInfo(modenum);
  if (!info) return 0;
  vid_mode.value = modenum;
  vid_mode.string = String(modenum);
  VID_SetPalette(palette);
  VID_CheckChanges();
  return 1;
}

export function VID_HandlePause(pause: boolean): void {
  void pause; // "called only on Win32" -- vid.h
}

export function VID_LockBuffer(): void {
  // real function on Win32, empty macro everywhere else -- quakedef.h
}

export function VID_UnlockBuffer(): void {
  // real function on Win32, empty macro everywhere else -- quakedef.h
}

export function D_BeginDirectRect(x: number, y: number, pbitmap: Uint8Array, width: number, height: number): void {
  void x;
  void y;
  void pbitmap;
  void width;
  void height;
  // "direct drawing of the 'accessing disk' icon isn't supported under Linux" -- vid_x.c
}

export function D_EndDirectRect(x: number, y: number, width: number, height: number): void {
  void x;
  void y;
  void width;
  void height;
  // see D_BeginDirectRect
}

const vidBackendImpl: VidBackend = {
  VID_SetPalette,
  VID_ShiftPalette,
  VID_Init,
  VID_Shutdown,
  VID_Update,
  VID_SetMode,
  VID_HandlePause,
  VID_LockBuffer,
  VID_UnlockBuffer,
  D_BeginDirectRect,
  D_EndDirectRect,
};
vidBackend.current = vidBackendImpl;
hostClientHooks.vidInit = VID_Init;
hostClientHooks.vidShutdown = VID_Shutdown;

// test seam: undo everything VID_Init/VID_CheckChanges armed, so a suite can
// exercise a fresh vid_ref switch without a real renderer registered.
export function VID_ResetForTests(): void {
  teardownActiveRenderer();
  vid.buffer = null;
  vid.width = 0;
  vid.height = 0;
  vid.rowbytes = 0;
  vid.colormap = null;
  vid.conwidth = 0;
  vid.conheight = 0;
  vid.fullbright = 0;
  rState.d_pzbuffer = null;
}
