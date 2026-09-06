# Quake 1 TS

A faithful TypeScript port of the Quake v1.09 GPL source (id Software,
1996-1999, released December 21 1999), running on [Bun](https://bun.sh).
Same shape as the sibling Quake 2 port: strict TypeScript, one module per
C file, SDL2 through `bun:ffi` as the single platform layer, both the
software renderer and the OpenGL renderer selectable at runtime.

Game logic runs as `progs.dat` bytecode through a ported QuakeC virtual
machine, exactly as WinQuake does, so the base game, both mission packs,
and classic mods all work from their original data.

Tracks, in order: WinQuake (single player + NetQuake multiplayer), then
QuakeWorld client and server.

- Strict TypeScript: zero `any`, no casts (`as const` excepted)
- Bug-for-bug fidelity to the C where observable; deviations documented
  in file headers and `PORTING.md`
- Both renderers selectable at runtime through the one cvar this port
  adds: `vid_ref soft` (default) / `vid_ref gl`, seeded at startup by the
  `-vid_ref <name>` command-line parm
- The mouse is captured (and the pointer hidden) while playing with the
  window focused; opening the console or a menu, or losing window focus,
  releases it -- a documented deviation from the original's
  `_windowed_mouse`-gated capture, see `PORTING.md`

## Running

Requires the original game data (`pak0.pak` etc. from a Quake
installation) in `id1/` under the base directory, and libSDL2. `-basedir` may
point at a directory containing `Id1/PAK0.PAK` as shipped, mixed case and all.

```sh
bun install
bun src/main.ts -basedir /path/to/quake                # software renderer
bun src/main.ts -basedir /path/to/quake -vid_ref gl    # OpenGL renderer
bun src/main.ts -dedicated 1 -basedir /path/to/quake +map start
bun run build            # standalone binary: ./q1ts
```

Music: `cd` tracks play from `music/NN.ogg` under the game directory
(system libvorbisfile), replacing the physical CD.

### QuakeWorld server (qwsv)

`src/qw/main_sv.ts` is the standalone QuakeWorld server, the second of the
port's entry points. It needs no SDL and opens no window: it is a headless
server binary, exactly as `qwsv` is in the original tree.

```sh
bun run start:qwsv -- -basedir /path/to/quake -port 27500 +map start
bun run build:qwsv       # standalone binary: ./qwsv
```

The base directory needs `id1/pak0.pak` (the registered game data, for the
`gfx/pop.lmp` check) and `qw/qwprogs.dat` (the QuakeWorld progs); maps are
loaded from `qw/maps/<name>.bsp` and then `id1/`, as in the original.

- `-port <n>` sets the UDP port (default 27500). `-port 0` binds any free
  port.
- `+map <name>` picks the starting level; with no `+map`, the server spawns
  `start` on its own.
- `server.cfg` in the game directory is executed at startup, and console
  commands (`status`, `map`, `kick`, `quit`, ...) are read from stdin.

### QuakeWorld client (qwcl)

`src/qw/main_cl.ts` is the QuakeWorld client, the third entry point. It is a
pure client: it has no server half at all, so it always plays on a remote
server (`qwsv` above, or any other QuakeWorld server).

```sh
bun run start:qwcl -- -basedir /path/to/quake        # software renderer
bun run build:qwcl       # standalone binary: ./qwcl
bun run build:all        # all three binaries: q1ts, qwsv, qwcl
```

At the console (or as `+connect ...` on the command line, which `stuffcmds`
in `quake.rc` runs):

```
connect somehost:27500
```

The base directory needs the registered game data in `id1/` (`pak0.pak`, for
`gfx/pop.lmp`, `gfx.wad`, `gfx/palette.lmp`, `gfx/colormap.lmp` and the rest)
plus a `qw/` directory, which the client creates itself and then fills with
whatever the server sends it (maps, models, sounds and player skins are
downloaded into `qw/` on connect). `-game` is forced to `qw`, exactly as the
original client does.

`vid_ref` (`soft` by default, or `gl`) selects the renderer here too. It is
read once while the client starts up, before `quake.rc` runs, so `+vid_ref gl`
on the command line comes too late: pick the renderer at startup with the
`-vid_ref <soft|gl>` parm (all three binaries), or change it later from the
video menu's Apply or a `vid_restart` at the console.

## License

GPL v2, same as the original source release this is derived from -- see
`LICENSE`. Quake is a registered trademark of id Software, Inc. The game
assets are not included and remain under their original terms.
