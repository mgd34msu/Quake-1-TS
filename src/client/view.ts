/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/view.c and WinQuake/view.h (GNU GPL v2 or later).

view.c -- player eye positioning

The view is allowed to move slightly from it's true position for bobbing,
but if it exceeds 8 pixels linear distance (spherical, not box), the list of
entities sent from the server may not include everything in the pvs, especially
when crossing a water boudnary.

Deviations from PORTING.md / the C source:
- view.c's three `#ifdef GLQUAKE` sites go through the renderer seam, per
  render.ts's GLQUAKE-site table:
    * view.c:481  V_CalcBlend (GL only)          -> Renderer.V_CalcBlend
    * view.c:526/613 the two V_UpdatePalette
      bodies                                     -> Renderer.V_UpdatePalette
    * view.c:1056 the !GLQUAKE crosshair at the
      tail of V_RenderView                       -> Renderer.V_DrawCrosshair
  `V_CalcBlend`, `V_UpdatePalette` and the crosshair call keep their C names
  here as one-line forwarders, so screen.c's `V_UpdatePalette ()` call site and
  V_RenderView's own body read exactly as the C does.
- The pieces both V_UpdatePalette bodies share are exported for the renderers
  to call, which is the ownership render.ts's header block assigns this file:
  `V_CalcPowerupCshift`, `V_CheckGamma`, `BuildGammaTable`, `gammatable`,
  `v_gamma`, `gl_cshiftpercent`, `crosshair`, `cl_crossx`, `cl_crossy`. The
  rest of the shared prologue (the `cl.cshifts` vs `cl.prev_cshifts`
  new-detection loop and the two `percent -= host_frametime*150 / *100` decays)
  reads only `cl.cshifts`/`cl.prev_cshifts` and `host.frametime`, which the
  renderers import from client.ts and host.ts directly; render.ts rules the two
  bodies are duplicated per renderer "exactly as the C duplicates it", so
  nothing here wraps that prologue in a function the C does not have.
- `byte ramps[3][256]` and `float v_blend[4]` are declared in view.h but
  defined under `#ifdef GLQUAKE` in view.c, and their only readers are the GL
  V_UpdatePalette body and gl_rmain.c's R_PolyBlend. render.ts's table puts
  both inside src/ref_gl, so neither is declared here.
- `cl_pitchdriftspeed` is declared `extern cvar_t cl_pitchdriftspeed;` in
  client.h and DEFINED NOWHERE in v1.09 -- no .c in WinQuake or QW defines or
  reads it. Declaring it here would register a cvar the C never registers, so
  it is not ported. Reported.
- `vec3_t forward, right, up` at view.c file scope are written by V_CalcRoll
  and read again by V_RenderView's lcd_x stereo branch, so they stay
  module-scope here. V_ParseDamage and V_CalcRefdef each declare their OWN
  `vec3_t forward, right, up` locals in the C, shadowing the file-scope ones;
  both keep local vectors here for the same reason.
- `cl.cshifts[CSHIFT_CONTENTS] = cshift_empty;` in V_SetContentsColor is a C
  struct assignment, i.e. a copy. `CshiftT` is a class, so `copyCshift(dst,
  src)` does the field copy; a reference assignment would alias cl.cshifts
  onto the cshift_* singletons and let V_UpdatePalette's decays write through
  them.
- `vid.buffer += vid.rowbytes>>1;` (V_RenderView's lcd_x branch) is pointer
  arithmetic on the 8-bit framebuffer. `vid.buffer` is a `Uint8Array | null`
  here, so the offset is `subarray(vid.rowbytes >> 1)` and the matching
  `vid.buffer -= vid.rowbytes>>1;` restores the saved original instead of
  subtracting. The C's asymmetric `r_refdef.vrect.height <<= 1;` (doubled in
  this branch and never halved again) is kept as written.
- `view->model = cl.model_precache[cl.stats[STAT_WEAPON]]` indexes a JS array
  with a server-supplied stat, which yields `undefined` rather than reading out
  of bounds; `?? null` maps that back onto the C's `model_t *`.
- `v_dmg_time`/`v_dmg_roll`/`v_dmg_pitch` are file-scope in the C. They are
  exported here as `export let` (read-only through an import binding) so a test
  can observe what V_ParseDamage computed; nothing outside this file assigns
  them, the same arrangement host_cmd.ts uses for `noclip_anglehack`.
