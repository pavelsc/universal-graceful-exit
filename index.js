const diagnostics_channel = require('node:diagnostics_channel');
const { setImmediate, setTimeout } = require('node:timers/promises');

const REGULAR_STALL_THRESHOLD = 3000;
const EMERGENCY_STALL_THRESHOLD = 1500;
const CHECK_PROGRESS_INTERVAL = 100;
const CLOSING_METHODS = ['quit', 'close', 'end', 'disconnect'];

const activeSockets = new Set();
const coreServers = new Set(); // Native HTTP/TCP servers via tracing:net.server.listen
const customServers = new Set(); // Custom servers (WS, SSE etc), mostly EventEmitter instances
const clients = new Map(); // Regular clients like ioredis or custom wrappers, guarded via TrackableClient

diagnostics_channel.tracingChannel('net.server.listen').subscribe({
  asyncEnd({ server }) {
    if (coreServers.has(server)) return;
    coreServers.add(server);
    server.once('close', () => {
      coreServers.delete(server);
    });
  }
});

diagnostics_channel.channel('net.client.socket').subscribe(({ socket }) => {
  if (!activeSockets.has(socket)) {
    activeSockets.add(socket);

    socket.once('close', () => {
      activeSockets.delete(socket);
      console.log(`[UniversalExit] Socket natively CLOSED. Left in set: ${activeSockets.size}`);
    });

    socket.on('error', err => {
      console.log(`[UniversalExit] Socket encountered error: ${err.message}`);
    });
  }
});

// Internal application lifecycle state
let shuttingDown = false;
let activeTasksCount = 0;

const getCurrentBytes = () => Array.from(activeSockets).reduce((sum, s) => sum + (s.writableLength || 0), 0);

/**
 * Returns true if the process is currently shutting down
 * @returns {boolean}
 */
function isStopped() {
  return shuttingDown;
}

function startTask() {
  return ++activeTasksCount;
}

function endTask() {
  return --activeTasksCount;
}

function trackServer(server) {
  if (!server || typeof server.close !== 'function') return;

  // Ignore native servers
  if (coreServers.has(server)) {
    return;
  }

  if (customServers.has(server)) {
    return;
  }

  customServers.add(server);

  const cleanup = () => {
    console.log('[UniversalExit] Custom server close event');
    customServers.delete(server);
  };
  if (typeof server.once === 'function') {
    server.once('close', cleanup);
  } else if (typeof server.on === 'function') {
    server.on('close', cleanup);
  }
}

function resolveClosingMethod(client) {
  return CLOSING_METHODS.find(method => typeof client[method] === 'function');
}

function trackClient(client) {
  if (!client || clients.has(client)) return;

  const method = resolveClosingMethod(client);
  if (!method) return;

  console.log(`[UniversalExit] Adding client with method ${method}`);
  clients.set(client, method);
}

function untrackClient(client) {
  if (!client || !clients.has(client)) return;
  console.log(`[UniversalExit] Removing client manually`);
  clients.delete(client);
}

function closeCustomServers() {
  for (const server of customServers) {
    try {
      if (server.clients) {
        for (const client of server.clients) {
          client.terminate();
        }
      }
      server.close();
    } catch (err) {
      console.error('[UniversalExit] Error closing custom server:', err);
    }
  }
}

function closeCoreServers() {
  for (const server of coreServers) {
    try {
      server.close();
    } catch (err) {
      console.error('[UniversalExit] Error closing native server:', err);
    }
  }
}

function closeClients() {
  for (const [client, method] of clients) {
    try {
      console.log(`[UniversalExit] Closing client via ${method}...`);
      client[method]();
    } catch (err) {
      console.error(`[UniversalExit] Error closing client via ${method}:`, err);
    } finally {
      clients.delete(client);
    }
  }
}

/**
 * Universally flushes socket buffers and gracefully exits the process
 * @param {Object} options
 * @param {number} options.stallThreshold - Max wait time for buffer flush in ms
 * @param {number} options.exitCode - Process exit code (0 for success, 1 for error)
 */
