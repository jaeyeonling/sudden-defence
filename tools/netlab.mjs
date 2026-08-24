#!/usr/bin/env node
/**
 * NETLAB — the one lab bench every netcode module measures on.
 *
 *   node tools/netlab.mjs --listen=8081 --target=8080 --preset=m6 [--seed=1]
 *
 * The curriculum's modules each begin by REPRODUCING a symptom (input lag,
 * teleporting remotes, starved ticks) under a stated network condition. If
 * every learner hand-rolls their own delay injection, the stated condition is
 * whatever their implementation happens to do — and a gate whose reproduction
 * conditions differ per person is not a gate. So the conditions live here, as
 * named presets, and the lesson pages say `--preset=m6` instead of numbers.
 *
 * TWO SURFACES, BECAUSE TRANSPORT IS THE LEARNER'S CHOICE
 *
 *   relay (CLI)   A TCP-level relay. WebSocket rides TCP, so a WS connection
 *                 shaped at the TCP layer needs no knowledge of WS framing —
 *                 point the client at --listen and the relay at the server.
 *   shape() (lib) An in-process wrapper around any `deliver(msg)` function,
 *                 for transports the relay cannot sit under (WebRTC data
 *                 channels, WebTransport datagrams — both UDP-family).
 *
 * WHY "DROP" MEANS TWO DIFFERENT THINGS
 *
 * TCP does not lose data; it converts packet loss into retransmission delay.
 * Deleting bytes from a relayed TCP stream would not simulate loss — it would
 * corrupt the WS framing and kill the connection, which no real network does.
 * So in relay mode `drop` is translated into what loss actually looks like
 * from above TCP: a latency spike (3x the base delay) on that chunk. The
 * in-process shape() serves UDP-family transports, where loss is real — there
 * `drop` genuinely discards, and `order: 'free'` lets messages overtake.
 * A learner who picks WebSocket and wonders why M7's drop exercise behaves
 * differently has just met head-of-line blocking with their own eyes — that
 * is the lesson, not a tool bug.
 *
 * DETERMINISTIC ON PURPOSE
 *
 * Jitter and drop draw from the repo's seeded Rng, not Math.random(): the
 * same --seed shakes the same connection the same way, so "it broke under
 * --preset=m6 --seed=7" is a report someone else can reproduce. This is the
 * same bargain the whole codebase makes (ARCHITECTURE.md rule 5), applied to
 * the instrument. Precisely what is deterministic: the DRAWS — which
 * messages drop, what delay each one is assigned. The realized arrival
 * interleaving still rides the event loop, so two messages assigned
 * near-equal times may swap between runs; a gate must assert on the shaped
 * conditions (loss pattern, delay bounds), never on an exact arrival trace.
 */
import net from 'node:net';
import { Rng } from '../src/core/rng.js';
import { parseArgs } from './harness.mjs';

/**
 * Named network conditions. The module docs cite these by key; the numbers
 * have exactly one home, here. delay/jitter in ms one-way, drop in [0,1].
 *
 *   m1  the RTT that makes raw server authority unplayable (400 ms round trip)
 *   m2  enough loss to force mispredictions while staying playable
 *   m3  the wobble that makes unbuffered remote entities visibly teleport
 *   m4  m1's shooter: lag compensation is judged at the same 200 ms
 *   m6  the jitter gate: ±80 ms, commands must still land once per tick
 *   m7  light loss for the ack/delta exercise (pair with --dropOnce for the
 *       "exactly one lost baseline" sabotage run)
 *
 * M5 and M9 have no preset: desync and cheating are not network conditions.
 * M3's 5 Hz snapshot rate is the learner's SERVER setting, not the network's.
 */
export const PRESETS = {
  m1: { delay: 200, jitter: 0, drop: 0 },
  m2: { delay: 100, jitter: 20, drop: 0.02 },
  m3: { delay: 100, jitter: 30, drop: 0 },
  m4: { delay: 200, jitter: 0, drop: 0 },
  m6: { delay: 100, jitter: 80, drop: 0 },
  m7: { delay: 50, jitter: 0, drop: 0.01 },
  clean: { delay: 0, jitter: 0, drop: 0 },
};

