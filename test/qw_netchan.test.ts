// Q003 -- QW/client/net_chan.c ported to src/qw/net_chan.ts.
//
// QW's Netchan_Setup leaves both outgoing_sequence and incoming_sequence at
// 0 (unlike Quake 2's net_chan.c, which explicitly pre-increments
// outgoing_sequence to 1 in its own Netchan_Setup -- confirmed absent from
// the real QW C by direct reading of QW/client/net_chan.c). Netchan_Process's
// duplicate/out-of-order guard is `sequence <= chan->incoming_sequence`, so a
// freshly set-up channel's very first transmitted packet (sequence 0) is
// always rejected by the peer as "not newer than incoming_sequence(0)" --
// this happens independently in each direction. Every test below that needs
// a channel pair past this one-packet warm-up sends (and discards) one
// throwaway packet first, exactly as two real QW peers would.
//
// One real process only ever has one net_socket (the C's single global
// `net_socket`), so this suite never opens one: it installs a
// mockImplementation on net_udp's NET_SendPacket (rule 15) that queues
// packets instead of touching a socket, and calls Netchan_Process directly
// against net_message once a queued packet is copied into it -- the same
// seam NET_GetPacket would otherwise fill.
//
// netchanState.isClient models "which binary is this call happening in"
// (the C's SERVERONLY compile-time define) and is read fresh on every call,
// per this module's own file header. A real qwcl process always leaves it
// true and a real qwsv process always leaves it false; this suite drives
// both a "client" and a "server" NetchanT in one process, so the helpers
// below set netchanState.isClient to true immediately around any call that
// touches the client NetchanT (Transmit *or* Process) and false around any
// call that touches the server NetchanT -- exactly reproducing what two
// separate qwcl/qwsv processes would each see, since Transmit's qport
// *write* is gated on isClient and Process's qport *read* is gated on
// !isClient: client.Transmit writes it, server.Process reads it; server.
// Transmit never writes it, client.Process never reads it. (An earlier
// draft of this suite pinned netchanState.isClient to one fixed value for
// the whole file, which desyncs the write/read gates -- Process silently
// consumed two bytes of real payload as a phantom qport field. Caught by
// running the suite, not by inspection; see the unit's report.)

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as netUdp from "../src/qw/net_udp";
import { NetadrT, NET_StringToAdr, net_from } from "../src/qw/net_udp";
import { net_message, MSG_WriteByte, MSG_ReadByte } from "../src/common/sizebuf";
import {
  NetchanT,
  Netchan_Init,
  Netchan_Setup,
  Netchan_Transmit,
  Netchan_Process,
  Netchan_CanPacket,
  Netchan_CanReliable,
  Netchan_OutOfBand,
  Netchan_OutOfBandPrint,
  netchanState,
  net_drop,
  qport,
} from "../src/qw/net_chan";

interface SentPacket {
  length: number;
  data: Uint8Array;
  to: NetadrT;
}

const sentPackets: SentPacket[] = [];

const sendPacketSpy = spyOn(netUdp, "NET_SendPacket"); // module scope: bare spyOn (rule 15)

let savedData: Uint8Array;
let savedMaxsize: number;
let savedCursize: number;

beforeAll(() => {
  savedData = net_message.data;
  savedMaxsize = net_message.maxsize;
  savedCursize = net_message.cursize;

  net_message.data = new Uint8Array(2048);
  net_message.maxsize = net_message.data.length;
  net_message.cursize = 0;

  Netchan_Init();

  sendPacketSpy.mockImplementation((length: number, data: Uint8Array, to: NetadrT) => {
    sentPackets.push({ length, data: data.slice(0, length), to });
  });
});

afterAll(() => {
  sendPacketSpy.mockRestore();

  net_message.data = savedData;
  net_message.maxsize = savedMaxsize;
  net_message.cursize = savedCursize;
});

beforeEach(() => {
  sentPackets.length = 0;
  netchanState.isClient = true;
  netchanState.demoplayback = false;
  netchanState.realtime = 0;
});

function makeAdr(s: string): NetadrT {
  const a = new NetadrT();
  NET_StringToAdr(s, a);
  return a;
}

function setupPair(): { client: NetchanT; server: NetchanT } {
  const client = new NetchanT();
  const server = new NetchanT();
  const serverAdr = makeAdr("10.0.0.2:27500");
  const clientAdr = makeAdr("10.0.0.1:27501");
  Netchan_Setup(client, serverAdr, 12345);
  Netchan_Setup(server, clientAdr, 0);
  return { client, server };
}

// netchanState.isClient is set to `senderIsClient` for the Transmit call and
// to its opposite for the Process call, matching two real, separate
// processes each seeing their own fixed sense of the flag -- see file header.
function transmitAndDeliver(sender: NetchanT, senderIsClient: boolean, receiver: NetchanT, payload: Uint8Array): boolean {
  netchanState.isClient = senderIsClient;
  Netchan_Transmit(sender, payload.length, payload);

  const packet = sentPackets.shift();
  if (!packet) return false;

  net_message.data.set(packet.data, 0);
  net_message.cursize = packet.length;
  net_from.ip.set(receiver.remote_address.ip);
  net_from.port = receiver.remote_address.port;

  netchanState.isClient = !senderIsClient;
  return Netchan_Process(receiver);
}

