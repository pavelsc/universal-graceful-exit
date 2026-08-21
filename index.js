const diagnostics_channel = require('node:diagnostics_channel');
const { setTimeout } = require('node:timers/promises');

const REGULAR_STALL_THRESHOLD = 3000;
const EMERGENCY_STALL_THRESHOLD = 1500;
const CHECK_PROGRESS_INTERVAL = 100;

const activeSockets = new Set();
const activeServers = new Set();

diagnostics_channel.channel('net.server.listen').subscribe(({ server }) => {
  if (!activeServers.has(server)) {
    activeServers.add(server);

    server.once('close', () => {
      activeServers.delete(server);
    });
  }
});

diagnostics_channel.channel('net.client.socket').subscribe(({ socket }) => {
  if (!activeSockets.has(socket)) {
    activeSockets.add(socket);

    socket.once('close', () => {
      activeSockets.delete(socket);
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

  console.log(`[UniversalExit] Clean shutdown via Diagnostics Channels. Servers: ${activeServers.size}, Sockets: ${activeSockets.size}`);

  // Automatically close listening ports on all tracked servers
  for (const server of activeServers) {
    try {
      server.close();
    } catch (err) {
      console.error('[UniversalExit] Error closing server:', err);
    }
  }

  const lastState = {
    tasks: -1,
    bytes: -1,
    timestamp: Date.now()
  };

  async function checkProgress() {
    // Current metrics
    const currentBytes = Array.from(activeSockets).reduce((sum, s) => sum + (s.writableLength || 0), 0);
    const currentTasks = activeTasksCount;

    // Conditions to exit
    if (currentTasks === 0 && currentBytes === 0) {
      console.log('[UniversalExit] All buffers and tasks cleared successfully. Exiting cleanly.');
      process.exit(options.exitCode);
    }

    // Checking conditions dynamics
    const progressMade = currentTasks < lastState.tasks || currentBytes !== lastState.bytes;

    if (progressMade || lastState.tasks === -1) {
      // Update last state
      lastState.tasks = currentTasks;
      lastState.bytes = currentBytes;
      lastState.timestamp = Date.now();
    } else {
      // No dynamics detected
      const stalledDuration = Date.now() - lastState.timestamp;

      if (stalledDuration >= options.stallThreshold) {
        console.error(
          `[UniversalExit] EMERGENCY: No progress detected for ${options.stallThreshold}ms (Tasks: ${currentTasks}, Pending Bytes: ${currentBytes}). Forcing exit.`
        );
        process.exit(1);
      }
    }

    await setTimeout(CHECK_PROGRESS_INTERVAL);
    return checkProgress();
  }

  await checkProgress();
}

// Automatically intercept OS termination signals (Docker, K8s, PM2, Ctrl+C)
if (process.env.NODE_ENV !== 'test') {
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
  for (const signal of signals) {
    process.on(signal, () => gracefulExit({ stallThreshold: REGULAR_STALL_THRESHOLD, exitCode: 0 }));
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
  endTask
};