const SPIKE_FACTOR = 3; // relay mode: a "dropped" chunk arrives late, not never

/**
 * Wrap `deliver` so messages arrive shaped. Transport-agnostic: hand it your
 * DataChannel send, your WebTransport datagram writer, anything (msg) => void.
 *
 *   const send = shape((msg) => channel.send(msg), { ...PRESETS.m6, seed: 7 });
 *
 * opts: { delay, jitter, drop, seed, order }
 *   order 'preserve' (default) — no message overtakes another (TCP-like).
 *         'free'               — each message rides its own draw (UDP-like).
 *   drop  discards outright. Use order:'free' with it, or you are simulating
 *         a network that loses packets yet never reorders — which exists
 *         (it is TCP, and then drop should be 0 and the relay should be used).
 */
export function shape(deliver, opts = {}) {
  const { delay = 0, jitter = 0, drop = 0, seed = 1, order = 'preserve' } = opts;
  const rng = new Rng(seed >>> 0);
  let lastAt = 0;
  return (msg) => {
    if (drop > 0 && rng.float() < drop) return;
    let at = Date.now() + delay + (jitter > 0 ? (rng.float() * 2 - 1) * jitter : 0);
    if (order === 'preserve' && at < lastAt) at = lastAt;
    lastAt = at;
    setTimeout(() => deliver(msg), Math.max(0, at - Date.now()));
  };
}

/**
 * TCP relay: listen on `listenPort`, pipe every connection to `targetPort`
 * with both directions shaped. Returns the server (close() to stop).
 * Order is always preserved — it is TCP; anything else would be a lie the
 * receiving socket cannot even express.
 */
export function relay({ listenPort, targetPort, targetHost = '127.0.0.1', preset, seed = 1, log = () => {} }) {
  const { delay, jitter, drop } = preset;
  let conns = 0;
  const server = net.createServer((client) => {
    const id = ++conns;
    const upstream = net.connect({ port: targetPort, host: targetHost });
    // Two independent streams (c2s, s2c), each with its own rng fork-by-offset
    // so the directions do not share a jitter sequence.
    const mkDir = (from, to, dirSeed) => {
      const rng = new Rng(dirSeed >>> 0);
      let lastAt = 0;
      from.on('data', (chunk) => {
        let d = delay + (jitter > 0 ? (rng.float() * 2 - 1) * jitter : 0);
        if (drop > 0 && rng.float() < drop) d += delay * SPIKE_FACTOR; // loss on TCP = a spike
        let at = Date.now() + d;
        if (at < lastAt) at = lastAt; // TCP order survives shaping
        lastAt = at;
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, Math.max(0, at - Date.now()));
      });
      from.on('close', () => setTimeout(() => to.destroy(), delay + jitter));
      from.on('error', () => to.destroy());
    };
    mkDir(client, upstream, seed * 0x9e37 + id * 2);
    mkDir(upstream, client, seed * 0x9e37 + id * 2 + 1);
    log(`conn#${id} shaped: delay=${delay}ms jitter=±${jitter}ms drop=${drop}`);
  });
  server.listen(listenPort);
  return server;
}

// ---- CLI ------------------------------------------------------------------
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const args = parseArgs();
  const preset = PRESETS[args.preset ?? 'clean'];
  if (!preset) {
    console.error(`netlab: unknown preset '${args.preset}' — one of: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }
  const listenPort = Number(args.listen ?? 8081);
  const targetPort = Number(args.target ?? 8080);
  if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
    console.error('netlab: --listen and --target must be ports (the relay is TCP-level; give it the port under your WS URL)');
    process.exit(1);
  }
  relay({
    listenPort,
    targetPort,
    targetHost: args.host ?? '127.0.0.1',
    preset,
    seed: Number(args.seed ?? 1),
    log: (m) => console.log(`[netlab] ${m}`),
  });
  console.log(
    `[netlab] :${listenPort} -> ${args.host ?? '127.0.0.1'}:${targetPort}  ` +
      `preset=${args.preset ?? 'clean'} (delay=${preset.delay}ms jitter=±${preset.jitter}ms drop=${preset.drop}) seed=${args.seed ?? 1}`
  );
  console.log('[netlab] point your client at the listen port; ctrl-c to stop');
}
