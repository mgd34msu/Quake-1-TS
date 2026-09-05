import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ModelLoaderHooks, TextureT } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import type { EntityT, ParticleT, Renderer } from "../src/client/render";
import type { VrectT } from "../src/client/vid";

// Stand-ins for the four siblings SCR_UpdateScreen calls out to (console.c,
// menu.c, sbar.c, snd_dma.c). Two reasons, both load-bearing:
//   1. the assertions below are about the ORDER screen.c calls them in, so each
//      stub records its own name and nothing else;
//   2. src/common/cvar.ts statically imports src/client/console.ts, which
//      imports src/common/host.ts, which imports src/common/net_main.ts, whose
//      top-level `new CvarT("net_messagetimeout", "300")` then runs while
//      cvar.ts is still evaluating. That cycle currently throws
//      `ReferenceError: Cannot access 'CvarT' before initialization` for every
//      test file in the tree (`bun test test/cvar.test.ts` alone reproduces
//      it); standing in for console.ts is what keeps this suite runnable until
//      it is fixed. It is NOT this unit's to fix -- see the report.
// Every stub is registered before the first `await import` of anything under
// src/, which is why nothing below this block is a static import.
const calls: string[] = [];
const conCalls: string[] = [];

const conState = {
  con_forcedup: false,
  con_initialized: false,
  con_notifylines: 0,
  con_backscroll: 0,
  con_totallines: 0,
};

const consoleStub = () => ({
  conState,
  Con_Printf: (_fmt: string, ..._args: Array<string | number>) => {
    conCalls.push("Con_Printf");
  },
  Con_DPrintf: (_fmt: string, ..._args: Array<string | number>) => {},
  Con_SafePrintf: (_fmt: string, ..._args: Array<string | number>) => {},
  setDeveloper: (_cv: { value: number } | null) => {},
  Con_Init: () => {},
  Con_CheckResize: () => {
    conCalls.push("Con_CheckResize");
  },
  Con_ClearNotify: () => {
    conCalls.push("Con_ClearNotify");
  },
  Con_DrawConsole: (_lines: number, _drawinput: boolean) => {
    conCalls.push("Con_DrawConsole");
  },
  Con_DrawNotify: () => {
    conCalls.push("Con_DrawNotify");
  },
});

const menuStub = () => ({
  M_Draw: () => {
    calls.push("M_Draw");
  },
  M_Keydown: (_key: number) => {},
  M_ToggleMenu_f: () => {},
  M_Init: () => {},
});

const sndStub = () => ({
  S_StopAllSounds: (_clear: boolean) => {
    calls.push("S_StopAllSounds");
  },
  S_ClearBuffer: () => {
    calls.push("S_ClearBuffer");
  },
  S_ExtraUpdate: () => {},
  S_PrecacheSound: (_name: string) => null,
  S_StartSound: () => {},
  S_StaticSound: () => {},
  S_StopSound: () => {},
  S_TouchSound: (_name: string) => {},
  S_BeginPrecaching: () => {},
  S_EndPrecaching: () => {},
});

const sbarStub = () => ({
  Sbar_Init: () => {},
  Sbar_Changed: () => {
    calls.push("Sbar_Changed");
  },
  Sbar_Draw: () => {
    calls.push("Sbar_Draw");
  },
  Sbar_IntermissionOverlay: () => {
    calls.push("Sbar_IntermissionOverlay");
  },
  Sbar_FinaleOverlay: () => {
    calls.push("Sbar_FinaleOverlay");
  },
});

mock.module("../src/client/console.ts", consoleStub);
mock.module("../src/client/menu.ts", menuStub);
mock.module("../src/client/menu", menuStub);
mock.module("../src/client/snd_dma.ts", sndStub);
mock.module("../src/client/snd_dma", sndStub);
mock.module("../src/client/sbar.ts", sbarStub);

const modelMod = await import("../src/common/model");
const cmdMod = await import("../src/common/cmd");
const cvarMod = await import("../src/common/cvar");
const hostMod = await import("../src/common/host");
const clientMod = await import("../src/client/client");
const keysMod = await import("../src/client/keys");
const renderMod = await import("../src/client/render");
const screenTypesMod = await import("../src/client/screen_types");
const vidMod = await import("../src/client/vid");
const screen = await import("../src/client/screen");
const view = await import("../src/client/view");

