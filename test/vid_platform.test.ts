// Force headless SDL before ANY import can reach the FFI layer -- sdl.ts
// dlopen()s lazily, so as long as no SDL entry point is called above this
// assignment, SDL reads these on its first SDL_Init (mirrors sdl_platform's
// own banner comment).
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for src/platform/vid.ts: the flat mode table, the vid_ref renderer
registry (empty-registry Sys_Error, registering a fake renderer under
"soft" and having VID_CheckChanges install it + its modelHooks together),
VID_Init's 8-bit buffer allocation and palette upload, VID_Update presenting
without error under the dummy driver, and the gl-unavailable-under-dummy-
driver fallback to soft. Self-sufficient per standing order 13: every
process-wide singleton this file touches (re.current, vidBackend.current,
inputBackend.current, cmdHost.initialized, the model-loader hooks, the
platform/vid.ts renderer registry, rState.d_pzbuffer) is saved and restored.
*/

import { describe, test, expect, afterAll } from "bun:test";
import type { ModelLoaderHooks } from "../src/common/model";
import { getModelLoaderHooks, setModelLoaderHooks } from "../src/common/model";
import type { Renderer } from "../src/client/render";
import { re } from "../src/client/render";
import type { QpicT } from "../src/common/wad";
import { d_8to24table, vid, vidBackend, vidMenuHooks } from "../src/client/vid";
import { inputBackend } from "../src/client/input";
import { cmdHost } from "../src/common/cmd";
import { rState } from "../src/ref_soft/r_shared";
import { SDL_ResetBackendForTests } from "../src/platform/sdl";
import {
  registerRenderer,
  unregisterRenderer,
  VID_CheckChanges,
  VID_GetModeInfo,
  VID_Init,
  VID_MODES,
  VID_ResetForTests,
  VID_Update,
  vid_ref,
} from "../src/platform/vid";

function makePic(width: number, height: number): QpicT {
  return { width, height, data: new Uint8Array(0) };
}

const modelHooks: ModelLoaderHooks = {
  notexture: { name: "", width: 0, height: 0, gl_texturenum: 0, texturechain: null, anim_total: 0, anim_min: 0, anim_max: 0, anim_next: null, alternate_anims: null, offsets: new Uint32Array(4), data: new Uint8Array(0) },
  Mod_LoadTextures(): void {},
  Mod_LoadLighting(): void {},
  Mod_LoadAliasModel(): void {},
  Mod_LoadSpriteModel(): void {},
};

let rInitCalls = 0;
let cacheForResCalls = 0;
let initCachesArgs: { size: number } | null = null;

const fakeRenderer: Renderer = {
  modelHooks,

  R_Init(): void {
    rInitCalls++;
  },
  R_InitTextures(): void {},
  R_InitEfrags(): void {},
  R_RenderView(): void {},
  R_ViewChanged(): void {},
  R_InitSky(): void {},
  R_AddEfrags(): void {},
  R_RemoveEfrags(): void {},
  R_NewMap(): void {},
  R_PushDlights(): void {},

  r_cache_thrash: false,

  D_SurfaceCacheForRes(): number {
    cacheForResCalls++;
    return 4096;
  },
  D_FlushCaches(): void {},
  D_DeleteSurfaceCache(): void {},
  D_InitCaches(buffer: Uint8Array, size: number): void {
    initCachesArgs = { size };
    void buffer;
  },
  R_SetVrect(): void {},

  draw_disc: null,

  Draw_Init(): void {},
  Draw_Character(): void {},
  Draw_DebugChar(): void {},
  Draw_Pic(): void {},
  Draw_TransPic(): void {},
  Draw_TransPicTranslate(): void {},
  Draw_ConsoleBackground(): void {},
  Draw_BeginDisc(): void {},
  Draw_EndDisc(): void {},
  Draw_TileClear(): void {},
  Draw_Fill(): void {},
  Draw_FadeScreen(): void {},
  Draw_String(): void {},
  Draw_PicFromWad(): QpicT | null {
    return null;
  },
  Draw_CachePic(): QpicT | null {
    return makePic(8, 8);
  },

  D_StartParticles(): void {},
  D_DrawParticle(): void {},
  D_EndParticles(): void {},

  V_CalcBlend(): void {},
  V_UpdatePalette(): void {},
  V_DrawCrosshair(): void {},

  R_TranslatePlayerSkin(): void {},

  SCR_CalcRefdef(): void {},
  BeginFrame(): void {},
  EndFrame(): void {},
  D_EnableBackBufferAccess(): void {},
  D_DisableBackBufferAccess(): void {},
  D_UpdateRects(): void {},
  GL_Set2D(): void {},
  SCR_TileClear(): void {},
  SCR_SoftwareTileClear(): void {},
  SCR_DrawCrosshair(): void {},
  SCR_ScreenShot_f(): void {},
};

const savedCmdInitialized = cmdHost.initialized;
const savedRe = re.current;
const savedVidBackend = vidBackend.current;
const savedInputBackend = inputBackend.current;
const savedModelHooks = getModelLoaderHooks();
const savedMenuDraw = vidMenuHooks.vid_menudrawfn;
const savedMenuKey = vidMenuHooks.vid_menukeyfn;