- `V_Init` registers `hostClientHooks.vInit` at module load rather than from
  inside itself: host.c calls V_Init through that hook, so it has to be
  installed before Host_Init runs. Same pattern as cl_main.ts's
  `registerClMainHooks()` and screen.ts's `registerScreenHooks()`.
- `cl_forwardspeed` (cl_input.c) is imported from src/client/cl_input.ts, which
  imports `V_StartPitchDrift`/`V_StopPitchDrift` back from here. The cycle is
  real but harmless: neither module touches the other at module-evaluation
  time, only from inside functions.
- Not ported here, with the module that owns each:
  * `extern int in_forward, in_forward2, in_back;` is declared at view.c file
    scope and never used by view.c; the three kbuttons are cl_input.c's.
  * `Chase_Update`/`chase_active` (chase.c) -> src/client/chase.ts.
  * `V_CalcRoll` is also compiled into sv_user.c's SV_SetIdealPitch path in the
    C ("Used by view and sv_user"). src/server/sv_user.ts currently carries a
    private copy reading cl_rollspeed/cl_rollangle through Cvar_FindVar; it can
    now import this one. Follow-up: doing so also restores the C's side effect
    of sv_user's call writing this file's `forward`/`right`/`up`.
- Dropped: the `#if 1`/`#endif` around V_StartPitchDrift's `cl.laststop ==
  cl.time` guard (live code, the directive carries no branch), the commented-out
  `if (cl.inwater) value *= 6;` in V_CalcRoll, the `#if 0` model-name test above
  V_CalcRefdef's viewsize fudge, and the commented-out
  `view->origin[i] += right[i]*bob*0.4 / up[i]*bob*0.8` pair.
*/

import { Cmd_AddCommand, Cmd_Argv } from "../common/cmd";
import { Q_atoi } from "../common/common";
import { CvarT, Cvar_RegisterVariable, Cvar_Set } from "../common/cvar";
import { host, hostClientHooks } from "../common/host";
import { noclip_anglehack } from "../common/host_cmd";
import {
  AngleVectors,
  DotProduct,
  M_PI,
  type Vec3,
  VectorAdd,
  VectorCopy,
  VectorNormalize,
  VectorSubtract,
  anglemod,
  vec3,
} from "../common/mathlib";
import { CONTENTS_EMPTY, CONTENTS_LAVA, CONTENTS_SLIME, CONTENTS_SOLID } from "../common/bspfile";
import {
  IT_INVISIBILITY,
  IT_INVULNERABILITY,
  IT_QUAD,
  IT_SUIT,
  PITCH,
  ROLL,
  STAT_HEALTH,
  STAT_WEAPON,
  STAT_WEAPONFRAME,
  YAW,
} from "../common/quakedef";
import { MSG_ReadByte, MSG_ReadCoord } from "../common/sizebuf";
import { CSHIFT_BONUS, CSHIFT_CONTENTS, CSHIFT_DAMAGE, CSHIFT_POWERUP, CshiftT, cl, cl_entities, cls } from "./client";
import { Chase_Update, chase_active } from "./chase";
import { cl_forwardspeed } from "./cl_input";
import { conState } from "./console";
import type { EntityT } from "./render";
import { getRenderer, r_refdef } from "./render";
import { scr_viewsize } from "./screen";
import { vid } from "./vid";

export const lcd_x = new CvarT("lcd_x", "0");
export const lcd_yaw = new CvarT("lcd_yaw", "0");

export const scr_ofsx = new CvarT("scr_ofsx", "0", false);
export const scr_ofsy = new CvarT("scr_ofsy", "0", false);
export const scr_ofsz = new CvarT("scr_ofsz", "0", false);

export const cl_rollspeed = new CvarT("cl_rollspeed", "200");
export const cl_rollangle = new CvarT("cl_rollangle", "2.0");

export const cl_bob = new CvarT("cl_bob", "0.02", false);
export const cl_bobcycle = new CvarT("cl_bobcycle", "0.6", false);
export const cl_bobup = new CvarT("cl_bobup", "0.5", false);

export const v_kicktime = new CvarT("v_kicktime", "0.5", false);
export const v_kickroll = new CvarT("v_kickroll", "0.6", false);
export const v_kickpitch = new CvarT("v_kickpitch", "0.6", false);