const { ModelT, TextureT: TextureTClass } = modelMod;
const { Cmd_Exists } = cmdMod;
const { Cvar_FindVar, Cvar_SetValue } = cvarMod;
const { host } = hostMod;
const { CactiveT, SIGNONS, cl, cls } = clientMod;
const { KeydestT, keyState } = keysMod;
const { re } = renderMod;
const { scrState, scr_vrect } = screenTypesMod;
const { vid } = vidMod;

// the registered-name/default-string pairs, captured before any test writes a
// cvar (Cvar_SetValue rewrites `.string` to printf's "%f" form)
const cvarDefaults = [
  [screen.scr_viewsize, "viewsize", "100", true],
  [screen.scr_fov, "fov", "90", false],
  [screen.scr_conspeed, "scr_conspeed", "300", false],
  [screen.scr_centertime, "scr_centertime", "2", false],
  [screen.scr_showram, "showram", "1", false],
  [screen.scr_showturtle, "showturtle", "0", false],
  [screen.scr_showpause, "showpause", "1", false],
  [screen.scr_printspeed, "scr_printspeed", "8", false],
].map(([cv, name, str, archive]) => ({
  cv: cv instanceof cvarMod.CvarT ? cv : null,
  actualName: cv instanceof cvarMod.CvarT ? cv.name : "",
  actualString: cv instanceof cvarMod.CvarT ? cv.string : "",
  actualArchive: cv instanceof cvarMod.CvarT ? cv.archive : false,
  name: String(name),
  string: String(str),
  archive: archive === true,
}));

const {
  CalcFov,
  SCR_BeginLoadingPlaque,
  SCR_CenterPrint,
  SCR_DrawCenterString,
  SCR_EndLoadingPlaque,
  SCR_Init,
  SCR_SetUpToDrawConsole,
  SCR_SizeUp_f,
  SCR_UpdateScreen,
  scr_centertime,
  scr_conspeed,
  scr_printspeed,
  scr_showram,
  scr_viewsize,
} = screen;

//=============================================================================
// A recording Renderer: every method pushes its own name onto `calls`.

function makePic(width: number, height: number): QpicT {
  const pic = { width, height, data: new Uint8Array(width * height) };
  return pic;
}

const drawnChars: Array<{ x: number; y: number; num: number }> = [];
const tileClears: Array<{ x: number; y: number; w: number; h: number }> = [];
const picsFromWad: string[] = [];

const hooks: ModelLoaderHooks = {
  notexture: new TextureTClass(),
  Mod_LoadTextures(): void {},
  Mod_LoadLighting(): void {},
  Mod_LoadAliasModel(): void {},
  Mod_LoadSpriteModel(): void {},
};

