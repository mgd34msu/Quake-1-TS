/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/host.c (GNU GPL v2 or later).

Coordinator placeholder for unit U035. This file holds only what the server
and progs tracks need to compile against before host.c is ported in full:
the host.c cvar_t globals (their C initializers verbatim), the host state
words, HostError/Host_Error and HostEndGame/Host_EndGame. U035 keeps every
name here and adds the rest of host.c (Host_Init, Host_Frame, Host_Shutdown,
Host_ShutdownServer, Host_ClientCommands, Host_WriteConfiguration, ...).

Deviations from the C:
- `longjmp (host_abortserver, 1)` is a thrown HostError / HostEndGame,
  caught by Host_Frame's try/catch (PORTING.md's idiom map). Until U035
  lands, the SCR_EndLoadingPlaque / Host_ShutdownServer / CL_Disconnect
  steps before the longjmp are absent: the error is printed and thrown.
- `host_frametime`, `host_time`, `realtime`, `oldrealtime`,
  `host_framecount`, `host_initialized`, `host_hunklevel` are reassigned C
  globals and become fields of the exported `host` holder.
- `developer` takes the non-`_DEBUG` initializer "0".
*/

import { CvarT } from "./cvar";
import { Com_sprintf } from "./sprintf";
import { Con_Printf, Con_DPrintf } from "../client/console";
import { Sys_Error } from "../platform/sys";
import { MSG_WriteByte, MSG_WriteString } from "./sizebuf";
import { SvcOpsT } from "./protocol";
import { Hunk_FreeToLowMark } from "./zone";
import { Mod_ClearAll } from "./model";
import { sv, svState } from "../server/server";

// The client-side pieces Host_ClearMemory touches (D_FlushCaches, cls.signon,
// memset(&cl)) live in units not yet landed; they register here. Until then
// the server half of the C body runs alone.
export const hostClientHooks: { flushCaches: (() => void) | null; clearClient: (() => void) | null } = {
  flushCaches: null,
  clearClient: null,
};

export const host = {
  initialized: false, // true if into command execution
  frametime: 0,
  time: 0,
  realtime: 0, // without any filtering or bounding
  oldrealtime: 0, // last frame run
  framecount: 0,
  hunklevel: 0,
  minimum_memory: 0,
};

export const host_framerate = new CvarT("host_framerate", "0"); // set for slow motion
export const host_speeds = new CvarT("host_speeds", "0"); // set for running times

export const sys_ticrate = new CvarT("sys_ticrate", "0.05");
export const serverprofile = new CvarT("serverprofile", "0");

export const fraglimit = new CvarT("fraglimit", "0", false, true);
export const timelimit = new CvarT("timelimit", "0", false, true);
export const teamplay = new CvarT("teamplay", "0", false, true);

export const samelevel = new CvarT("samelevel", "0");
export const noexit = new CvarT("noexit", "0", false, true);

export const developer = new CvarT("developer", "0");

export const skill = new CvarT("skill", "1"); // 0 - 3
export const deathmatch = new CvarT("deathmatch", "0"); // 0, 1, or 2
export const coop = new CvarT("coop", "0"); // 0 or 1

export const pausable = new CvarT("pausable", "1");

export const temp1 = new CvarT("temp1", "0");

export class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostError";
  }
}

export class HostEndGame extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostEndGame";
  }
}

let inerror = false;

/*
================
Host_Error

This shuts down both the client and server
================
*/
export function Host_Error(error: string, ...args: Array<string | number>): never {
  if (inerror) Sys_Error("Host_Error: recursively entered");
  inerror = true;

  const string = Com_sprintf(error, ...args);
  Con_Printf("Host_Error: %s\n", string);

  inerror = false;

  throw new HostError(string);
}

/*
================
Host_EndGame
================
*/
export function Host_EndGame(message: string, ...args: Array<string | number>): never {
  const string = Com_sprintf(message, ...args);
  Con_DPrintf("Host_EndGame: %s\n", string);

  throw new HostEndGame(string);
}

/*
=================
Host_ClientCommands

Send text over to the client to be executed
=================
*/
export function Host_ClientCommands(fmt: string, ...args: Array<string | number>): void {
  const string = Com_sprintf(fmt, ...args);

  const host_client = svState.host_client;
  if (host_client === null) Sys_Error("Host_ClientCommands: no host_client");
  MSG_WriteByte(host_client.message, SvcOpsT.svc_stufftext);
  MSG_WriteString(host_client.message, string);
}

/*
================
Host_ClearMemory

This clears all the memory used by both the client and server, but does
not reinitialize anything.
================
*/
export function Host_ClearMemory(): void {
  Con_DPrintf("Clearing memory\n");
  if (hostClientHooks.flushCaches) hostClientHooks.flushCaches(); // D_FlushCaches
  Mod_ClearAll();
  if (host.hunklevel) Hunk_FreeToLowMark(host.hunklevel);

  if (hostClientHooks.clearClient) hostClientHooks.clearClient(); // cls.signon = 0; memset (&cl, 0, sizeof(cl))
  sv.clear();
}
