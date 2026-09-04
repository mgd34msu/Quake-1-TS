/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sys.h and WinQuake/sys_linux.c (GNU GPL v2 or later);
sys_win.c, sys_dos.c, sys_sun.c, sys_wind.c, sys_null.c are alternative
implementations of the same interface and are not separately ported
(PORTING.md's platform mapping: one bun implementation).

This file currently holds only the entry points the common track needs
(Sys_Error, Sys_Printf, Sys_Quit, Sys_FloatTime, Sys_DebugLog). Unit U010
completes it (file I/O, Sys_ConsoleInput, Sys_SendKeyEvents, main-loop
support, isDedicated, nostdout wiring).

Deviations from the C:
- Sys_Error and Sys_Quit call Host_Shutdown, which lives in host.ts (U035).
  host.ts registers itself through setHostShutdown; until then the hook is a
  no-op, which is what sys_null.c's Sys_Error does.
- Sys_Error is fatal in the C (exit(1)). Under bun, tests need to observe it,
  so it throws SysError; src/main.ts's top level is where the process exits.
- The fcntl(0, ...) non-blocking-stdin toggles are dropped: bun has no
  equivalent and Sys_ConsoleInput (U010) does not use FNDELAY.
- Sys_Printf's byte filter (`*p &= 0x7f`, `[%02x]` for control chars) is
  ported; the `sleep(0)`-retry write loop variant and the stderr+Con_Print
  variant are the `#if 0`/dead alternates in sys_linux.c and are dropped.
*/

import { appendFileSync } from "node:fs";
import { Com_sprintf } from "../common/sprintf";

export class SysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SysError";
  }
}

let hostShutdown: (() => void) | null = null;
export function setHostShutdown(fn: (() => void) | null): void {
  hostShutdown = fn;
}

// sys_linux.c: `int nostdout = 0;` set from the -nostdout command line parm.
export const sysState = { nostdout: 0 };

export function Sys_Error(error: string, ...args: Array<string | number>): never {
  const string = Com_sprintf(error, ...args);
  process.stderr.write(`Error: ${string}\n`);
  if (hostShutdown) hostShutdown();
  throw new SysError(string);
}

export function Sys_Printf(fmt: string, ...args: Array<string | number>): void {
  const text = Com_sprintf(fmt, ...args);

  if (text.length > 1024) Sys_Error("memory overwrite in Sys_Printf");

  if (sysState.nostdout) return;

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const p = text.charCodeAt(i) & 0x7f;
    if ((p > 128 || p < 32) && p !== 10 && p !== 13 && p !== 9) out += Com_sprintf("[%02x]", p);
    else out += String.fromCharCode(p);
  }
  process.stdout.write(out);
}

export function Sys_Quit(): never {
  if (hostShutdown) hostShutdown();
  process.exit(0);
}

let secbase = 0;
export function Sys_FloatTime(): number {
  const now = Date.now();
  const tv_sec = Math.floor(now / 1000);
  const tv_usec = (now - tv_sec * 1000) * 1000;

  if (!secbase) {
    secbase = tv_sec;
    return tv_usec / 1000000.0;
  }

  return tv_sec - secbase + tv_usec / 1000000.0;
}

export function Sys_DebugLog(file: string, fmt: string, ...args: Array<string | number>): void {
  const data = Com_sprintf(fmt, ...args);
  // open(file, O_WRONLY | O_CREAT | O_APPEND, 0666); write; close
  appendFileSync(file, data);
}