export const v_iyaw_cycle = new CvarT("v_iyaw_cycle", "2", false);
export const v_iroll_cycle = new CvarT("v_iroll_cycle", "0.5", false);
export const v_ipitch_cycle = new CvarT("v_ipitch_cycle", "1", false);
export const v_iyaw_level = new CvarT("v_iyaw_level", "0.3", false);
export const v_iroll_level = new CvarT("v_iroll_level", "0.1", false);
export const v_ipitch_level = new CvarT("v_ipitch_level", "0.3", false);

export const v_idlescale = new CvarT("v_idlescale", "0", false);

export const crosshair = new CvarT("crosshair", "0", true);
export const cl_crossx = new CvarT("cl_crossx", "0", false);
export const cl_crossy = new CvarT("cl_crossy", "0", false);

export const gl_cshiftpercent = new CvarT("gl_cshiftpercent", "100", false);

export let v_dmg_time = 0;
export let v_dmg_roll = 0;
export let v_dmg_pitch = 0;

/*
===============
V_CalcRoll

Used by view and sv_user
===============
*/
const forward: Vec3 = vec3();
const right: Vec3 = vec3();
const up: Vec3 = vec3();

export function V_CalcRoll(angles: Vec3, velocity: Vec3): number {
  let sign: number;
  let side: number;
  let value: number;

  AngleVectors(angles, forward, right, up);
  side = DotProduct(velocity, right);
  sign = side < 0 ? -1 : 1;
  side = Math.abs(side);

  value = cl_rollangle.value;

  if (side < cl_rollspeed.value) side = (side * value) / cl_rollspeed.value;
  else side = value;

  return side * sign;
}

/*
===============
V_CalcBob

===============
*/
export function V_CalcBob(): number {
  let bob: number;
  let cycle: number;

  cycle = cl.time - ((cl.time / cl_bobcycle.value) | 0) * cl_bobcycle.value;
  cycle /= cl_bobcycle.value;
  if (cycle < cl_bobup.value) cycle = (M_PI * cycle) / cl_bobup.value;
  else cycle = M_PI + (M_PI * (cycle - cl_bobup.value)) / (1.0 - cl_bobup.value);

  // bob is proportional to velocity in the xy plane
  // (don't count Z, or jumping messes it up)

  bob = Math.sqrt(cl.velocity[0] * cl.velocity[0] + cl.velocity[1] * cl.velocity[1]) * cl_bob.value;
  bob = bob * 0.3 + bob * 0.7 * Math.sin(cycle);
  if (bob > 4) bob = 4;
  else if (bob < -7) bob = -7;
  return bob;
}

//=============================================================================

export const v_centermove = new CvarT("v_centermove", "0.15", false);
export const v_centerspeed = new CvarT("v_centerspeed", "500");

export function V_StartPitchDrift(): void {
  if (cl.laststop === cl.time) {
    return; // something else is keeping it from drifting
  }
  if (cl.nodrift || !cl.pitchvel) {
    cl.pitchvel = v_centerspeed.value;
    cl.nodrift = false;
    cl.driftmove = 0;
  }
}

export function V_StopPitchDrift(): void {
  cl.laststop = cl.time;
  cl.nodrift = true;
  cl.pitchvel = 0;
}

/*
===============
V_DriftPitch

Moves the client pitch angle towards cl.idealpitch sent by the server.

If the user is adjusting pitch manually, either with lookup/lookdown,
mlook and mouse, or klook and keyboard, pitch drifting is constantly stopped.

Drifting is enabled when the center view key is hit, mlook is released and
lookspring is non 0, or when
===============
*/
export function V_DriftPitch(): void {
  let delta: number;
  let move: number;

  if (noclip_anglehack || !cl.onground || cls.demoplayback) {
    cl.driftmove = 0;
    cl.pitchvel = 0;
    return;
  }

  // don't count small mouse motion
  if (cl.nodrift) {
    if (Math.abs(cl.cmd.forwardmove) < cl_forwardspeed.value) cl.driftmove = 0;
    else cl.driftmove += host.frametime;

    if (cl.driftmove > v_centermove.value) {
      V_StartPitchDrift();
    }
    return;
  }

  delta = cl.idealpitch - cl.viewangles[PITCH];

  if (!delta) {
    cl.pitchvel = 0;
    return;
  }

  move = host.frametime * cl.pitchvel;
  cl.pitchvel += host.frametime * v_centerspeed.value;

  if (delta > 0) {
    if (move > delta) {
      cl.pitchvel = 0;
      move = delta;
    }
    cl.viewangles[PITCH] += move;
  } else if (delta < 0) {
    if (move > -delta) {
      cl.pitchvel = 0;
      move = -delta;
    }
    cl.viewangles[PITCH] -= move;
  }
}

