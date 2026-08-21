export function isStopped(): boolean;
export function startTask(): number;
export function endTask(): number;

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
