# `moldesk fetch`

Downloads a structure or sequence into a local cache with a provenance record. With `--json` it prints one [`moldesk.fetch` envelope](./analysis-json.md). There is no search: find the id first.

```sh
moldesk fetch pdb:1M17                    # mmCIF from RCSB (EGFR kinase domain)
moldesk fetch pdb:1M17 --format pdb       # PDB format instead
moldesk fetch afdb:P00533                 # AlphaFold DB model (mmCIF; --format pdb also works)
moldesk fetch uniprot:P00533              # FASTA from UniProt
moldesk fetch pdb:1M17 --output ./data    # also copy the file and its provenance there (never overwrites)
moldesk fetch pdb:1M17 --refresh          # download again even though a verified copy is cached
```

The result's `files[].path` is the copy to use (the `--output` copy when given), and every file works with [`analyze`](./analyze.md), [`inspect`](./inspect.md), [`view`](./visualizer.md) and [`compare`](./compare.md); `uniprot:` FASTA works with `analyze --validate-fasta`.

## Sources (verified against the live services)

| Source | Id | What is requested | Version recorded |
| --- | --- | --- | --- |
| `pdb:` | 4 characters: a digit 1-9, then three letters or digits (`1M17`) | `https://files.rcsb.org/download/<ID>.cif` or `.pdb` | The HTTP `Last-Modified` time, as ISO 8601 |
| `afdb:` | UniProt accession in UniProt's own pattern, no isoform suffix (`P00533`) | `https://alphafold.ebi.ac.uk/api/prediction/<ACC>`, then the `cifUrl`/`pdbUrl` it names for entry `AF-<ACC>-F1`; the model version is never hard-coded | The model version from the file name (`v6`), plus `entryId` and `modelCreatedDate` |
| `uniprot:` | The same accession pattern | `https://rest.uniprot.org/uniprotkb/<ACC>.fasta` | The `X-UniProt-Release` header (`2026_03`), plus the release date |

Extended 12-character PDB ids are not accepted yet, since none are in use. Long AlphaFold proteins that the database splits into fragments are fetched as fragment 1 only.

## Cache and provenance

Files live under `~/.moldesk/cache/fetch/<source>/<ID>/`: `1M17.cif` (AlphaFold: `AF-P00533-F1.cif`, UniProt: `P00533.fasta`) and, next to each, `<name>.provenance.json`:

```jsonc
{
  "schemaVersion": 1, "source": "pdb", "id": "1M17", "file": "1M17.cif", "format": "mmcif",
  "url": "https://files.rcsb.org/download/1M17.cif",     // + "apiUrl" for afdb
  "retrievedAt": "…", "sha256": "…", "sizeBytes": 307709,
  "sourceVersion": "2025-09-22T00:17:19.000Z", "sourceVersionKind": "http-last-modified",
  "details": {}, "license": { "name": "CC0 1.0", "url": "…", "notice": "…" }, "moldeskVersion": "…"
}
```

A cached copy counts only if its provenance is complete and the file still has the recorded SHA-256 and size; otherwise it is downloaded again. A cache hit makes no network request, so it works offline. The file is written first and its provenance last, each atomically (temporary file, then rename), so an interrupted fetch is just a cache miss. `--refresh` replaces the copy only after the new download passed every check; a failed refresh keeps the old one.

## Licenses

| Source | License | Basis |
| --- | --- | --- |
| `pdb:` | CC0 1.0 | wwPDB policy on [rcsb.org/pages/policies](https://www.rcsb.org/pages/policies) |
| `afdb:` | CC-BY 4.0, attribution required | The [AlphaFold DB license disclaimer](https://alphafold.ebi.ac.uk/assets/License-Disclaimer.pdf), subject to EMBL-EBI terms. The API itself has no license field. Fetching adds a `PREDICTED_STRUCTURE` warning. |
| `uniprot:` | CC BY 4.0, attribution required | UniProt's [license page](https://www.uniprot.org/help/license). The page needs JavaScript, so this was confirmed from UniProt's quoted statement rather than read from the page itself. |

MoleculeDesk records the license; following its terms (attribution, citation) is up to you.

## Safety rules

- **Ids are validated first**, with a strict pattern per source, before any network call or path join. `../x`, `1M17/..`, URL-encoded forms, whitespace, NUL and trailing newlines are all rejected with `INVALID_FETCH_SPEC`, and nothing is requested or created.
- **HTTPS only, one allowed host per source**, exact match. Redirects are followed only within that host (at most 3); a redirect to another host is refused and that host is never contacted. Requests carry no cookies or credentials.
- **The AlphaFold API is untrusted.** The file URL it names must be `https://alphafold.ebi.ac.uk/files/AF-<ACC>-F1-model_v<N>.cif|pdb` for the requested accession; anything else is refused and never requested.
- **Size caps** apply to the decompressed stream, so a small gzip body that inflates enormously is stopped: 64 MiB for structures, 4 MiB for FASTA, 1 MiB for API answers. A declared oversize length is refused before reading.
- **Content is checked before it is written.** mmCIF must start with `data_<expected id>` and have `_atom_site`; PDB needs `ATOM`/`HETATM` records; FASTA must be exactly one record with a plain sequence. Empty, binary and non-UTF-8 bodies are refused. A refused download writes nothing.
- **`--output` never overwrites.** The file names are fixed by the validated id, so the copy cannot leave the directory you gave.
- A 60 second timeout and Ctrl-C (exit 8) apply.

## Errors

| Code | Exit | When |
| --- | --- | --- |
| `INVALID_FETCH_SPEC`, `INVALID_FETCH_ARGS` | 2 | Bad `<source>:<id>`, an unknown `--format`, or `--format` with `uniprot:` |
| `FETCH_NOT_FOUND` | 2 | The service answered 404 |
| `OUTPUT_EXISTS` | 2 | A file in `--output` already exists |
| `FETCH_CANCELLED` | 8 | Ctrl-C or SIGTERM |
| `FETCH_HTTP_ERROR`, `FETCH_NETWORK_ERROR`, `FETCH_TIMEOUT`, `FETCH_REDIRECT_REFUSED`, `FETCH_HOST_REFUSED`, `FETCH_TOO_LARGE`, `FETCH_BAD_CONTENT` | 10 | The service or network misbehaved; the message says how, and nothing was saved |

## Tests

A local HTTP server covers success, 404, a 5xx, an oversize response (declared, streamed, and gzip-inflated), wrong content, a cross-host redirect, a redirect loop, timeouts, cancellation and hostile AlphaFold answers. Traversal ids are rejected with zero requests. Cache hits make no request, damaged or unverifiable cache entries are not trusted, and refresh and `--output` behave as above. The tests reach the local server through a test-only option that is not exposed to the CLI or the environment. Live tests are opt-in and need network access:

```sh
MOLDESK_LIVE_FETCH=1 pnpm --filter @moldesk/core exec vitest run src/fetch/fetch.live.test.ts
```