const fake: Renderer = {
  modelHooks: hooks,

  R_Init(): void {
    calls.push("R_Init");
  },
  R_InitTextures(): void {
    calls.push("R_InitTextures");
  },
  R_InitEfrags(): void {
    calls.push("R_InitEfrags");
  },
  R_RenderView(): void {
    calls.push("R_RenderView");
  },
  R_ViewChanged(_pvrect: VrectT, _lineadj: number, _aspect: number): void {
    calls.push("R_ViewChanged");
  },
  R_InitSky(_mt: TextureT): void {
    calls.push("R_InitSky");
  },
  R_AddEfrags(_ent: EntityT): void {
    calls.push("R_AddEfrags");
  },
  R_RemoveEfrags(_ent: EntityT): void {
    calls.push("R_RemoveEfrags");
  },
  R_NewMap(): void {
    calls.push("R_NewMap");
  },
  R_PushDlights(): void {
    calls.push("R_PushDlights");
  },

  r_cache_thrash: false,

  D_SurfaceCacheForRes(_width: number, _height: number): number {
    return 0;
  },
  D_FlushCaches(): void {
    calls.push("D_FlushCaches");
  },
  D_DeleteSurfaceCache(): void {
    calls.push("D_DeleteSurfaceCache");
  },
  D_InitCaches(_buffer: Uint8Array, _size: number): void {
    calls.push("D_InitCaches");
  },
  R_SetVrect(_pvrectin: VrectT, _pvrect: VrectT, _lineadj: number): void {
    calls.push("R_SetVrect");
  },

  draw_disc: null,

  Draw_Init(): void {
    calls.push("Draw_Init");
  },
  Draw_Character(x: number, y: number, num: number): void {
    calls.push("Draw_Character");
    drawnChars.push({ x, y, num });
  },
  Draw_DebugChar(_num: number): void {
    calls.push("Draw_DebugChar");
  },
  Draw_Pic(_x: number, _y: number, _pic: QpicT): void {
    calls.push("Draw_Pic");
  },
  Draw_TransPic(_x: number, _y: number, _pic: QpicT): void {
    calls.push("Draw_TransPic");
  },
  Draw_TransPicTranslate(_x: number, _y: number, _pic: QpicT, _translation: Uint8Array): void {
    calls.push("Draw_TransPicTranslate");
  },
  Draw_ConsoleBackground(_lines: number): void {
    calls.push("Draw_ConsoleBackground");
  },
  Draw_BeginDisc(): void {
    calls.push("Draw_BeginDisc");
  },
  Draw_EndDisc(): void {
    calls.push("Draw_EndDisc");
  },
  Draw_TileClear(x: number, y: number, w: number, h: number): void {
    calls.push("Draw_TileClear");
    tileClears.push({ x, y, w, h });
  },
  Draw_Fill(_x: number, _y: number, _w: number, _h: number, _c: number): void {
    calls.push("Draw_Fill");
  },
  Draw_FadeScreen(): void {
    calls.push("Draw_FadeScreen");
  },
  Draw_String(_x: number, _y: number, _str: string): void {
    calls.push("Draw_String");
  },
  Draw_PicFromWad(name: string): QpicT | null {
    calls.push("Draw_PicFromWad");
    picsFromWad.push(name);
    return makePic(8, 8);
  },
  Draw_CachePic(_path: string): QpicT | null {
    calls.push("Draw_CachePic");
    return makePic(16, 16);
  },

  D_StartParticles(): void {
    calls.push("D_StartParticles");
  },
  D_DrawParticle(_pparticle: ParticleT): void {
    calls.push("D_DrawParticle");
  },
  D_EndParticles(): void {
    calls.push("D_EndParticles");
  },

  V_CalcBlend(): void {
    calls.push("V_CalcBlend");
  },
  V_UpdatePalette(): void {
    calls.push("V_UpdatePalette");
  },
  V_DrawCrosshair(): void {
    calls.push("V_DrawCrosshair");
  },

  R_TranslatePlayerSkin(_playernum: number): void {
    calls.push("R_TranslatePlayerSkin");
  },

  SCR_CalcRefdef(): void {
    calls.push("SCR_CalcRefdef");
  },
  BeginFrame(): void {
    calls.push("BeginFrame");
  },
  EndFrame(): void {
    calls.push("EndFrame");
  },
  D_EnableBackBufferAccess(): void {
    calls.push("D_EnableBackBufferAccess");
  },
  D_DisableBackBufferAccess(): void {
    calls.push("D_DisableBackBufferAccess");
  },
  D_UpdateRects(_rects: VrectT | null): void {
    calls.push("D_UpdateRects");
  },
  GL_Set2D(): void {
    calls.push("GL_Set2D");
  },
  SCR_TileClear(): void {
    calls.push("SCR_TileClear");
  },
  SCR_SoftwareTileClear(x: number, y: number, w: number, h: number): void {
    calls.push(`SCR_SoftwareTileClear(${x},${y},${w},${h})`);
    tileClears.push({ x, y, w, h });
  },
  SCR_DrawCrosshair(): void {
    calls.push("SCR_DrawCrosshair");
  },
  SCR_ScreenShot_f(): void {
    calls.push("SCR_ScreenShot_f");
  },
};

// `names` appear in `seq` in this order, with anything else allowed between
function isSubsequence(seq: string[], names: string[]): boolean {
  let i = 0;
  for (const s of seq) {
    if (i < names.length && s === names[i]) i++;
  }
  return i === names.length;
}

function resetScreenState(): void {
  calls.length = 0;
  conCalls.length = 0;
  drawnChars.length = 0;
  tileClears.length = 0;
  picsFromWad.length = 0;

  scrState.scr_con_current = 0;
  scrState.scr_conlines = 0;
  scrState.scr_fullupdate = 0;
  scrState.sb_lines = 0;
  scrState.clearnotify = 0;
  scrState.scr_disabled_for_loading = false;
  scrState.scr_skipupdate = false;
  scrState.scr_copytop = 0;
  scrState.scr_copyeverything = 0;
  scrState.block_drawing = false;
  scr_vrect.x = 0;
  scr_vrect.y = 0;
  scr_vrect.width = 0;
  scr_vrect.height = 0;

  vid.width = 320;
  vid.height = 200;
  vid.numpages = 2;
  vid.recalc_refdef = 0;

  conState.con_forcedup = false;
  conState.con_initialized = true;
  conState.con_notifylines = 0;

  host.realtime = 0;
  host.frametime = 0.1;

  cl.clear();
  cl.paused = true; // V_RenderView then skips V_CalcRefdef
  cl.worldmodel = new ModelT();
  cls.state = CactiveT.ca_connected;
  cls.signon = SIGNONS;
  cls.demoplayback = false;
  keyState.key_dest = KeydestT.key_game;

  re.current = fake;
  fake.r_cache_thrash = false;

  Cvar_SetValue("viewsize", 100);
  Cvar_SetValue("fov", 90);
  Cvar_SetValue("lcd_x", 0);
  Cvar_SetValue("showram", 0);
  Cvar_SetValue("showturtle", 0);
  Cvar_SetValue("showpause", 0);
}

