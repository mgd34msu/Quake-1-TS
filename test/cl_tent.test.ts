// Self-sufficient test for src/client/cl_tent.ts (WinQuake cl_tent.c).
//
// cl_tent.ts imports from sibling specifiers this suite cannot use for real:
//   - "./cl_main" (CL_AllocDlight) -- landed, but a real import still needs
//     a full client bootstrap this suite has no reason to carry.
//   - "./r_part" (R_RunParticleEffect and friends) and "./snd_dma"
//     (S_PrecacheSound, S_StartSound) -- landed, but their real bodies need
//     an initialized particle pool / sound device this suite has no reason
//     to carry either; testing that machinery is r_part.test.ts's and
//     snd_dma.test.ts's job, not this unit's.
//   - "../common/model" (Mod_ForName) -- landed and fully runnable, but its
//     real behavior needs an actual .mdl file reachable through
//     COM_FindFile -- fidelity this suite leaves to model.test.ts. Testing
//     CL_ParseTEnt's TE_LIGHTNING*/TE_BEAM dispatch only needs to observe
//     *that* Mod_ForName was called with the right path and crash flag, and
//     that whatever it returns flows into the right cl_beams slot, so
//     Mod_ForName is faked here too.
// bun:test's `mock.module` replaces all four specifiers with minimal fakes,
// registered before a *dynamic* `import()` of cl_tent.ts itself (a static
// top-level import of the module under test would resolve the real import
// graph before the mock ever takes effect -- static imports are all
// resolved before any of that module's own statements run). `mock.module`
// only replaces this test process's module registry entry for the exact
// specifier given; it never touches the filesystem, so it cannot clobber a
// concurrent worker's real file the way a stub at the sibling's real path
// would (forbidden by this project's standing orders).
//
// test/cl_input.test.ts mocks this same "./cl_main" specifier too (with a
// different, non-overlapping export shape: CL_Disconnect/lookspring there,
// CL_AllocDlight here). Confirmed empirically (bun 1.3.14): `mock.module`
// replaces one shared registry entry rather than creating a fresh module
// identity per call, and every test file's own top-level code (every
// `mock.module`/dynamic-`import()` pair included) runs during bun test's
// file-loading pass, strictly before any test() body from *any* file
// actually runs -- so whichever file's `mock.module("./cl_main", ...)` call
// happens to execute last during that pass wins for every file's test
// bodies, not just its own, and the loser's own needed export can vanish
// from under it. `installClMainMock` (below) is re-invoked in `beforeAll`,
// which runs at test-*execution* time -- strictly after every file has
// finished loading -- so this file's own CL_AllocDlight binding is
// guaranteed current by the time any test in this file actually runs,
// whichever file happened to load last.
//
// `num_temp_entities` and the seven `cl_sfx_*` holders are live ES bindings
// (`export let`) on cl_tent.ts, so this file reads them off the imported
// module namespace object (`cl_tent.num_temp_entities`) rather than through
// a destructured copy, which would only capture the value at import time.

import { describe, test, expect, beforeEach, beforeAll, mock } from "bun:test";
import { SZ_Alloc, SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort, MSG_WriteCoord, net_message } from "../src/common/sizebuf";
import {
  TE_BEAM,
  TE_EXPLOSION,
  TE_EXPLOSION2,
  TE_GUNSHOT,
  TE_KNIGHTSPIKE,
  TE_LAVASPLASH,
  TE_LIGHTNING1,
  TE_LIGHTNING2,
  TE_LIGHTNING3,
  TE_SPIKE,
  TE_SUPERSPIKE,
  TE_TAREXPLOSION,
  TE_TELEPORT,
  TE_WIZSPIKE,
} from "../src/common/protocol";
import { ModelT } from "../src/common/model";
import { SysError } from "../src/platform/sys";
import { cl, cl_beams, cl_entities, cl_visedicts, clState, DlightT, MAX_BEAMS, MAX_TEMP_ENTITIES, MAX_VISEDICTS } from "../src/client/client";
import { vid } from "../src/client/vid";

// -- fakes for the absent/broken sibling specifiers -------------------------

