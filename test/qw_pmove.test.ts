import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { Mod_ForName, Mod_Init, Mod_ClearAll, type ModelT } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { CONTENTS_EMPTY, CONTENTS_SOLID } from "../src/common/bspfile";
import { vec3, VectorCopy } from "../src/common/mathlib";
import {
  JumpButton,
  NudgePosition,
  PM_AirMove,
  PM_CatagorizePosition,
  PM_ClipVelocity,
  PM_FlyMove,
  PM_Friction,
  PlayerMove,
  Pmove_Init,
  forward,
  movevars,
  pmState,
  pmove,
  player_maxs,
  player_mins,
} from "../src/qw/pmove";
import { PM_HullForBox, PM_PointContents, PM_TestPlayerPosition, PM_PlayerMove } from "../src/qw/pmovetst";

const scratchRoot = "/tmp/claude-1000/-home-buzzkill-Projects-quake-1-ts/3ee4d8d6-89b6-415b-a497-e7e5aa27a1a6/scratchpad";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qw-pmove-test-"));
const baseDir = join(scratchDir, "quake");

// test/support/bsp_builder.ts's map, seen through the hulls pmove uses:
//   hull1 (PM_PlayerMove / PM_TestPlayerPosition): z < 0 is CONTENTS_SOLID,
//     z >= 0 is CONTENTS_EMPTY everywhere -- an infinite floor at z = 0.
//   hull0 (PM_PointContents): the same split through node 0 / leafs 0 and 1.
// So an origin of (x, y, 0) is a player standing on the floor.
let world: ModelT;

const BUTTON_JUMP = 2;

// QW server defaults (QW/server/sv_main.c's sv_gravity/sv_stopspeed/... cvars,
// copied into movevars_t by SV_SetMoveVars and sent to the client).
function setQwDefaultMovevars(): void {
  movevars.gravity = 800;
  movevars.stopspeed = 100;
  movevars.maxspeed = 320;
  movevars.spectatormaxspeed = 500;
  movevars.accelerate = 10;
  movevars.airaccelerate = 10;
  movevars.wateraccelerate = 10;
  movevars.friction = 4;
  movevars.waterfriction = 4;
  movevars.entgravity = 1;
}

function clearMovevars(): void {
  movevars.gravity = 0;
  movevars.stopspeed = 0;
  movevars.maxspeed = 0;
  movevars.spectatormaxspeed = 0;
  movevars.accelerate = 0;
  movevars.airaccelerate = 0;
  movevars.wateraccelerate = 0;
  movevars.friction = 0;
  movevars.waterfriction = 0;
  movevars.entgravity = 0;
}

function resetPmove(): void {
  pmove.sequence = 0;
  pmove.origin.fill(0);
  pmove.angles.fill(0);
  pmove.velocity.fill(0);
  pmove.oldbuttons = 0;
  pmove.waterjumptime = 0;
  pmove.dead = false;
  pmove.spectator = 0;
  pmove.numphysent = 0;
  for (const pe of pmove.physents) {
    pe.origin.fill(0);
    pe.model = null;
    pe.mins.fill(0);
    pe.maxs.fill(0);
    pe.info = 0;
  }
  pmove.cmd.msec = 0;
  pmove.cmd.angles.fill(0);
  pmove.cmd.forwardmove = 0;
  pmove.cmd.sidemove = 0;
  pmove.cmd.upmove = 0;
  pmove.cmd.buttons = 0;
  pmove.cmd.impulse = 0;
  pmove.numtouch = 0;
  pmove.touchindex.fill(0);

  pmState.onground = 0;
  pmState.waterlevel = 0;
  pmState.watertype = 0;
  pmState.frametime = 0;

  forward.fill(0);
}

// physent 0 is the world, exactly as pmove.h's "0 should be the world".
function setWorldPhysent(): void {
  pmove.physents[0].model = world;
  pmove.physents[0].origin.fill(0);
  pmove.numphysent = 1;
}