// Transmits, then discards the packet without ever handing it to
// Netchan_Process -- simulates the datagram being lost in flight.
function transmitAndDrop(sender: NetchanT, senderIsClient: boolean): void {
  netchanState.isClient = senderIsClient;
  Netchan_Transmit(sender, 0, new Uint8Array(0));
  sentPackets.length = 0;
}

// See file header: a fresh channel's first packet (sequence 0) is always
// rejected by Netchan_Process's `sequence <= incoming_sequence` check
// against the peer's own initial incoming_sequence of 0.
function warmUp(sender: NetchanT, senderIsClient: boolean, receiver: NetchanT): void {
  expect(transmitAndDeliver(sender, senderIsClient, receiver, new Uint8Array(0))).toBe(false);
}

describe("Netchan_Setup", () => {
  test("zeroes both sequence counters and stores remote_address/qport/rate (no Quake 2-style outgoing_sequence pre-increment)", () => {
    const { client, server } = setupPair();

    expect(client.outgoing_sequence).toBe(0);
    expect(client.incoming_sequence).toBe(0);
    expect(client.qport).toBe(12345);
    expect(client.rate).toBeCloseTo(1 / 2500, 10);
    expect(server.qport).toBe(0);
  });

  test("the first packet a fresh channel sends is rejected by its peer as not newer than incoming_sequence(0), but still advances outgoing_sequence", () => {
    const { client, server } = setupPair();

    expect(transmitAndDeliver(client, true, server, new Uint8Array([1]))).toBe(false);
    expect(client.outgoing_sequence).toBe(1); // Transmit itself always increments
    expect(server.incoming_sequence).toBe(0); // rejected before being applied
  });
});

describe("Netchan_Transmit / Netchan_Process over a spied NET_SendPacket", () => {
  test("delivers an unreliable payload and advances both sides' sequence numbers, once past the warm-up packet", () => {
    const { client, server } = setupPair();
    warmUp(client, true, server);

    const payload = new Uint8Array([10, 20, 30]);
    expect(transmitAndDeliver(client, true, server, payload)).toBe(true);

    expect(client.outgoing_sequence).toBe(2);
    expect(server.incoming_sequence).toBe(1);
    expect(server.drop_count).toBe(0);

    // Netchan_Process leaves the read cursor positioned right after the
    // header, ready for the caller to read the payload that follows it.
    expect(MSG_ReadByte()).toBe(10);
    expect(MSG_ReadByte()).toBe(20);
    expect(MSG_ReadByte()).toBe(30);

    expect(transmitAndDeliver(client, true, server, new Uint8Array(0))).toBe(true);
    expect(client.outgoing_sequence).toBe(3);
    expect(server.incoming_sequence).toBe(2);
  });

  test("duplicate and out-of-order packets are rejected without disturbing the connection", () => {
    const { client, server } = setupPair();
    warmUp(client, true, server);

    netchanState.isClient = true;
    Netchan_Transmit(client, 0, new Uint8Array(0));
    const packet = sentPackets.shift();
    if (!packet) throw new Error("expected a queued packet");
    net_message.data.set(packet.data, 0);
    net_message.cursize = packet.length;
    net_from.ip.set(server.remote_address.ip);
    net_from.port = server.remote_address.port;
    const saved = net_message.data.slice(0, net_message.cursize);

    netchanState.isClient = false;
    expect(Netchan_Process(server)).toBe(true);
    expect(server.incoming_sequence).toBe(1);

    // redeliver the exact same datagram
    net_message.data.set(saved, 0);
    net_message.cursize = saved.length;
    expect(Netchan_Process(server)).toBe(false);
    expect(server.incoming_sequence).toBe(1); // unchanged
  });

  test("a gap between sequence numbers is reflected in net_drop and the receiver's drop_count", () => {
    const { client, server } = setupPair();
    warmUp(client, true, server);

    transmitAndDrop(client, true); // sequence 1, lost in flight
    expect(transmitAndDeliver(client, true, server, new Uint8Array(0))).toBe(true); // sequence 2

    expect(net_drop).toBe(1);
    expect(server.drop_count).toBe(1);
  });
});

describe("Netchan_CanPacket / Netchan_CanReliable rate gating", () => {
  test("Netchan_CanPacket gates on netchanState.realtime vs cleartime, moved by hand", () => {
    const { client } = setupPair();

    expect(Netchan_CanPacket(client)).toBe(true); // cleartime starts at 0

    client.cleartime = 1000;
    netchanState.realtime = 0;
    expect(Netchan_CanPacket(client)).toBe(false); // far short of cleartime

    netchanState.realtime = 1000; // MAX_BACKUP*rate is > 0, so equal-or-later realtime reopens the gate
    expect(Netchan_CanPacket(client)).toBe(true);
  });

  test("Netchan_CanReliable is false while a reliable message is still unacked, independent of the packet gate", () => {
    const { client } = setupPair();

    expect(Netchan_CanReliable(client)).toBe(true);
    client.reliable_length = 10;
    expect(Netchan_CanReliable(client)).toBe(false);
  });
});

