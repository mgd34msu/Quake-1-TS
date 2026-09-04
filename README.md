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

## Running

Requires the original game data (`pak0.pak` etc. from a Quake
installation) in `id1/` under the base directory, and libSDL2.

```sh
bun install
bun src/main.ts -basedir /path/to/quake
bun run build            # standalone binary: ./q1ts
```

## License

GPL v2, same as the original source release this is derived from -- see
`LICENSE`. Quake is a registered trademark of id Software, Inc. The game
assets are not included and remain under their original terms.