afterAll(() => {
  resetPmove();
  clearMovevars();
  Mod_ClearAll();
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  // gfx/pop.lmp inside id1/pak0.pak: the registered-version check must pass
  // before COM_FindFile will search a loose "maps/world.bsp" path at all.
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
  world = loaded;

  Pmove_Init();
});

beforeEach(() => {
  resetPmove();
  setQwDefaultMovevars();
  setWorldPhysent();
});

describe("pmove_types", () => {
  test("player_mins / player_maxs are the QW hull sizes", () => {
    expect(Array.from(player_mins)).toEqual([-16, -16, -24]);
    expect(Array.from(player_maxs)).toEqual([16, 16, 32]);
  });

  test("physents array is MAX_PHYSENTS long and touchindex matches it", () => {
    expect(pmove.physents.length).toBe(32);
    expect(pmove.touchindex.length).toBe(32);
  });
});

describe("PM_PointContents", () => {
  test("reads both leafs of the world hull0", () => {
    expect(PM_PointContents(vec3(0, 0, 10))).toBe(CONTENTS_EMPTY);
    expect(PM_PointContents(vec3(0, 0, -10))).toBe(CONTENTS_SOLID);
    expect(PM_PointContents(vec3(-500, 250, 1))).toBe(CONTENTS_EMPTY);
    expect(PM_PointContents(vec3(-500, 250, -1))).toBe(CONTENTS_SOLID);
  });
});

describe("PM_TestPlayerPosition", () => {
  test("true above the floor, false below it", () => {
    expect(PM_TestPlayerPosition(vec3(0, 0, 0))).toBe(true);
    expect(PM_TestPlayerPosition(vec3(0, 0, 4))).toBe(true);
    expect(PM_TestPlayerPosition(vec3(0, 0, -0.5))).toBe(false);
  });

  test("a modelless physent becomes a box hull expanded by the player size", () => {
    pmove.physents[1].model = null;
    VectorCopy(vec3(100, 0, 0), pmove.physents[1].origin);
    VectorCopy(vec3(-16, -16, -16), pmove.physents[1].mins);
    VectorCopy(vec3(16, 16, 16), pmove.physents[1].maxs);
    pmove.numphysent = 2;

    // box hull spans pe.origin + (mins - player_maxs) .. pe.origin + (maxs - player_mins)
    // = x in [68, 132], so x = 100 is inside and x = 60 is outside.
    expect(PM_TestPlayerPosition(vec3(100, 0, 0))).toBe(false);
    expect(PM_TestPlayerPosition(vec3(60, 0, 0))).toBe(true);
  });
});

