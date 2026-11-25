/**
 * Returns whether a graceful shutdown is already in progress.
 * Use this to stop accepting new work (consumers, HTTP handlers, loops).
 * @returns `true` after the first SIGINT / SIGTERM / `gracefulExit` event.
 */
export function isStopped(): boolean;

/**
 * Marks an in-flight unit of work so shutdown will not close clients yet.
 * Pair every call with {@link endTask} when the work finishes (success or error).
 * @returns The updated count of active tasks.
 */
export function startTask(): number;

/**
 * Marks an in-flight unit of work as finished.
 * When the count reaches 0, shutdown proceeds to close tracked clients.
 * @returns The updated count of active tasks.
 */
export function endTask(): number;

interface ShutdownConfigurationOptions {
  /**
   * Shutdown stall threshold for regular exits (signals and `gracefulExit` with code `0`).
   * Must be an integer in range [1000, 30000]. Defaults to 3000.
   */
  regularStallThreshold?: number;

  /**
   * Shutdown stall threshold for crash exits (`unhandledRejection`, `uncaughtException`,
   * and `gracefulExit` with a non-zero code).
   * Must be an integer in range [1000, 30000]. Defaults to 1500.
   */
  emergencyStallThreshold?: number;

  /**
   * Interval between shutdown progress checks in milliseconds.
   * Must be an integer in range [10, 500]. Defaults to 100.
   */
  checkProgressInterval?: number;
}

export type ShutdownConfiguration = {
  [Key in keyof ShutdownConfigurationOptions]-?: Required<Pick<ShutdownConfigurationOptions, Key>> &
    Partial<Omit<ShutdownConfigurationOptions, Key>>;
}[keyof ShutdownConfigurationOptions];

/**
 * Configures one or more shutdown thresholds.
 * Call this exactly once during application bootstrap, before shutdown starts.
 * Throws on an empty object, invalid values, or a subsequent call.
 */
export function configureShutdown(options: ShutdownConfiguration): void;

export interface CustomServer {
  close(callback?: (err?: Error) => void): any;

  once?(event: 'close', listener: (...args: any[]) => void): any;

  on?(event: 'close', listener: (...args: any[]) => void): any;
}

/**
 * Registers an external server instance (e.g., WebSocketServer)
 * to ensure it receives a `.close()` call during standard process teardown.
 */
export function trackServer(server: CustomServer): void;

type CloseableMethod = (...args: any[]) => any;

export type TrackableClient =
  { quit: CloseableMethod } | { close: CloseableMethod } | { end: CloseableMethod } | { disconnect: CloseableMethod };

/**
 * Registers an outbound client (ioredis, amqplib, pg, ...).
 * The client must have at least one of: quit, close, end, disconnect.
 */
export function trackClient(client: TrackableClient): void;

/**
 * Removes an outbound client previously registered with {@link trackClient}.
 * Required when you close or replace the client yourself: the library retains
 * a reference until untrack or process exit, so a reconnect loop would otherwise
 * leak closed clients for the lifetime of the process. A second `quit` / `close`
 * / `end` / `disconnect` on shutdown is usually harmless; the retained reference
 * is not. No-op if the client was never tracked.
 */
export function untrackClient(client: TrackableClient): void;

declare global {
  namespace NodeJS {
    interface Process {
      emit(event: 'gracefulExit', exitCode?: number): boolean;

      on(event: 'gracefulExit', listener: (exitCode?: number) => void): this;

      once(event: 'gracefulExit', listener: (exitCode?: number) => void): this;
    }
  }
}

export {};