/*
==============================================================================

						PALETTE FLASHES

==============================================================================
*/

function makeCshift(r: number, g: number, b: number, percent: number): CshiftT {
  const cs = new CshiftT();
  cs.destcolor[0] = r;
  cs.destcolor[1] = g;
  cs.destcolor[2] = b;
  cs.percent = percent;
  return cs;
}

// `cl.cshifts[CSHIFT_CONTENTS] = cshift_empty;` is a struct copy in the C
function copyCshift(dst: CshiftT, src: CshiftT): void {
  dst.destcolor[0] = src.destcolor[0];
  dst.destcolor[1] = src.destcolor[1];
  dst.destcolor[2] = src.destcolor[2];
  dst.percent = src.percent;
}

export const cshift_empty = makeCshift(130, 80, 50, 0);
export const cshift_water = makeCshift(130, 80, 50, 128);
export const cshift_slime = makeCshift(0, 25, 5, 150);
export const cshift_lava = makeCshift(255, 80, 0, 150);

export const v_gamma = new CvarT("gamma", "1", true);

export const gammatable = new Uint8Array(256); // palette is sent through this

export function BuildGammaTable(g: number): void {
  let i: number;
  let inf: number;

  if (g === 1.0) {
    for (i = 0; i < 256; i++) gammatable[i] = i;
    return;
  }

  for (i = 0; i < 256; i++) {
    inf = (255 * Math.pow((i + 0.5) / 255.5, g) + 0.5) | 0;
    if (inf < 0) inf = 0;
    if (inf > 255) inf = 255;
    gammatable[i] = inf;
  }
}

/*
=================
V_CheckGamma
=================
*/
let oldgammavalue = 0; // static float oldgammavalue

export function V_CheckGamma(): boolean {
  if (v_gamma.value === oldgammavalue) return false;
  oldgammavalue = v_gamma.value;

  BuildGammaTable(v_gamma.value);
  vid.recalc_refdef = 1; // force a surface cache flush

  return true;
}

/*
===============
V_ParseDamage
===============
*/
export function V_ParseDamage(): void {
  let armor: number;
  let blood: number;
  const from: Vec3 = vec3();
  let i: number;
  const dmgForward: Vec3 = vec3();
  const dmgRight: Vec3 = vec3();
  const dmgUp: Vec3 = vec3();
  let ent: EntityT;
  let side: number;
  let count: number;

  armor = MSG_ReadByte();
  blood = MSG_ReadByte();
  for (i = 0; i < 3; i++) from[i] = MSG_ReadCoord();

  count = blood * 0.5 + armor * 0.5;
  if (count < 10) count = 10;

  cl.faceanimtime = cl.time + 0.2; // but sbar face into pain frame

  cl.cshifts[CSHIFT_DAMAGE].percent += 3 * count;
  if (cl.cshifts[CSHIFT_DAMAGE].percent < 0) cl.cshifts[CSHIFT_DAMAGE].percent = 0;
  if (cl.cshifts[CSHIFT_DAMAGE].percent > 150) cl.cshifts[CSHIFT_DAMAGE].percent = 150;

  if (armor > blood) {
    cl.cshifts[CSHIFT_DAMAGE].destcolor[0] = 200;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[1] = 100;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[2] = 100;
  } else if (armor) {
    cl.cshifts[CSHIFT_DAMAGE].destcolor[0] = 220;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[1] = 50;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[2] = 50;
  } else {
    cl.cshifts[CSHIFT_DAMAGE].destcolor[0] = 255;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[1] = 0;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[2] = 0;
  }

  //
  // calculate view angle kicks
  //
  ent = cl_entities[cl.viewentity];

  VectorSubtract(from, ent.origin, from);
  VectorNormalize(from);

  AngleVectors(ent.angles, dmgForward, dmgRight, dmgUp);

  side = DotProduct(from, dmgRight);
  v_dmg_roll = count * side * v_kickroll.value;

  side = DotProduct(from, dmgForward);
  v_dmg_pitch = count * side * v_kickpitch.value;

  v_dmg_time = v_kicktime.value;
}

