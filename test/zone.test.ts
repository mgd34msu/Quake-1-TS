/*
Self-sufficient test for src/common/zone.ts (WinQuake zone.h/zone.c).

zone.ts reaches Cmd_AddCommand (./cmd, U004) from inside Cache_Init and
COM_CheckParm/com_argv (./common, U003) from inside Memory_Init, both lazily
via `require()` (see zone.ts's file header): neither is a static top-level
import, so zone.ts itself loads at runtime whether or not those siblings are
present. This suite only exercises functions that never call Cache_Init or
Memory_Init (Z_Malloc, Hunk_Alloc/AllocName, Hunk_LowMark, Cache_Alloc/
Check/Free/Flush), so it needs no mock.module stand-in for either sibling and
never depends on load order or another test file having run first.
*/

import { describe, expect, test } from "bun:test";
import { SysError } from "../src/platform/sys";
import {
  CacheUser,
  Cache_Alloc,
  Cache_Check,
  Cache_Flush,
  Cache_Free,
  Hunk_Alloc,
  Hunk_AllocName,
  Hunk_LowMark,
  Z_Malloc,
} from "../src/common/zone";

describe("Hunk_AllocName", () => {
  test("returns a zeroed buffer of the size rounded up to 16 bytes, like the C's hunk_t alignment", () => {
    const buf = Hunk_AllocName(10, "test");
    expect(buf.length).toBe(16); // (10+15) & ~15 == 16
    expect(Array.from(buf)).toEqual(new Array(16).fill(0));
  });

  test("size already a multiple of 16 is unchanged", () => {
    const buf = Hunk_AllocName(32, "test");
    expect(buf.length).toBe(32);
  });
});

describe("Hunk_LowMark", () => {
  test("increases across allocations, so callers can assert call order", () => {
    const before = Hunk_LowMark();
    Hunk_AllocName(1, "a");
    const afterOne = Hunk_LowMark();
    Hunk_AllocName(1, "b");
    const afterTwo = Hunk_LowMark();

    expect(afterOne).toBeGreaterThan(before);
    expect(afterTwo).toBeGreaterThan(afterOne);
  });
});

describe("Hunk_Alloc", () => {
  test("negative size throws SysError, matching Sys_Error(\"Hunk_Alloc: bad size: %i\")", () => {
    expect(() => Hunk_Alloc(-1)).toThrow(SysError);
    expect(() => Hunk_Alloc(-1)).toThrow("Hunk_Alloc: bad size: -1");
  });
});

describe("Z_Malloc", () => {
  test("returns a zero-filled buffer of the requested size", () => {
    const buf = Z_Malloc(24);
    expect(buf.length).toBe(24);
    expect(Array.from(buf)).toEqual(new Array(24).fill(0));
  });
});

describe("Cache_Alloc / Cache_Check", () => {
  test("Cache_Alloc stores the object and Cache_Check returns the same one", () => {
    const c = new CacheUser<{ tag: string }>();
    const obj = { tag: "loaded" };

    const result = Cache_Alloc(c, 16, "test_cache", obj);

    expect(result).toBe(obj);
    expect(Cache_Check(c)).toBe(obj);
  });

  test("Cache_Alloc on an already-allocated user throws SysError with the C's message", () => {
    const c = new CacheUser<{ tag: string }>();
    Cache_Alloc(c, 16, "first", { tag: "first" });

    expect(() => Cache_Alloc(c, 16, "second", { tag: "second" })).toThrow(SysError);
    expect(() => Cache_Alloc(c, 16, "second", { tag: "second" })).toThrow(
      "Cache_Alloc: allready allocated",
    );
  });

  test("Cache_Alloc with size <= 0 throws SysError with the C's message", () => {
    const c = new CacheUser<{ tag: string }>();
    expect(() => Cache_Alloc(c, 0, "bad", { tag: "bad" })).toThrow(SysError);
    expect(() => Cache_Alloc(c, 0, "bad", { tag: "bad" })).toThrow("Cache_Alloc: size 0");
  });
});

describe("Cache_Free", () => {
  test("nulls data; Cache_Check then returns null", () => {
    const c = new CacheUser<{ tag: string }>();
    Cache_Alloc(c, 16, "test_free", { tag: "loaded" });

    Cache_Free(c);

    expect(Cache_Check(c)).toBeNull();
  });

  test("throws SysError with the C's message when already unallocated", () => {
    const c = new CacheUser<{ tag: string }>();
    expect(() => Cache_Free(c)).toThrow(SysError);
    expect(() => Cache_Free(c)).toThrow("Cache_Free: not allocated");
  });
});

describe("Cache_Flush", () => {
  test("nulls every registered user at once, the console \"flush\" command's observable effect", () => {
    const a = new CacheUser<{ tag: string }>();
    const b = new CacheUser<{ tag: string }>();
    Cache_Alloc(a, 16, "a", { tag: "a" });
    Cache_Alloc(b, 16, "b", { tag: "b" });

    Cache_Flush();

    expect(Cache_Check(a)).toBeNull();
    expect(Cache_Check(b)).toBeNull();
    // reload works normally afterward, exactly what the C's demand-cache
    // behaviour depends on
    const reloaded = Cache_Alloc(a, 16, "a", { tag: "reloaded" });
    expect(Cache_Check(a)).toBe(reloaded);
  });
});
