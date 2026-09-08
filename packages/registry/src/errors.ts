export interface MoldeskErrorData {
  code: string;
  message: string;
  remediation?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class MoldeskError extends Error {
  readonly code: string;
  readonly remediation?: string;
  readonly cause?: unknown;
  readonly details?: Record<string, unknown>;

  constructor(data: MoldeskErrorData) {
    super(data.message);
    this.name = "MoldeskError";
    this.code = data.code;
    this.remediation = data.remediation;
    this.cause = data.cause;
    this.details = data.details;
  }
}