interface DlightCall {
  key: number;
  dlight: DlightT;
}
const dlightCalls: DlightCall[] = [];
// see this file's header for why this is re-invoked from beforeAll too
async function installClMainMock(): Promise<void> {
  await mock.module("../src/client/cl_main", () => ({
    CL_AllocDlight: (key: number) => {
      const dl = new DlightT();
      dlightCalls.push({ key, dlight: dl });
      return dl;
    },
    // test/cl_input.test.ts's own share of this specifier's export surface;
    // present here purely so a load-order race with that file can never
    // produce a "no export named CL_Disconnect/lookspring" crash while that
    // file's own module graph is loading. This file's own beforeAll below
    // re-asserts the shape above regardless.
    CL_Disconnect: () => {},
    lookspring: { value: 0 },
  }));
}
await installClMainMock();

interface ParticleCall {
  fn: string;
  args: unknown[];
}
const particleCalls: ParticleCall[] = [];
function recordParticle(fn: string, ...args: unknown[]): void {
  particleCalls.push({ fn, args });
}
await mock.module("../src/client/r_part", () => ({
  R_RunParticleEffect: (org: Float32Array, dir: Float32Array, color: number, count: number) =>
    recordParticle("R_RunParticleEffect", Array.from(org), Array.from(dir), color, count),
  R_ParticleExplosion: (org: Float32Array) => recordParticle("R_ParticleExplosion", Array.from(org)),
  R_ParticleExplosion2: (org: Float32Array, colorStart: number, colorLength: number) =>
    recordParticle("R_ParticleExplosion2", Array.from(org), colorStart, colorLength),
  R_BlobExplosion: (org: Float32Array) => recordParticle("R_BlobExplosion", Array.from(org)),
  R_LavaSplash: (org: Float32Array) => recordParticle("R_LavaSplash", Array.from(org)),
  R_TeleportSplash: (org: Float32Array) => recordParticle("R_TeleportSplash", Array.from(org)),
}));

interface SoundCall {
  entnum: number;
  entchannel: number;
  sfx: unknown;
  origin: number[];
  fvol: number;
  attenuation: number;
}
const precacheCalls: string[] = [];
const soundCalls: SoundCall[] = [];
await mock.module("../src/client/snd_dma", () => ({
  S_PrecacheSound: (path: string) => {
    precacheCalls.push(path);
    return path; // identity, so cl_sfx_* holders are recognizable by name below
  },
  S_StartSound: (entnum: number, entchannel: number, sfx: unknown, origin: Float32Array, fvol: number, attenuation: number) => {
    soundCalls.push({ entnum, entchannel, sfx, origin: Array.from(origin), fvol, attenuation });
  },
}));

interface ModForNameCall {
  name: string;
  crash: boolean;
}
const modForNameCalls: ModForNameCall[] = [];
let lastFakeModel: unknown = null;
await mock.module("../src/common/model", () => ({
  Mod_ForName: (name: string, crash: boolean) => {
    modForNameCalls.push({ name, crash });
    lastFakeModel = { tag: name };
    return lastFakeModel;
  },
}));

const cl_tent = await import("../src/client/cl_tent");

// -- shared fixtures ---------------------------------------------------------

function resetBeams(): void {
  for (const b of cl_beams) {
    b.entity = 0;
    b.model = null;
    b.endtime = 0;
    b.start[0] = b.start[1] = b.start[2] = 0;
    b.end[0] = b.end[1] = b.end[2] = 0;
  }
}

function beginTEntMessage(): void {
  SZ_Alloc(net_message, 2048);
  SZ_Clear(net_message);
}

function parseTEnt(): void {
  MSG_BeginReading();
  cl_tent.CL_ParseTEnt();
}

// cl_tent.ts's cl_sfx_* holders are typed sound.ts's real `SfxT | null`; the
// mocked S_PrecacheSound above returns the path string itself (identity) so
// this suite can recognize which wav a holder came from without needing a
// real SfxT instance. `value` is accepted as `unknown` so comparing it to a
// path string needs no cast, just a run-of-the-mill typeof narrowing.
function expectSfxPath(value: unknown, expected: string): void {
  expect(typeof value).toBe("string");
  if (typeof value === "string") {
    expect(value).toBe(expected);
  }
}

beforeAll(async () => {
  await installClMainMock(); // see the file header above installClMainMock
});

beforeEach(() => {
  particleCalls.length = 0;
  soundCalls.length = 0;
  dlightCalls.length = 0;
  modForNameCalls.length = 0;
  resetBeams();
  clState.cl_numvisedicts = 0;
  cl.time = 0;
  cl.viewentity = 0;
});

