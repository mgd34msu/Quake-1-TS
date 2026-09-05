/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/net_udp.c and QW/client/net.h (GNU GPL v2 or later).

Q003. QW/client/net_udp.c's own top-of-file comment reads "// net_main.c" --
the file on disk in the QW/client tree is a copy of NetQuake's net_main.c
(the driver-independent half of the UDP transport: the netadr_t helpers,
NET_GetPacket/NET_SendPacket, NET_Init/NET_Shutdown, the module-owned
net_local_adr/net_from/net_message/net_message_buffer/net_socket globals),
not a renamed net_udp.c/net_wins.c driver file. Ported here anyway under the
net_udp.ts name per the unit brief's file mapping.

Adapted from ../quake-2-ts/src/platform/net_udp.ts for the Bun.udpSocket
idioms (async bind, a poll-based NET_GetPacket/NET_SendPacket pair, the
dotted-quad-only NET_StringToAdr) -- QW's own net.h/net_main.c is otherwise
simpler than either NetQuake's or Quake 2's transport and is ported from it
directly, not translated from the Quake 2 file structurally.

Deviations from the brief / from Quake 2's net_udp.ts:
- netadr_t here is QW's actual struct, confirmed by direct reading of
  QW/client/net.h: `{ byte ip[4]; unsigned short port; unsigned short pad; }`
  -- no `type` discriminant, no NA_LOOPBACK/NA_BROADCAST/NA_IP enum, no ipx
  field. QW has no single-player mode and no loopback network driver -- even
  a locally hosted game connects over a real UDP socket to 127.0.0.1 -- so
  there is nothing for a type tag to distinguish. This is a deliberate
  departure from the brief's suggestion to reuse Quake 2's netadr_t shape
  (PORTING.md: "the netadr_t shape as in Quake 2's port"); "port QW's
  exactly" (the brief's own words) wins where the two directives conflict,
  since the real header has no such field to carry over.
- UDP_OpenSocket does not set SO_BROADCAST. The brief anticipated it, but
  QW/client/net_udp.c's UDP_OpenSocket (unlike some other id UDP drivers)
  never calls setsockopt(SO_BROADCAST) -- confirmed by direct reading.
  Nothing here calls it either.