/*
==================
V_cshift_f
==================
*/
export function V_cshift_f(): void {
  cshift_empty.destcolor[0] = Q_atoi(Cmd_Argv(1));
  cshift_empty.destcolor[1] = Q_atoi(Cmd_Argv(2));
  cshift_empty.destcolor[2] = Q_atoi(Cmd_Argv(3));
  cshift_empty.percent = Q_atoi(Cmd_Argv(4));
}

/*
==================
V_BonusFlash_f

When you run over an item, the server sends this command
==================
*/
export function V_BonusFlash_f(): void {
  cl.cshifts[CSHIFT_BONUS].destcolor[0] = 215;
  cl.cshifts[CSHIFT_BONUS].destcolor[1] = 186;
  cl.cshifts[CSHIFT_BONUS].destcolor[2] = 69;
  cl.cshifts[CSHIFT_BONUS].percent = 50;
}

/*
=============
V_SetContentsColor

Underwater, lava, etc each has a color shift
=============
*/
export function V_SetContentsColor(contents: number): void {
  switch (contents) {
    case CONTENTS_EMPTY:
    case CONTENTS_SOLID:
      copyCshift(cl.cshifts[CSHIFT_CONTENTS], cshift_empty);
      break;
    case CONTENTS_LAVA:
      copyCshift(cl.cshifts[CSHIFT_CONTENTS], cshift_lava);
      break;
    case CONTENTS_SLIME:
      copyCshift(cl.cshifts[CSHIFT_CONTENTS], cshift_slime);
      break;
    default:
      copyCshift(cl.cshifts[CSHIFT_CONTENTS], cshift_water);
  }
}

/*
=============
V_CalcPowerupCshift
=============
*/
export function V_CalcPowerupCshift(): void {
  if (cl.items & IT_QUAD) {
    cl.cshifts[CSHIFT_POWERUP].destcolor[0] = 0;
    cl.cshifts[CSHIFT_POWERUP].destcolor[1] = 0;
    cl.cshifts[CSHIFT_POWERUP].destcolor[2] = 255;
    cl.cshifts[CSHIFT_POWERUP].percent = 30;
  } else if (cl.items & IT_SUIT) {
    cl.cshifts[CSHIFT_POWERUP].destcolor[0] = 0;
    cl.cshifts[CSHIFT_POWERUP].destcolor[1] = 255;
    cl.cshifts[CSHIFT_POWERUP].destcolor[2] = 0;
    cl.cshifts[CSHIFT_POWERUP].percent = 20;
  } else if (cl.items & IT_INVISIBILITY) {
    cl.cshifts[CSHIFT_POWERUP].destcolor[0] = 100;
    cl.cshifts[CSHIFT_POWERUP].destcolor[1] = 100;
    cl.cshifts[CSHIFT_POWERUP].destcolor[2] = 100;
    cl.cshifts[CSHIFT_POWERUP].percent = 100;
  } else if (cl.items & IT_INVULNERABILITY) {
    cl.cshifts[CSHIFT_POWERUP].destcolor[0] = 255;
    cl.cshifts[CSHIFT_POWERUP].destcolor[1] = 255;
    cl.cshifts[CSHIFT_POWERUP].destcolor[2] = 0;
    cl.cshifts[CSHIFT_POWERUP].percent = 30;
  } else cl.cshifts[CSHIFT_POWERUP].percent = 0;
}

/*
=============
V_CalcBlend
=============
*/
export function V_CalcBlend(): void {
  getRenderer().V_CalcBlend();
}

/*
=============
V_UpdatePalette
=============
*/
export function V_UpdatePalette(): void {
  getRenderer().V_UpdatePalette();
}

/*
==============================================================================

						VIEW RENDERING

==============================================================================
*/

export function angledelta(a: number): number {
  a = anglemod(a);
  if (a > 180) a -= 360;
  return a;
}