describe("CL_InitTEnts", () => {
  test("precaches the exact wav paths from cl_tent.c, in order", () => {
    precacheCalls.length = 0;
    cl_tent.CL_InitTEnts();
    expect(precacheCalls).toEqual([
      "wizard/hit.wav",
      "hknight/hit.wav",
      "weapons/tink1.wav",
      "weapons/ric1.wav",
      "weapons/ric2.wav",
      "weapons/ric3.wav",
      "weapons/r_exp3.wav",
    ]);
    expectSfxPath(cl_tent.cl_sfx_wizhit, "wizard/hit.wav");
    expectSfxPath(cl_tent.cl_sfx_knighthit, "hknight/hit.wav");
    expectSfxPath(cl_tent.cl_sfx_tink1, "weapons/tink1.wav");
    expectSfxPath(cl_tent.cl_sfx_ric1, "weapons/ric1.wav");
    expectSfxPath(cl_tent.cl_sfx_ric2, "weapons/ric2.wav");
    expectSfxPath(cl_tent.cl_sfx_ric3, "weapons/ric3.wav");
    expectSfxPath(cl_tent.cl_sfx_r_exp3, "weapons/r_exp3.wav");
  });
});

describe("CL_ParseBeam", () => {
  test("overrides an existing beam entry for the same entity number", () => {
    cl.time = 100;
    cl_beams[3].entity = 77;
    cl_beams[3].model = new ModelT();
    cl_beams[3].endtime = 500;

    beginTEntMessage();
    MSG_WriteShort(net_message, 77);
    MSG_WriteCoord(net_message, 1);
    MSG_WriteCoord(net_message, 2);
    MSG_WriteCoord(net_message, 3);
    MSG_WriteCoord(net_message, 4);
    MSG_WriteCoord(net_message, 5);
    MSG_WriteCoord(net_message, 6);
    MSG_BeginReading();

    const newModel = new ModelT();
    cl_tent.CL_ParseBeam(newModel);

    expect(cl_beams[3].model).toBe(newModel);
    expect(cl_beams[3].entity).toBe(77);
    expect(cl_beams[3].endtime).toBeCloseTo(100.2, 5);
    expect(Array.from(cl_beams[3].start)).toEqual([1, 2, 3]);
    expect(Array.from(cl_beams[3].end)).toEqual([4, 5, 6]);
  });

  test("claims the first free slot when no entity matches an existing beam", () => {
    // resetBeams() (beforeEach) leaves every slot free (model === null)
    beginTEntMessage();
    MSG_WriteShort(net_message, 55);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_BeginReading();

    const m = new ModelT();
    cl_tent.CL_ParseBeam(m);

    expect(cl_beams[0].model).toBe(m);
    expect(cl_beams[0].entity).toBe(55);
  });

  test("an expired (endtime < cl.time) beam counts as a free slot", () => {
    cl.time = 100;
    // occupy every earlier slot with a still-active beam so the free-slot
    // loop is forced past them and must reach (and choose) slot 2
    for (let i = 0; i < 2; i++) {
      cl_beams[i].model = new ModelT();
      cl_beams[i].entity = 500 + i;
      cl_beams[i].endtime = cl.time + 1000;
    }
    cl_beams[2].model = new ModelT();
    cl_beams[2].entity = 1;
    cl_beams[2].endtime = 1; // long expired

    beginTEntMessage();
    MSG_WriteShort(net_message, 42);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_BeginReading();

    const m = new ModelT();
    cl_tent.CL_ParseBeam(m);

    expect(cl_beams[2].model).toBe(m);
    expect(cl_beams[2].entity).toBe(42);
  });

  test("prints \"beam list overflow!\" and changes nothing once every slot is taken by an unrelated, still-active entity", () => {
    cl.time = 100;
    for (const b of cl_beams) {
      b.entity = 999;
      b.model = new ModelT();
      b.endtime = cl.time + 1000;
    }
    const snapshotModels = cl_beams.map((b) => b.model);
    const snapshotEntities = cl_beams.map((b) => b.entity);

    beginTEntMessage();
    MSG_WriteShort(net_message, 1); // does not match any of the 999s
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_BeginReading();

    expect(() => cl_tent.CL_ParseBeam(new ModelT())).not.toThrow();
    expect(cl_beams.map((b) => b.model)).toEqual(snapshotModels);
    expect(cl_beams.map((b) => b.entity)).toEqual(snapshotEntities);
  });
});

