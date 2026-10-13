# Independent lifetime guard (scheduler): design

**Status: design only.** Nothing described here is implemented, deployed, authorized or tested. Cloud
execution stays disabled (`resolveDeadlineGuard()` refuses) until this guard exists, has been validated, and the
live-validation blockers in [runpod-execution-implementation-plan.md](./runpod-execution-implementation-plan.md)
section 13 are cleared. Every platform behavior marked **(verify)** is an assumption to check, not a fact.

## 1. Why a second mechanism is required

Evidence from [runpod-spike-findings.md](./runpod-spike-findings.md):

- Pod creation has no lifetime/deadline field.
- A Pod whose container process exited stayed `RUNNING` at the full hourly rate for 5+ minutes.
- The Pod-scoped `RUNPOD_API_KEY` can terminate only its own Pod, but only a *running container* can use it.
  A Pod that never boots (image pull failure, crash loop, bootstrap failure) has no watchdog, yet still bills.
- Account API keys cannot be scoped to a single Pod (per-resource scoping exists for Serverless only), and no key
  expiry is documented.

So the in-Pod watchdog is **layer 1** (cheap, covers a healthy container when the client is offline). The guard
below is **layer 2**: an independent service that outlives the client and does not depend on any container.

## 2. Requirements

| # | Requirement |
|---|---|
| R1 | Armed **before** any paid resource is requested; if it cannot be armed, nothing is provisioned. |
| R2 | Terminates every Pod of a run by the approved deadline with the client offline, the container never booting, or the worker hung. |
| R3 | Finds Pods it was never told the ID of (client crashed between create and attach). |
| R4 | Retries termination until the provider confirms the Pod is gone; never gives up silently. |
| R5 | Verifies deletion independently of the terminate call's response. |
| R6 | Cannot delete volumes, read results/inputs/tokens, create resources, or reach other Pods outside the registered run. |
| R7 | Holds the narrowest provider credential the provider allows, and the user can revoke it instantly. |
| R8 | Cannot be used by a third party to terminate the user's Pods or to extend a deadline. |
| R9 | Tells the user when it fired, when it is failing, and when it is itself unhealthy. |
| R10 | Testable without paid compute using a fake provider and a fake clock. |

## 3. Architecture

```text
  moldesk client                      guard service (user-owned host)             Runpod
  ──────────────                      ───────────────────────────────             ──────
  1. GET  /health  ───────────────►   fresh heartbeat? provider key ok?
  2. POST /registrations ─────────►   store {run, deadline, names}; arm timer
  3. GET  /registrations/{id} ────►   confirm state=armed, deadline matches
  4. create Pod(s)  (names precomputed) ─────────────────────────────────────►  Pod exists
  5. PUT  /registrations/{id}/resources  (podId, name)  [best effort]
  ...
  6a. normal end: POST /disarm ───►   sweep → terminate leftovers → verify ──►  list / GET / terminate
  6b. client gone: ──── deadline ──►  sweep → terminate → retry → verify ───►  list / GET / terminate
                                      alert user on failure / fire

  in the Pod (layer 1): watchdog with the Pod-scoped key terminates its own Pod at the same deadline.
```

The guard never receives the Runpod account key from the client and the Pod never receives the guard's key.

## 4. Hosting

| Option | Verdict |
|---|---|
| Client-side timer / `cloud recover` | **Rejected for release**: dies with the client. Kept only as the *third* line (preflight reconciliation at next start). |
| In-Pod watchdog only | **Rejected as sufficient**: cannot cover a Pod that never boots. Kept as layer 1. |
| MoleculeDesk-hosted multi-tenant service | **Rejected for v0.1**: it would hold many users' provider credentials, making MoleculeDesk a high-value target and a custodian. Could be revisited only with explicit per-user consent, a separate security review and per-user restricted keys. |
| **User-owned Cloudflare Worker + Durable Object (alarms)** | **Primary reference host.** No server to run; durable per-run alarm; secrets in the Worker's secret store; deployed into the user's own account. **(verify)** alarm durability across deploys/restarts, retry behavior on failures, and the exact free-tier limits. |
| Self-hosted Node service (Docker/systemd) on an always-on machine | **Supported alternative.** Same protocol and code with a SQLite store and an in-process scheduler that reloads armed registrations on start. Protection is only as available as that machine; the docs must say so. |
| User-owned AWS EventBridge Scheduler + Lambda, GCP Cloud Scheduler | Possible later host adapters; not planned for the first implementation. |

