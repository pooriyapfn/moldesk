import type { RuntimeKind } from "@moldesk/registry";

export { MoldeskError } from "@moldesk/registry";
export type { MoldeskErrorData, RuntimeKind } from "@moldesk/registry";

export interface RuntimeCapability {
  kind: RuntimeKind;
  available: boolean;
  version?: string;
  error?: string;
}

export interface PrepareRuntimeRequest {
  modelName: string;
  modelVersion: string;
  runtimeFingerprint: string;
  targetDir: string;
}

export interface PreparedRuntime {
  kind: RuntimeKind;
  executable: string;
  fingerprint: string;
}

export interface ExecuteRequest {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecutionResult {
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
  pid?: number;
  signal?: string;
  cancelled?: boolean;
}

export interface RemoveRuntimeRequest {
  modelName: string;
  runtimeFingerprint: string;
}

export interface RuntimeProvider {
  readonly kind: RuntimeKind;
  inspect(): Promise<RuntimeCapability>;
  prepare(request: PrepareRuntimeRequest): Promise<PreparedRuntime>;
  execute(request: ExecuteRequest): Promise<ExecutionResult>;
  remove(request: RemoveRuntimeRequest): Promise<void>;
}