describe("CL_ParseTEnt: particle-only cases", () => {
  test("TE_WIZSPIKE: color 20, count 30, wizhit sound", () => {
    cl_tent.CL_InitTEnts();
    particleCalls.length = 0;
    soundCalls.length = 0;
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_WIZSPIKE);
    MSG_WriteCoord(net_message, 1);
    MSG_WriteCoord(net_message, 2);
    MSG_WriteCoord(net_message, 3);
    parseTEnt();

    expect(particleCalls).toEqual([{ fn: "R_RunParticleEffect", args: [[1, 2, 3], [0, 0, 0], 20, 30] }]);
    expect(soundCalls).toEqual([{ entnum: -1, entchannel: 0, sfx: "wizard/hit.wav", origin: [1, 2, 3], fvol: 1, attenuation: 1 }]);
  });

  test("TE_KNIGHTSPIKE: color 226, count 20, knighthit sound", () => {
    cl_tent.CL_InitTEnts();
    particleCalls.length = 0;
    soundCalls.length = 0;
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_KNIGHTSPIKE);
    MSG_WriteCoord(net_message, 4);
    MSG_WriteCoord(net_message, 5);
    MSG_WriteCoord(net_message, 6);
    parseTEnt();

    expect(particleCalls).toEqual([{ fn: "R_RunParticleEffect", args: [[4, 5, 6], [0, 0, 0], 226, 20] }]);
    expect(soundCalls).toEqual([{ entnum: -1, entchannel: 0, sfx: "hknight/hit.wav", origin: [4, 5, 6], fvol: 1, attenuation: 1 }]);
  });

  test("TE_GUNSHOT: color 0, count 20, no sound", () => {
    particleCalls.length = 0;
    soundCalls.length = 0;
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_GUNSHOT);
    MSG_WriteCoord(net_message, 7);
    MSG_WriteCoord(net_message, 8);
    MSG_WriteCoord(net_message, 9);
    parseTEnt();

    expect(particleCalls).toEqual([{ fn: "R_RunParticleEffect", args: [[7, 8, 9], [0, 0, 0], 0, 20] }]);
    expect(soundCalls).toEqual([]);
  });

  test("TE_LAVASPLASH: R_LavaSplash only", () => {
    particleCalls.length = 0;
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_LAVASPLASH);
    MSG_WriteCoord(net_message, 10);
    MSG_WriteCoord(net_message, 11);
    MSG_WriteCoord(net_message, 12);
    parseTEnt();

    expect(particleCalls).toEqual([{ fn: "R_LavaSplash", args: [[10, 11, 12]] }]);
  });

  test("TE_TELEPORT: R_TeleportSplash only", () => {
    particleCalls.length = 0;
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_TELEPORT);
    MSG_WriteCoord(net_message, 13);
    MSG_WriteCoord(net_message, 14);
    MSG_WriteCoord(net_message, 15);
    parseTEnt();

    expect(particleCalls).toEqual([{ fn: "R_TeleportSplash", args: [[13, 14, 15]] }]);
  });

  test("TE_TAREXPLOSION: R_BlobExplosion + r_exp3 sound, no dlight", () => {
    cl_tent.CL_InitTEnts();
    particleCalls.length = 0;
    soundCalls.length = 0;
    dlightCalls.length = 0;
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_TAREXPLOSION);
    MSG_WriteCoord(net_message, 16);
    MSG_WriteCoord(net_message, 17);
    MSG_WriteCoord(net_message, 18);
    parseTEnt();

    expect(particleCalls).toEqual([{ fn: "R_BlobExplosion", args: [[16, 17, 18]] }]);
    expect(soundCalls).toEqual([{ entnum: -1, entchannel: 0, sfx: "weapons/r_exp3.wav", origin: [16, 17, 18], fvol: 1, attenuation: 1 }]);
    expect(dlightCalls).toEqual([]);
  });
});