describe("PM_HullForBox", () => {
  test("returns the shared box hull with the six plane distances filled in", () => {
    const hull = PM_HullForBox(vec3(-1, -2, -3), vec3(4, 5, 6));
    expect(hull.firstclipnode).toBe(0);
    expect(hull.lastclipnode).toBe(5);
    expect(hull.planes.map((p) => p.dist)).toEqual([4, -1, 5, -2, 6, -3]);
    expect(hull.planes.map((p) => p.type)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("PM_ClipVelocity", () => {
  test("floor plane sets bit 1 and cancels the downward component", () => {
    const out = vec3();
    const blocked = PM_ClipVelocity(vec3(100, 0, -200), vec3(0, 0, 1), out, 1);
    expect(blocked).toBe(1);
    expect(out[0]).toBeCloseTo(100, 5);
    expect(out[2]).toBe(0);
  });

  test("vertical wall sets bit 2", () => {
    const out = vec3();
    const blocked = PM_ClipVelocity(vec3(300, 0, -100), vec3(-1, 0, 0), out, 1);
    expect(blocked).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[2]).toBeCloseTo(-100, 5);
  });

  test("a ceiling plane sets neither bit", () => {
    const out = vec3();
    expect(PM_ClipVelocity(vec3(0, 0, 100), vec3(0, 0, -1), out, 1)).toBe(0);
  });

  test("STOP_EPSILON snaps tiny components to zero", () => {
    const out = vec3();
    PM_ClipVelocity(vec3(0.05, -0.09, 0), vec3(0, 0, 1), out, 1);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe("PM_CatagorizePosition", () => {
  test("standing on the floor gives onground 0 and waterlevel 0", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    PM_CatagorizePosition();
    expect(pmState.onground).toBe(0);
    expect(pmState.waterlevel).toBe(0);
    expect(pmState.watertype).toBe(CONTENTS_EMPTY);
  });

  test("well above the floor gives onground -1", () => {
    VectorCopy(vec3(0, 0, 64), pmove.origin);
    PM_CatagorizePosition();
    expect(pmState.onground).toBe(-1);
  });

  test("velocity[2] > 180 short-circuits the ground trace", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    VectorCopy(vec3(0, 0, 181), pmove.velocity);
    PM_CatagorizePosition();
    expect(pmState.onground).toBe(-1);
  });
});

describe("PM_FlyMove", () => {
  test("falling into the solid half stops on the floor with blocked bit 1", () => {
    VectorCopy(vec3(0, 0, 10), pmove.origin);
    VectorCopy(vec3(0, 0, -400), pmove.velocity);
    pmState.frametime = 0.05;

    const blocked = PM_FlyMove();

    expect(blocked & 1).toBe(1);
    expect(pmove.origin[2]).toBeCloseTo(0.03125, 5); // DIST_EPSILON off the plane
    expect(pmove.numtouch).toBe(1);
    expect(pmove.touchindex[0]).toBe(0); // the world physent
  });

  test("a modelless physent blocks the move and lands in touchindex", () => {
    pmove.physents[1].model = null;
    VectorCopy(vec3(100, 0, 0), pmove.physents[1].origin);
    VectorCopy(vec3(-16, -16, -16), pmove.physents[1].mins);
    VectorCopy(vec3(16, 16, 16), pmove.physents[1].maxs);
    pmove.numphysent = 2;

    VectorCopy(vec3(50, 0, 0), pmove.origin);
    VectorCopy(vec3(1000, 0, 0), pmove.velocity);
    pmState.frametime = 0.05;

    const blocked = PM_FlyMove();

    expect(blocked & 2).toBe(2); // vertical plane, normal[2] == 0
    expect(pmove.numtouch).toBe(1);
    expect(pmove.touchindex[0]).toBe(1);
    expect(pmove.origin[0]).toBeCloseTo(67.96875, 4);
  });

  test("starting inside solid zeroes the velocity and returns 3", () => {
    VectorCopy(vec3(0, 0, -32), pmove.origin);
    VectorCopy(vec3(100, 0, 0), pmove.velocity);
    pmState.frametime = 0.05;

    expect(PM_FlyMove()).toBe(3);
    expect(Array.from(pmove.velocity)).toEqual([0, 0, 0]);
  });
});

describe("PM_Friction", () => {
  test("speed under 1 zeroes x and y but leaves z", () => {
    VectorCopy(vec3(0.2, -0.3, 0.4), pmove.velocity);
    pmState.onground = 0;
    pmState.frametime = 0.05;
    PM_Friction();
    expect(pmove.velocity[0]).toBe(0);
    expect(pmove.velocity[1]).toBe(0);
    expect(pmove.velocity[2]).toBeCloseTo(0.4, 5);
  });

  test("ground friction scales by control * friction * frametime", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    VectorCopy(vec3(320, 0, 0), pmove.velocity);
    pmState.onground = 0;
    pmState.frametime = 0.05;
    PM_Friction();
    // control = 320 (> stopspeed), drop = 320*4*0.05 = 64
    expect(pmove.velocity[0]).toBeCloseTo(256, 3);
  });

  test("waterjumptime skips friction entirely", () => {
    VectorCopy(vec3(320, 0, 0), pmove.velocity);
    pmove.waterjumptime = 2;
    pmState.onground = 0;
    pmState.frametime = 0.05;
    PM_Friction();
    expect(pmove.velocity[0]).toBe(320);
  });
});

describe("PM_AirMove / PM_Accelerate", () => {
  test("one grounded frame accelerates to accel * frametime * wishspeed", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    pmState.onground = 0;
    pmState.frametime = 0.05;
    forward[0] = 1;
    PM_AirMove();
    // accelspeed = 10 * 0.05 * 320 = 160
    expect(pmove.velocity[0]).toBe(0); // no forwardmove, so no wish velocity
    pmove.cmd.forwardmove = 400;
    forward[0] = 1;
    forward[1] = 0;
    forward[2] = 0;
    PM_AirMove();
    expect(pmove.velocity[0]).toBeCloseTo(160, 3);
  });
});

describe("PlayerMove", () => {
  test("running forward converges on movevars.maxspeed and never exceeds it", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    pmove.cmd.msec = 50;
    pmove.cmd.forwardmove = 400;

    let lastX = pmove.origin[0];
    for (let i = 0; i < 20; i++) {
      PlayerMove();
      expect(pmove.origin[0]).toBeGreaterThan(lastX);
      lastX = pmove.origin[0];

      const speed = Math.hypot(pmove.velocity[0], pmove.velocity[1], pmove.velocity[2]);
      expect(speed).toBeLessThanOrEqual(movevars.maxspeed + 1e-3);
      expect(pmState.onground).toBe(0);
    }

    expect(pmove.velocity[0]).toBeCloseTo(320, 3);
    expect(pmove.velocity[1]).toBeCloseTo(0, 5);
  });

  test("jump adds 270 once, gravity brings it back, and the pogo guard holds", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    pmove.cmd.msec = 50;
    pmove.cmd.buttons = BUTTON_JUMP;

    PlayerMove();
    // 270 from JumpButton, then one frame of gravity (800 * 0.05 = 40)
    expect(pmove.velocity[2]).toBeCloseTo(230, 3);
    expect(pmState.onground).toBe(-1);
    expect(pmove.oldbuttons & BUTTON_JUMP).toBe(BUTTON_JUMP);

    let landedAt = -1;
    for (let i = 1; i < 30; i++) {
      PlayerMove();
      // the button is still held, so JumpButton must never fire again
      expect(pmove.velocity[2]).toBeLessThanOrEqual(230 + 1e-3);
      if (landedAt < 0 && pmState.onground === 0) landedAt = i;
    }

    expect(landedAt).toBeGreaterThan(0);
    expect(landedAt).toBeLessThan(20);
    expect(pmove.origin[2]).toBeCloseTo(0.03125, 4);
    expect(pmove.velocity[2]).toBe(0);
  });

  test("releasing and re-pressing jump jumps again", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    pmove.cmd.msec = 50;
    pmove.cmd.buttons = BUTTON_JUMP;
    PlayerMove();
    expect(pmove.oldbuttons & BUTTON_JUMP).toBe(BUTTON_JUMP);

    // land again
    pmove.cmd.buttons = 0;
    for (let i = 0; i < 30; i++) PlayerMove();
    expect(pmState.onground).toBe(0);
    expect(pmove.oldbuttons & BUTTON_JUMP).toBe(0);

    pmove.cmd.buttons = BUTTON_JUMP;
    PlayerMove();
    expect(pmove.velocity[2]).toBeCloseTo(230, 3);
  });

  test("JumpButton does not fire while dead, but still latches oldbuttons", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    pmove.dead = true;
    pmState.onground = 0;
    pmState.frametime = 0.05;
    JumpButton();
    expect(pmove.velocity[2]).toBe(0);
    expect(pmove.oldbuttons & BUTTON_JUMP).toBe(BUTTON_JUMP);
  });

  test("spectator mode flies straight through the solid half", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);
    pmove.spectator = 1;
    pmove.cmd.msec = 50;
    pmove.cmd.upmove = -400;

    for (let i = 0; i < 10; i++) PlayerMove();

    expect(pmove.origin[2]).toBeLessThan(-10);
    expect(PM_PointContents(pmove.origin)).toBe(CONTENTS_SOLID);
    expect(pmove.numtouch).toBe(0);
  });

  test("spectator speed is clamped to movevars.spectatormaxspeed", () => {
    pmove.spectator = 1;
    pmove.cmd.msec = 50;
    pmove.cmd.forwardmove = 5000;

    for (let i = 0; i < 40; i++) PlayerMove();

    const speed = Math.hypot(pmove.velocity[0], pmove.velocity[1], pmove.velocity[2]);
    expect(speed).toBeLessThanOrEqual(movevars.spectatormaxspeed + 1e-3);
  });
});

