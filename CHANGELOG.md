# Changelog — operator distribution

This repository is generated from Ditto's canonical repository; every entry names the canonical source
commit and the export digest (`python3 ops/build/export-operator-repo.py <dir>` upstream reproduces it).
**"Deployed" means running on a live host. Historical entries retain their status at the stated date.**

## Deployment status (2026-09-28)

| What | Where it runs |
|---|---|
| The live mainnet pilot (deployed 2026-08-11 from canonical `0cffc1002567…`, record `mainnet-2026-08-11`) | its own host tree from the pre-rc1 lineage — **not** this distribution's `main`, **not** `v2.0.0-rc1` |
| `v2.0.0-rc1` (tag, 2026-09-05) | historical candidate, not the source of either live deployment |
| September 23 mainnet stack | reviewed code `93d6a6b`; seats run runtime files from canonical `5cd9d0c` (operator export `f90a575`); HMAC v2, new contracts, five Ditto seats / quorum four; record `ops/deployments/mainnet-2026-09-23.addresses.json` |
| Later documentation exports | updated instructions, not an automatic operator runtime rollout; agree an exact commit and manifest before onboarding |

Joining the older pilot is not supported by this distribution. External seats need the agreed
deployment record, commit and manifest. No rc2 tag has been issued.

## 2026-09-28 — host sizing and RPC requirements

- Documentation only. README and `docs/ONBOARD.md` now state measured requirements on the current
  code: 1–2 vCPU, 2 GB RAM and about 20 GB of disk; the reconciler's first run peaked at 33 MB.
  The earlier 4 GB advice came from an August release that walked the whole Ethereum history at once.
- RPC requirements are spelled out: recent state for signing, archive state on Ethereum for the first
  sync, `eth_getLogs` range sizes, request rate and methods.

## 2026-09-28 — repository publication preparation

- Documentation and packaging only; no runtime file changes. Seats keep running canonical `5cd9d0c`.
- Ships the September 23 stack's deployment record, `ops/deployments/mainnet-2026-09-23.addresses.json`.
- Adds `SECURITY.md`. README and `docs/ONBOARD.md` no longer assume the repository is private, and
  the guardian section describes the September 23 stack rather than the pilot's invited-depositor phase.

## 2026-09-24 — 500 MUSD placement minimum

- Owner-approved shared placement minimum: 100 → 500 MUSD. Applied to the actual Mezo →
  Ethereum placement after withdrawal reservations and the 15% buffer floor, not per depositor.
- Below the threshold, funds remain on Mezo without Spark yield. Existing Spark positions,
  ALLOCATE of already-delivered USDC, and withdrawal close rules (100 MUSD / 24 h) are unchanged.
- Aggregator and all seats must run the same policy. Coordinate the update with Ditto:
  quiesce the aggregator, preserve WAL/signature journals, update seats and aggregator, verify
  readiness and authenticated historical signature reads, then resume. No contract upgrade.
- This is a code-policy release, unlike the documentation-only export below. Exact canonical
  source and export digest are recorded in the release PR; publication alone is not host rollout.

## 2026-09-24 — deployment documentation

- README and ONBOARD now distinguish the deployed September 23 stack from the older pilot
  and historical rc1 candidate. No signing, accounting, configuration or contract code changes.
- The deployed code export is `5b29503f3801626e80d1b4fdb5683c1546857cad`, 44 manifest entries,
  digest `2a634a9d3869a08e20ff8bf862ecd588b8c7833ffb4f0ad4fe7957ca3149b19f`.
  A documentation re-export changes the artifact digest, not the runtime implementation.
- New deployment record: `mainnet-2026-09-23`, supplied by Ditto. Its real forward path into
  Spark has completed; a full production return/claim cycle and state-restore drill remain
  separate acceptance checks. Rehearsal success is not a substitute for either.

## Historical RC2 review entries

The packages below were merged before the September 23 deployment. "Candidate", "draft" and
"not deployed" refer to their review dates, not today's status. Breaking changes still apply:
do not update the old pilot one seat at a time.

### Second-scan candidate (2026-09-22; not deployed)

