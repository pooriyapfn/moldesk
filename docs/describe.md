# `moldesk describe`

One self-describing document per model, for agents and people who need to know what a model takes, what it costs and whether it will run here before installing or running anything. `moldesk list --json` stays the index of models; `moldesk describe <model> --json` prints a [`moldesk.model` envelope](./analysis-json.md) (its schema: `moldesk schema moldesk.model`).

```sh
moldesk describe boltz
moldesk describe boltz --json
moldesk describe boltz --runtime docker     # judge compatibility for one runtime only
```

It never installs, downloads or runs a model. It probes this machine the same way `doctor`, `list` and `install` do.

## Result

| Field | Meaning |
| --- | --- |
| `name`, `displayName`, `modelVersion`, `adapterVersion`, `description`, `category`, `status`, `license`, `homepage`, `source` | From the registry manifest. `source` is the pinned repository and revision. |
| `capabilities` | `category`, whether the model is `installable` (not `planned`, and it has an adapter), whether it is `installed` here, and whether it can run in the `cloud`. |
| `input` | The accepted file `formats` and whether an input is `required`. |
| `outputs` | What a successful run produces (`id`, `glob`, `required`). |
| `parameters` | Every `--param` name `moldesk run` accepts, with `type`, `required`, `default`, `min`, `max`, `enum` and a description. |
| `runtimes`, `hardware` | The runtimes (python with platforms and Python version, or docker) and the manifest's hardware requirements (platforms, memory, disk, NVIDIA GPU, VRAM, CUDA). |
| `assets` | Downloads the install needs (`id`, `url`, size, license, source), for example checkpoints. |
| `compatibility`, `verdict` | The verdict for **this machine**: the full result of the compatibility check (per-runtime reasons with remediation) and a one-line summary. |
| `cloud` | `{ "available": false }`, or Runpod with the platform, minimum VRAM and RAM, an optional GPU allow list, disk sizes and whether assets can be prepared on a CPU Pod. |
| `adapterVerification` | When and where the adapter was last verified live, if recorded. |

### Parameters and defaults

`parameters` is built from the adapter's own declarations, the same list `moldesk run` validates `--param` against, so the two cannot drift: a test checks, for every catalog model, that each listed parameter is accepted (and its range, enum and required-ness enforced) and that any other name is refused.

Some defaults depend on which platform's runtime was installed. Those have no static `default`; `defaultsByPlatform` shows what the adapter picks for each platform the manifest supports. For Boltz, `accelerator` defaults to `gpu` on `linux-x64` and `mps` on `darwin-arm64`. A supplied value is still checked at run time against the installed platform (for example `mps` is refused off Apple Silicon), which a static description cannot cover.

### Compatibility

`compatibility` is computed by the same function as `moldesk list` and `moldesk install`, from the same system report that `moldesk doctor --json` prints. Tests run `doctor` and `describe` under the same faked hardware (no GPU, an A100 with CUDA 12.4, a small GPU with old CUDA) and require every model's `compatibility` to equal the check applied to doctor's report. Nothing is guessed: hardware that cannot be detected is reported as such by the reasons.

## Errors

| Code | Exit | When |
| --- | --- | --- |
| `UNKNOWN_MODEL` | 3 | No such model (same code as `run`). `moldesk list` shows the names. |
| `INVALID_DESCRIBE_ARGS` | 2 | `--runtime` is not `python` or `docker`. |
