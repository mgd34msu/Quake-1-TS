# Contributing

## Read PORTING.md first

[PORTING.md](PORTING.md) is the contract. It holds the file-by-file mapping from
id's C to this tree, the type discipline, the renderer seam, how the QuakeC VM
and the engine string table work, the import-cycle rules, and every deviation
from the C with the reasoning behind it. A change that contradicts it needs the
document updated in the same commit, not a comment explaining why the document
is wrong.

## This is a port, not a fork

The goal is Quake as id shipped it, bug for bug, wherever the behaviour is
observable.

- **No gameplay changes.** Not physics tweaks, not "obvious" bug fixes in the
  engine's game-facing behaviour, not quality-of-life additions. If the C does
  something odd and a player can see it, the port does it too.
- **Deviations get documented.** Where a deviation is unavoidable — a language
  or runtime limit, a platform layer that no longer exists — say so in the
  affected file's header comment and in PORTING.md, with what the C did, what
  the port does, and why. The existing deviations (the `vid_ref` cvar, mouse
  capture, `SIGINT`/`SIGTERM` handling, the engine string table) are the model
  for how much detail is expected.
- **Cite the C.** A change to ported code should name the C file and the
  behaviour it is matching. "Matches `WinQuake/sv_phys.c`'s `SV_PushMove` when
  `pusher->v.solid == SOLID_NOT`" is a review-able claim; "fixes movement" is
  not.
- **Port bugs are different from Quake bugs.** A crash, a wrong buffer, a
  mis-transcribed constant — fix those, and add a test that fails without the
  fix.

## The gate

Both must be clean before a change is proposed:

```sh
bun run check      # must print CHECK OK
bun test           # one forward run; 0 failures
```

`bun run check` is `tsc --noEmit` under strict TypeScript plus a grep that
rejects `any` anywhere in `src/` or `test/` — including `as any`, `<any>`,
`any[]` and `Array<any>`. Casts are out too, `as const` excepted. When the C's
type cannot be expressed directly, model the domain instead of laundering it
through a cast.

Run `bun test` once, forward. It is a single process that shares the module
registry, the command table and the cvar registry across every file, so suites
must leave process-wide state as they found it: capture and restore, and give
test-only `Cmd_AddCommand` names a `test_` prefix.

## Tests

New behaviour needs a test that would fail without it. The unit suite builds its
own synthetic paks, maps, models and BSPs (`test/support/`) and needs no game
data, so keep it that way — a test that only passes on a machine with retail
paks belongs in one of the two opt-in suites described below, or in
`test/e2e/`.

Two unit suites do boot the real engine (`test/net_e2e.test.ts`,
`test/host_error_frame.test.ts`). They skip unless `Q1TS_DATA` points at a base
directory holding `id1/pak0.pak`:

```sh
Q1TS_DATA=/path/to/quake SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test
```

Fixtures taken from id's source release (`progs106/progs.dat`,
`QW/progs/qwprogs.dat`) are found relative to the repository at
`../qsrc/quake`, or wherever `Q1TS_QSRC` points. Suites that use them skip when
they are missing.

## End-to-end harnesses

`test/e2e/` holds manual drivers that run a real build of the engine against
real game data through the actual SDL, UDP and filesystem backends. They are not
`bun test` suites — `bun test` collects only `*.test.ts`, and nothing there is
named that way, so a plain test run never spawns a live engine.

Each driver is its own process and reads the base directory from `Q1TS_DATA`:

```sh
Q1TS_DATA=/path/to/quake SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  bun test/e2e/b_s1_console.ts
```

Use `SDL_VIDEODRIVER=offscreen` for the OpenGL scenarios and
`SDL_AUDIODRIVER=disk` for the audio-capture ones. Pass `-game e2e_<letter>` so
one family's `config.cfg`, saves, demos and screenshots do not land in another's
directory. [test/e2e/README.md](test/e2e/README.md) maps every driver to what it
covers and lists the ports each family uses.

## Reporting a platform failure

Only the Linux build has been exercised end to end; the Windows and macOS
binaries cross-compile but are untested. A useful report includes:

1. OS and version, and how you got Bun (`bun --version`).
2. Which binary (`q1ts`, `qwsv`, `qwcl`), whether from source or from a
   `bun build --compile` build, and the full command line.
3. `-vid_ref soft` or `gl`, and whether the other one behaves differently.
4. Your SDL2 and OpenGL driver versions, and whether a window manager or
   compositor is involved (see the tiling-compositor note in the README before
   filing a window-size issue).
5. The console output from the first error onward, and `qconsole.log` if you can
   reproduce it with `-condebug`.
6. Whether it reproduces on shareware `pak0.pak`, which anyone can obtain — that
   turns a report into something reproducible.

Do not attach pak files, maps, models, sounds or anything else extracted from
the game data. It is not ours to redistribute; see [NOTICE](NOTICE).

## License

Contributions are made under GPL-2.0-or-later, the same terms as id's original
release. Keep the id Software copyright header on every ported file and name the
C file it came from.