- New deployment uses caller-bound bridge adapters; public pilot adapters are NOT replaced
  by an operator update. Reconciler pins one provider per leg per tick, holds inconsistent
  evidence, rejects duplicate sequence state, commits candidate state before publication and
  bounds Ethereum catch-up. Publish retry never reapplies a transfer.
- Independent-review follow-up: invalid uncommitted candidate state/watermarks now use normal
  tick-error and RPC fallback, without changing live state or files. Corrupt stored startup state
  remains fatal and requires explicit recovery. The reconciler README includes backend-order,
  sticky-provider and ambiguous-window incident procedures; no pilot update is implied.
- HEARTBEAT and other non-price tasks no longer require a readable NAV inventory file.
  Price-setting tasks still take exactly one inventory snapshot and fail closed.
- NAV checks pinned vault virtual shares and mandatory vault/executor/receiver custody,
  while retaining additional historical owners. Invalid numeric types refuse; empty historical
  haircut buckets are ignored but invalid NONZERO positions are not clamped.
- `/sign` coalesces only identical authenticated in-flight requests (4 unique jobs, at most
  16 waiters per job). Excess work returns 503; completed retries revalidate. Python signing is
  asynchronous; durable anti-equivocation reservation still precedes signing.
- READY uses the price verifier's bridge-pin admission, not only a lag threshold. An RPC
  read failure is UNKNOWN. The NAV generator bounds calls and does not echo provider secrets.
- Candidate must be reviewed/exported from one canonical SHA. No rolling seat-only update
  of the live pilot is implied; the candidate uses the new contracts and HMAC-v2 lineage.

### Contract follow-ups under review (not deployed or included in `85f7cab`)

Canonical #39/#40/#42 are separate drafts for bounded confirmations, wiring, emergency
funding and public wind-down. They require a NEW deployment/record, not a seat-only update.
The owner's 2026-09-16 follow-up adds draft #44: independent quorum HEARTBEAT after 13 idle days
on EACH leg. The 14-day delay and guardian reset model remain; no 60-day scheme. Public deposits remain public. Final operator
export must come from the reviewed integrated revision after these PRs are accepted.

### Review candidate only — #43 and #44, 2026-09-16

- Final acceptance follow-up: contradictory inbound reads no longer create an irreversible
  window; the tick holds without publishing or advancing cursors and retries the same range.
  A stored impossible sequence interval requires an explicit rebuild, not automatic deletion.
  Persistent contradictions still deny fresh accounting; no inferred donation is trusted.
- #43: retained inbound mint windows, late-source-history recovery, unambiguous attribution
  across range splits/restarts, and fail-closed unreadable state. Old states missing the
  evidence window may need an explicit rebuild. See the reconciler README.
- #44: the same `HEARTBEAT` tag is domain-bound to each leg's executor/receiver. A seat reads
  that leg's clock and armed flag, refuses early/stale/future or malformed payloads, and signs
  only a five-minute task bound to the observed last activity. No NAV or capital movement.
  One task does not refresh both chains; an active dead-man cannot be cleared this way.
- Requires BOTH new contracts, matching aggregator and seats. Neither rc1 nor the live pilot
  supports this operation. This candidate branch is for review, not a piecemeal pilot update.
- Quorum liveness is not proof of correct accounting or the ability to complete withdrawals.

### `85f7cab` — canonical `abadb52` (PR #38), 2026-09-13 — digest `fc6f700c9aea01737c205c17d9243f33bdaaccc1ae2a71de34d98bac09b9ae5e`

- `BRIDGE_BACK` reads the exact `BridgeReceiver.unbondTicket(uint64)` through the seat's own RPC and
  refuses a missing, unreadable, already-claimed, zero-amount or immature ticket.
- `CLEAR_BATCH` accepts only Closed / Unwinding / InFlight / PartiallyFunded batches; malformed batch
  data is refused. Topping up a partially funded batch still works.
- Keccak `rotl64` fixed for a rotation of exactly 32 bits (unreachable by the permutation constants).
- With `registryMode: "onchain"` a nonzero local `navHaircutBps` is refused; omit it or keep `0`.
- New shipped tests: `ops/task-engine/keccak.test.mjs`, `ops/task-engine/funding-status.test.mjs`.
- Docs: an in-flight bridge transfer is not automatically a 100 % loss; historical RPC state is required.

