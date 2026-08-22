export function isStopped(): boolean;

export function startTask(): number;

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

export type TrackableClient = { quit: Function } | { close: Function } | { end: Function } | { disconnect: Function };

/**
 * Registers an outbound client (ioredis, amqplib, pg, ...).
 * The client must have at least one of: quit, close, end, disconnect.
 */
export function trackClient(client: TrackableClient): void;

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