- Bun.udpSocket's bind is asynchronous; NET_Init kicks it off and returns
  immediately (matching the C's `void NET_Init(int port)` signature), with
  an exported `NET_Ready()` promise as the test/caller seam for "the socket
  has finished binding" -- NET_GetPacket/NET_SendPacket both silently no-op
  (matching the C's EWOULDBLOCK-is-silent branches) until then.
- No "Oversize packet from %s" drop exists in the real C NET_GetPacket (that
  message belongs to a different id UDP driver) -- QW's recvfrom is bounded
  by `sizeof(net_message_buffer)` at the syscall itself. Bun's socket `data`
  callback instead hands over a complete datagram regardless of buffer size,
  so an equivalent bounds check is added here (not in the literal source) to
  avoid an out-of-range `Uint8Array#set`; it prints and drops instead.
- NetadrToSockadr/SockadrToNetadr have no Bun equivalent (there is no
  sockaddr_in struct) and are replaced by the two small ip<->string helpers
  below, exactly as neither function is declared in net.h either (both are
  file-local to net_main.c).
- `net_message` is the same SizeBuf singleton object exported by
  src/common/sizebuf.ts. That module's MSG_Read* functions are hardwired to
  read from their own singleton (matching the real C prototypes, e.g.
  `int MSG_ReadLong (void)` -- no sizebuf_t parameter, unlike Quake 2's
  MSG_ReadLong(sizebuf_t*)), so there is no way to give QW an independent
  net_message object and still use those functions. Since qwcl/qwsv/quake
  never run in the same process, reusing the one singleton as QW's own
  process-global net_message is exactly the WinQuake net_main.c ownership
  model sizebuf.ts's own header comment describes, just reused for a second
  binary. NET_Init resizes its `.data`/`.maxsize` to MAX_UDP_PACKET (8192)
  bytes; test suites that call NET_Init must restore the original
  data/maxsize/cursize afterward (rule 15 -- shared singleton).
- net_send_socket (declared, never read or assigned anywhere in net_chan.c,
  net_main.c, or any other QW/client file -- confirmed by a repo-wide grep)
  is vestigial in the reference engine itself; not ported, matching the
  PORTING.md idiom of dropping dead globals rather than preserving unused
  ones for their own sake. Reported nonetheless since the brief's struct
  list mentions the field.
- NET_GetLocalAddress's `gethostname()` + `NET_StringToAdr()` DNS-resolution
  path has no safe synchronous equivalent on Bun's event loop (this port's
  NET_StringToAdr only resolves dotted quads, per the ruling below), so
  net_local_adr's IP is 127.0.0.1 unless a `-ip` command-line parameter gives
  a dotted quad, exactly as the brief rules.
- NET_StringToAdr: RULING per brief -- dotted quads only; a leading
  non-digit character (the C's gethostbyname path) returns false rather than
  attempting any DNS lookup.
*/

import { Q_atoi, COM_CheckParm, com_argv } from "../common/common";
import { net_message } from "../common/sizebuf";
import { Sys_Error, Sys_Printf } from "../platform/sys";
import { Con_Printf } from "../client/console";

// net.h
export const PORT_ANY = -1;

export class NetadrT {
  ip: Uint8Array = new Uint8Array(4);
  port = 0;
  pad = 0;
}

// `netadr_t` is a plain struct in the C, so every `a = b` on one is a copy.
// It is a class here, so the copies the C gets for free are explicit; this is
// the one helper both net_chan.ts's Netchan_Setup and server/sv_main.ts's
// stored-address assignments use, so no stored address ever aliases the
// `net_from` singleton. Not a QW/client/net_udp.c function.
export function copyNetadr(src: NetadrT): NetadrT {
  const a = new NetadrT();
  a.ip.set(src.ip);
  a.port = src.port;
  a.pad = src.pad;
  return a;
}

export const net_local_adr: NetadrT = new NetadrT();
export const net_from: NetadrT = new NetadrT(); // address of who sent the packet
export { net_message }; // sizebuf_t net_message -- see file header

const MAX_UDP_PACKET = 8192;
export const net_message_buffer: Uint8Array = new Uint8Array(MAX_UDP_PACKET);

// net_send_socket -- vestigial, not ported (see file header)

//=============================================================================
// address helpers (NetadrToSockadr/SockadrToNetadr have no Bun equivalent;
// see file header)

function ipBytesToString(ip: Uint8Array): string {
  return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
}

function stringToIpBytes(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part === undefined || !/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

export function NET_CompareBaseAdr(a: NetadrT, b: NetadrT): boolean {
  return a.ip[0] === b.ip[0] && a.ip[1] === b.ip[1] && a.ip[2] === b.ip[2] && a.ip[3] === b.ip[3];
}

export function NET_CompareAdr(a: NetadrT, b: NetadrT): boolean {
  return a.ip[0] === b.ip[0] && a.ip[1] === b.ip[1] && a.ip[2] === b.ip[2] && a.ip[3] === b.ip[3] && a.port === b.port;
}

export function NET_AdrToString(a: NetadrT): string {
  // sprintf (s, "%i.%i.%i.%i:%i", ..., ntohs(a.port)) -- port kept host-order
  // throughout this port (see brief); the ntohs() call in the C undoes the
  // network-byte-order storage this port never adopts, so it is simply
  // absent here rather than becoming a no-op call.
  return `${a.ip[0]}.${a.ip[1]}.${a.ip[2]}.${a.ip[3]}:${a.port}`;
}

export function NET_BaseAdrToString(a: NetadrT): string {
  return `${a.ip[0]}.${a.ip[1]}.${a.ip[2]}.${a.ip[3]}`;
}

/*
=============
NET_StringToAdr

idnewt
idnewt:28000
192.246.40.70
192.246.40.70:28000
=============
*/
export function NET_StringToAdr(s: string, a: NetadrT): boolean {
  let host = s;
  let port = 0;

  // strip off a trailing :port if present -- the C's char-by-char loop
  // truncates at the first colon it finds and parses the port from
  // whatever follows the last one; realistic input (an IPv4 dotted quad,
  // never containing a colon) only ever has at most one, so lastIndexOf
  // reproduces both without needing the C's exact quirky double-role loop.
  const colon = s.lastIndexOf(":");
  if (colon !== -1) {
    host = s.slice(0, colon);
    port = Q_atoi(s.slice(colon + 1)) & 0xffff;
  }

  if (host.length === 0) return false;

  const firstChar = host.charCodeAt(0);
  if (firstChar < 48 || firstChar > 57) {
    // gethostbyname path -- not supported, see file header
    return false;
  }

  const ip = stringToIpBytes(host);
  if (!ip) return false;

  a.ip.set(ip);
  a.port = port;
  a.pad = 0;

  return true;
}

// Returns true if we can't bind the address locally--in other words,
// the IP is NOT one of our interfaces.
//
// The C body is entirely `#if 0`'d out (a bind-probe against a real
// sockaddr_in) with `#else return true; #endif` selecting the always-true
// path in every real build -- dropped per PORTING.md's "#if 0 is dropped
// silently" rule; only the compiled `return true;` survives.
export function NET_IsClientLegal(_adr: NetadrT): boolean {
  return true;
}

//=============================================================================

type UdpSocket = Bun.udp.Socket<"buffer">;

interface RxPacket {
  data: Uint8Array;
  port: number;
  address: string;
}

let socket: UdpSocket | null = null;
const rxQueue: RxPacket[] = [];
let readyResolve: (() => void) | null = null;
let readyPromise: Promise<void> = new Promise((resolve) => {
  readyResolve = resolve;
});

// Test/caller seam: the C's UDP_OpenSocket/bind are synchronous, so by the
// time NET_Init returns the socket is already usable. Bun's bind is
// asynchronous; await this to reach the same point. Not part of net.h.
export function NET_Ready(): Promise<void> {
  return readyPromise;
}

async function UDP_OpenSocket(port: number): Promise<UdpSocket> {
  const ipParm = COM_CheckParm("-ip");
  let iface = "0.0.0.0"; // INADDR_ANY
  if (ipParm !== 0 && ipParm < com_argv.length - 1) {
    const parmIp = com_argv[ipParm + 1];
    if (parmIp !== undefined) {
      iface = parmIp;
      Con_Printf(`Binding to IP Interface Address of ${parmIp}\n`);
    }
  }

  const bindPort = port === PORT_ANY ? 0 : port;

  return Bun.udpSocket({
    hostname: iface,
    port: bindPort,
    socket: {
      data(_sock, data, fromPort, fromAddress) {
        rxQueue.push({ data: new Uint8Array(data), port: fromPort, address: fromAddress });
      },
      error(_sock, error) {
        Sys_Printf("NET_GetPacket: %s\n", error.message);
      },
    },
  });
}

// gethostname() has no portable synchronous Bun equivalent and the DNS
// resolve that follows it in the C is unsupported anyway (see file header):
// net_local_adr defaults to 127.0.0.1, or the `-ip` interface if one was
// given on the command line.
function NET_GetLocalAddress(): void {
  const ipParm = COM_CheckParm("-ip");
  let ipStr = "127.0.0.1";
  if (ipParm !== 0 && ipParm < com_argv.length - 1) {
    const parmIp = com_argv[ipParm + 1];
    if (parmIp !== undefined) ipStr = parmIp;
  }

  NET_StringToAdr(ipStr, net_local_adr);
  net_local_adr.port = socket ? socket.port : 0; // getsockname()'s bound port

  Con_Printf(`IP address ${NET_AdrToString(net_local_adr)}\n`);
}

/*
====================
NET_Init
====================
*/
export function NET_Init(port: number): void {
  // init the message buffer
  net_message.data = net_message_buffer;
  net_message.maxsize = net_message_buffer.length;
  net_message.cursize = 0;

  readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });

  // open the single socket to be used for all communications
  void UDP_OpenSocket(port)
    .then((sock) => {
      socket = sock;

      // determine my name & address
      NET_GetLocalAddress();

      Con_Printf("UDP Initialized\n");
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      Sys_Error("UDP_OpenSocket: socket: %s", message);
    })
    .finally(() => {
      readyResolve?.();
    });
}

/*
====================
NET_Shutdown
====================
*/
export function NET_Shutdown(): void {
  if (socket) {
    socket.close();
    socket = null;
  }
  rxQueue.length = 0;
}

export function NET_GetPacket(): boolean {
  const packet = rxQueue.shift();
  if (!packet) return false;

  // Not in the literal C (see file header) -- guards the Uint8Array#set
  // below the way recvfrom's own length cap did in the original.
  if (packet.data.length >= net_message_buffer.length) {
    Sys_Printf(`NET_GetPacket: oversize packet from ${packet.address}\n`);
    return false;
  }

  net_message.data.set(packet.data, 0);
  net_message.cursize = packet.data.length;

  const ip = stringToIpBytes(packet.address);
  if (ip) net_from.ip.set(ip);
  net_from.port = packet.port;
  net_from.pad = 0;

  return true;
}

export function NET_SendPacket(length: number, data: Uint8Array, to: NetadrT): void {
  if (!socket) return; // matches the EWOULDBLOCK-is-silent branch: nothing to send through yet

  const address = ipBytesToString(to.ip);
  // The C differentiates EWOULDBLOCK/ECONNREFUSED (silent) from any other
  // send() error (printed via Sys_Printf("NET_SendPacket: %s\n", ...)).
  // Bun's fire-and-forget socket.send() reports failures asynchronously
  // through the socket's own `error` callback above rather than throwing
  // synchronously, so that distinction has nothing to key off here.
  socket.send(data.subarray(0, length), to.port, address);
}
