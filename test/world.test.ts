import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { Mod_ForName, Mod_Init, type ModelT } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { CONTENTS_EMPTY, CONTENTS_SOLID } from "../src/common/bspfile";
import { vec3 } from "../src/common/mathlib";
import { EdictT, LinkT, setEdictTable } from "../src/progs/progs";
import { ENTVARS_SIZE_WORDS } from "../src/progs/progdefs";
import { sv, MOVETYPE_NONE, MOVETYPE_PUSH, SOLID_BBOX, SOLID_TRIGGER } from "../src/server/server";
import {
  AREA_NODES,
  type AreanodeT,
  MOVE_NOMONSTERS,
  MOVE_NORMAL,
  SV_ClearWorld,
  SV_HullForBox,
  SV_HullPointContents,
  SV_LinkEdict,
  SV_Move,
  SV_PointContents,
  SV_RecursiveHullCheck,
  SV_TestEntityPosition,
  SV_UnlinkEdict,
  TraceT,
  sv_areanodes,
  sv_numareanodes,
} from "../src/server/world";

const scratchRoot = "/tmp/claude-1000/-home-buzzkill-Projects-quake-1-ts/3ee4d8d6-89b6-415b-a497-e7e5aa27a1a6/scratchpad";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "world-test-"));
const baseDir = join(scratchDir, "quake");

let mod: ModelT;

// test-only entities, one per column so different SV_Move rays in different
// tests never see each other's entity.
let entLink: EdictT; // SOLID_BBOX, link/unlink round trip
let entMoveTarget: EdictT; // SOLID_BBOX, column x=0,y=0
let entNomonsters: EdictT; // SOLID_BBOX, column x=0,y=150
let entTrigger: EdictT; // SOLID_TRIGGER, column x=0,y=-150
let entFree: EdictT; // not linked, used only by SV_TestEntityPosition
let entEmbedded: EdictT; // not linked, sits inside the world's solid half

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  // gfx/pop.lmp inside id1/pak0.pak, exactly as test/model.test.ts does: the
  // registered-version check must pass before COM_FindFile will search a
  // loose "maps/world.bsp" path at all.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  const loaded = Mod_ForName("maps/world.bsp", true);
  if (loaded === null) throw new Error("expected maps/world.bsp to load");
  mod = loaded;

  sv.worldmodel = mod;
  sv.models[1] = mod;

  // SV_SpawnServer's own edict-0 setup (sv_main.c): the world edict is a
  // SOLID_BSP/MOVETYPE_PUSH entity pointing at model slot 1.
  const world = new EdictT(0, ENTVARS_SIZE_WORDS);
  world.v.solid = 4; // SOLID_BSP -- server.ts's own constant, avoided here to
  // keep this file's import list free of a name only used once; see below
  // for the real SOLID_BSP-driven test.
  world.v.movetype = MOVETYPE_PUSH;
  world.v.modelindex = 1;

  entLink = new EdictT(1, ENTVARS_SIZE_WORDS);
  entLink.v.solid = SOLID_BBOX;
  entLink.v.movetype = MOVETYPE_NONE;
  vec3CopyInto(entLink.v.origin, 100, 0, 50);
  vec3CopyInto(entLink.v.mins, -8, -8, -8);
  vec3CopyInto(entLink.v.maxs, 8, 8, 8);

  entMoveTarget = new EdictT(2, ENTVARS_SIZE_WORDS);
  entMoveTarget.v.solid = SOLID_BBOX;
  entMoveTarget.v.movetype = MOVETYPE_NONE;
  vec3CopyInto(entMoveTarget.v.origin, 0, 0, 0);
  vec3CopyInto(entMoveTarget.v.mins, -16, -16, -16);
  vec3CopyInto(entMoveTarget.v.maxs, 16, 16, 16);

  entNomonsters = new EdictT(3, ENTVARS_SIZE_WORDS);
  entNomonsters.v.solid = SOLID_BBOX;
  entNomonsters.v.movetype = MOVETYPE_NONE;
  vec3CopyInto(entNomonsters.v.origin, 0, 150, 0);
  vec3CopyInto(entNomonsters.v.mins, -16, -16, -16);
  vec3CopyInto(entNomonsters.v.maxs, 16, 16, 16);

  entTrigger = new EdictT(4, ENTVARS_SIZE_WORDS);
  entTrigger.v.solid = SOLID_TRIGGER;
  entTrigger.v.movetype = MOVETYPE_NONE;
  entTrigger.v.touch = 999; // an arbitrary nonzero func_t; never executed (touch_triggers=false below)
  vec3CopyInto(entTrigger.v.origin, 0, -150, 0);
  vec3CopyInto(entTrigger.v.mins, -16, -16, -16);
  vec3CopyInto(entTrigger.v.maxs, 16, 16, 16);

  entFree = new EdictT(5, ENTVARS_SIZE_WORDS);
  entFree.v.solid = SOLID_BBOX;
  vec3CopyInto(entFree.v.origin, 100, 100, 50); // z=50, well above the ground and away from every column above
  vec3CopyInto(entFree.v.mins, -8, -8, -8);
  vec3CopyInto(entFree.v.maxs, 8, 8, 8);

  entEmbedded = new EdictT(6, ENTVARS_SIZE_WORDS);
  entEmbedded.v.solid = SOLID_BBOX;
  vec3CopyInto(entEmbedded.v.origin, 100, 100, -50); // z=-50, inside the world's solid half
  vec3CopyInto(entEmbedded.v.mins, -8, -8, -8);
  vec3CopyInto(entEmbedded.v.maxs, 8, 8, 8);

  sv.edicts = [world, entLink, entMoveTarget, entNomonsters, entTrigger, entFree, entEmbedded];
  sv.num_edicts = sv.edicts.length;
  sv.max_edicts = sv.edicts.length;
  setEdictTable(sv.edicts);
});