describe("NudgePosition", () => {
  test("unsticks an origin just inside the floor", () => {
    VectorCopy(vec3(0, 0, -0.1), pmove.origin);
    expect(PM_TestPlayerPosition(pmove.origin)).toBe(false);

    NudgePosition();

    expect(PM_TestPlayerPosition(pmove.origin)).toBe(true);
    expect(pmove.origin[2]).toBeCloseTo(0.025, 5);
  });

  test("leaves the origin alone when no nudge frees it", () => {
    VectorCopy(vec3(3, 4, -5), pmove.origin);
    NudgePosition();
    expect(Array.from(pmove.origin)).toEqual([3, 4, -5]);
  });

  test("a valid origin survives untouched", () => {
    VectorCopy(vec3(1.5, -2.5, 8), pmove.origin);
    NudgePosition();
    expect(Array.from(pmove.origin)).toEqual([1.5, -2.5, 8]);
  });
});

describe("PM_PlayerMove", () => {
  test("a clear move reports fraction 1 and ent -1", () => {
    const tr = PM_PlayerMove(vec3(0, 0, 16), vec3(64, 0, 16));
    expect(tr.fraction).toBe(1);
    expect(tr.ent).toBe(-1);
    expect(Array.from(tr.endpos)).toEqual([64, 0, 16]);
  });

  test("a move into the floor reports the world plane", () => {
    const tr = PM_PlayerMove(vec3(0, 0, 16), vec3(0, 0, -16));
    expect(tr.ent).toBe(0);
    expect(tr.plane.normal[2]).toBe(1);
    expect(tr.endpos[2]).toBeCloseTo(0.03125, 5);
  });

  test("a move that starts in solid reports startsolid with fraction 0", () => {
    const tr = PM_PlayerMove(vec3(0, 0, -16), vec3(0, 0, -32));
    expect(tr.startsolid).toBe(true);
    expect(tr.allsolid).toBe(true);
    expect(tr.fraction).toBe(0);
  });
});

