/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/net_udp.h and WinQuake/net_udp.c (GNU GPL v2 or later),
folding in win32/net_wins.c's `-ip` command-line override (linux/net_udp.c
itself has no `-ip` handling; the unit brief for this port explicitly rules
it in here) -- net_wins.c/net_bsd.c themselves are not separately ported
(PORTING.md's platform mapping: one Bun.udpSocket LAN driver).

This module implements one `net_landriver_t` (net.h) over `Bun.udpSocket`.
`net.ts`/`net_main.ts` (unit U009, the owner of `net_landriver_t`/
`qsockaddr`/the `net_landrivers[]` table/`net_hostport`/the `hostname` cvar)
did not exist yet when this unit started (`src/common/net.ts`: "Cannot find
module" -- confirmed by `ls` before writing this file). Per the unit brief's
fallback ruling this file first declared local structural `NetLandriverT`/
`QsockaddrT` interfaces with the same shape instead of importing them;
net.ts landed mid-session with a `NetLandriverT`/`QsockaddrT` matching the
brief's sheet exactly, so this file now does `import type` from it instead
(see below) -- the fallback interfaces were removed once the real ones were
available, per the ruling's primary instruction. Only `udpLandriver` is
exported; net_main.ts's `NET_Init` is expected to
register it into `net_landrivers[]` at integration (the driver-table
initializer that lived in net_bsd.c/net_win.c/net_dos.c is not this file's
job either way -- see net_bsd.c:66-92 for its shape, mirrored below in
`udpLandriver`'s literal).

Deviations from the C:
- `struct qsockaddr { short sa_family; unsigned char sa_data[14]; }` ->
  `QsockaddrT { sa_family: number; sa_data: Uint8Array (14) }`. Every place
  the C reinterprets a qsockaddr as `struct sockaddr_in` reads/writes
  `sa_data` directly at the sockaddr_in layout's offsets past sa_family:
  sin_port at sa_data[0..1] (big-endian/network order), sin_addr at
  sa_data[2..5] (dotted-quad byte order), the remaining 8 bytes unused/zero.
- Sockets: there is no OS file descriptor to hand back synchronously --
  `Bun.udpSocket()` returns a Promise. Ruling (unit brief): UDP_OpenSocket
  allocates a small integer handle immediately and queues the bind in the
  background; UDP_Read against a socket whose bind hasn't resolved yet (or
  that failed to bind) just sees an empty receive queue, the same as every
  other "nothing arrived yet" case (see the UDP_Read note below); UDP_Write before
  the bind resolves returns -1. `UDP_Ready(socket)` (not part of net_udp.h)
  is exported as a test/integration seam: `await`ing it resolves once that
  handle's bind attempt has settled, returning whether it actually bound.
- UDP_Read: the C returns 0 for EWOULDBLOCK/ECONNREFUSED (recvfrom "nothing
  available yet", not an error -- net_dgrm.c:335-341 treats 0 as "stop
  polling, try again later" and -1 as a real read error worth a Con_Printf)
  and returns -1 only for a genuine error. The unit brief's prose describes
  this as "-1 when nothing queued", which would flip that C distinction and
  make net_dgrm.ts's future poll loop mis-treat "no packet yet" as a read
  error; resolved here in the C's actual favor -- an empty receive queue
  (bound or not-yet-bound) returns 0, and -1 is reserved for an unknown/
  closed socket handle (this port's closest analog to a bad-fd recvfrom()
  error). Reported as the port's resolution of that inconsistency.
- UDP_GetAddrFromName/gethostbyname, UDP_Init's gethostname+gethostbyname,
  and UDP_GetNameFromAddr's gethostbyaddr: none has a safe synchronous,
  network-free bun equivalent (a real DNS lookup would block the whole
  event loop or require an async signature no caller in net.h expects).
  Ruling (unit brief): GetAddrFromName resolves dotted-quad strings only
  (PartialIPAddress, ported exactly) and returns -1 for anything else;
  GetNameFromAddr never does reverse DNS and just returns AddrToString;
  UDP_Init never calls gethostname/gethostbyname and instead takes myAddr
  from `-ip` (parsed as a dotted quad, Sys_Error on a bad one, exactly as
  net_wins.c's `-ip` handling) or defaults to 127.0.0.1 ("resolve localhost
  -> 127.0.0.1" per the brief) with no `-ip` given. Real async DNS is a
  documented follow-up.
- UDP_Init's `hostname` cvar ("if the quake hostname isn't set, set it to
  the machine name"): net_main.c owns and registers this cvar; since
  net_main.ts doesn't exist yet, this file registers a local placeholder
  cvar if `Cvar_FindVar("hostname")` finds none (Cvar_RegisterVariable's own
  "already defined" guard makes the later real registration, once
  net_main.ts lands, a harmless no-op -- same precedent as common.ts's
  `host_parms` placeholder). With no real machine name available either
  (see the DNS point above), the address label (`-ip`'s argument, or
  "127.0.0.1") is used in its place, truncated to 15 chars like the C's
  `buff[15] = 0`.
- UDP_Init's `net_controlsocket`/broadcastaddr setup normally reads back its
  own just-opened control socket's bound address via UDP_GetSocketAddr to
  build `my_tcpip_address`. Because UDP_OpenSocket's bind is async (previous
  point), that socket is never bound yet at the moment UDP_Init returns;
  `my_tcpip_address` is built directly from myAddr instead of round-tripping
  through UDP_GetSocketAddr/AddrToString/colon-strip, which is the same
  observable result the C produces (getsockname's 0.0.0.0/127.0.0.1 result
  gets substituted with myAddr regardless -- see UDP_GetSocketAddr below).
- `net_hostport`/`my_tcpip_address`/`tcpipAvailable` are net_main.c globals
  this driver only reads/writes via `extern`. Not yet owned by anything
  (net_main.ts doesn't exist), so they live here as `udpState`, the same
  registrable-singleton idiom sys.ts uses for `hostShutdown`; `setNetHostport`
  lets net_main.ts override the default (26000, net_main.c's
  DEFAULTnet_hostport) once it lands, mirroring its `-port` handling.
- UDP_Broadcast/UDP_MakeSocketBroadcastCapable: the unit brief anticipated
  Bun might not expose SO_BROADCAST; it does (`Socket.setBroadcast`), so
  this is ported directly against that instead of the brief's documented
  "return -1" fallback.
- UDP_CheckNewConnections: the C's `ioctl(FIONREAD)` can itself fail and
  Sys_Error; there is no such ioctl here, only a JS array length check,
  which cannot fail the same way, so that Sys_Error path has no equivalent
  and is dropped.
- UDP_StringToAddr: `sscanf("%d.%d.%d.%d:%d", ...)` always returns 0 in the
  C even on a partial/failed match, leaving the unfilled `int`s as whatever
  garbage was already on the stack (undefined behavior, not reproducible in
  JS). Ported as a regex anchored the same way as the format string; a
  field sscanf would have left unfilled reads as 0 instead of stack garbage,
  and the function still always returns 0, matching the C's observable
  return value (never -1) even though the "garbage" itself can't match.
- PartialIPAddress is ported at byte granularity (this port's IPs are plain
  4-byte arrays, not a raw `sockaddr_in.s_addr` int) instead of literally
  reproducing the C's `mask <<= 8` / `htonl` bit tricks; the two are
  equivalent for every input the function accepts (".56" keeps myAddr's
  high 3 octets, replaces the low 1; "12.34" keeps the high 2, replaces the
  low 2; a full "a.b.c.d" replaces all 4). More than 4 dotted groups is a
  32-bit-shift-past-width UB corner in the original C with no defined
  result to match; this port returns -1 for that input instead (documented
  new behavior for an input class the original never defined).
*/

import { COM_CheckParm, Q_atoi, com_argc, com_argv } from "../common/common";
import { Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set, CvarT } from "../common/cvar";
import { Con_Printf } from "../client/console";
import { Sys_Error } from "./sys";
import type { NetLandriverT, QsockaddrT } from "../common/net";

// net.h's net_landriver_t / struct qsockaddr: src/common/net.ts (U009)
// landed mid-session (it did not exist when this unit started -- confirmed
// missing by `ls` before this file was written, per the unit brief's
// fallback ruling; a local structural interface was declared first and is
// now replaced by this import now that the real module is here and its
// `NetLandriverT`/`QsockaddrT` match the brief's sheet exactly). Re-exported
// so this module stays a one-stop import for its own test suite.
export type { NetLandriverT, QsockaddrT } from "../common/net";

const AF_INET = 2;

// net_main.c's globals this driver reaches through `extern` -- see header.
export const udpState = {
  net_hostport: 26000, // DEFAULTnet_hostport
  my_tcpip_address: "",
  tcpipAvailable: false,
};

export function setNetHostport(port: number): void {
  udpState.net_hostport = port;
}

//=============================================================================
// address byte helpers

function stringToIpBytes(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function fillSockaddr(addr: QsockaddrT, ipBytes: Uint8Array, port: number): void {
  addr.sa_family = AF_INET;
  addr.sa_data.fill(0);
  addr.sa_data[0] = (port >> 8) & 0xff;
  addr.sa_data[1] = port & 0xff;
  addr.sa_data[2] = ipBytes[0] ?? 0;
  addr.sa_data[3] = ipBytes[1] ?? 0;
  addr.sa_data[4] = ipBytes[2] ?? 0;
  addr.sa_data[5] = ipBytes[3] ?? 0;
}

//=============================================================================
// socket handle table

interface RxPacket {
  data: Uint8Array;
  port: number;
  address: string;
}

interface UdpSocketEntry {
  socket: Bun.udp.Socket<"buffer"> | null;
  rxQueue: RxPacket[];
  closed: boolean;
}

let nextHandle = 1;
const socketTable = new Map<number, UdpSocketEntry>();
const pendingBinds = new Map<number, Promise<void>>();

// Test/integration seam, not part of net_udp.h: resolves once `socket`'s
// (async) bind attempt has settled, returning whether it actually bound.
export async function UDP_Ready(socket: number): Promise<boolean> {
  const pending = pendingBinds.get(socket);
  if (pending) await pending;
  const entry = socketTable.get(socket);
  return entry !== undefined && entry.socket !== null;
}

//=============================================================================

let net_acceptsocket = -1; // socket for fielding new connections
let net_controlsocket = -1;
let net_broadcastsocket = 0;
const broadcastaddr: QsockaddrT = { sa_family: AF_INET, sa_data: new Uint8Array(14) };

let myAddr: Uint8Array = new Uint8Array([127, 0, 0, 1]);

function UDP_Init(): number {
  if (COM_CheckParm("-noudp")) return -1;

  // determine my name & address -- see header (no gethostname/gethostbyname)
  let addressLabel = "127.0.0.1";
  const ipParm = COM_CheckParm("-ip");
  if (ipParm) {
    if (ipParm < com_argc - 1) {
      const parsed = stringToIpBytes(com_argv[ipParm + 1]);
      if (!parsed) Sys_Error("%s is not a valid IP address", com_argv[ipParm + 1]);
      myAddr = parsed;
      addressLabel = com_argv[ipParm + 1];
    } else {
      Sys_Error("NET_Init: you must specify an IP address after -ip");
    }
  } else {
    myAddr = new Uint8Array([127, 0, 0, 1]);
  }

  // if the quake hostname isn't set, set it to the machine name
  let hostnameCvar = Cvar_FindVar("hostname");
  if (!hostnameCvar) {
    hostnameCvar = new CvarT("hostname", "UNNAMED");
    Cvar_RegisterVariable(hostnameCvar);
  }
  if (hostnameCvar.string === "UNNAMED") {
    Cvar_Set("hostname", addressLabel.slice(0, 15));
  }

  net_controlsocket = UDP_OpenSocket(0);
  if (net_controlsocket === -1) Sys_Error("UDP_Init: Unable to open control socket\n");

  fillSockaddr(broadcastaddr, new Uint8Array([255, 255, 255, 255]), udpState.net_hostport);

  udpState.my_tcpip_address = `${myAddr[0]}.${myAddr[1]}.${myAddr[2]}.${myAddr[3]}`;

  Con_Printf("UDP Initialized\n");
  udpState.tcpipAvailable = true;

  return net_controlsocket;
}

function UDP_Shutdown(): void {
  UDP_Listen(false);
  UDP_CloseSocket(net_controlsocket);
}

function UDP_Listen(state: boolean): void {
  // enable listening
  if (state) {
    if (net_acceptsocket !== -1) return;
    net_acceptsocket = UDP_OpenSocket(udpState.net_hostport);
    if (net_acceptsocket === -1) Sys_Error("UDP_Listen: Unable to open accept socket\n");
    return;
  }

  // disable listening
  if (net_acceptsocket === -1) return;
  UDP_CloseSocket(net_acceptsocket);
  net_acceptsocket = -1;
}

function UDP_OpenSocket(port: number): number {
  const handle = nextHandle++;
  const entry: UdpSocketEntry = { socket: null, rxQueue: [], closed: false };
  socketTable.set(handle, entry);

  const promise = Bun.udpSocket({
    hostname: "0.0.0.0",
    port,
    socket: {
      data(_socket, data, fromPort, fromAddress) {
        entry.rxQueue.push({ data: new Uint8Array(data), port: fromPort, address: fromAddress });
      },
      error(_socket, error) {
        Con_Printf("UDP: %s\n", error.message);
      },
    },
  })
    .then((socket) => {
      if (entry.closed) {
        socket.close();
        return;
      }
      entry.socket = socket;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      Con_Printf("UDP_OpenSocket: %s\n", message);
    });

  pendingBinds.set(handle, promise);
  return handle;
}

function UDP_CloseSocket(socket: number): number {
  if (socket === net_broadcastsocket) net_broadcastsocket = 0;

  const entry = socketTable.get(socket);
  if (!entry) return -1;

  entry.closed = true;
  if (entry.socket) entry.socket.close();
  socketTable.delete(socket);
  pendingBinds.delete(socket);
  return 0;
}

//=============================================================================
/*
============
PartialIPAddress

this lets you type only as much of the net address as required, using
the local network components to fill in the rest
============
*/
// Exported only for the test suite: static in the C (net_udp.c has no
// header declaration for it) and reached in this port the same way, through
// UDP_GetAddrFromName's `name[0]` digit gate below -- which a leading-dot
// input like ".56" never passes, in the C as much as here, so a call
// through the public UDP_GetAddrFromName entry point alone cannot exercise
// that case even though PartialIPAddress itself supports it.
export function PartialIPAddress(input: string, hostaddr: QsockaddrT): number {
  const buff = "." + input;
  let i = buff.charAt(1) === "." ? 1 : 0;

  const octets: number[] = [];
  while (buff.charAt(i) === ".") {
    i++;
    let num = 0;
    let run = 0;
    while (buff.charAt(i) >= "0" && buff.charAt(i) <= "9") {
      num = num * 10 + (buff.charCodeAt(i) - 48);
      i++;
      run++;
      if (run > 3) return -1;
    }
    const next = buff.charAt(i);
    if (next !== "" && next !== "." && next !== ":" && !(next >= "0" && next <= "9")) return -1;
    if (num < 0 || num > 255) return -1;
    octets.push(num);
  }

  if (octets.length === 0 || octets.length > 4) return -1; // see header: >4 groups is UB in the C, not ported

  let port = udpState.net_hostport;
  if (buff.charAt(i) === ":") {
    port = Q_atoi(buff.slice(i + 1));
  }

  const addrBytes = new Uint8Array(4);
  const fixed = 4 - octets.length;
  for (let k = 0; k < fixed; k++) addrBytes[k] = myAddr[k] ?? 0;
  for (let k = 0; k < octets.length; k++) {
    const octet = octets[k];
    if (octet !== undefined) addrBytes[fixed + k] = octet;
  }

  fillSockaddr(hostaddr, addrBytes, port);
  return 0;
}

//=============================================================================

function UDP_Connect(_socket: number, _addr: QsockaddrT): number {
  return 0;
}

//=============================================================================

function UDP_CheckNewConnections(): number {
  if (net_acceptsocket === -1) return -1;

  const entry = socketTable.get(net_acceptsocket);
  if (entry && entry.rxQueue.length > 0) return net_acceptsocket;
  return -1;
}

//=============================================================================

function UDP_Read(socket: number, buf: Uint8Array, len: number, addr: QsockaddrT): number {
  const entry = socketTable.get(socket);
  if (!entry) return -1; // unknown/closed handle -- this port's closest analog to a bad-fd recvfrom() error

  const packet = entry.rxQueue.shift();
  if (!packet) return 0; // EWOULDBLOCK/ECONNREFUSED equivalent (also covers "bind still pending") -- see header

  const n = Math.min(len, packet.data.length);
  buf.set(packet.data.subarray(0, n), 0);

  const ipBytes = stringToIpBytes(packet.address) ?? new Uint8Array(4);
  fillSockaddr(addr, ipBytes, packet.port);

  return n;
}

//=============================================================================

function UDP_MakeSocketBroadcastCapable(socket: number): number {
  const entry = socketTable.get(socket);
  if (!entry || !entry.socket) return -1;

  // make this socket broadcast capable
  if (!entry.socket.setBroadcast(true)) return -1;
  net_broadcastsocket = socket;

  return 0;
}

//=============================================================================

function UDP_Broadcast(socket: number, buf: Uint8Array, len: number): number {
  if (socket !== net_broadcastsocket) {
    if (net_broadcastsocket !== 0) Sys_Error("Attempted to use multiple broadcasts sockets\n");
    const ret = UDP_MakeSocketBroadcastCapable(socket);
    if (ret === -1) {
      Con_Printf("Unable to make socket broadcast capable\n");
      return ret;
    }
  }

  return UDP_Write(socket, buf, len, broadcastaddr);
}

//=============================================================================

function UDP_Write(socket: number, buf: Uint8Array, len: number, addr: QsockaddrT): number {
  const entry = socketTable.get(socket);
  if (!entry || !entry.socket) return -1; // not bound yet, or unknown handle -- see header

  const port = (addr.sa_data[0] << 8) | addr.sa_data[1];
  const address = `${addr.sa_data[2]}.${addr.sa_data[3]}.${addr.sa_data[4]}.${addr.sa_data[5]}`;

  try {
    const ok = entry.socket.send(buf.subarray(0, len), port, address);
    return ok ? len : 0; // false is this port's closest analog to sendto()'s EWOULDBLOCK
  } catch {
    return -1;
  }
}

//=============================================================================

function UDP_AddrToString(addr: QsockaddrT): string {
  const port = (addr.sa_data[0] << 8) | addr.sa_data[1];
  return `${addr.sa_data[2]}.${addr.sa_data[3]}.${addr.sa_data[4]}.${addr.sa_data[5]}:${port}`;
}

//=============================================================================

function UDP_StringToAddr(s: string, addr: QsockaddrT): number {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+):(\d+)/.exec(s);
  const ha1 = m ? Number(m[1]) & 0xff : 0;
  const ha2 = m ? Number(m[2]) & 0xff : 0;
  const ha3 = m ? Number(m[3]) & 0xff : 0;
  const ha4 = m ? Number(m[4]) & 0xff : 0;
  const hp = m ? Number(m[5]) : 0;

  fillSockaddr(addr, new Uint8Array([ha1, ha2, ha3, ha4]), hp);
  return 0;
}

//=============================================================================

function UDP_GetSocketAddr(socket: number, addr: QsockaddrT): number {
  addr.sa_family = AF_INET;
  addr.sa_data.fill(0);

  const entry = socketTable.get(socket);
  const bunSocket = entry ? entry.socket : null;
  if (!bunSocket) return 0; // getsockname() has nothing to report; addr stays zeroed like the C's memset

  let ipBytes = stringToIpBytes(bunSocket.address.address);
  const isAny = !ipBytes || (ipBytes[0] === 0 && ipBytes[1] === 0 && ipBytes[2] === 0 && ipBytes[3] === 0);
  const isLoopback = ipBytes && ipBytes[0] === 127 && ipBytes[1] === 0 && ipBytes[2] === 0 && ipBytes[3] === 1;
  if (isAny || isLoopback) ipBytes = myAddr;

  fillSockaddr(addr, ipBytes ?? new Uint8Array(4), bunSocket.port);
  return 0;
}

//=============================================================================

function UDP_GetNameFromAddr(addr: QsockaddrT): string {
  return UDP_AddrToString(addr);
}

//=============================================================================

function UDP_GetAddrFromName(name: string, addr: QsockaddrT): number {
  if (name.length > 0 && name.charAt(0) >= "0" && name.charAt(0) <= "9") return PartialIPAddress(name, addr);

  return -1; // no gethostbyname network lookup -- see header
}

//=============================================================================

function UDP_AddrCompare(addr1: QsockaddrT, addr2: QsockaddrT): number {
  if (addr1.sa_family !== addr2.sa_family) return -1;

  for (let i = 2; i <= 5; i++) if (addr1.sa_data[i] !== addr2.sa_data[i]) return -1;

  if (addr1.sa_data[0] !== addr2.sa_data[0] || addr1.sa_data[1] !== addr2.sa_data[1]) return 1;

  return 0;
}

//=============================================================================

function UDP_GetSocketPort(addr: QsockaddrT): number {
  return (addr.sa_data[0] << 8) | addr.sa_data[1];
}

function UDP_SetSocketPort(addr: QsockaddrT, port: number): number {
  addr.sa_data[0] = (port >> 8) & 0xff;
  addr.sa_data[1] = port & 0xff;
  return 0;
}

//=============================================================================
// net_bsd.c:66-92's net_landrivers[] initializer, one entry.

export const udpLandriver: NetLandriverT = {
  name: "UDP",
  initialized: false,
  controlSock: 0,
  Init: UDP_Init,
  Shutdown: UDP_Shutdown,
  Listen: UDP_Listen,
  OpenSocket: UDP_OpenSocket,
  CloseSocket: UDP_CloseSocket,
  Connect: UDP_Connect,
  CheckNewConnections: UDP_CheckNewConnections,
  Read: UDP_Read,
  Write: UDP_Write,
  Broadcast: UDP_Broadcast,
  AddrToString: UDP_AddrToString,
  StringToAddr: UDP_StringToAddr,
  GetSocketAddr: UDP_GetSocketAddr,
  GetNameFromAddr: UDP_GetNameFromAddr,
  GetAddrFromName: UDP_GetAddrFromName,
  AddrCompare: UDP_AddrCompare,
  GetSocketPort: UDP_GetSocketPort,
  SetSocketPort: UDP_SetSocketPort,
};