describe("reliable messages", () => {
  test("a reliable byte queued on chan.message is copied into reliable_buf on the next Transmit and the peer's incoming_reliable_sequence flips on receipt", () => {
    const { client, server } = setupPair();
    warmUp(client, true, server);

    MSG_WriteByte(client.message, 0xab);
    expect(client.message.cursize).toBe(1);
    expect(client.reliable_length).toBe(0);

    expect(transmitAndDeliver(client, true, server, new Uint8Array(0))).toBe(true);

    // the reliable payload was moved out of message and into reliable_buf
    expect(client.message.cursize).toBe(0);
    expect(client.reliable_length).toBe(1);
    expect(client.reliable_buf[0]).toBe(0xab);
    expect(Netchan_CanReliable(client)).toBe(false); // waiting for ack

    expect(server.incoming_reliable_sequence).toBe(1); // flipped by the reliable bit in w1

    // the payload delivered is the reliable byte itself
    expect(MSG_ReadByte()).toBe(0xab);
  });

  test("a reliable message survives a deliberately dropped packet and is resent once the client notices the ack gap", () => {
    const { client, server } = setupPair();
    warmUp(client, true, server);
    warmUp(server, false, client); // the ack path needs the reverse direction warmed up too

    MSG_WriteByte(client.message, 0x42);
    expect(Netchan_CanReliable(client)).toBe(true); // nothing in flight yet

    // this transmit picks up the reliable byte and is then lost before the
    // server ever processes it
    transmitAndDrop(client, true);
    expect(client.reliable_length).toBe(1);
    expect(Netchan_CanReliable(client)).toBe(false);

    // drive a bounded number of round trips; Netchan_Transmit resends the
    // still-unacked reliable buffer on its own once the client notices its
    // own incoming_acknowledged has passed last_reliable_sequence, so just
    // keep exchanging packets in both directions and watch for reliable_buf
    // showing up on the server (and reliable_length clearing on the client).
    let serverGotIt = false;
    for (let i = 0; i < 16 && !serverGotIt; i++) {
      if (transmitAndDeliver(client, true, server, new Uint8Array(0)) && server.incoming_reliable_sequence === 1) {
        serverGotIt = true;
      }
      transmitAndDeliver(server, false, client, new Uint8Array(0));
    }

    expect(serverGotIt).toBe(true);
    expect(client.reliable_length).toBe(0); // the server's ack eventually clears it
  });
});

describe("Netchan_OutOfBand / Netchan_OutOfBandPrint", () => {
  test("writes a -1 sequence header followed by the raw payload", () => {
    const adr = makeAdr("10.0.0.9:27500");
    Netchan_OutOfBand(adr, 3, new Uint8Array([65, 66, 67]));

    const packet = sentPackets.shift();
    if (!packet) throw new Error("expected a queued packet");

    const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
    expect(view.getInt32(0, true)).toBe(-1);
    expect(Array.from(packet.data.slice(4))).toEqual([65, 66, 67]);
  });

  test("Netchan_OutOfBandPrint formats its args and sends them after the -1 header", () => {
    const adr = makeAdr("10.0.0.9:27500");
    Netchan_OutOfBandPrint(adr, "ping %i", 7);

    const packet = sentPackets.shift();
    if (!packet) throw new Error("expected a queued packet");

    const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
    expect(view.getInt32(0, true)).toBe(-1);
    expect(new TextDecoder().decode(packet.data.slice(4))).toBe("ping 7");
  });
});

describe("netchanState.isClient -- the qport write (RULING: substitutes for #ifndef SERVERONLY)", () => {
  test("Transmit writes the qport cvar's value as a trailing short when isClient is true", () => {
    const { client } = setupPair();
    netchanState.isClient = true;
    qport.value = 999;

    Netchan_Transmit(client, 2, new Uint8Array([7, 8]));

    const packet = sentPackets.shift();
    if (!packet) throw new Error("expected a queued packet");

    // header: 4 (w1) + 4 (w2) + 2 (qport) = 10 bytes, then the 2-byte payload
    expect(packet.length).toBe(12);
    const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
    expect(view.getUint16(8, true)).toBe(999);
    expect(Array.from(packet.data.slice(10))).toEqual([7, 8]);
  });

  test("Transmit omits the qport short when isClient is false", () => {
    const { client } = setupPair();
    netchanState.isClient = false;

    Netchan_Transmit(client, 2, new Uint8Array([7, 8]));

    const packet = sentPackets.shift();
    if (!packet) throw new Error("expected a queued packet");

    // header: 4 (w1) + 4 (w2) = 8 bytes, then the 2-byte payload
    expect(packet.length).toBe(10);
    expect(Array.from(packet.data.slice(8))).toEqual([7, 8]);
  });
});
