# Analysis JSON contract

Structure-intelligence commands (`analyze`, `inspect`, `compare`, `fetch`, `describe`) print one shared, versioned envelope with `--json`. Stdout carries exactly one JSON document; logs go to stderr. Failures use the existing error shape `{ "status": "error", "code", "message", "remediation" }` and exit 2 for invalid input.

```jsonc
{
  "schemaVersion": 1,
  "kind": "moldesk.analysis",   // moldesk.inspect | moldesk.compare | moldesk.fetch | moldesk.model
  "status": "ok",
  "input": { "path": "…", "format": "pdb|mmcif", "sha256": "…" },   // absent for fetch / model
  "result": { /* kind-specific */ },
  "warnings": [{ "code": "…", "message": "…" }],
  "provenance": { "moldeskVersion": "…", "tool": { "name": "usalign", "version": "…" } }
}
```

## Discovering schemas

```sh
moldesk schema                    # list the kinds
moldesk schema moldesk.analysis   # JSON Schema (draft 2020-12) for one kind
```

Each schema pins `schemaVersion` and `kind`. `result` is an open object for now; each command tightens its own `result` schema when it lands. In code, `validateEnvelope()` from `@moldesk/core` rejects unknown `kind` or `schemaVersion`, unknown keys and `__proto__`-style keys.

## Selectors

One grammar, parsed once by `parseSelector()` in `@moldesk/core`:

| Selector | Meaning |
| --- | --- |
| `A` | whole chain |
| `A:45` | residue 45 |
| `A:40-60` | residues 40 to 60 |
| `A:52A` | residue 52 with insertion code `A` (uppercase) |

Chain ids are 1–4 letters or digits. The default namespace is `auth`; commands take `--label` to switch to `label` ids. `A:`, `:5`, `A:60-40` and `A:4x` are invalid and exit 2 with `INVALID_SELECTOR`.
