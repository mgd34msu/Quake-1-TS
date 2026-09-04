/*
Self-sufficient test for src/platform/net_udp.ts (WinQuake net_udp.h/net_udp.c).

Drives two real Bun.udpSocket-backed sockets over loopback (127.0.0.1) on
high/ephemeral ports -- no mocking of the transport -- to prove Write/Read,
address round-tripping, and PartialIPAddress work end to end. Both sockets
are closed in afterAll.
*/

import { describe, expect, test, afterAll } from "bun:test";
import {
  udpLandriver,
  UDP_Ready,
  PartialIPAddress,
  type QsockaddrT,
} from "../src/platform/net_udp";

function newAddr(): QsockaddrT {
  return { sa_family: 0, sa_data: new Uint8Array(14) };
}

// High ports, chosen to avoid the well-known/registered range and any
// default Quake port (26000).
const PORT_A = 47201;
const PORT_B = 47202;

const socketA = udpLandriver.OpenSocket(PORT_A);
const socketB = udpLandriver.OpenSocket(PORT_B);

afterAll(() => {
  udpLandriver.CloseSocket(socketA);
  udpLandriver.CloseSocket(socketB);
});

describe("UDP_OpenSocket / UDP_Ready", () => {
  test("both sockets bind successfully", async () => {
    const readyA = await UDP_Ready(socketA);
    const readyB = await UDP_Ready(socketB);
    expect(readyA).toBe(true);
    expect(readyB).toBe(true);
  });
});

describe("real loopback Write/Read round trip", () => {
  test("A writes to B; B reads the bytes and A's sender address", async () => {
    await UDP_Ready(socketA);
    await UDP_Ready(socketB);

    const destAddr = newAddr();
    destAddr.sa_family = 2; // AF_INET
    // 127.0.0.1:PORT_B
    destAddr.sa_data[0] = (PORT_B >> 8) & 0xff;
    destAddr.sa_data[1] = PORT_B & 0xff;
    destAddr.sa_data[2] = 127;
    destAddr.sa_data[3] = 0;
    destAddr.sa_data[4] = 0;
    destAddr.sa_data[5] = 1;

    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3]);
    const written = udpLandriver.Write(socketA, payload, payload.length, destAddr);
    expect(written).toBe(payload.length);

    // Give the event loop a turn for the datagram to arrive.
    let received = -1;
    const recvBuf = new Uint8Array(64);
    const fromAddr = newAddr();
    for (let attempt = 0; attempt < 50 && received <= 0; attempt++) {
      received = udpLandriver.Read(socketB, recvBuf, recvBuf.length, fromAddr);
      if (received <= 0) await Bun.sleep(10);
    }

    expect(received).toBe(payload.length);
    expect(Array.from(recvBuf.subarray(0, received))).toEqual(Array.from(payload));

    // The sender's address, as seen by B, should carry A's port.
    expect(udpLandriver.GetSocketPort(fromAddr)).toBe(PORT_A);
    expect(fromAddr.sa_data[2]).toBe(127);
    expect(fromAddr.sa_data[3]).toBe(0);
    expect(fromAddr.sa_data[4]).toBe(0);
    expect(fromAddr.sa_data[5]).toBe(1);
  });

  test("Read returns 0 when nothing is queued", () => {
    const buf = new Uint8Array(16);
    const addr = newAddr();
    // socketA hasn't been written to (in this test), so its queue is empty.
    expect(udpLandriver.Read(socketA, buf, buf.length, addr)).toBe(0);
  });
});

describe("AddrToString / StringToAddr / SetSocketPort / GetSocketPort round trip", () => {
  test("AddrToString formats %d.%d.%d.%d:%d", () => {
    const addr = newAddr();
    addr.sa_family = 2;
    addr.sa_data.set([0x65, 0x79, 192, 168, 1, 42]); // port 0x6579 = 25977
    expect(udpLandriver.AddrToString(addr)).toBe("192.168.1.42:25977");
  });

  test("StringToAddr parses the same format AddrToString produces", () => {
    const addr = newAddr();
    expect(udpLandriver.StringToAddr("10.20.30.40:5000", addr)).toBe(0);
    expect(udpLandriver.AddrToString(addr)).toBe("10.20.30.40:5000");
  });

  test("SetSocketPort / GetSocketPort round trip", () => {
    const addr = newAddr();
    expect(udpLandriver.SetSocketPort(addr, 26000)).toBe(0);
    expect(udpLandriver.GetSocketPort(addr)).toBe(26000);

    expect(udpLandriver.SetSocketPort(addr, 1)).toBe(0);
    expect(udpLandriver.GetSocketPort(addr)).toBe(1);
  });

  test("full AddrToString -> StringToAddr -> AddrToString round trip", () => {
    const original = "203.0.113.7:34567";
    const addr = newAddr();
    udpLandriver.StringToAddr(original, addr);
    expect(udpLandriver.AddrToString(addr)).toBe(original);
  });
});

