// Q003 -- QW/client/net_udp.c (net_main.c) + net.h ported to src/qw/net_udp.ts.
//
// Rule 15 hygiene: net_message is the same singleton src/common/sizebuf.ts
// exports (see src/qw/net_udp.ts's file header for why); NET_Init resizes
// its data/maxsize for QW's own MAX_UDP_PACKET buffer, so this suite snapshots
// and restores it, and closes its socket in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { net_message } from "../src/common/sizebuf";
import {
  NetadrT,
  net_local_adr,
  net_from,
  NET_Init,
  NET_Ready,
  NET_Shutdown,
  NET_GetPacket,
  NET_SendPacket,
  NET_StringToAdr,
  NET_AdrToString,
  NET_BaseAdrToString,
  NET_CompareAdr,
  NET_CompareBaseAdr,
  NET_IsClientLegal,
  PORT_ANY,
} from "../src/qw/net_udp";

const TEST_PORT = 27960;

let savedData: Uint8Array;
let savedMaxsize: number;
let savedCursize: number;

beforeAll(async () => {
  savedData = net_message.data;
  savedMaxsize = net_message.maxsize;
  savedCursize = net_message.cursize;

  NET_Init(TEST_PORT);
  await NET_Ready();
});

afterAll(() => {
  NET_Shutdown();
  net_message.data = savedData;
  net_message.maxsize = savedMaxsize;
  net_message.cursize = savedCursize;
});

describe("NET_StringToAdr / NET_AdrToString / NET_BaseAdrToString", () => {
  test("parses a dotted-quad address with a port and round-trips", () => {
    const a = new NetadrT();
    expect(NET_StringToAdr("192.246.40.70:27910", a)).toBe(true);
    expect(Array.from(a.ip)).toEqual([192, 246, 40, 70]);
    expect(a.port).toBe(27910);
    expect(NET_AdrToString(a)).toBe("192.246.40.70:27910");
    expect(NET_BaseAdrToString(a)).toBe("192.246.40.70");
  });

  test("parses a dotted-quad address with no port (port defaults to 0)", () => {
    const a = new NetadrT();
    expect(NET_StringToAdr("10.0.0.5", a)).toBe(true);
    expect(Array.from(a.ip)).toEqual([10, 0, 0, 5]);
    expect(a.port).toBe(0);
    expect(NET_AdrToString(a)).toBe("10.0.0.5:0");
  });

  test("rejects a hostname (dotted quads only, per the port's DNS ruling)", () => {
    const a = new NetadrT();
    expect(NET_StringToAdr("idnewt", a)).toBe(false);
    expect(NET_StringToAdr("idnewt:28000", a)).toBe(false);
  });

  test("rejects a malformed dotted quad", () => {
    const a = new NetadrT();
    expect(NET_StringToAdr("999.1.2.3", a)).toBe(false);
    expect(NET_StringToAdr("1.2.3", a)).toBe(false);
    expect(NET_StringToAdr("", a)).toBe(false);
  });
});

describe("NET_CompareAdr / NET_CompareBaseAdr", () => {
  test("compares full address including port", () => {
    const a = new NetadrT();
    NET_StringToAdr("10.0.0.1:100", a);
    const b = new NetadrT();
    NET_StringToAdr("10.0.0.1:100", b);
    const c = new NetadrT();
    NET_StringToAdr("10.0.0.1:200", c);
    expect(NET_CompareAdr(a, b)).toBe(true);
    expect(NET_CompareAdr(a, c)).toBe(false);
  });

  test("base compare ignores port", () => {
    const a = new NetadrT();
    NET_StringToAdr("10.0.0.1:100", a);
    const b = new NetadrT();
    NET_StringToAdr("10.0.0.1:200", b);
    expect(NET_CompareBaseAdr(a, b)).toBe(true);

    const c = new NetadrT();
    NET_StringToAdr("10.0.0.2:100", c);
    expect(NET_CompareBaseAdr(a, c)).toBe(false);
  });
});

describe("NET_IsClientLegal", () => {
  test("always returns true (the C body is entirely #if 0'd out)", () => {
    const a = new NetadrT();
    expect(NET_IsClientLegal(a)).toBe(true);
  });
});

describe("NET_Init / NET_Ready / real loopback UDP", () => {
  test("net_local_adr resolved to 127.0.0.1 with the bound port", () => {
    expect(Array.from(net_local_adr.ip)).toEqual([127, 0, 0, 1]);
    expect(net_local_adr.port).toBeGreaterThan(0);
  });

  test("NET_SendPacket to net_local_adr is delivered back through NET_GetPacket", async () => {
    const to = new NetadrT();
    to.ip.set(net_local_adr.ip);
    to.port = net_local_adr.port;

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    NET_SendPacket(payload.length, payload, to);

    let got = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (NET_GetPacket()) {
        got = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(got).toBe(true);
    expect(Array.from(net_message.data.slice(0, net_message.cursize))).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(net_from.ip)).toEqual([127, 0, 0, 1]);
    expect(net_from.port).toBeGreaterThan(0);
  });

  test("NET_GetPacket returns false when nothing is queued", () => {
    expect(NET_GetPacket()).toBe(false);
  });
});

describe("PORT_ANY", () => {
  test("is -1, matching net.h's #define PORT_ANY -1", () => {
    expect(PORT_ANY).toBe(-1);
  });
});
