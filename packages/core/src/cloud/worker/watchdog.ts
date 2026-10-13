/**
 * In-Pod deadline watchdog (layer 1 of the lifetime guard). It terminates the Pod it runs in at the
 * approved deadline using the Pod-scoped key Runpod injects (RUNPOD_API_KEY / RUNPOD_POD_ID). That
 * key was observed to terminate only its own Pod. It cannot help when the container never boots, so
 * an independent external scheduler remains required; see docs/runpod-spike-findings.md.
 */
export interface WatchdogOptions {
  deadlineAt: string;
  podId: string;
  /** Pod-scoped key; never the account key and never logged. */
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { unref?: () => void } | unknown;
  retryMs?: number;
  log?: (message: string) => void;
}

export interface Watchdog {
  /** Resolves after a termination request was accepted (2xx or 404). */
  done: Promise<void>;
  stop(): void;
}

export function startDeadlineWatchdog(options: WatchdogOptions): Watchdog {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.baseUrl ?? "https://api.runpod.io/v2";
  const retryMs = options.retryMs ?? 30_000;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const log = options.log ?? (() => undefined);
  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    try {
      const response = await fetchFn(`${base}/pods/${encodeURIComponent(options.podId)}/action`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", "User-Agent": "moldesk-watchdog/1" },
        body: JSON.stringify({ action: "terminate" }),
      });
      if (response.ok || response.status === 404) {
        log(`deadline reached; termination requested (status ${response.status})`);
        return resolveDone();
      }
      log(`termination attempt failed with status ${response.status}`);
    } catch {
      log("termination attempt failed (network)");
    }
    schedule(retryMs);
  };
  function schedule(ms: number): void {
    const timer = setTimer(() => void attempt(), ms) as { unref?: () => void } | undefined;
    // Must keep the process alive until it fires; never unref.
    void timer;
  }
  const remaining = Date.parse(options.deadlineAt) - now();
  schedule(Math.max(0, remaining));
  return {
    done,
    stop: () => {
      stopped = true;
    },
  };
}