### `9e0c39d` — canonical `3b24a87` (PRs #36 + #37), 2026-09-12 — digest `88ae502f597228978b8714e0f27fae35b64401e7c13fb69f5834c198c3d1a3c3` (superseded by `85f7cab`)

**Breaking — needs a coordinated aggregator + operator rollout, never a piecemeal seat update:**

- **HMAC v2.** Requests are signed over `JSON.stringify([2, method, pathWithQuery, timestamp, body])`.
  There is no body-only fallback; an rc1 aggregator and a `main` seat cannot authenticate each other.
- **Policy age budget.** `navAccounting.policy` must satisfy pin depth + healthy lag + alignment ≤
  `maxSnapshotAgeSecs`; the generators now write `300`. If omitted, the default is `180`: this budget
  check fails only if the configured depths/lag/alignment exceed 180 s. For example, the default
  6/12 confirmations, zero extra lag and 30 s alignment fit 180 s. The shipped rc1 lag allowances
  4/6 do NOT fit 180 s (Ethereum alone needs `(12 + 6) * 12 + 30 = 246 s`).
  Check the complete policy rather than assuming every older config fails. Do not loosen
  `minConfirmations` to compensate.
- **Proposer pin depth** is `minConfirmations + maxHealthyLagBlocks`; `check-operator-ready.sh` uses the
  same depth (it needs `node` and `ops/task-engine/nav-snapshot.mjs`).
- **Reconciler state schema v4** (transfer records). A v3 state file with outstanding queues is refused:
  rebuild from the deployment blocks (`ops/reconciler/README.md`); a valid v3 state with empty queues
  can migrate automatically. New knobs `RECON_RPC_BUDGET_SECS`,
  `RECON_RPC_MAX_ATTEMPTS`, `RECON_RPC_TIMEOUT_SECS`, `RECON_LOG_MAX_DEPTH`, `RECON_MEZO_RANGE_MAX`.
- **Providers** must serve historical state and logs from the deployment blocks and EIP-1898
  `eth_call` with `{blockHash, requireCanonical: true}`; providers without it fail closed.
- **`cast` pinned to 1.5.1.** The image downloads the release tarball and checks its SHA-256; the native
  installer refuses another version.
- **Config files** are written `0600` by the generators; a native install must `chown root:<service group>`
  and `chmod 0640` them before starting the unit. The Compose ownership procedure is in
  `docs/ONBOARD.md`; it uses the image's uid/gid, not the native service group. `/app` in the image is root-owned.

Other changes in the same export:

- Task ABI fields are validated before any RPC or signature reservation; `navEpoch` must be exactly
  last + 1; `DEALLOCATE` refuses an unreadable venue balance; missing tracked policy keys refuse startup;
  a zero batch-size trigger means off; one inventory object per verification.
- JSON-RPC batch responses are checked for arity, unique known ids and a well-formed result envelope.
- `REPORT_URL` must be exactly `/report`; report redirects are refused; the `/sig-log/<key>` route is
  part of what the HMAC signs.
- Generators read the pool's live `tickSpacing`, corroborate pool ↔ quoter factory and the token pair,
  try every fallback endpoint with a timeout, redact RPC credentials and never treat an RPC error as an
  address.
- Bridge reconciler: transfer records, departures of both legs folded before arrivals, read → fold →
  persist → publish, provenance filters and RPC failure budgets. Outbound deliveries match bridge
  confirmation sequences; inbound settlement uses the processed sequence window and observed mint
  residual with bounded, unique-subset attribution. Ambiguous evidence blocks NAV rather than guessing.
  Late departures settle on read. Outstanding outbound amounts still have no automatic age/loss
  haircut; an oldest-block diagnostic is not a write-off policy.

### Earlier

Exports before the tag (`b835c04` and older) predate the release candidate and are historical.

## v2.0.0-rc1 — 2026-09-05

- canonical `bc927a0` → operator `66b9d8e` (tagged), digest
  `f88dc1150dbcb19f5087f0940cac62209283dfc08857d68fa214b81f283fa368`.
- Release candidate for the next deployment; not deployed. What it contains and how it was rehearsed is
  recorded upstream in `docs/ops/RELEASE-CANDIDATE.md`.