Host contract (any host must provide): durable storage of registrations, timers that survive process/host
restarts and fire at-least-once, a secret store, outbound HTTPS to the provider, and an inbound HTTPS endpoint.
A host that cannot show a durable timer in the conformance run (section 13) is not accepted.

Decision needed from the owner: confirm Cloudflare as the first host and who deploys it (see section 15).

## 5. Credentials

| Credential | Held by | Scope and handling |
|---|---|---|
| **Guard → Runpod key** (dedicated, user-created) | Guard host secret store only | A *Restricted* key: **Pods read/write; everything else None** (no network volumes, billing, serverless, secrets). Never sent to the client, Pods, logs, the journal or `run.json`. Revoked in the Runpod console by the user at any time. **(verify)** that "Pods write" permits terminate and that volume delete is denied; that a restricted key can list Pods. Residual power: it can terminate *any* Pod in the account, which is why the guard enforces its own allow-list (section 8). |
| **Client ↔ guard secret** | Client OS keyring + guard secret store | 32 random bytes generated by `moldesk cloud scheduler setup`. Every request is signed: `HMAC-SHA256(secret, method \n path \n sha256(body) \n timestamp \n nonce)`; the guard rejects skew over 60 s and replayed nonces (kept for 5 min). Rotation: `moldesk cloud scheduler rotate` writes a new secret to both sides with a short overlap. Compromise of this secret lets an attacker register/disarm runs, **not** reach the provider key. |
| **Pod-scoped key** (layer 1) | Injected into each Pod by Runpod | Unchanged from the spike. Expiry unverified. |
| What the guard never holds | | Job inputs/outputs, worker tokens, model assets, volume-delete rights, the client's account key. |

Non-secret configuration (guard URL, account label, alert target) lives in a client config file; the HMAC secret
never does.

## 6. Protocol

All requests are signed (section 5). All state-changing calls are idempotent by `registrationId` (the run id).

| Call | Purpose |
|---|---|
| `GET /v1/health` | `{version, tickAt, armed, providerKey: {ok, checkedAt, scope}, clock}`. Client requires `tickAt` fresher than 2 minutes and `providerKey.ok`. |
| `POST /v1/registrations` | `{registrationId, clientId, accountLabel, provider, deadlineAt, expectedNames[]}` → `{state: "armed", armedAt, deadlineAt}`. |
| `GET /v1/registrations/{id}` | Full status and evidence (below). |
| `PUT /v1/registrations/{id}/resources` | `{podId, name}`; accepted only if `name ∈ expectedNames`. Best effort; discovery does not depend on it. |
| `PATCH /v1/registrations/{id}` | May only **shorten** `deadlineAt`. There is no way to extend a deadline. |
| `POST /v1/registrations/{id}/disarm` | Guard sweeps, terminates anything left, verifies, then closes. Returns `{verified}`; the client trusts `verified: true` only. |

Registration validation (rejects otherwise): `deadlineAt` between now+60 s and now+24 h; `expectedNames` match
`^moldesk-[0-9a-f]{8}-[0-9a-f]{8}-(cpu|gpu)$` with the client's own 8-hex prefix, at most 4 names, at most 8 open
registrations; `accountLabel` equals the label the guard was set up for; volumes are not representable.

State machine:

```text
armed ──deadline──► sweeping ─► terminating ─► verifying ─► verified ─► closed (tombstone kept 7 days)
  │                      ▲            │ retry (backoff)        │ pods reappear
  └──disarm─────────────┘            └──────── stuck (alerted, keeps retrying)
```

## 7. Registration before provisioning

1. Client computes `deadlineAt = now + approved lifetime` (this includes boot, install and transfer) and the
   deterministic names `moldesk-<client8>-<run8>-gpu` (and `-cpu` for persistent). These names already exist in
   the journal logic (`cloudResourceName`) before any create.