async function gracefulExit(options = { stallThreshold: REGULAR_STALL_THRESHOLD, exitCode: 0 }) {
  // Prevent overriding critical errors if already shutting down cleanly
  if (shuttingDown && options.exitCode === 0) return;
  shuttingDown = true;

  console.log(
    `[UniversalExit] Clean shutdown initiated. Native Servers: ${coreServers.size}, Custom Servers: ${customServers.size}, Sockets: ${activeSockets.size}`
  );

  closeCustomServers();
  closeCoreServers();

  const now = Date.now();

  const lastState = {
    tasks: -1,
    bytes: -1,
    servers: -1,
    clients: -1,
    sockets: -1,
    started: now,
    updated: now
  };

  // noinspection InfiniteLoopJS
  while (true) {
    const currentBytes = getCurrentBytes();
    const currentTasks = activeTasksCount;

    console.log(`[UniversalExit] currentTasks: ${currentTasks}, currentBytes: ${currentBytes}, customServers: ${customServers.size}, clients: ${clients.size}`);
    if (currentTasks === 0) {
      closeClients();
    }

    if (currentTasks === 0 && currentBytes === 0 && customServers.size === 0 && clients.size === 0) {
      console.log('[UniversalExit] All buffers, tasks, servers and clients cleared successfully. Exiting cleanly.');
      await setImmediate();
      process.exit(options.exitCode);
    }

    const progressMade =
      currentTasks < lastState.tasks ||
      currentBytes !== lastState.bytes ||
      customServers.size < lastState.servers ||
      clients.size < lastState.clients ||
      activeSockets.size < lastState.sockets;
    const now = Date.now();

    if (progressMade || lastState.tasks === -1) {
      lastState.tasks = currentTasks;
      lastState.bytes = currentBytes;
      lastState.servers = customServers.size;
      lastState.clients = clients.size;
      lastState.sockets = activeSockets.size;
      lastState.updated = now;
    } else {
      const stalledDuration = now - lastState.updated;

      if (stalledDuration >= options.stallThreshold) {
        console.error(
          `[UniversalExit] EMERGENCY: No progress detected for ${options.stallThreshold}ms (Tasks: ${currentTasks}, Pending Bytes: ${currentBytes}). Forcing exit.`
        );
        closeClients();
        await setImmediate();
        process.exit(1);
      }
    }

    console.log(
      `[UniversalExit] Scheduling next check #${Math.round((now - lastState.started) / CHECK_PROGRESS_INTERVAL)}. Sockets left: ${activeSockets.size}`
    );
    await setTimeout(CHECK_PROGRESS_INTERVAL);
  }
}

// Automatically intercept OS termination signals (Docker, K8s, PM2, Ctrl+C)
if (process.env.NODE_ENV !== 'test') {
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR2'];
  for (const signal of signals) {
    /**
     * The first SIGINT starts gracefulExit. Then Node removes the listener.
     * That is the problem. With zero SIGINT listeners, Node’s default is: SIGINT means die. Now.
     * You always get a second SIGINT (~100ms later from PM2 → npm → node).
     * First one is yours. Second one hits a process with no handler left, so Node kills it immediately.
     * on plus if (shuttingDown) return keeps a listener installed. The second SIGINT is swallowed.
     * Node still thinks someone is handling SIGINT, so it does not restore the default kill. Your drain can finish.
     * Same rule for SIGTERM / SIGHUP / SIGQUIT.
     * once is fine only if you will never get that signal twice. Under Docker/PM2/npm you will.
     */
    process.on(signal, () => {
      if (shuttingDown) return;
      console.log(`[UniversalExit] Received OS signal: ${signal}`);
      gracefulExit({ stallThreshold: REGULAR_STALL_THRESHOLD, exitCode: 0 });
    });
  }

  // Intercept unhandled exceptions and crashes
  // Shorter timeout ensures unstable processes don't hang in memory for too long
  process.on('unhandledRejection', reason => {
    console.error('[UniversalExit] Critical Unhandled Rejection:', reason);
    gracefulExit({ stallThreshold: EMERGENCY_STALL_THRESHOLD, exitCode: 1 });
  });

  process.on('uncaughtException', err => {
    console.error('[UniversalExit] Critical Uncaught Exception:', err);
    gracefulExit({ stallThreshold: EMERGENCY_STALL_THRESHOLD, exitCode: 1 });
  });

  // Listen for custom event on the global process event emitter
  process.on('gracefulExit', (code = 0) => {
    console.log(`[UniversalExit] Programmatic graceful exit triggered with code ${code}`);
    gracefulExit({ stallThreshold: REGULAR_STALL_THRESHOLD, exitCode: code });
  });
}

module.exports = {
  isStopped,
  startTask,
  endTask,
  trackServer,
  trackClient,
  untrackClient
};