/*
==================
CalcGunAngle
==================
*/
let gunOldyaw = 0; // static float oldyaw = 0
let gunOldpitch = 0; // static float oldpitch = 0

export function CalcGunAngle(): void {
  let yaw: number;
  let pitch: number;
  let move: number;

  yaw = r_refdef.viewangles[YAW];
  pitch = -r_refdef.viewangles[PITCH];

  yaw = angledelta(yaw - r_refdef.viewangles[YAW]) * 0.4;
  if (yaw > 10) yaw = 10;
  if (yaw < -10) yaw = -10;
  pitch = angledelta(-pitch - r_refdef.viewangles[PITCH]) * 0.4;
  if (pitch > 10) pitch = 10;
  if (pitch < -10) pitch = -10;
  move = host.frametime * 20;
  if (yaw > gunOldyaw) {
    if (gunOldyaw + move < yaw) yaw = gunOldyaw + move;
  } else {
    if (gunOldyaw - move > yaw) yaw = gunOldyaw - move;
  }

  if (pitch > gunOldpitch) {
    if (gunOldpitch + move < pitch) pitch = gunOldpitch + move;
  } else {
    if (gunOldpitch - move > pitch) pitch = gunOldpitch - move;
  }

  gunOldyaw = yaw;
  gunOldpitch = pitch;

  cl.viewent.angles[YAW] = r_refdef.viewangles[YAW] + yaw;
  cl.viewent.angles[PITCH] = -(r_refdef.viewangles[PITCH] + pitch);

  cl.viewent.angles[ROLL] -= v_idlescale.value * Math.sin(cl.time * v_iroll_cycle.value) * v_iroll_level.value;
  cl.viewent.angles[PITCH] -= v_idlescale.value * Math.sin(cl.time * v_ipitch_cycle.value) * v_ipitch_level.value;
  cl.viewent.angles[YAW] -= v_idlescale.value * Math.sin(cl.time * v_iyaw_cycle.value) * v_iyaw_level.value;
}

/*
==============
V_BoundOffsets
==============
*/
export function V_BoundOffsets(): void {
  const ent = cl_entities[cl.viewentity];

  // absolutely bound refresh reletive to entity clipping hull
  // so the view can never be inside a solid wall

  if (r_refdef.vieworg[0] < ent.origin[0] - 14) r_refdef.vieworg[0] = ent.origin[0] - 14;
  else if (r_refdef.vieworg[0] > ent.origin[0] + 14) r_refdef.vieworg[0] = ent.origin[0] + 14;
  if (r_refdef.vieworg[1] < ent.origin[1] - 14) r_refdef.vieworg[1] = ent.origin[1] - 14;
  else if (r_refdef.vieworg[1] > ent.origin[1] + 14) r_refdef.vieworg[1] = ent.origin[1] + 14;
  if (r_refdef.vieworg[2] < ent.origin[2] - 22) r_refdef.vieworg[2] = ent.origin[2] - 22;
  else if (r_refdef.vieworg[2] > ent.origin[2] + 30) r_refdef.vieworg[2] = ent.origin[2] + 30;
}

/*
==============
V_AddIdle

Idle swaying
==============
*/
export function V_AddIdle(): void {
  r_refdef.viewangles[ROLL] += v_idlescale.value * Math.sin(cl.time * v_iroll_cycle.value) * v_iroll_level.value;
  r_refdef.viewangles[PITCH] += v_idlescale.value * Math.sin(cl.time * v_ipitch_cycle.value) * v_ipitch_level.value;
  r_refdef.viewangles[YAW] += v_idlescale.value * Math.sin(cl.time * v_iyaw_cycle.value) * v_iyaw_level.value;
}

/*
==============
V_CalcViewRoll

Roll is induced by movement and damage
==============
*/
export function V_CalcViewRoll(): void {
  let side: number;

  side = V_CalcRoll(cl_entities[cl.viewentity].angles, cl.velocity);
  r_refdef.viewangles[ROLL] += side;

  if (v_dmg_time > 0) {
    r_refdef.viewangles[ROLL] += (v_dmg_time / v_kicktime.value) * v_dmg_roll;
    r_refdef.viewangles[PITCH] += (v_dmg_time / v_kicktime.value) * v_dmg_pitch;
    v_dmg_time -= host.frametime;
  }

  if (cl.stats[STAT_HEALTH] <= 0) {
    r_refdef.viewangles[ROLL] = 80; // dead view angle
    return;
  }
}

