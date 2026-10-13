#!/usr/bin/env node
import { createManifestPipeline } from "./pipeline.js";
import { createWorkerServer } from "./server.js";
import { startDeadlineWatchdog } from "./watchdog.js";

/**
 * Worker entry point, run inside the Pod. Configuration comes from the environment the client set
 * at Pod creation; the token is never printed.
 */
async function main(): Promise<void> {
  const token = process.env.MOLDESK_WORKER_TOKEN;
  if (!token || token.length < 24) {
    console.error("MOLDESK_WORKER_TOKEN is missing or too short.");
    process.exit(2);
  }
  const rootDir = process.env.MOLDESK_WORKER_ROOT ?? "/job";
  const port = Number(process.env.MOLDESK_WORKER_PORT ?? "8000");
  const secrets = [process.env.RUNPOD_API_KEY].filter((value): value is string => Boolean(value));
  const worker = createWorkerServer({ token, rootDir, pipeline: createManifestPipeline(), secrets });
  await worker.listen(port);
  console.error(`moldesk worker listening on ${port}`);

  const deadlineAt = process.env.MOLDESK_WORKER_DEADLINE_AT;
  const podId = process.env.RUNPOD_POD_ID;
  const podKey = process.env.RUNPOD_API_KEY;
  if (deadlineAt && podId && podKey) {
    startDeadlineWatchdog({ deadlineAt, podId, apiKey: podKey, log: (message) => console.error(`watchdog: ${message}`) });
  } else {
    console.error("watchdog: not armed (missing deadline, pod id or pod-scoped key)");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