function vec3CopyInto(dst: Float32Array, x: number, y: number, z: number): void {
  dst[0] = x;
  dst[1] = y;
  dst[2] = z;
}

// test-only helper: walks an area-node tree looking for `ent`'s link on the
// named list. Not a C port -- world.h never exposed sv_areanodes for reading.
function findEdictInTree(node: AreanodeT, ent: EdictT, listKey: "solid_edicts" | "trigger_edicts"): boolean {
  const head = node[listKey];
  for (let l: LinkT | null = head.next; l !== null && l !== head; l = l.next) {
    if (l.owner === ent) return true;
  }
  if (node.axis === -1) return false;
  const c0 = node.children[0];
  const c1 = node.children[1];
  return (c0 !== null && findEdictInTree(c0, ent, listKey)) || (c1 !== null && findEdictInTree(c1, ent, listKey));
}

//============================================================================

describe("SV_ClearWorld", () => {
  test("builds all 32 area nodes, 31 of which SV_CreateAreaNode fills in", () => {
    SV_ClearWorld();
    expect(sv_areanodes.length).toBe(AREA_NODES);
    expect(sv_numareanodes).toBe(31); // a full depth-4 binary tree: 2^5 - 1
  });
});

describe("SV_LinkEdict / SV_UnlinkEdict", () => {
  test("a SOLID_BBOX entity lands in a solid_edicts list, not trigger_edicts", () => {
    SV_LinkEdict(entLink, false);
    expect(findEdictInTree(sv_areanodes[0], entLink, "solid_edicts")).toBe(true);
    expect(findEdictInTree(sv_areanodes[0], entLink, "trigger_edicts")).toBe(false);
    expect(entLink.area.prev).not.toBeNull();
  });

  test("SV_UnlinkEdict removes it from the tree", () => {
    SV_UnlinkEdict(entLink);
    expect(findEdictInTree(sv_areanodes[0], entLink, "solid_edicts")).toBe(false);
    expect(entLink.area.prev).toBeNull();
    expect(entLink.area.next).toBeNull();
  });
});

describe("SV_PointContents", () => {
  test("above the split plane is empty", () => {
    expect(SV_PointContents(vec3(0, 0, 10))).toBe(CONTENTS_EMPTY);
  });

  test("below the split plane is solid", () => {
    expect(SV_PointContents(vec3(0, 0, -10))).toBe(CONTENTS_SOLID);
  });
});

