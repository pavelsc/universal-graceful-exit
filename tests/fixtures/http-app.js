'use strict';

/**
 * Isolated HTTP application used by the child-process integration tests.
 *
 * Why a separate process?
 *   `universal-graceful-exit` installs process-wide signal handlers and
 *   eventually calls `process.exit()`. Running that inside the Jest worker
 *   would kill the test runner, leak listeners across cases, and make exit
 *   code assertions impossible. This file is the application under test.
 *
 * Why NODE_ENV must not be "test":
 *   The library skips OS-signal / crash hooks when NODE_ENV === 'test' so
 *   unit tests can import it safely. Jest launches this file with
 *   NODE_ENV=production so the production SIGINT path is exercised.
 *
 * Lifecycle:
 *   1. Import the library first (signal hooks + tracing:net.server.listen).
 *   2. Bind a native HTTP server — asyncEnd adds it to nativeServers
 *      and the listening handle keeps the event loop alive (no setInterval).
 *   3. Register mock + delayed outbound clients via trackClient().
 *   4. Idle until SIGINT (or a Windows IPC stand-in) starts gracefulExit().
 *   5. A second SIGINT listener trackClient()s a late client after
 *      clients.closing is already true.
 */

// Documented usage: first require so the tracing subscriber is in place
// before listen() publishes tracing:net.server.listen.
const { trackClient } = require('../../index.js');
const http = require('node:http');
const { setTimeout } = require('node:timers/promises');

const DELAYED_CLIENT_CLOSE_MS = 250;

/**
 * Stand-in for an outbound I/O client (ioredis, amqplib, pg, ...).
 * A `close()` method is enough for trackClient() to accept it; gracefulExit
 * will invoke that method once in-flight tasks drain to zero.
 */

const mockClientWithAllMethods = {
  quit() {
    console.log('[Fixture] Mock outbound client closed via quit');
    return Promise.reject('UNKNOWN');
  },
  close() {
    console.log('[Fixture] Mock outbound client closed via close');
  },
  end() {
    console.log('[Fixture] Mock outbound client closed via end');
  },
  disconnect() {
    console.log('[Fixture] Mock outbound client closed via disconnect');
  }
};

trackClient(mockClientWithAllMethods);

const mockClientWithCloseMethod = {
  close() {
    console.log('[Fixture] Mock outbound client closed with close');
  }
};

trackClient(mockClientWithCloseMethod);

/**
 * Promise-based client whose close takes ~150ms. Registered before SIGINT so
 * closeClients() keeps clients.size > 0 until the timer fires — shutdown must
 * wait for the handshake, not just the method call.
 */
const delayedClient = {
  async end() {
    await setTimeout(DELAYED_CLIENT_CLOSE_MS);
    console.log('[Fixture] Delayed outbound client closed via end');
  }
};

trackClient(delayedClient);

/**
 * Registered from our SIGINT listener, which runs after the library's.
 * By then closeClients() has set clients.closing, so this hits the late
 * trackClient path (void closeClient) instead of being inserted into the map.
 * Same 150ms delay: the boot-tracked delayed client keeps the process alive
 * long enough for this close to finish and log.
 */
const lateClient = {
  async disconnect() {
    await setTimeout(DELAYED_CLIENT_CLOSE_MS);
    console.log('[Fixture] Late outbound client closed via disconnect');
  }
};

process.on('SIGINT', () => {
  trackClient(lateClient);
});

/**
 * Native http.Server. listen() publishes `net.server.listen`, so the library
 * adds it to nativeServers and will call server.close() on shutdown.
 *
 * Do not add a setInterval heartbeat to "keep the process alive": a live
 * timer can delay process.exit() and inflate measured shutdown latency.
 * The listening handle is sufficient.
 */
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : address;
  console.log(`[Fixture] HTTP server listening on 127.0.0.1:${port}`);

  // Handshake for the test runner: do not send SIGINT until listen() finished.
  // process.send exists only when we were started with child_process.fork().
  if (typeof process.send === 'function') {
    process.send({ type: 'ready', port });
  }
});

/**
 * Windows cannot deliver a real SIGINT to a forked Node process — ChildProcess
 * #kill('SIGINT') terminates the pid unconditionally, skipping our handlers.
 * The Jest parent therefore sends this IPC payload; we re-emit SIGINT so the
 * library's process.on('SIGINT') listener (the production path) still runs.
 */
process.on('message', msg => {
  if (msg && msg.type === 'simulate-signal' && typeof msg.signal === 'string') {
    process.emit(msg.signal);
  }
});
