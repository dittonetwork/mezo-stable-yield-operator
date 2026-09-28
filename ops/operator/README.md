# Operator runtime — pull-sign service (P1)

## What it does

The operator process (`server.mjs`) is the **entire runtime loop for a BLS operator** in the
Ditto × Mezo micro-BLS operator layer. Operators are passive: they idle until the single
aggregator pushes a proposed `(task, nonce, payload)`, re-derive it locally, sign only if it
reconciles, and send the partial BLS signature back.

**The re-derivation is the whole point.** The aggregator is trusted to SEQUENCE rounds, never
to dictate their content — so `verify.mjs` re-checks every dangerous parameter against this
host's OWN chain reads and OWN pinned config (`OPERATOR_CONFIG`, required at startup): the
payload against `calldataHash`, chainId/target binding, the 5-minute swap window and
max-block bound, placement `amountIn` against its own `placeableSurplus`, `minOut` against
its own pool quote, exact canonical NAV at signed pins and next epoch, `closeNavRay > 0`, capital movement within the
executor's balance. Unknown task types are default-denied. Without this an operator set is
five rubber stamps and the 4-of-5 threshold means nothing: a compromised aggregator would
simply have `minOut = 1` signed and sandwich the swap. Refusals are logged and returned as
`422` with the reason.

## Additional task and inventory checks (RC2 follow-up)

`BRIDGE_BACK` reads the exact `BridgeReceiver.unbondTicket(id)` through this seat's RPC. It
refuses an absent, already-claimed, zero-amount or immature ticket and an unreadable response.
The current venue is not an authority for an older ticket: its stored adapter remains valid
after a venue rotation. The contract still checks maturity, amount, claimed state and recipient
at execution; this pre-sign check does not replace those checks or shorten the admin expiry.

`CLEAR_BATCH` accepts only Closed, Unwinding, InFlight or PartiallyFunded batches. Unknown
states are refused; topping up a partially funded batch remains possible within its outstanding
obligation and the vault's available buffer.

With `registryMode: "onchain"`, pending-unbond haircuts come from the receiver's historical
ticket buckets. Omit the local adapter `navHaircutBps`, or keep the old generated `0` placeholder.
A nonzero local value is refused, not silently ignored. In `audited-static` mode that field is
required and applies to pending requested/claimable balances. Neither mode applies this field
to managed venue assets or underlying dust; no new valuation policy is introduced here.

## Endpoints

The signing and signature-log endpoints require HMAC-SHA256 authentication via
`x-mezo-signature` and `x-mezo-timestamp` headers (see `auth.mjs`). Health is intentionally
unauthenticated and exposes no configuration or key material.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/sign` | Receive `(taskKey, task, nonce, payload)`; **re-derive it against this host's own chain reads and pinned config** (`verify.mjs`) and refuse `422` if anything does not reconcile; log to the partial-sig store; return the BLS partial signature |
| `GET`  | `/sig-log/:taskKey` | Return the partial-sig log entry for DB-restore reconciliation (PERSISTENCE-DESIGN.md step 3) |
| `GET`  | `/health` | Liveness check (unauthenticated) |

## Quick start

```bash
OPERATOR_SECRET=<distinct-64-char-hex-for-this-seat> \
BLS_KEY_PATH=/path/to/operator.bls.key \
PARTIAL_SIG_DB=/var/lib/ditto-operator/partial-sigs.db \
OPERATOR_CONFIG=/etc/ditto-operator/operator-config.json \
PYTHON=/opt/ditto-operator/.venv/bin/python3 \
PORT=4000 \
node ops/operator/server.mjs
```

Generate this seat's secret (deliver the same value to the aggregator out of band as
`OPERATOR_SECRET_<index>`; never reuse it for another seat):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For commissioning, add `OPERATOR_SHADOW_ONLY=1`. The service performs the complete independent
verification and reports its verdict, but it never creates a partial signature or writes a
signature-log entry. Remove that setting only after shadow verdicts match the existing fleet.

## Storage

- **Partial-sig log** (`PARTIAL_SIG_DB`): SQLite database via `sql.js` (zero native deps).
  Records `(taskKey, nonce, payloadHash, signedAt)` for every signature produced. This is
  the operator's ONLY durable state — it feeds the aggregator's DB-restore reconciliation
  when `GET /sig-log/:taskKey` is queried.
- **BLS key**: the operator's own private key, generated ON its host and never transmitted
  (`signer.py keygen <file>` writes it 0600 and prints only the public material: the
  compressed pubkey for the aggregator's config, plus `pubkeyG1`/`popG2` for
  `OperatorWhitelist` enrollment). Signing shells out to `signer.py sign` — set `PYTHON` to
  an interpreter that has `py_ecc` (a venv, since PEP 668 blocks system-wide pip on modern
  distros). P2 upgrade path: KMS / encrypted keystore.

## Auth model

Symmetric HMAC-SHA256, with **one distinct 256-bit secret per operator** — not one shared across
the set. The aggregator holds a secret for each seat (`OPERATOR_SECRET_<index>`); each operator holds
only its own (`OPERATOR_SECRET`). Delivered out-of-band (env/file). Each request is signed with
`HMAC(sha256, secret, JSON.stringify([2, method, pathWithQuery, timestamp, body]))`,
with a ±30s timestamp window. The route (including a signature-log key) cannot be substituted.
This wire format requires a coordinated aggregator/operator update; old body-only MACs are refused.

**Why per-operator** (external review, 2026-07-15): with a single set-wide secret, compromising ANY
one operator host yields the key to impersonate the aggregator to the other four — collecting a real
quorum from honest operators. Per-operator secrets contain the blast radius to the host that fell.
The same secrets authenticate the reverse direction: the aggregator identifies a `/report` by finding
which seat's secret validates the body, so a report proves WHICH seat sent it rather than trusting a
self-declared index in the payload.

It authenticates the **channel**, never the content. An authenticated proposal is not a trusted one —
that is what `verify.mjs` re-derivation is for.

P2 upgrade path: mTLS, or signing requests with the aggregator's own key so operators verify a
signature rather than hold a symmetric secret — which would mean nothing secret has to cross an
organisational boundary at all. See `auth.mjs` for the full rationale.

## Tests

```bash
npm test
```
