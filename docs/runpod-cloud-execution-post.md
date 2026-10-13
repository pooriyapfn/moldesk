<!-- Editorial metadata; omit this block when publishing.
Format: public-facing development update, not a release announcement.
GEO: generative engine optimization. Uses explicit product names, a direct summary,
comparison table, question-led sections and source links. No ranking guarantees.
Suggested slug: moleculedesk-runpod-cloud-gpu-execution
Meta description: MoleculeDesk is developing optional Runpod cloud GPU execution for molecular AI, with local results and temporary or reusable model assets. Boltz is the first target.
Last reviewed: 2026-10-13
-->

# MoleculeDesk + Runpod: cloud GPU execution with local molecular results

**MoleculeDesk is developing optional Runpod cloud execution for molecular AI models.** The planned workflow uses your own Runpod account, prepares the model, runs prediction on a cloud GPU, and downloads verified results to your computer. Boltz-2 is the first target model. Cloud execution is currently disabled and is not ready for production use.

The goal is to make a cloud run feel like a familiar MoleculeDesk run: choose an input, review the cost and location, approve execution, then open the structures and report locally.

## Why model preparation matters for cloud GPU costs

Running a molecular AI model can involve more than inference. Checkpoint downloads, reference-data extraction and dependency installation also take time. If all preparation happens on a rented GPU, you pay for that GPU while those tasks finish.

MoleculeDesk's Runpod integration introduces two cache policies. They let you choose whether model assets disappear after a run or remain available for future runs.

| Cache policy | Where preparation happens | What remains afterward | Tradeoff |
|---|---|---|---|
| `ephemeral` — temporary model assets | GPU Pod prepares assets and runtime | Downloaded local results; no persistent model volume | Simple cleanup, but model assets must be prepared again next time |
| `persistent` — reusable model assets | CPU Pod prepares missing assets; GPU Pod installs its runtime and predicts | Local results plus model assets on a retained network volume | Reuses prepared assets, but storage continues to incur charges |

Both policies are designed to terminate GPU Pods after each run. Persistent caching retains model data, not a running GPU or a portable Python environment. GPU runtime setup is still required.

Persistent caching may reduce repeated preparation work. It does not guarantee a lower bill for every workload, especially for a single run. Actual costs depend on preparation time, hardware, transfer time and storage retention.

## What will the first Runpod run look like?

The planned onboarding starts with connecting your Runpod account. MoleculeDesk saves the API key in the operating system's credential store. Runpod bills your account directly.

Next, you choose temporary or reusable model assets. Before execution, MoleculeDesk presents the uploaded input, selected datacenter and GPU, lifetime limit, estimated compute cost and budget exclusions. Retained storage charges are disclosed separately; unavailable rates are shown as unknown.

After approval, the run progresses through provisioning, asset preparation, runtime installation, prediction, result verification and Pod cleanup. Returned structures can be opened through MoleculeDesk's existing local visualization workflow.

The CLI interface is implemented behind release gates. These examples describe the intended workflow once enabled; they cannot currently start a shipped model in the cloud:

```bash
moldesk cloud connect runpod

moldesk run boltz complex.yaml --compute runpod \
  --cache-policy ephemeral --max-budget 2 --max-lifetime 3600

moldesk run boltz complex.yaml --compute runpod \
  --cache-policy persistent --max-budget 2 --max-lifetime 3600
```

The example budget is a user-selected limit for covered cost estimates, not a quoted Runpod price or a guaranteed spending cap. Desktop onboarding is a future integration; MoleculeDesk's desktop application is still planned.

## What stays on your computer?

The cloud workflow is designed to preserve input snapshots, parameters, model provenance, verified outputs and received logs in the local run directory. Scientific outputs are checked by file size and SHA-256 before acceptance. Local reports use the existing MoleculeDesk adapters and visualizer.

Cloud execution still uploads approved inputs to the selected datacenter. Local result storage does not mean inference happens locally. Worker logs currently use a bounded remote tail, so complete log retention is not guaranteed for very chatty jobs.

## What happens if MoleculeDesk disconnects?

Stopping a worker process is insufficient. Provider spikes found that a Runpod Pod could remain running and billable after its container command exited.

MoleculeDesk uses a client-side deadline while running and connected, automatic cleanup, an in-Pod watchdog where supported, and restart recovery. These are best-effort protections; automatic shutdown is not guaranteed. Before approving each run, you must acknowledge this warning:

> If MoleculeDesk closes or loses connection, your Runpod Pod may keep running and charging. Automatic shutdown is not guaranteed. Check your Runpod dashboard and terminate any remaining Pod.

Ordinary cleanup terminates ephemeral Pods. Deleting a retained model cache is a separate action requiring confirmation. A one-run compute budget does not cover indefinite storage retention or every provider fee.

## Is MoleculeDesk Runpod execution available now?

**No. It is a work in progress.** Core orchestration, CLI controls, authenticated worker transport, cache handling and local result collection exist, with automated tests using local fixtures and fake providers.

Release still requires a live GPU watchdog test, validated worker images and release bundle, and a real Boltz Linux/CUDA cloud run. CPU-prepared storage must also be tested through GPU remount in the same datacenter, alongside large proxy transfers and billing behavior after termination.

Provider capability spikes are useful evidence, but they are not validation of the complete scientific execution workflow.

## Common questions

### Do I need my own Runpod account?

Yes. The integration is designed around your own Runpod account and API key. MoleculeDesk does not act as a billing intermediary.

### Does persistent caching keep the GPU running?

No. It retains prepared model assets on a network volume. GPU Pods are intended to be terminated after each run; the retained volume remains billable until deleted.

### Can I run Boltz from a computer without a local NVIDIA GPU?

That is the intended cloud workflow. Prediction would use the remote Linux/CUDA environment, while verified results return to your computer. The complete Boltz cloud workflow has not yet passed live validation.

### Will every MoleculeDesk model support Runpod immediately?

No. Cloud support requires a validated model profile. Boltz-2 is the first target; no shipped model is currently enabled for cloud execution.

### Where can I follow implementation details?

See the [cloud execution documentation](./cloud-execution.md), [implementation plan](./runpod-execution-implementation-plan.md) and [provider spike findings](./runpod-spike-findings.md). These describe the current implementation, remaining gates and evidence behind the design.