/*
==================
V_CalcIntermissionRefdef

==================
*/
export function V_CalcIntermissionRefdef(): void {
  let old: number;

  // ent is the player model (visible when out of body)
  const ent = cl_entities[cl.viewentity];
  // view is the weapon model (only visible from inside body)
  const view = cl.viewent;

  VectorCopy(ent.origin, r_refdef.vieworg);
  VectorCopy(ent.angles, r_refdef.viewangles);
  view.model = null;

  // allways idle in intermission
  old = v_idlescale.value;
  v_idlescale.value = 1;
  V_AddIdle();
  v_idlescale.value = old;
}

/*
==================
V_CalcRefdef

==================
*/
let calcRefdefOldz = 0; // static float oldz = 0

export function V_CalcRefdef(): void {
  let i: number;
  const localForward: Vec3 = vec3();
  const localRight: Vec3 = vec3();
  const localUp: Vec3 = vec3();
  const angles: Vec3 = vec3();
  let bob: number;

  V_DriftPitch();

  // ent is the player model (visible when out of body)
  const ent = cl_entities[cl.viewentity];
  // view is the weapon model (only visible from inside body)
  const view = cl.viewent;

  // transform the view offset by the model's matrix to get the offset from
  // model origin for the view
  ent.angles[YAW] = cl.viewangles[YAW]; // the model should face
  // the view dir
  ent.angles[PITCH] = -cl.viewangles[PITCH]; // the model should face
  // the view dir

  bob = V_CalcBob();

  // refresh position
  VectorCopy(ent.origin, r_refdef.vieworg);
  r_refdef.vieworg[2] += cl.viewheight + bob;

  // never let it sit exactly on a node line, because a water plane can
  // dissapear when viewed with the eye exactly on it.
  // the server protocol only specifies to 1/16 pixel, so add 1/32 in each axis
  r_refdef.vieworg[0] += 1.0 / 32;
  r_refdef.vieworg[1] += 1.0 / 32;
  r_refdef.vieworg[2] += 1.0 / 32;

  VectorCopy(cl.viewangles, r_refdef.viewangles);
  V_CalcViewRoll();
  V_AddIdle();

  // offsets
  angles[PITCH] = -ent.angles[PITCH]; // because entity pitches are
  //  actually backward
  angles[YAW] = ent.angles[YAW];
  angles[ROLL] = ent.angles[ROLL];

  AngleVectors(angles, localForward, localRight, localUp);

  for (i = 0; i < 3; i++) {
    r_refdef.vieworg[i] +=
      scr_ofsx.value * localForward[i] + scr_ofsy.value * localRight[i] + scr_ofsz.value * localUp[i];
  }

  V_BoundOffsets();

  // set up gun position
  VectorCopy(cl.viewangles, view.angles);

  CalcGunAngle();

  VectorCopy(ent.origin, view.origin);
  view.origin[2] += cl.viewheight;

  for (i = 0; i < 3; i++) {
    view.origin[i] += localForward[i] * bob * 0.4;
  }
  view.origin[2] += bob;

  // fudge position around to keep amount of weapon visible
  // roughly equal with different FOV

  if (scr_viewsize.value === 110) view.origin[2] += 1;
  else if (scr_viewsize.value === 100) view.origin[2] += 2;
  else if (scr_viewsize.value === 90) view.origin[2] += 1;
  else if (scr_viewsize.value === 80) view.origin[2] += 0.5;

  view.model = cl.model_precache[cl.stats[STAT_WEAPON]] ?? null;
  view.frame = cl.stats[STAT_WEAPONFRAME];
  view.colormap = vid.colormap;

  // set up the refresh position
  VectorAdd(r_refdef.viewangles, cl.punchangle, r_refdef.viewangles);

  // smooth out stair step ups
  if (cl.onground && ent.origin[2] - calcRefdefOldz > 0) {
    let steptime: number;

    steptime = cl.time - cl.oldtime;
    if (steptime < 0)
      //FIXME		I_Error ("steptime < 0");
      steptime = 0;

    calcRefdefOldz += steptime * 80;
    if (calcRefdefOldz > ent.origin[2]) calcRefdefOldz = ent.origin[2];
    if (ent.origin[2] - calcRefdefOldz > 12) calcRefdefOldz = ent.origin[2] - 12;
    r_refdef.vieworg[2] += calcRefdefOldz - ent.origin[2];
    view.origin[2] += calcRefdefOldz - ent.origin[2];
  } else calcRefdefOldz = ent.origin[2];

  if (chase_active.value) Chase_Update();
}