describe("CL_ParseTEnt: TE_SPIKE / TE_SUPERSPIKE (rand()%5 tink/ric sound selection)", () => {
  test("TE_SPIKE runs a color-0/count-10 particle effect and always picks one of the four spike sounds", () => {
    cl_tent.CL_InitTEnts();
    for (let i = 0; i < 25; i++) {
      particleCalls.length = 0;
      soundCalls.length = 0;
      beginTEntMessage();
      MSG_WriteByte(net_message, TE_SPIKE);
      MSG_WriteCoord(net_message, 1);
      MSG_WriteCoord(net_message, 1);
      MSG_WriteCoord(net_message, 1);
      parseTEnt();

      expect(particleCalls).toEqual([{ fn: "R_RunParticleEffect", args: [[1, 1, 1], [0, 0, 0], 0, 10] }]);
      expect(soundCalls.length).toBe(1);
      const sfx = soundCalls[0]?.sfx;
      expect(typeof sfx).toBe("string");
      if (typeof sfx === "string") {
        expect(["weapons/tink1.wav", "weapons/ric1.wav", "weapons/ric2.wav", "weapons/ric3.wav"]).toContain(sfx);
      }
    }
  });

  test("TE_SUPERSPIKE runs a color-0/count-20 particle effect and always picks one of the four spike sounds", () => {
    cl_tent.CL_InitTEnts();
    for (let i = 0; i < 25; i++) {
      particleCalls.length = 0;
      soundCalls.length = 0;
      beginTEntMessage();
      MSG_WriteByte(net_message, TE_SUPERSPIKE);
      MSG_WriteCoord(net_message, 2);
      MSG_WriteCoord(net_message, 2);
      MSG_WriteCoord(net_message, 2);
      parseTEnt();

      expect(particleCalls).toEqual([{ fn: "R_RunParticleEffect", args: [[2, 2, 2], [0, 0, 0], 0, 20] }]);
      expect(soundCalls.length).toBe(1);
      const sfx = soundCalls[0]?.sfx;
      expect(typeof sfx).toBe("string");
      if (typeof sfx === "string") {
        expect(["weapons/tink1.wav", "weapons/ric1.wav", "weapons/ric2.wav", "weapons/ric3.wav"]).toContain(sfx);
      }
    }
  });
});

describe("CL_ParseTEnt: TE_EXPLOSION / TE_EXPLOSION2 (350/0.5/300 dlight)", () => {
  test("TE_EXPLOSION: particle explosion, r_exp3 sound, dlight radius 350 / die cl.time+0.5 / decay 300", () => {
    cl_tent.CL_InitTEnts();
    particleCalls.length = 0;
    soundCalls.length = 0;
    dlightCalls.length = 0;
    cl.time = 12;

    beginTEntMessage();
    MSG_WriteByte(net_message, TE_EXPLOSION);
    MSG_WriteCoord(net_message, 1);
    MSG_WriteCoord(net_message, 2);
    MSG_WriteCoord(net_message, 3);
    parseTEnt();

    expect(particleCalls).toEqual([{ fn: "R_ParticleExplosion", args: [[1, 2, 3]] }]);
    expect(soundCalls).toEqual([{ entnum: -1, entchannel: 0, sfx: "weapons/r_exp3.wav", origin: [1, 2, 3], fvol: 1, attenuation: 1 }]);

    expect(dlightCalls.length).toBe(1);
    expect(dlightCalls[0]?.key).toBe(0);
    const dl = dlightCalls[0]?.dlight;
    if (!dl) throw new Error("unreachable");
    expect(Array.from(dl.origin)).toEqual([1, 2, 3]);
    expect(dl.radius).toBe(350);
    expect(dl.die).toBeCloseTo(12.5, 5);
    expect(dl.decay).toBe(300);
  });

  test("TE_EXPLOSION2: color-mapped particle explosion with colorStart/colorLength bytes, same dlight shape", () => {
    cl_tent.CL_InitTEnts();
    particleCalls.length = 0;
    soundCalls.length = 0;
    dlightCalls.length = 0;
    cl.time = 20;

    beginTEntMessage();
    MSG_WriteByte(net_message, TE_EXPLOSION2);
    MSG_WriteCoord(net_message, 4);
    MSG_WriteCoord(net_message, 5);
    MSG_WriteCoord(net_message, 6);
    MSG_WriteByte(net_message, 200); // colorStart
    MSG_WriteByte(net_message, 8); // colorLength
    parseTEnt();

    expect(particleCalls).toEqual([{ fn: "R_ParticleExplosion2", args: [[4, 5, 6], 200, 8] }]);
    expect(soundCalls).toEqual([{ entnum: -1, entchannel: 0, sfx: "weapons/r_exp3.wav", origin: [4, 5, 6], fvol: 1, attenuation: 1 }]);

    expect(dlightCalls.length).toBe(1);
    const dl = dlightCalls[0]?.dlight;
    if (!dl) throw new Error("unreachable");
    expect(dl.radius).toBe(350);
    expect(dl.die).toBeCloseTo(20.5, 5);
    expect(dl.decay).toBe(300);
  });
});

