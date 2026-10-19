# Cloud GPU runs on Runpod

## Current status

Runpod execution is available for four models, with `--cache-policy ephemeral` (nothing is kept after the run):

| Model | Notes |
| --- | --- |
| `boltz` | `persistent` caching is experimental: it was slower than `ephemeral` for a single run |
| `proteinmpnn` | Runs on the Ampere, Ada and Hopper NVIDIA GPUs in its allow-list |
| `diffdock` | Uploads the protein file named in the job file, so the run also needs `--accept-file-upload` |
| `opendde` | Needs a GPU with at least 24 GB. No `.pdb` copy of the structure is made in cloud runs; the mmCIF is returned |

`ligandmpnn` and `bindcraft2` are not enabled: `moldesk run <model> <input> --compute runpod` refuses them. A CLI version that ships without a worker bundle also refuses every model. Do not try to work around a refusal (for example with `MOLDESK_WORKER_BUNDLE_URL` or edited manifests); those are developer settings.

If cloud is refused, or the user prefers not to use it, suggest:

- a Linux + NVIDIA machine they already manage, using "Remote GPU servers" in [install.md](install.md), or
- a model that runs locally (see [compatibility.md](compatibility.md)).

Check whether a model is enabled with `moldesk run <model> <input> --compute runpod --dry-run`. Follow the rest of this file only when a dry run returns a quote.

## Costs and risks the user must understand

- Runs use the **user's own Runpod account** and bill it directly.
- `--max-budget` is a guard on MoleculeDesk's estimate, **not** a spending cap enforced by Runpod.
- If MoleculeDesk closes or loses connection, the Pod **may keep running and charging**. Automatic shutdown is not guaranteed.
- `--cache-policy persistent` keeps a network volume that **bills until deleted**. It is not counted in the one-run budget.
- Inputs are uploaded to the chosen datacenter. When the job file references other files (DiffDock-L's protein structure), the quote lists each one by role, local path, size and a short checksum. Show that list to the user: the files are copied to a machine whose disk is erased on termination, and the run needs a separate acknowledgment for it.
- Runpod's proxy sometimes returns a transient `Worker error 404` right after a Pod starts. The run fails and cleanup is confirmed; running the same command again usually works. Check `moldesk cloud resources --json` first.

## Procedure

1. **Connect the account (the user does this).** Ask the user to run, in their own terminal:

   ```bash
   moldesk cloud connect runpod
   ```

   It prompts for the API key and stores it in the OS keychain. Never ask for the key in chat, never put it in a command line or file, never set `RUNPOD_API_KEY` yourself. Check with `moldesk cloud status --json`.

2. **Quote only (no spend):**

   ```bash
   moldesk run boltz complex.yaml --compute runpod --cache-policy ephemeral \
     --max-budget 2 --max-lifetime 3600 --dry-run --json
   ```

   Use `ephemeral` unless the user asks to keep a cache. Pick `--max-budget` and `--max-lifetime` with the user; do not invent generous limits.

3. **Show the user the quote** before anything else: GPU type, datacenter, hourly rate, lifetime limit, estimated compute cost, what the budget does and does not cover (storage and transfer can be "unknown"), and the warning:

   > If MoleculeDesk closes or loses connection, your Runpod Pod may keep running and charging. Automatic shutdown is not guaranteed. Check your Runpod dashboard and terminate any remaining Pod.

4. **Ask for an explicit yes** to that cost and that risk. Silence, "ok go ahead with the analysis", or an earlier general approval is not consent to this quote. For `persistent`, also ask about ongoing storage charges.

5. **Run only after the yes**, with the same options as the quote:

   ```bash
   moldesk run boltz complex.yaml --compute runpod --cache-policy ephemeral \
     --max-budget 2 --max-lifetime 3600 --yes --accept-lifetime-risk --json
   ```

   Add `--accept-storage-charges` only for `persistent`, and only if the user agreed to it. Add `--accept-file-upload` only when the quote lists files to upload and the user agreed to copy those exact files. `--yes` does not cover either. Approval expires after 15 minutes; a changed price or location needs a new quote and a new yes.

6. **Clean up and check.** After the run, or if anything fails or disconnects:

   ```bash
   moldesk cloud resources --json    # anything still running or owed cleanup?
   moldesk cloud recover <run-id>    # finish transfer and cleanup; never restarts inference
   ```

   Tell the user to confirm in the Runpod dashboard that no Pod is still running. `moldesk cloud recover <run-id> --terminate` stops a machine whose job is still running and loses unfinished results; ask first.

7. **Retained caches** (persistent only): `moldesk cloud cache list`. Deleting one (`moldesk cloud cache delete <model>`) stops storage billing; ask first.

## Exit codes

`11` credential, `12` provider (payment, capacity, rate limit), `13` cleanup pending or orphaned resources (new paid work is refused until resolved), `14` consent or safety refusal (missing acknowledgment such as `--accept-file-upload`, expired approval, re-quote required).