describe("PartialIPAddress", () => {
  // "12.34" and "1.2.3.4:26001" both start with a digit, so they're
  // exercised through the public UDP_GetAddrFromName entry point (its
  // `name[0]` digit gate, ported straight from the C, routes them into
  // PartialIPAddress). ".56" starts with '.', which that same gate rejects
  // in the C as much as here -- net_udp.c's UDP_GetAddrFromName can never
  // reach PartialIPAddress with a leading-dot input even though
  // PartialIPAddress itself supports one, so that case is called directly.
  test('"12.34" fills the low two octets, keeping myAddr\'s high two', () => {
    const addr = newAddr();
    const ret = udpLandriver.GetAddrFromName("12.34", addr);
    expect(ret).toBe(0);
    // myAddr defaults to 127.0.0.1 (no -ip parm in this test run), so the
    // high two octets (127, 0) are kept and the low two become 12, 34.
    expect(addr.sa_data[2]).toBe(127);
    expect(addr.sa_data[3]).toBe(0);
    expect(addr.sa_data[4]).toBe(12);
    expect(addr.sa_data[5]).toBe(34);
  });

  test('".56" fills only the low octet, keeping myAddr\'s high three', () => {
    const addr = newAddr();
    const ret = PartialIPAddress(".56", addr);
    expect(ret).toBe(0);
    expect(addr.sa_data[2]).toBe(127);
    expect(addr.sa_data[3]).toBe(0);
    expect(addr.sa_data[4]).toBe(0);
    expect(addr.sa_data[5]).toBe(56);
  });

  test('"1.2.3.4:26001" fully overrides the address and sets the given port', () => {
    const addr = newAddr();
    const ret = udpLandriver.GetAddrFromName("1.2.3.4:26001", addr);
    expect(ret).toBe(0);
    expect(addr.sa_data[2]).toBe(1);
    expect(addr.sa_data[3]).toBe(2);
    expect(addr.sa_data[4]).toBe(3);
    expect(addr.sa_data[5]).toBe(4);
    expect(udpLandriver.GetSocketPort(addr)).toBe(26001);
  });

  test("a non-numeric name (no gethostbyname lookup) returns -1", () => {
    const addr = newAddr();
    expect(udpLandriver.GetAddrFromName("some.hostname.example", addr)).toBe(-1);
  });
});

describe("AddrCompare", () => {
  test("identical address and port compare equal", () => {
    const a = newAddr();
    const b = newAddr();
    udpLandriver.StringToAddr("10.0.0.1:1000", a);
    udpLandriver.StringToAddr("10.0.0.1:1000", b);
    expect(udpLandriver.AddrCompare(a, b)).toBe(0);
  });

  test("same address, different port returns 1", () => {
    const a = newAddr();
    const b = newAddr();
    udpLandriver.StringToAddr("10.0.0.1:1000", a);
    udpLandriver.StringToAddr("10.0.0.1:2000", b);
    expect(udpLandriver.AddrCompare(a, b)).toBe(1);
  });

  test("different address returns -1", () => {
    const a = newAddr();
    const b = newAddr();
    udpLandriver.StringToAddr("10.0.0.1:1000", a);
    udpLandriver.StringToAddr("10.0.0.2:1000", b);
    expect(udpLandriver.AddrCompare(a, b)).toBe(-1);
  });

  test("different sa_family returns -1", () => {
    const a = newAddr();
    const b = newAddr();
    a.sa_family = 2;
    b.sa_family = 0;
    expect(udpLandriver.AddrCompare(a, b)).toBe(-1);
  });
});