describe("PlayerMove — stability", () => {
  test("no NaN in origin/velocity after 100 mixed-command frames", () => {
    VectorCopy(vec3(0, 0, 0), pmove.origin);

    pmove.physents[1].model = null;
    VectorCopy(vec3(120, 40, 0), pmove.physents[1].origin);
    VectorCopy(vec3(-32, -32, -32), pmove.physents[1].mins);
    VectorCopy(vec3(32, 32, 32), pmove.physents[1].maxs);
    pmove.numphysent = 2;

    for (let frame = 0; frame < 100; frame++) {
      pmove.cmd.msec = 10 + (frame % 5) * 10;
      pmove.cmd.forwardmove = (frame % 7) * 100 - 300;
      pmove.cmd.sidemove = (frame % 5) * 100 - 200;
      pmove.cmd.upmove = frame % 3 === 0 ? -400 : frame % 3 === 1 ? 400 : 0;
      pmove.cmd.buttons = frame % 4 === 0 ? BUTTON_JUMP : 0;
      pmove.cmd.angles[0] = (frame * 13) % 360;
      pmove.cmd.angles[1] = (frame * 47) % 360;
      pmove.cmd.angles[2] = (frame * 7) % 360;
      pmove.dead = frame % 31 === 30;

      PlayerMove();

      for (let i = 0; i < 3; i++) {
        expect(Number.isNaN(pmove.origin[i])).toBe(false);
        expect(Number.isNaN(pmove.velocity[i])).toBe(false);
        expect(Number.isFinite(pmove.origin[i])).toBe(true);
        expect(Number.isFinite(pmove.velocity[i])).toBe(true);
      }
      expect(pmove.numtouch).toBeLessThanOrEqual(pmove.touchindex.length);
    }
  });
});