afterAll(() => {
  unregisterRenderer("soft");
  unregisterRenderer("gl");
  VID_ResetForTests();
  SDL_ResetBackendForTests();
  re.current = savedRe;
  vidBackend.current = savedVidBackend;
  inputBackend.current = savedInputBackend;
  setModelLoaderHooks(savedModelHooks);
  vidMenuHooks.vid_menudrawfn = savedMenuDraw;
  vidMenuHooks.vid_menukeyfn = savedMenuKey;
  cmdHost.initialized = savedCmdInitialized;
});

describe("VID_MODES / VID_GetModeInfo -- the flat mode table", () => {
  test("index 0 is 320x240 and the last entry is 3840x2160", () => {
    expect(VID_GetModeInfo(0)).toEqual({ width: 320, height: 240 });
    expect(VID_GetModeInfo(VID_MODES.length - 1)).toEqual({ width: 3840, height: 2160 });
  });

  test("an out-of-range index is rejected instead of throwing", () => {
    expect(VID_GetModeInfo(-1)).toBeNull();
    expect(VID_GetModeInfo(9999)).toBeNull();
  });
});

describe("VID_Init -- the 8-bit buffer and palette upload", () => {
  test("allocates vid.buffer sized to the selected mode, builds d_8to24table from the 768-byte palette, and wires the video menu hooks", () => {
    cmdHost.initialized = false; // Cmd_AddCommand("vid_restart", ...) throws once this is true
    registerRenderer("soft", () => fakeRenderer);

    const palette = new Uint8Array(768);
    palette[0] = 255; // index 0: pure red
    palette[1] = 0;
    palette[2] = 0;

    VID_Init(palette);

    expect(vid.buffer).not.toBeNull();
    expect(vid.buffer?.length).toBe(vid.width * vid.height);
    expect(vid.width).toBeGreaterThan(0);
    expect(vid.height).toBeGreaterThan(0);
    expect(vid.rowbytes).toBe(vid.width);
    expect(vid.conwidth).toBe(vid.width);
    expect(vid.conheight).toBe(vid.height);
    expect(vid.numpages).toBe(2);

    // d_8to24table packs (255<<24)+(r<<0)+(g<<8)+(b<<16), R,G,B,A in
    // increasing byte address on a little-endian host (vid.ts's own header
    // comment) -- index 0 must read back as opaque red.
    const bytes = new Uint8Array(d_8to24table.buffer);
    expect(bytes[0]).toBe(255); // R
    expect(bytes[1]).toBe(0); // G
    expect(bytes[2]).toBe(0); // B
    expect(bytes[3]).toBe(255); // A forced opaque

    expect(vidMenuHooks.vid_menudrawfn).not.toBeNull();
    expect(vidMenuHooks.vid_menukeyfn).not.toBeNull();

    // rState.d_pzbuffer / the surface-cache heap: allocated by vid.ts,
    // handed to the software rasterizer's D_InitCaches (see vid.ts's own
    // header comment on the followups.md directive this satisfies).
    expect(rState.d_pzbuffer).not.toBeNull();
    expect(rState.d_pzbuffer?.length).toBe(vid.width * vid.height);
    expect(cacheForResCalls).toBeGreaterThan(0);
    expect(initCachesArgs).toEqual({ size: 4096 });
  });

  test("VID_Update presents the buffer through the dummy driver without throwing", () => {
    expect(() => VID_Update(null)).not.toThrow();
  });
});

describe("VID_CheckChanges -- the vid_ref renderer registry", () => {
  test("registering a fake renderer under \"soft\" installs it, and its modelHooks, together", () => {
    registerRenderer("soft", () => fakeRenderer);
    rInitCalls = 0;
    VID_CheckChanges();
    expect(re.current).toBe(fakeRenderer);
    expect(getModelLoaderHooks()).toBe(modelHooks);
  });

  test("selecting an unregistered name Sys_Errors, listing what IS registered", () => {
    const original = vid_ref.string;
    vid_ref.string = "nonexistent";
    try {
      expect(() => VID_CheckChanges()).toThrow(/vid_ref nonexistent not available \(registered: soft\)/);
    } finally {
      vid_ref.string = original;
    }
  });

  test("an empty registry Sys_Errors the same way", () => {
    unregisterRenderer("soft");
    try {
      expect(() => VID_CheckChanges()).toThrow(/vid_ref soft not available \(registered: \(none\)\)/);
    } finally {
      registerRenderer("soft", () => fakeRenderer);
    }
  });

  test("a \"gl\" selection that fails under the dummy video driver falls back to soft without throwing", () => {
    registerRenderer("gl", () => fakeRenderer);
    const original = vid_ref.string;
    vid_ref.string = "gl";
    try {
      expect(() => VID_CheckChanges()).not.toThrow();
      expect(vid_ref.string).toBe("soft"); // the direct-field fallback, see vid.ts's own comment on why this isn't Cvar_Set
      expect(re.current).toBe(fakeRenderer);
    } finally {
      unregisterRenderer("gl");
      if (vid_ref.string !== "soft") vid_ref.string = original;
    }
  });
});
