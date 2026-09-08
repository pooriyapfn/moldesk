import { EventEmitter } from "node:events";

export interface FakeSpawnResult {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Simulate `spawn` itself failing (command not on PATH) instead of the process exiting non-zero. */
  spawnError?: boolean;
}

export type FakeSpawnHandler = (command: string, args: string[]) => FakeSpawnResult;

/**
 * Minimal fake `child_process.ChildProcess` good enough for
 * `packages/runtime/src/process/index.ts`'s `runCommand` — stdout/stderr
 * event emitters plus `error`/`close`. Used to fake the process boundary
 * (docker/nvidia-smi/nvcc/python3/which) in CLI-level tests without mocking
 * `@moldesk/core` itself.
 */
export function createFakeSpawn(handler: FakeSpawnHandler) {
  return (command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    const result = handler(command, args);
    queueMicrotask(() => {
      if (result.spawnError) {
        child.emit("error", new Error("spawn ENOENT"));
        return;
      }
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
      child.emit("close", result.code ?? 0);
    });
    return child;
  };
}