/*
==================
V_RenderView

The player's clipping box goes from (-16 -16 -24) to (16 16 32) from
the entity origin, so any view position inside that will be valid
==================
*/
export function V_RenderView(): void {
  if (conState.con_forcedup) return;

  // don't allow cheats in multiplayer
  if (cl.maxclients > 1) {
    Cvar_Set("scr_ofsx", "0");
    Cvar_Set("scr_ofsy", "0");
    Cvar_Set("scr_ofsz", "0");
  }

  if (cl.intermission) {
    // intermission / finale rendering
    V_CalcIntermissionRefdef();
  } else {
    if (!cl.paused /* && (sv.maxclients > 1 || key_dest == key_game) */) V_CalcRefdef();
  }

  const re = getRenderer();

  re.R_PushDlights();

  if (lcd_x.value) {
    //
    // render two interleaved views
    //
    let i: number;

    vid.rowbytes <<= 1;
    vid.aspect *= 0.5;

    const oldbuffer = vid.buffer;

    r_refdef.viewangles[YAW] -= lcd_yaw.value;
    for (i = 0; i < 3; i++) r_refdef.vieworg[i] -= right[i] * lcd_x.value;
    re.R_RenderView();

    if (vid.buffer) vid.buffer = vid.buffer.subarray(vid.rowbytes >> 1);

    re.R_PushDlights();

    r_refdef.viewangles[YAW] += lcd_yaw.value * 2;
    for (i = 0; i < 3; i++) r_refdef.vieworg[i] += 2 * right[i] * lcd_x.value;
    re.R_RenderView();

    vid.buffer = oldbuffer;

    r_refdef.vrect.height <<= 1;

    vid.rowbytes >>= 1;
    vid.aspect *= 2;
  } else {
    re.R_RenderView();
  }

  re.V_DrawCrosshair();
}

//============================================================================

/*
=============
V_Init
=============
*/
export function V_Init(): void {
  Cmd_AddCommand("v_cshift", V_cshift_f);
  Cmd_AddCommand("bf", V_BonusFlash_f);
  Cmd_AddCommand("centerview", V_StartPitchDrift);

  Cvar_RegisterVariable(lcd_x);
  Cvar_RegisterVariable(lcd_yaw);

  Cvar_RegisterVariable(v_centermove);
  Cvar_RegisterVariable(v_centerspeed);

  Cvar_RegisterVariable(v_iyaw_cycle);
  Cvar_RegisterVariable(v_iroll_cycle);
  Cvar_RegisterVariable(v_ipitch_cycle);
  Cvar_RegisterVariable(v_iyaw_level);
  Cvar_RegisterVariable(v_iroll_level);
  Cvar_RegisterVariable(v_ipitch_level);

  Cvar_RegisterVariable(v_idlescale);
  Cvar_RegisterVariable(crosshair);
  Cvar_RegisterVariable(cl_crossx);
  Cvar_RegisterVariable(cl_crossy);
  Cvar_RegisterVariable(gl_cshiftpercent);

  Cvar_RegisterVariable(scr_ofsx);
  Cvar_RegisterVariable(scr_ofsy);
  Cvar_RegisterVariable(scr_ofsz);
  Cvar_RegisterVariable(cl_rollspeed);
  Cvar_RegisterVariable(cl_rollangle);
  Cvar_RegisterVariable(cl_bob);
  Cvar_RegisterVariable(cl_bobcycle);
  Cvar_RegisterVariable(cl_bobup);

  Cvar_RegisterVariable(v_kicktime);
  Cvar_RegisterVariable(v_kickroll);
  Cvar_RegisterVariable(v_kickpitch);

  BuildGammaTable(1.0); // no gamma yet
  Cvar_RegisterVariable(v_gamma);
}

//============================================================================
// see the file header: host.c reaches V_Init through hostClientHooks.

export function registerViewHooks(): void {
  hostClientHooks.vInit = V_Init;
}

registerViewHooks();
