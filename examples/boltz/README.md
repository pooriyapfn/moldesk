# Boltz example

`protein.yaml` is a real, minimal single-chain job fixture, not an invented
one — it is `examples/prot_no_msa.yaml` from the upstream Boltz repository,
copied verbatim.

- Source: https://github.com/jwohlwend/boltz/blob/cb04aeccdd480fd4db707f0bbafde538397fa2ac/examples/prot_no_msa.yaml
- Pinned revision: `cb04aeccdd480fd4db707f0bbafde538397fa2ac` (tag `v2.2.1`
  — the same revision `models/boltz/manifest.yaml` pins for the Linux/CUDA
  runtime entry).
- License: MIT (`https://github.com/jwohlwend/boltz/blob/cb04aeccdd480fd4db707f0bbafde538397fa2ac/LICENSE`,
  Copyright (c) 2024 Jeremy Wohlwend, Gabriele Corso, Saro Passaro).

`msa: empty` is used (rather than the plain `examples/prot.yaml`, which
omits the `msa` key and relies on Boltz generating one from an MSA server at
run time) so this example doesn't require network access to an MSA search
service to run — it's a self-contained smoke-test input.

The job format matches what `packages/adapters/src/boltz/index.ts`'s
`validateInput` expects for a `.yaml` input: a non-empty YAML document with
a top-level `sequences:` key.

```bash
moldesk install boltz
moldesk run boltz examples/boltz/protein.yaml
```
