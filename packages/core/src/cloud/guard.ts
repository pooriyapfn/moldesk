import { MoldeskError } from "../errors.js";

export interface DeadlineRegistration {
  runId: string;
  provider: string;
  clientId: string;
  /** Every resource of this run must be terminated by this instant, even if the client is offline. */
  deadlineAt: string;
}

/**
 * Independent enforcement of a run's lifetime. A guard must be registered BEFORE any paid compute
 * starts and must keep working if this client crashes or goes offline. A local timer, worker exit
 * or stopped Pod is not a guard: spike evidence shows a Pod whose process exited kept billing.
 */
export interface DeadlineGuard {
  /** Throws when enforcement cannot be guaranteed; the run then never provisions anything. */
  register(registration: DeadlineRegistration): Promise<{ id: string }>;
  /** Called only after the provider confirmed every resource of the run is gone. */
  disarm(id: string): Promise<void>;
}

/**
 * Production guard resolution. Intentionally refuses until a verified independent scheduler is
 * configured: the in-Pod watchdog alone cannot cover failures before the container boots, and no
 * external scheduler has been authorized or tested yet. See docs/runpod-spike-findings.md.
 */
export function resolveDeadlineGuard(): DeadlineGuard {
  return {
    async register(): Promise<{ id: string }> {
      throw new MoldeskError({
        code: "CLOUD_GUARD_UNAVAILABLE",
        message: "No independent lifetime guard is configured, so cloud runs are disabled.",
        remediation:
          "Cloud execution requires a verified deadline guard that terminates Pods even when this client is offline. This is a known release blocker; see docs/runpod-execution-implementation-plan.md section 9.",
      });
    },
    async disarm(): Promise<void> {},
  };
}
