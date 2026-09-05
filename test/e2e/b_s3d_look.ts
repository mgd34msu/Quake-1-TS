import { boot, frames, exec, tap, key, check, summary, keyState, Cvar_VariableValue } from "./b_lib";
import { KeydestT } from "../../src/client/keys";
import { cl } from "../../src/client/client";
import { PITCH, YAW } from "../../src/common/quakedef";
import { inputBackend } from "../../src/client/input";
import * as sdl from "../../src/platform/sdl";

const BASE = "/home/buzzkill/Projects/qfiles/q1-basedir";

boot(["-basedir", BASE, "-game", "e2e_b", "-nosound"]);
frames(5);
exec("disconnect", 3);
exec("map start", 20);
keyState.key_dest = KeydestT.key_game;
frames(5);

// ---- keyboard look -------------------------------------------------------
const p0 = cl.viewangles[PITCH];
exec("+lookup", 1);
frames(10);
exec("-lookup", 1);
const p1 = cl.viewangles[PITCH];
check("+lookup pitches the view up (pitch decreases)", p1 < p0, `pitch ${p0} -> ${p1}`);

exec("+lookdown", 1);
frames(10);
exec("-lookdown", 1);
const p2 = cl.viewangles[PITCH];
check("+lookdown pitches back down", p2 > p1, `pitch ${p1} -> ${p2}`);

exec("centerview", 2);
frames(3);
check("centerview zeroes the pitch", Math.abs(cl.viewangles[PITCH]) < 1e-6, `pitch=${cl.viewangles[PITCH]}`);

const y0 = cl.viewangles[YAW];
exec("+left", 1);
frames(10);
exec("-left", 1);
const y1 = cl.viewangles[YAW];
check("+left turns the view (yaw increases)", y1 > y0, `yaw ${y0} -> ${y1}`);

// cl_yawspeed scales the turn rate
exec("cl_yawspeed 280", 1);
const y2 = cl.viewangles[YAW];
exec("+left", 1);
frames(10);
exec("-left", 1);
const y3 = cl.viewangles[YAW];
check("cl_yawspeed 280 turns roughly twice as fast", y3 - y2 > (y1 - y0) * 1.5, `delta140=${(y1 - y0).toFixed(2)} delta280=${(y3 - y2).toFixed(2)}`);
exec("cl_yawspeed 140", 1);

// ---- mouse seam ----------------------------------------------------------
// IN_Move in src/platform/sdl.ts reads its deltas straight from
// SDL_GetRelativeMouseState and bails out at `if (!l || !mouse_active) return;`.
// mouse_active only becomes true inside IN_ActivateMouse, which needs a real
// SDL window with relative-mouse mode; under SDL_VIDEODRIVER=dummy/offscreen
// it never does. sdl.ts exports no mouse_x/mouse_y holder and no injection
// hook, so a headless harness cannot feed synthetic motion through the real
// backend. Report the exported surface so the gap is on the record.
const sdlExports = Object.keys(sdl).filter((k) => /mouse|delta|rel|motion/i.test(k));
console.log("  src/platform/sdl.ts mouse-related exports:", sdlExports.join(", ") || "(none)");
check("a synthetic-mouse-delta seam exists in src/platform/sdl.ts", sdlExports.some((k) => /^(mouse_x|mouse_y|mouseState|injectMouse)/.test(k)), `exports=${sdlExports.join(",") || "(none)"} -- IN_Move returns early while mouse_active is false`);
check("inputBackend.current is installed", inputBackend.current !== null, "");

// The cvars IN_Move reads are all registered and settable, which is as far as
// a headless run can go.
for (const n of ["sensitivity", "m_pitch", "m_yaw", "m_forward", "m_side", "m_filter", "lookspring", "lookstrafe", "_windowed_mouse"]) {
  const { Cvar_FindVar } = require("../../src/common/cvar");
  check(`IN_Move cvar ${n} registered`, Cvar_FindVar(n) !== null, `value=${Cvar_VariableValue(n)}`);
}

summary("S3d look/mouse");
process.exit(0);