describe("CL_ParseTEnt: lightning bolt / beam dispatch (Mod_ForName + CL_ParseBeam)", () => {
  test.each([
    [TE_LIGHTNING1, "progs/bolt.mdl"],
    [TE_LIGHTNING2, "progs/bolt2.mdl"],
    [TE_LIGHTNING3, "progs/bolt3.mdl"],
    [TE_BEAM, "progs/beam.mdl"],
  ])("type %i loads %s with crash=true and stores a beam ending at cl.time+0.2", (type, path) => {
    modForNameCalls.length = 0;
    cl.time = 8;

    beginTEntMessage();
    MSG_WriteByte(net_message, type);
    MSG_WriteShort(net_message, 3); // entity
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 90);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    parseTEnt();

    expect(modForNameCalls).toEqual([{ name: path, crash: true }]);
    const b = cl_beams.find((x) => x.entity === 3 && x.model === lastFakeModel);
    expect(b).toBeDefined();
    if (!b) throw new Error("unreachable");
    expect(b.endtime).toBeCloseTo(8.2, 5);
    expect(Array.from(b.end)).toEqual([90, 0, 0]);
  });
});

describe("CL_ParseTEnt: unknown type", () => {
  test("throws SysError with the exact C message", () => {
    beginTEntMessage();
    MSG_WriteByte(net_message, 250);
    MSG_BeginReading();
    expect(() => cl_tent.CL_ParseTEnt()).toThrow(SysError);

    beginTEntMessage();
    MSG_WriteByte(net_message, 250);
    MSG_BeginReading();
    expect(() => cl_tent.CL_ParseTEnt()).toThrow("CL_ParseTEnt: bad type");
  });
});

describe("CL_NewTempEntity", () => {
  test("returns null once MAX_VISEDICTS is reached", () => {
    cl_tent.CL_UpdateTEnts(); // resets num_temp_entities to 0 (no active beams)
    clState.cl_numvisedicts = MAX_VISEDICTS;
    expect(cl_tent.CL_NewTempEntity()).toBeNull();
  });

  test("returns null once MAX_TEMP_ENTITIES is reached; pushes into cl_visedicts and sets colormap from vid.colormap otherwise", () => {
    cl_tent.CL_UpdateTEnts();
    clState.cl_numvisedicts = 0;
    vid.colormap = new Uint8Array([9, 9, 9]);

    let last = null;
    for (let i = 0; i < MAX_TEMP_ENTITIES; i++) {
      last = cl_tent.CL_NewTempEntity();
      expect(last).not.toBeNull();
    }
    expect(cl_tent.CL_NewTempEntity()).toBeNull();
    expect(clState.cl_numvisedicts).toBe(MAX_TEMP_ENTITIES);
    expect(cl_visedicts[0]).not.toBeNull();
    if (!last) throw new Error("unreachable");
    expect(last.colormap).toBe(vid.colormap);
  });
});