beforeAll(() => {
  re.current = fake;
  view.V_Init(); // registers lcd_x, which SCR_UpdateScreen reads
  SCR_Init();
});

beforeEach(() => {
  resetScreenState();
});

describe("SCR_Init", () => {
  test("registers every scr_* cvar under its C name", () => {
    expect(Cvar_FindVar("viewsize")).toBe(scr_viewsize);
    expect(Cvar_FindVar("fov")).toBe(screen.scr_fov);
    expect(Cvar_FindVar("scr_conspeed")).toBe(scr_conspeed);
    expect(Cvar_FindVar("scr_centertime")).toBe(scr_centertime);
    expect(Cvar_FindVar("showram")).toBe(scr_showram);
    expect(Cvar_FindVar("showturtle")).toBe(screen.scr_showturtle);
    expect(Cvar_FindVar("showpause")).toBe(screen.scr_showpause);
    expect(Cvar_FindVar("scr_printspeed")).toBe(scr_printspeed);
  });

  test("every scr_* cvar carries screen.c's default string and archive flag", () => {
    for (const d of cvarDefaults) {
      expect(d.cv).not.toBe(null);
      expect(d.actualName).toBe(d.name);
      expect(d.actualString).toBe(d.string);
      expect(d.actualArchive).toBe(d.archive);
    }
  });

  test("registers screenshot, sizeup and sizedown", () => {
    expect(Cmd_Exists("screenshot")).toBe(true);
    expect(Cmd_Exists("sizeup")).toBe(true);
    expect(Cmd_Exists("sizedown")).toBe(true);
  });

  test("loads ram, net and turtle out of the wad, in that order", () => {
    SCR_Init();
    expect(picsFromWad).toEqual(["ram", "net", "turtle"]);
  });
});

describe("CalcFov", () => {
  test("CalcFov(90, 320, 240) is the C's 73.74 degrees", () => {
    expect(CalcFov(90, 320, 240)).toBeCloseTo(73.739795, 4);
  });

  test("Sys_Errors outside 1..179", () => {
    expect(() => CalcFov(0, 320, 240)).toThrow();
    expect(() => CalcFov(180, 320, 240)).toThrow();
  });
});

describe("SCR_SizeUp_f / SCR_SizeDown_f", () => {
  test("step the viewsize by 10 and force a refdef recalc", () => {
    Cvar_SetValue("viewsize", 100);
    vid.recalc_refdef = 0;
    SCR_SizeUp_f();
    expect(scr_viewsize.value).toBe(110);
    expect(vid.recalc_refdef).toBe(1);

    vid.recalc_refdef = 0;
    screen.SCR_SizeDown_f();
    expect(scr_viewsize.value).toBe(100);
    expect(vid.recalc_refdef).toBe(1);
  });

  test("the 30..120 clamp is the renderer's SCR_CalcRefdef, not this command", () => {
    Cvar_SetValue("viewsize", 120);
    SCR_SizeUp_f();
    expect(scr_viewsize.value).toBe(130);
  });
});

