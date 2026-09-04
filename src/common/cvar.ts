/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cvar.h and WinQuake/cvar.c (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- `cvar_t` -> `CvarT`, a class with the same six fields (`name`, `string`,
  `archive`, `server`, `value`, `next`). The C's `qboolean archive`/`server`
  are plain `boolean`; `value` is computed by Q_atof exactly where the C
  computes it (Cvar_RegisterVariable, Cvar_Set), not in the constructor, so a
  freshly constructed CvarT reads `value === 0` until registered/set, same as
  a `cvar_t` literal with only name/string filled in.
- `cvar_t *cvar_vars` (the singly linked list head, `extern`) -> the module
  `let cvar_vars: CvarT | null`, mutated only by Cvar_RegisterVariable's
  prepend (`variable->next = cvar_vars; cvar_vars = variable;`), read
  everywhere else via the `next` chain exactly as the C walks it. New cvars
  land at the head, so Cvar_WriteVariables (and every other walk) visits
  newest-registered-first, matching the C's observable order.
- `cvar_null_string` -> Cvar_VariableString returns `""` directly; no shared
  string constant is needed since JS strings are values, not pointers.
- Z_Malloc/Z_Free string copies (Cvar_Set's free-old/copy-new, Cvar_
  RegisterVariable's off-copy so a later Z_Free doesn't clobber a caller's
  static buffer) are dropped: `string` is a plain immutable JS string field,
  assigned directly. No zone.ts import.
- `sv.active` / `SV_BroadcastPrintf` (server.ts/sv_main.ts, not yet ported):
  reached through a registrable hook, `setCvarServerHooks`. With no hook
  registered, Cvar_Set behaves as if `sv.active == false` (skips the
  broadcast), which is the correct behavior before any server unit lands.
  sv_main.ts (U031) is expected to call `setCvarServerHooks` once `sv` and
  `SV_BroadcastPrintf` exist.
- Cvar_WriteVariables takes `FILE *f` in C. Ruling (unit brief): a structural
  text sink `{ write(s: string): void }`; host.ts's Host_WriteConfiguration
  wraps a real file for it. Formats every archived cvar as `Com_sprintf('%s
  "%s"\n', var.name, var.string)`, matching the C's `fprintf (f, "%s \"%s\"\n"
  ...)` exactly, one `write` call per line.
*/

import { Q_atof } from "./common";
import { Cmd_Exists, Cmd_Argc, Cmd_Argv } from "./cmd";
import { Con_Printf } from "../client/console";
import { Com_sprintf } from "./sprintf";

export class CvarT {
  name: string;
  string: string;
  archive: boolean;
  server: boolean; // notifies players when changed
  value: number;
  next: CvarT | null;

  constructor(name: string, string: string, archive = false, server = false) {
    this.name = name;
    this.string = string;
    this.archive = archive;
    this.server = server;
    this.value = 0; // set by Cvar_RegisterVariable/Cvar_Set; a cvar is 0 until registered, same as the C
    this.next = null;
  }
}

// cvar_t *cvar_vars;
export let cvar_vars: CvarT | null = null;

export interface CvarServerHooks {
  active(): boolean;
  broadcastPrintf(fmt: string, ...args: Array<string | number>): void;
}

let serverHooks: CvarServerHooks | null = null;
export function setCvarServerHooks(h: CvarServerHooks | null): void {
  serverHooks = h;
}

/*
============
Cvar_FindVar
============
*/
export function Cvar_FindVar(var_name: string): CvarT | null {
  for (let v = cvar_vars; v !== null; v = v.next) if (var_name === v.name) return v;

  return null;
}

/*
============
Cvar_VariableValue
============
*/
export function Cvar_VariableValue(var_name: string): number {
  const v = Cvar_FindVar(var_name);
  if (!v) return 0;
  return Q_atof(v.string);
}

/*
============
Cvar_VariableString
============
*/
export function Cvar_VariableString(var_name: string): string {
  const v = Cvar_FindVar(var_name);
  if (!v) return ""; // cvar_null_string
  return v.string;
}

/*
============
Cvar_CompleteVariable
============
*/
export function Cvar_CompleteVariable(partial: string): string | null {
  const len = partial.length;

  if (!len) return null;

  // check functions
  for (let cvar = cvar_vars; cvar !== null; cvar = cvar.next) if (cvar.name.startsWith(partial)) return cvar.name;

  return null;
}

/*
============
Cvar_Set
============
*/
export function Cvar_Set(var_name: string, value: string): void {
  const v = Cvar_FindVar(var_name);
  if (!v) {
    // there is an error in C code if this happens
    Con_Printf("Cvar_Set: variable %s not found\n", var_name);
    return;
  }

  const changed = v.string !== value;

  v.string = value; // Z_Free the old value string, Z_Malloc + copy the new one -> plain assignment
  v.value = Q_atof(v.string);
  if (v.server && changed) {
    if (serverHooks !== null && serverHooks.active()) {
      serverHooks.broadcastPrintf('"%s" changed to "%s"\n', v.name, v.string);
    }
  }
}

/*
============
Cvar_SetValue
============
*/
export function Cvar_SetValue(var_name: string, value: number): void {
  const val = Com_sprintf("%f", value);
  Cvar_Set(var_name, val);
}

/*
============
Cvar_RegisterVariable

Adds a freestanding variable to the variable list.
============
*/
export function Cvar_RegisterVariable(variable: CvarT): void {
  // first check to see if it has allready been defined
  if (Cvar_FindVar(variable.name)) {
    Con_Printf("Can't register variable %s, allready defined\n", variable.name);
    return;
  }

  // check for overlap with a command
  if (Cmd_Exists(variable.name)) {
    Con_Printf("Cvar_RegisterVariable: %s is a command\n", variable.name);
    return;
  }

  // copy the value off, because future sets will Z_Free it -- variable.string
  // is already a plain JS string owned by this CvarT, so no copy is needed
  variable.value = Q_atof(variable.string);

  // link the variable in
  variable.next = cvar_vars;
  cvar_vars = variable;
}

/*
============
Cvar_Command

Handles variable inspection and changing from the console
============
*/
export function Cvar_Command(): boolean {
  // check variables
  const v = Cvar_FindVar(Cmd_Argv(0));
  if (!v) return false;

  // perform a variable print or set
  if (Cmd_Argc() === 1) {
    Con_Printf('"%s" is "%s"\n', v.name, v.string);
    return true;
  }

  Cvar_Set(v.name, Cmd_Argv(1));
  return true;
}

/*
============
Cvar_WriteVariables

Writes lines containing "set variable value" for all variables
with the archive flag set to true.
============
*/
export function Cvar_WriteVariables(f: { write(s: string): void }): void {
  for (let v = cvar_vars; v !== null; v = v.next) if (v.archive) f.write(Com_sprintf('%s "%s"\n', v.name, v.string));
}
