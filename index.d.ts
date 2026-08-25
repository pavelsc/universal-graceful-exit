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