describe("SCR_CenterPrint / SCR_DrawCenterString", () => {
  test("centers a one-line string on vid.height*0.35", () => {
    cl.time = 0;
    SCR_CenterPrint("AB");
    SCR_DrawCenterString();

    // y = (int)(200*0.35) = 70; x = (320 - 2*8)/2 = 152
    expect(drawnChars).toEqual([
      { x: 152, y: 70, num: 65 },
      { x: 160, y: 70, num: 66 },
    ]);
  });

  test("a 5-line string starts at y = 48 and advances 8 per line", () => {
    cl.time = 0;
    SCR_CenterPrint("A\nB\nC\nD\nE");
    SCR_DrawCenterString();

    expect(drawnChars.map((c) => c.y)).toEqual([48, 56, 64, 72, 80]);
    // x = (320 - 1*8)/2 = 156 on every line
    expect(drawnChars.every((c) => c.x === 156)).toBe(true);
  });

  test("the finale meters characters out at scr_printspeed per second", () => {
    cl.time = 1.0;
    SCR_CenterPrint("ABCDEF");
    cl.intermission = 1;
    cl.time = 1.0 + 3 / 8; // remaining = (int)(8 * 0.375) = 3
    drawnChars.length = 0;
    SCR_DrawCenterString();

    // the C draws, THEN tests `if (!remaining--)`, so remaining==3 draws 4
    expect(drawnChars.map((c) => String.fromCharCode(c.num)).join("")).toBe("ABCD");
  });
});

describe("SCR_SetUpToDrawConsole", () => {
  test("no worldmodel forces a full-screen console immediately", () => {
    cl.worldmodel = null;
    SCR_SetUpToDrawConsole();

    expect(conState.con_forcedup).toBe(true);
    expect(scrState.scr_conlines).toBe(200);
    expect(scrState.scr_con_current).toBe(200);
  });

  test("an incomplete signon forces it too", () => {
    cls.signon = SIGNONS - 1;
    SCR_SetUpToDrawConsole();
    expect(conState.con_forcedup).toBe(true);
    expect(scrState.scr_conlines).toBe(200);
  });

  test("key_console approaches half screen at scr_conspeed*host_frametime", () => {
    keyState.key_dest = KeydestT.key_console;
    scrState.scr_con_current = 0;
    SCR_SetUpToDrawConsole();
    // conlines = 200/2 = 100; con_current += 300*0.1 = 30
    expect(scrState.scr_conlines).toBe(100);
    expect(scrState.scr_con_current).toBeCloseTo(30, 10);

    SCR_SetUpToDrawConsole();
    expect(scrState.scr_con_current).toBeCloseTo(60, 10);
  });

  test("key_game retracts it, and never past the target", () => {
    keyState.key_dest = KeydestT.key_game;
    scrState.scr_con_current = 20;
    SCR_SetUpToDrawConsole();
    // conlines = 0; con_current -= 300*0.1 = 30, clamped to 0
    expect(scrState.scr_conlines).toBe(0);
    expect(scrState.scr_con_current).toBe(0);
  });

  test("while clearconsole < vid.numpages it tile-clears below the console and marks the sbar", () => {
    keyState.key_dest = KeydestT.key_game;
    scrState.scr_con_current = 0;
    vid.numpages = 1000; // keep this run on the clearconsole branch
    calls.length = 0;
    tileClears.length = 0;
    SCR_SetUpToDrawConsole();
    expect(calls.some((c) => c.startsWith("SCR_SoftwareTileClear("))).toBe(true);
    expect(calls).toContain("Sbar_Changed");
    expect(tileClears[0]).toEqual({ x: 0, y: 0, w: 320, h: 200 });
    expect(scrState.scr_copytop).toBe(1);
  });

  test("once both counters pass vid.numpages it clears nothing and zeroes con_notifylines", () => {
    keyState.key_dest = KeydestT.key_game;
    vid.numpages = 0;
    conState.con_notifylines = 5;
    calls.length = 0;
    SCR_SetUpToDrawConsole();
    expect(calls).not.toContain("Draw_TileClear");
    expect(conState.con_notifylines).toBe(0);
  });
});

