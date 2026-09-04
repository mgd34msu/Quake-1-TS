/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/console.h and WinQuake/console.c (GNU GPL v2 or later).

Coordinator placeholder for unit U047. Only the three printers exist, and
only their dedicated-server path: the C's Con_Printf echoes to Sys_Printf
first and returns before the scrollable buffer when `cls.state ==
ca_dedicated` or `!con_initialized`. Neither cls nor the console buffer is
ported yet, so that early return is the whole body. U047 replaces this file
with the full console.c port; the exported names and signatures stay.

Con_DPrintf reads `developer.value`; cvar.ts (U005) is in flight, so the
cvar is handed in through setDeveloper by whoever registers it (host.ts).
*/

import { Sys_Printf } from "../platform/sys";
import { Com_sprintf } from "../common/sprintf";

interface DeveloperCvar {
  value: number;
}

let developer: DeveloperCvar | null = null;
export function setDeveloper(cv: DeveloperCvar | null): void {
  developer = cv;
}

export function Con_Printf(fmt: string, ...args: Array<string | number>): void {
  const msg = Com_sprintf(fmt, ...args);

  // also echo to debugging console
  Sys_Printf("%s", msg); // also echo to debugging console
}

export function Con_DPrintf(fmt: string, ...args: Array<string | number>): void {
  if (!developer || !developer.value) return; // don't confuse non-developers with techie stuff...

  const msg = Com_sprintf(fmt, ...args);
  Con_Printf("%s", msg);
}

export function Con_SafePrintf(fmt: string, ...args: Array<string | number>): void {
  const msg = Com_sprintf(fmt, ...args);
  Con_Printf("%s", msg);
}