2. `GET /health` must be fresh and healthy, else **fail closed** (`CLOUD_GUARD_UNAVAILABLE`), nothing provisioned.
3. `POST /registrations`, then `GET /registrations/{id}` must show `state: armed` and an identical `deadlineAt`.
   A network failure or mismatch fails closed.
4. Only then does the client write the job to the journal with the guard id and call `backend.start`.
5. After each create the client `PUT`s the resource (best effort). Failure to attach is logged, never fatal.
6. On normal completion the client terminates and verifies by itself (existing behavior), then calls `disarm`
   and requires `verified: true`; otherwise the run reports `CLOUD_CLEANUP_PENDING`.

## 8. Resource discovery (what the guard may touch)

At the deadline or on disarm the guard computes the **allow-list**: `attachedPodIds ∪ {pods whose name is in
expectedNames}`. It lists all Pods (following pagination) and acts only on that intersection. Consequences:

- A client crash between create and attach is still covered (name match, R3).
- A container that never boots is covered (matching is by name, not by worker health).
- Two Pods with the same registered name are both terminated; both are inside this run's namespace.
- Pods outside the allow-list are never touched, even though the key could terminate them.
- Names are discovery hints, not authorization by themselves: the guard additionally requires the registration
  to have been signed by the client secret, and the prefix to equal the registering client's id.
- After the first verified sweep the guard keeps sweeping every 30 s for 15 minutes (late-arriving creates from a
  request that completed after the deadline) and closes after two consecutive empty sweeps at least 60 s apart.

## 9. Termination retries

Per Pod, independent of others:

- `POST /v2/pods/{id}/action {"action":"terminate"}`; `204` and `404` count as "requested".
- Backoff 5 s, 10 s, 20 s, … capped at 5 min with ±20% jitter; `Retry-After` honored on 429.
- Network errors and 5xx retry forever; the registration moves to `stuck` and an alert is sent after 3 failed
  attempts or 15 minutes, whichever is first.
- `401/403` (key revoked, expired or lacking permission): alert immediately as a credential failure, keep
  retrying hourly so a restored key still works.
- Terminate is idempotent; the guard never creates, stops-and-restarts or modifies Pods.

## 10. Deletion verification

A terminate response is never proof. For each Pod the guard requires `GET /v2/pods/{id}` to return `404` or
status `TERMINATED` (polling up to 60 s, then back to the retry loop), then re-lists Pods and requires the
allow-list intersection to be empty. It records evidence: pod ids, names, first/last attempt times, final
observed status and `verifiedAt`. Only then does the state become `verified`. The client independently
reconciles on its next start (`reconcile` against a fresh listing) as a third check, and `cloud status` surfaces
guard evidence for open runs.

## 11. Failure analysis

| Scenario | Outcome |
|---|---|
| Client crashes before provisioning | Guard armed with no Pods; deadline sweep finds nothing; closes. No harm. |
| Client crashes after create, before attach | Name match finds the Pod; terminated at the deadline. |
| Container never boots / bootstrap fails | Name match terminates it (layer 1 could not). |
| Client offline for the whole run | Guard terminates at the deadline; results on the Pod are lost (disclosed in the quote). |
| Runpod API down at the deadline | Retry loop with backoff and alert; keeps trying until verified. |
| **Guard host down at the deadline** | **Residual risk.** Layer 1 still terminates a healthy container; otherwise cost continues until the host returns, the user is alerted by the host's own monitoring, or the client's next start reconciles. Must be disclosed and bounded by the host's availability; this is why `health()` freshness is required *before* provisioning. |
| Guard credentials compromised | Attacker can terminate any Pod in the account (cannot create, delete volumes or read data). Revoke the key; rotate the HMAC secret. |
| Client secret compromised | Attacker can register/disarm; cannot extend deadlines, cannot reach the provider key. |
| Provider key revoked mid-run | Alert, hourly retries, layer 1 and next-start reconciliation remain. |
| Clock skew | Guard uses its own clock; client registers an absolute time and rejects health with skew > 60 s. |
| Duplicate registration | Idempotent by `registrationId`; a different deadline for an existing id is rejected. |
| User deletes the Pod manually | Sweep sees nothing; verifies; closes. |
| Disarm race with a running job | Disarm terminates anything left; the client only disarms after its own cleanup. |