describe("SCR_UpdateScreen", () => {
  test("scr_skipupdate and block_drawing return before anything is drawn", () => {
    scrState.scr_skipupdate = true;
    SCR_UpdateScreen();
    expect(calls).toEqual([]);

    scrState.scr_skipupdate = false;
    scrState.block_drawing = true;
    SCR_UpdateScreen();
    expect(calls).toEqual([]);
  });

  test("scr_disabled_for_loading swallows the frame, then gives up after 60 seconds", () => {
    // scr_disabled_time is whatever the last SCR_BeginLoadingPlaque latched;
    // this suite never runs one before this point, so it is still 0
    scrState.scr_disabled_for_loading = true;
    host.realtime = 10;
    SCR_UpdateScreen();
    expect(calls).toEqual([]);
    expect(scrState.scr_disabled_for_loading).toBe(true);

    host.realtime = 61;
    SCR_UpdateScreen();
    expect(scrState.scr_disabled_for_loading).toBe(false);
    expect(conCalls).toContain("Con_Printf"); // "load failed.\n"
    expect(calls.length).toBeGreaterThan(0);
  });

  test("a dedicated client draws nothing", () => {
    cls.state = CactiveT.ca_dedicated;
    SCR_UpdateScreen();
    expect(calls).toEqual([]);
  });

  test("an uninitialized console draws nothing", () => {
    conState.con_initialized = false;
    SCR_UpdateScreen();
    expect(calls).toEqual([]);
  });

  test("drives the seam in the C's order", () => {
    vid.recalc_refdef = 1;
    SCR_UpdateScreen();

    expect(
      isSubsequence(calls, [
        "BeginFrame",
        "SCR_CalcRefdef",
        "D_EnableBackBufferAccess",
        "D_DisableBackBufferAccess",
        "R_PushDlights",
        "R_RenderView",
        "D_EnableBackBufferAccess",
        "GL_Set2D",
        "SCR_TileClear",
        "SCR_DrawCrosshair",
        "Sbar_Draw",
        "M_Draw",
        "D_DisableBackBufferAccess",
        "V_UpdatePalette",
        "EndFrame",
      ]),
    ).toBe(true);
  });

  test("skips SCR_CalcRefdef when nothing changed", () => {
    SCR_UpdateScreen(); // latch oldfov / oldscreensize / oldlcd_x / oldscr_viewsize
    calls.length = 0;
    vid.recalc_refdef = 0;
    SCR_UpdateScreen();
    expect(calls).not.toContain("SCR_CalcRefdef");
    expect(calls).toContain("BeginFrame");
    expect(calls).toContain("EndFrame");
  });

  test("a changed fov forces a recalc on the next frame", () => {
    SCR_UpdateScreen();
    calls.length = 0;
    vid.recalc_refdef = 0;
    Cvar_SetValue("fov", 110);
    SCR_UpdateScreen();
    expect(calls).toContain("SCR_CalcRefdef");
    Cvar_SetValue("fov", 90);
  });

  test("intermission 1 draws the intermission overlay instead of the hud", () => {
    cl.intermission = 1;
    keyState.key_dest = KeydestT.key_game;
    SCR_UpdateScreen();
    expect(calls).toContain("Sbar_IntermissionOverlay");
    expect(calls).not.toContain("M_Draw");
  });

  test("intermission 2 draws the finale overlay", () => {
    cl.intermission = 2;
    keyState.key_dest = KeydestT.key_game;
    SCR_UpdateScreen();
    expect(calls).toContain("Sbar_FinaleOverlay");
  });
});

describe("the loading plaque", () => {
  test("Begin arms scr_disabled_for_loading and draws one plaque frame; End disarms it", () => {
    cls.state = CactiveT.ca_connected;
    cls.signon = SIGNONS;
    scrState.scr_disabled_for_loading = false;

    SCR_BeginLoadingPlaque();

    expect(calls).toContain("S_StopAllSounds");
    expect(conCalls).toContain("Con_ClearNotify");
    expect(calls).toContain("Draw_CachePic"); // SCR_DrawLoading ran inside
    expect(scrState.scr_disabled_for_loading).toBe(true);
    expect(scrState.scr_con_current).toBe(0);
    expect(scrState.scr_fullupdate).toBe(0);

    SCR_EndLoadingPlaque();
    expect(scrState.scr_disabled_for_loading).toBe(false);
    expect(scrState.scr_fullupdate).toBe(0);
  });

  test("Begin stops sounds but draws nothing when not connected", () => {
    cls.state = CactiveT.ca_disconnected;
    SCR_BeginLoadingPlaque();
    expect(calls).toEqual(["S_StopAllSounds"]);
    expect(scrState.scr_disabled_for_loading).toBe(false);
  });
});

describe("SCR_UpdateWholeScreen", () => {
  test("zeroes scr_fullupdate so the frame it drives clears everything", () => {
    scrState.scr_fullupdate = 99;
    screen.SCR_UpdateWholeScreen();
    expect(scrState.scr_fullupdate).toBe(1); // 0, then the frame's own ++
    expect(calls.some((c) => c.startsWith("SCR_SoftwareTileClear("))).toBe(true);
  });
});

describe("SCR_ScreenShot_f", () => {
  test("forwards to the renderer", () => {
    screen.SCR_ScreenShot_f();
    expect(calls).toEqual(["SCR_ScreenShot_f"]);
  });
});
