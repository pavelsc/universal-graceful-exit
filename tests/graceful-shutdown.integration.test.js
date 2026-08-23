'use strict';

/**
 * Integration tests for universal-graceful-exit.
 *
 * Strategy — Testing via Child Processes
 * --------------------------------------
 * The library under test calls `process.exit()` and installs process-wide
 * signal handlers. Requiring it inside this Jest worker would:
 *   - tear down the runner on a successful shutdown
 *   - leak handlers / shuttingDown state across tests
 *   - make exit-code and latency assertions impossible
 *
 * We therefore spawn `tests/fixtures/http-app.js` as a sibling Node process.
 * That child is a miniature production app. The runner only observes its
 * stdout and lifecycle — the same signals Docker, PM2, or Ctrl+C would send.
 */

const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const path = require('node:path');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'http-app.js');
const IS_LOUD = process.env.LOUD_TESTS === 'true';

/** Production shutdown of an idle HTTP app must beat this budget. */
const SHUTDOWN_LATENCY_BUDGET_MS = 1000;

/**
 * Upper bound for waitForChildExit. Larger than the latency budget so a
 * hung child fails with our error (and a SIGKILL) instead of Jest's generic
 * timeout, while still not waiting the full default 5000 ms.
 */
const CHILD_EXIT_TIMEOUT_MS = 2000;

const READY_TIMEOUT_MS = 5000;

/**
 * Launch the fixture in a process that looks like production.
 *
 * NODE_ENV is forced to "production" because the library skips signal hooks
 * when NODE_ENV === 'test'. The child must not inherit Jest's environment.
 *
 * silent: true  — pipe stdout/stderr so we can assert on log lines.
 * execArgv: []  — drop Jest / inspector flags that would attach to the child.
 */
function spawnFixture() {
  return fork(FIXTURE_PATH, [], {
    silent: true,
    execArgv: [],
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'production'
    }
  });
}

/**
 * Resolve once the fixture's HTTP server is listening.
 * Attaches listeners in this function and always detaches them on settle
 * so a late 'ready' message cannot leak a handler into the next test.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<{ type: string, port: number }>}
 */
function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Fixture did not become ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    function onMessage(msg) {
      if (msg && msg.type === 'ready') {
        cleanup();
        resolve(msg);
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Fixture exited before ready (code=${code}, signal=${signal})`));
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    }

    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/**
 * Deliver SIGINT the way production would, with a Windows stand-in.
 *
 * POSIX: ChildProcess#kill('SIGINT') is a real OS signal and hits the
 *   library's process.on('SIGINT') listener.
 * Windows: kill('SIGINT') unconditionally terminates the pid and never
 *   runs JS handlers. We send an IPC payload that the fixture re-emits as
 *   SIGINT so the identical listener still runs.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function deliverSigint(child) {
  if (process.platform === 'win32') {
    const sent = child.send({ type: 'simulate-signal', signal: 'SIGINT' });
    if (!sent) {
      throw new Error('Failed to send SIGINT simulation to the fixture (IPC channel closed)');
    }
    return;
  }

  child.kill('SIGINT');
}

/**
 * Capture stdout/stderr until the child exits, then detach every listener.
 * If the child hangs, SIGKILL it and reject with the buffered output so
 * the failure is diagnosable.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }>}
 */
function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onStdout);
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', onStderr);
    }

    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      finish(new Error(`Child did not exit within ${CHILD_EXIT_TIMEOUT_MS}ms (possible hang).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, CHILD_EXIT_TIMEOUT_MS);

    child.once('exit', onExit);
    child.once('error', onError);

    function onStdout(chunk) {
      stdout += chunk;
      if (IS_LOUD) {
        process.stdout.write(chunk);
      }
    }

    function onStderr(chunk) {
      stderr += chunk;
      if (IS_LOUD) {
        process.stderr.write(chunk);
      }
    }

    function onExit(code, signal) {
      finish(null, { code, signal, stdout, stderr });
    }

    function onError(err) {
      finish(err);
    }

    function finish(err, result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (child.stdout) {
        child.stdout.off('data', onStdout);
        child.stdout.removeAllListeners('data');
      }
      if (child.stderr) {
        child.stderr.off('data', onStderr);
        child.stderr.removeAllListeners('data');
      }
      child.off('exit', onExit);
      child.off('error', onError);

      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    }
  });
}

/**
 * Force-kill a child that is still alive after a failed assertion so the
 * next test cannot inherit a leaked pid or open IPC channel.
 *
 * @param {import('node:child_process').ChildProcess | undefined} child
 */
function ensureChildDead(child) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGKILL');
}

describe('graceful shutdown via child process', () => {
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;

  afterEach(() => {
    ensureChildDead(child);
    child = undefined;
  });

  test('SIGINT drains an idle HTTP app and exits 0 within the latency budget', async () => {
    child = spawnFixture();

    // Attach stdio watchers before the child can print anything, then wait
    // until listen() has completed so we do not signal a half-booted app.
    const exitPromise = waitForChildExit(child);
    await waitForReady(child);

    const shutdownStartedAt = performance.now();
    deliverSigint(child);

    const { code, signal, stdout, stderr } = await exitPromise;
    const shutdownLatencyMs = performance.now() - shutdownStartedAt;

    const output = `${stdout}${stderr}`;

    // 1. Library acknowledged the start of a clean drain.
    expect(output).toContain('[UniversalExit] Clean shutdown initiated.');

    // 2. Drain finished; this is the last line the library prints before exit.
    expect(output).toContain('Exiting cleanly.');

    // 3. Checking that close method was found
    expect(output).toContain('[Fixture] Mock outbound client closed');

    const initiatedAt = output.indexOf('[UniversalExit] Clean shutdown initiated.');
    const exitingAt = output.indexOf('Exiting cleanly.');
    expect(exitingAt).toBeGreaterThan(initiatedAt);

    // 3. Successful teardown — not an emergency force-exit (code 1).
    expect(signal).toBeNull();
    expect(code).toBe(0);

    // 4. An idle app must not sit on the 3s stall watchdog or Jest's timeout.
    expect(shutdownLatencyMs).toBeLessThan(SHUTDOWN_LATENCY_BUDGET_MS);
  });
});