describe("CL_UpdateTEnts", () => {
  test("spawns ceil(dist/30) entities along a straight beam, with truncated yaw/pitch and a rand()%360 roll", () => {
    cl.time = 5;
    const b = cl_beams[0];
    b.model = new ModelT();
    b.endtime = cl.time + 1;
    b.entity = 123; // not cl.viewentity, so start is not overwritten
    cl.viewentity = 999;
    b.start[0] = 0;
    b.start[1] = 0;
    b.start[2] = 0;
    b.end[0] = 90;
    b.end[1] = 0;
    b.end[2] = 0;

    cl_tent.CL_UpdateTEnts();

    expect(clState.cl_numvisedicts).toBe(3); // ceil(90/30)
    const origins = cl_visedicts.slice(0, 3).map((e) => (e ? Array.from(e.origin) : null));
    expect(origins).toEqual([
      [0, 0, 0],
      [30, 0, 0],
      [60, 0, 0],
    ]);
    for (const e of cl_visedicts.slice(0, 3)) {
      if (!e) throw new Error("unreachable");
      expect(e.angles[0]).toBeCloseTo(0, 5); // pitch
      expect(e.angles[1]).toBeCloseTo(0, 5); // yaw
      expect(e.angles[2]).toBeGreaterThanOrEqual(0);
      expect(e.angles[2]).toBeLessThan(360);
      expect(Number.isInteger(e.angles[2])).toBe(true);
      expect(e.model).toBe(b.model);
    }
  });

  test("a purely-vertical beam takes the dist[0]==dist[1]==0 branch: yaw 0, pitch 90 (or 270 pointing down)", () => {
    cl.time = 5;
    const up = cl_beams[0];
    up.model = new ModelT();
    up.endtime = cl.time + 1;
    up.entity = -1; // != cl.viewentity (0), so the start isn't overwritten from cl_entities
    up.start[0] = 0;
    up.start[1] = 0;
    up.start[2] = 0;
    up.end[0] = 0;
    up.end[1] = 0;
    up.end[2] = 50;

    cl_tent.CL_UpdateTEnts();
    expect(clState.cl_numvisedicts).toBe(2); // ceil(50/30)
    const e0 = cl_visedicts[0];
    if (!e0) throw new Error("unreachable");
    expect(e0.angles[1]).toBe(0); // yaw
    expect(e0.angles[0]).toBe(90); // pitch: dist[2] > 0

    resetBeams();
    clState.cl_numvisedicts = 0;
    cl_tent.CL_UpdateTEnts();

    const down = cl_beams[0];
    down.model = new ModelT();
    down.endtime = cl.time + 1;
    down.entity = -1; // != cl.viewentity (0)
    down.start[0] = 0;
    down.start[1] = 0;
    down.start[2] = 50;
    down.end[0] = 0;
    down.end[1] = 0;
    down.end[2] = 0;

    cl_tent.CL_UpdateTEnts();
    const e1 = cl_visedicts[0];
    if (!e1) throw new Error("unreachable");
    expect(e1.angles[1]).toBe(0);
    expect(e1.angles[0]).toBe(270); // pitch: dist[2] < 0
  });

  test("updates the beam start from cl_entities[cl.viewentity].origin when b.entity === cl.viewentity", () => {
    cl.time = 5;
    cl.viewentity = 7;
    cl_entities[7].origin[0] = 10;
    cl_entities[7].origin[1] = 20;
    cl_entities[7].origin[2] = 30;

    const b = cl_beams[0];
    b.model = new ModelT();
    b.endtime = cl.time + 1;
    b.entity = 7;
    b.start[0] = 0; // stale -- must be refreshed from cl_entities before use
    b.start[1] = 0;
    b.start[2] = 0;
    b.end[0] = 40;
    b.end[1] = 20;
    b.end[2] = 30; // 30 units from the refreshed start -> exactly one entity

    cl_tent.CL_UpdateTEnts();

    expect(clState.cl_numvisedicts).toBe(1);
    const e0 = cl_visedicts[0];
    if (!e0) throw new Error("unreachable");
    expect(Array.from(e0.origin)).toEqual([10, 20, 30]);
  });

  test("skips a beam with no model or an expired endtime", () => {
    cl.time = 5;
    cl_beams[0].model = null; // no model -> skipped
    cl_beams[1].model = new ModelT();
    cl_beams[1].endtime = 1; // expired (< cl.time) -> skipped
    cl_beams[1].end[0] = 90;

    cl_tent.CL_UpdateTEnts();
    expect(clState.cl_numvisedicts).toBe(0);
  });

  test("stops early (returns) once MAX_TEMP_ENTITIES is exhausted, without throwing", () => {
    cl.time = 5;
    const b = cl_beams[0];
    b.model = new ModelT();
    b.endtime = cl.time + 1;
    b.start[0] = 0;
    b.start[1] = 0;
    b.start[2] = 0;
    // far longer than MAX_TEMP_ENTITIES*30
    b.end[0] = (MAX_TEMP_ENTITIES + 10) * 30;
    b.end[1] = 0;
    b.end[2] = 0;

    expect(() => cl_tent.CL_UpdateTEnts()).not.toThrow();
    expect(clState.cl_numvisedicts).toBe(MAX_TEMP_ENTITIES);
  });
});

describe("client.h constants this unit relies on", () => {
  test("MAX_BEAMS / MAX_TEMP_ENTITIES / MAX_VISEDICTS", () => {
    expect(MAX_BEAMS).toBe(24);
    expect(MAX_TEMP_ENTITIES).toBe(64);
    expect(MAX_VISEDICTS).toBe(256);
  });
});