## 12. Client integration (planned interface, not implemented)

```ts
interface DeadlineGuard {
  health(): Promise<{ ok: boolean; reason?: string }>;
  register(r: DeadlineRegistration & { expectedNames: string[] }): Promise<{ id: string; deadlineAt: string }>; // verifies armed
  attach(id: string, resource: { podId: string; name: string }): Promise<void>;                              // best effort
  status(id: string): Promise<GuardStatus>;
  disarm(id: string): Promise<{ verified: boolean }>;                                                         // guard-verified
}
```

- `HttpDeadlineGuard` implements it; `resolveDeadlineGuard()` returns it only when `moldesk cloud scheduler setup`
  has configured a guard whose `health()` and conformance canary passed; otherwise it keeps refusing.
- `runCloudModel` registers before `backend.start` (already true), also attaches resources through the ledger,
  and replaces its own `disarm` call with the guard-verified one. `recover` consults `status`.
- New commands: `cloud scheduler setup | status | verify | rotate | remove`.
- `run.json` gets a non-secret `compute.guard` summary (host, registration id, verified time).

## 13. Reference implementation and tests

- A protocol core with injected storage, clock and alarm scheduling, plus host adapters for Cloudflare and Node.
  It reuses the existing provider client, name rules and journal-free reconciliation logic from
  `@moldesk/runtime`. Packaging (a workspace app rather than a published library) is a decision for the owner.
- **Conformance suite** (fake provider + fake clock, no paid compute), run against every host adapter:
  registration validation; HMAC and replay rejection; deadline fire; disarm early; allow-list discovery by name
  and by id; never touching an unrelated Pod; same-name duplicates; late-created Pod caught by the post-deadline
  sweep; 5xx/429/network retries; terminate success but Pod still listed; credential failure alerting; restart
  between registration and deadline (durable timer); clock skew; idempotent re-registration; shorten-only PATCH.
- Chaos cases: kill the host process mid-sweep; provider returns stale listings.

## 14. Validation plan (each step needs explicit approval; none has been run)

| Step | What it proves | Cost |
|---|---|---|
| V1 restricted-key permissions | A key with Pods read/write only can list and terminate a Pod, and cannot delete a volume or read billing | Reads free; one CPU Pod ≈ well under $0.01 |
| V2 host timer durability | Alarm survives restart/redeploy and fires on time | Free |
| V3 offline-client end to end | Register, create a CPU Pod from a deliberately broken image (never boots), kill the client, observe termination at the deadline with evidence | A few cents |
| V4 retry and verification under injected faults | Fake-provider conformance run | Free |
| V5 guard outage behavior | Layer 1 + reconciliation + alert path with the guard stopped | A few cents |
| V6 GPU Pod key injection and Pod-key expiry | Layer 1 behaves on a GPU Pod; whether the Pod key stops working after termination | A few cents |

Acceptance: V1–V6 pass and are recorded in `docs/runpod-spike-findings.md`; the conformance suite is green on
each supported host; `resolveDeadlineGuard()` returns a verified guard; only then may a live Boltz run be
considered (a separate approval).

## 15. Decisions needed

1. Confirm the first host (Cloudflare Workers + Durable Objects) and who deploys it (each user, in their own account).
2. Alert channel: webhook URL, email via the host, or both.
3. Maximum lifetime the guard accepts (proposed 24 h) and open-registration cap (proposed 8).
4. Whether to ship the Node self-hosted adapter in the first release or only the Cloudflare one.
5. Whether a MoleculeDesk-hosted option is ever offered (default: no).

## 16. Non-goals

Automatic spend caps beyond the deadline; deleting volumes; managing non-MoleculeDesk Pods; guaranteeing the
guard host's own uptime; replacing the client's own cleanup and verification, which remain primary.