describe("SV_HullForBox / SV_HullPointContents", () => {
  test("solid inside the box, empty outside", () => {
    const hull = SV_HullForBox(vec3(-16, -16, -16), vec3(16, 16, 16));
    expect(SV_HullPointContents(hull, hull.firstclipnode, vec3(0, 0, 0))).toBe(CONTENTS_SOLID);
    expect(SV_HullPointContents(hull, hull.firstclipnode, vec3(100, 100, 100))).toBe(CONTENTS_EMPTY);
  });
});

describe("SV_RecursiveHullCheck", () => {
  test("a ray straight down through a box hull hits the top face", () => {
    const hull = SV_HullForBox(vec3(-16, -16, -16), vec3(16, 16, 16));
    const start = vec3(0, 0, 100);
    const end = vec3(0, 0, -100);

    const trace = new TraceT();
    trace.clear();
    trace.fraction = 1;
    trace.allsolid = true;

    SV_RecursiveHullCheck(hull, hull.firstclipnode, 0, 1, start, end, trace);

    // 1/32 epsilon backs the crosspoint off toward the near (empty) side, so
    // the hit is a hair short of the exact geometric (100-16)/200 = 0.42.
    const expectedFraction = (84 - 0.03125) / 200;
    expect(trace.fraction).toBeCloseTo(expectedFraction, 4);
    expect(trace.allsolid).toBe(false);
    expect(trace.startsolid).toBe(false);

    // the hit face is the box's top (+Z) face
    expect(Math.abs(trace.plane.normal[2])).toBeCloseTo(1, 5);
    expect(trace.plane.normal[0]).toBeCloseTo(0, 5);
    expect(trace.plane.normal[1]).toBeCloseTo(0, 5);
    expect(trace.endpos[2]).toBeCloseTo(16 + 0.03125, 3);
  });
});

describe("SV_Move", () => {
  test("stops against a linked SOLID_BBOX entity", () => {
    SV_LinkEdict(entMoveTarget, false);

    const trace = SV_Move(vec3(0, 0, 100), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, -100), MOVE_NORMAL, null);

    expect(trace.ent).toBe(entMoveTarget);
    expect(trace.fraction).toBeLessThan(1);
  });

  test("MOVE_NOMONSTERS skips a non-bsp (SOLID_BBOX) entity", () => {
    SV_LinkEdict(entNomonsters, false);

    const traceNormal = SV_Move(vec3(0, 150, 100), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 150, -100), MOVE_NORMAL, null);
    expect(traceNormal.ent).toBe(entNomonsters);

    const traceNoMonsters = SV_Move(vec3(0, 150, 100), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 150, -100), MOVE_NOMONSTERS, null);
    expect(traceNoMonsters.ent).not.toBe(entNomonsters);
    expect(traceNoMonsters.fraction).toBeGreaterThan(traceNormal.fraction);
  });

  test("a SOLID_TRIGGER entity is never clipped against (SV_ClipToLinks only walks solid_edicts)", () => {
    // touch_triggers=false: SV_TouchLinks (and PR_ExecuteProgram) never runs.
    SV_LinkEdict(entTrigger, false);
    expect(findEdictInTree(sv_areanodes[0], entTrigger, "trigger_edicts")).toBe(true);
    expect(findEdictInTree(sv_areanodes[0], entTrigger, "solid_edicts")).toBe(false);

    const trace = SV_Move(vec3(0, -150, 100), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, -150, -100), MOVE_NORMAL, null);
    expect(trace.ent).not.toBe(entTrigger);
  });
});

describe("SV_TestEntityPosition", () => {
  test("a free-standing box away from the world's solid half is not embedded", () => {
    expect(SV_TestEntityPosition(entFree)).toBeNull();
  });

  test("a box sitting inside the world's solid half is embedded", () => {
    expect(SV_TestEntityPosition(entEmbedded)).toBe(sv.edicts[0]);
  });
});
