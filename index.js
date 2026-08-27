const diagnostics_channel = require('node:diagnostics_channel');
const { setImmediate, setTimeout } = require('node:timers/promises');
const { createLogger } = require('./src/logging');
const logger = createLogger('UniversalExit');

const REGULAR_STALL_THRESHOLD = 3000;
const EMERGENCY_STALL_THRESHOLD = 1500;
const CHECK_PROGRESS_INTERVAL = 100;

const activeSockets = new Set();
const nativeServers = new Set(); // Native HTTP/TCP servers via tracing:net.server.listen
const customServers = new Set(); // Custom servers (WS, SSE etc), mostly EventEmitter instances
class Clients extends Map {
  closing = false;
}
/**
 * Regular clients like ioredis or custom wrappers, guarded via TrackableClient
 * @type {Clients<object, string>}
 */
const clients = new Clients();

const CLOSING_METHODS = ['quit', 'close', 'end', 'disconnect'];
const resolveClosingMethod = client => CLOSING_METHODS.find(method => typeof client[method] === 'function');
const getCurrentBytes = () => Array.from(activeSockets).reduce((sum, s) => sum + (s.writableLength || 0), 0);

diagnostics_channel.tracingChannel('net.server.listen').subscribe({
  asyncEnd({ server }) {
    if (nativeServers.has(server)) return;
    nativeServers.add(server);
    server.once('close', () => {
      logger.debug('Native server close event');
      nativeServers.delete(server);
    });
  }
});

diagnostics_channel.channel('net.client.socket').subscribe(({ socket }) => {
  if (!activeSockets.has(socket)) {
    activeSockets.add(socket);

    socket.once('close', () => {
      activeSockets.delete(socket);
      logger.debug('Socket CLOSED. Left in set: %d', activeSockets.size);
    });

    socket.on('error', err => {
      logger.warn('Socket encountered error: %s', err.message);
    });
  }
});

// Internal application lifecycle state
let shuttingDown = false;
let activeTasksCount = 0;

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
  if (nativeServers.has(server)) {
    return;
  }

  if (customServers.has(server)) {
    return;
  }

  customServers.add(server);

  const cleanup = () => {
    logger.debug('Custom server close event');
    customServers.delete(server);
  };
  if (typeof server.once === 'function') {
    server.once('close', cleanup);
  } else if (typeof server.on === 'function') {
    server.on('close', cleanup);
  }
}

function trackClient(client) {
  if (!client || clients.has(client)) return;

  const method = resolveClosingMethod(client);
  if (!method) return;

  if (clients.closing) {
    void closeClient(client, method);
    return;
  }

  logger.debug('Adding client with method %s', method);
  clients.set(client, method);
}

function untrackClient(client) {
  if (!client || !clients.has(client)) return;
  logger.debug('Removing client manually');
  clients.delete(client);
}

function closeCustomServers() {
  for (const server of customServers) {
    try {
      if (server.clients) {
        logger.debug('Custom server clients: %d', server.clients.size);
        for (const client of server.clients) {
          client.terminate();
        }
      }
      server.close();
    } catch (err) {
      logger.error('Error closing custom server: %o', err);
    }
  }
}

function closeNativeServers() {
  for (const server of nativeServers) {
    try {
      server.close();
    } catch (err) {
      logger.error('Error closing native server: %o', err);
    }
  }
}

function closeClients() {
  if (clients.closing) {
    return;
  }
  clients.closing = true;
  Promise.all(
    Array.from(clients).map(async ([client, method]) => {
      await closeClient(client, method);
      clients.delete(client);
    })
  ).finally(() => logger.debug('Client close attempts finished'));
}

async function closeClient(client, method) {
  try {
    logger.debug('Closing client via %s...', method);
    await client[method]();
  } catch (err) {
    logger.error('Error closing client via %s: %o', method, err);
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

  logger.info(
    'Clean shutdown initiated. Custom Servers: %d, Native Servers: %d, Sockets: %d',
    customServers.size,
    nativeServers.size,
    activeSockets.size
  );

  closeCustomServers();
  closeNativeServers();

  const startedAt = Date.now();

  const lastState = {
    tasks: -1,
    bytes: -1,
    customServers: -1,
    nativeServers: -1,
    clients: -1,
    sockets: -1,
    started: startedAt,
    updated: startedAt
  };

  // noinspection InfiniteLoopJS
  while (true) {
    const currentBytes = getCurrentBytes();
    const currentTasks = activeTasksCount;

    logger.debug(
      'currentTasks: %d, currentBytes: %d, customServers: %d, nativeServers: %d, clients: %d',
      currentTasks,
      currentBytes,
      customServers.size,
      nativeServers.size,
      clients.size
    );
    if (currentTasks === 0) {
      closeClients();
    }

    if (
      currentTasks === 0 &&
      currentBytes === 0 &&
      customServers.size === 0 &&
      nativeServers.size === 0 &&
      clients.size === 0
    ) {
      logger.info('All buffers, tasks, servers and clients cleared successfully. Exiting cleanly.');
      await setImmediate();
      process.exit(options.exitCode);
    }

    const progressMade =
      currentTasks < lastState.tasks ||
      currentBytes !== lastState.bytes ||
      customServers.size < lastState.customServers ||
      nativeServers.size < lastState.nativeServers ||
      clients.size < lastState.clients ||
      activeSockets.size < lastState.sockets;
    const updatedAt = Date.now();

    if (progressMade || lastState.tasks === -1) {
      lastState.tasks = currentTasks;
      lastState.bytes = currentBytes;
      lastState.customServers = customServers.size;
      lastState.nativeServers = nativeServers.size;
      lastState.clients = clients.size;
      lastState.sockets = activeSockets.size;
      lastState.updated = updatedAt;
    } else {
      const stalledDuration = updatedAt - lastState.updated;

      if (stalledDuration >= options.stallThreshold) {
        logger.error(
          'EMERGENCY: No progress detected for %dms (Tasks: %d, Pending Bytes: %d). Forcing exit.',
          options.stallThreshold,
          currentTasks,
          currentBytes
        );
        closeClients();
        await setImmediate();
        process.exit(1);
      }
    }

    logger.debug(
      'Scheduling next check #%d. Sockets left: %d',
      Math.round((updatedAt - lastState.started) / CHECK_PROGRESS_INTERVAL),
      activeSockets.size
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
      logger.info('Received OS signal: %s', signal);
      void gracefulExit({ stallThreshold: REGULAR_STALL_THRESHOLD, exitCode: 0 });
    });
  }

  // Intercept unhandled exceptions and crashes
  // Shorter timeout ensures unstable processes don't hang in memory for too long
  process.on('unhandledRejection', reason => {
    logger.error('Critical Unhandled Rejection: %o', reason);
    void gracefulExit({ stallThreshold: EMERGENCY_STALL_THRESHOLD, exitCode: 1 });
  });

  process.on('uncaughtException', err => {
    logger.error('Critical Uncaught Exception: %o', err);
    void gracefulExit({ stallThreshold: EMERGENCY_STALL_THRESHOLD, exitCode: 1 });
  });

  // Listen for custom event on the global process event emitter
  process.on('gracefulExit', (code = 0) => {
    logger.info('Programmatic graceful exit triggered with code %d', code);
    void gracefulExit({ stallThreshold: REGULAR_STALL_THRESHOLD, exitCode: code });
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
