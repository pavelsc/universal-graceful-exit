import net from 'net';

const activeSockets = new Set();
const originalConnect = net.connect;

// Internal application lifecycle state
let shuttingDown = false;
let activeTasksCount = 0;

// Intercept low-level TCP socket creation
net.connect = function (...args) {
  const socket = originalConnect.apply(this, args);
  activeSockets.add(socket);
  socket.on('close', () => activeSockets.delete(socket));
  return socket;
};
net.createConnection = net.connect;

/**
 * Returns true if the process is currently shutting down
 * @returns {boolean}
 */
export function isStopped() { return shuttingDown; }
export function startTask() { return ++activeTasksCount; }
export function endTask() { return --activeTasksCount; }

/**
 * Universally flushes socket buffers and gracefully exits the process
 * @param {Object} options
 * @param {number} options.stallThreshold - Max wait time for buffer flush in ms
 * @param {number} options.exitCode - Process exit code (0 for success, 1 for error)
 */
export async function gracefulExit(options = { stallThreshold: 3000, exitCode: 0 }) {
  // Prevent overriding critical errors if already shutting down cleanly
  if (shuttingDown && options.exitCode === 0) return;
  shuttingDown = true;

  console.log(`[UniversalExit] Shutdown started. Tracking active tasks and socket buffers...`);

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

    // Checking conditions dynamic
    const progressMade = currentTasks < lastState.tasks || currentBytes !== lastState.bytes;

    if (progressMade || lastState.tasks === -1) {
      // Update last state
      lastState.tasks = currentTasks;
      lastState.bytes = currentBytes;
      lastState.timestamp = Date.now();
    } else {
      // No dynamic detected
      const stalledDuration = Date.now() - lastState.timestamp;

      if (stalledDuration >= options.stallThreshold) {
        console.error(`[UniversalExit] EMERGENCY: No progress detected for ${options.stallThreshold}ms (Tasks: ${currentTasks}, Pending Bytes: ${currentBytes}). Forcing exit.`);
        process.exit(1);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 100));
    return checkProgress();
  }

  await checkProgress();
}

// Automatically intercept OS termination signals (Docker, K8s, PM2, Ctrl+C)
if (process.env.NODE_ENV !== 'test') {
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
  signals.forEach(signal => {
    process.on(signal, () => gracefulExit({ stallThreshold: 3000, exitCode: 0 }));
  });

  // Intercept unhandled exceptions and crashes
  // Shorter timeout ensures unstable processes don't hang in memory for too long
  process.on('unhandledRejection', (reason) => {
    console.error('[UniversalExit] Critical Unhandled Rejection:', reason);
    gracefulExit({ stallThreshold: 1500, exitCode: 1 });
  });

  process.on('uncaughtException', (err) => {
    console.error('[UniversalExit] Critical Uncaught Exception:', err);
    gracefulExit({ stallThreshold: 1500, exitCode: 1 });
  });
}
