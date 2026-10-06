# dMUSD operator seat

Software for running one operator seat in the Ditto × Mezo dMUSD vault's threshold-signing set.

**Deployment status, 2026-09-30:** the September 23 mainnet stack uses the post-review code
from canonical `93d6a6b`. Its seats run the runtime files exported from canonical `0026358`
(operator export `474f78f`), which values non-MUSD assets at the Tigris pool's exit rate. It supports
independent 13-day quorum heartbeats on both legs. A heartbeat updates only its contract's
activity clock, not NAV, balances or an armed dead-man. The older pilot does not support this
protocol.
See [CHANGELOG.md](CHANGELOG.md) for compatibility and upgrade notes.

**This repository is generated.** It is exported from Ditto's canonical repository by an allowlist
and is never edited directly — a fix made here would be overwritten and, worse, would put your seat
on a different release history from everyone else's. Report issues to Ditto, and report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

> **Which version is which (2026-09-30).**
>
> | | |
> |---|---|
> | **New mainnet stack** | `mainnet-2026-09-23`, reviewed code `93d6a6b`; seats run runtime files from canonical `0026358` (operator export `474f78f`); five Ditto seats, quorum four. Deployment record: `ops/deployments/mainnet-2026-09-23.addresses.json`. Later documentation exports do not imply a runtime rollout. |
> | **Older pilot** | `mainnet-2026-08-11`, canonical contracts `0cffc1002567…`, separate pre-rc1 host tree. This distribution is **wire-incompatible** with its runtime (HMAC v2). |
> | **Historical tag** | `v2.0.0-rc1` was a candidate, not either deployment's source. No rc2 tag has been issued. |
>
> Do not install an arbitrary `main` revision on a running seat. External onboarding requires an
> agreed deployment record, commit and `MANIFEST.sha256`, plus guardian enrolment. What changed
> since the tag, including the breaking changes: [`CHANGELOG.md`](CHANGELOG.md).

## What your seat actually does

The aggregator proposes tasks. It is trusted to **sequence** rounds and never to dictate their
content. Your seat re-derives every dangerous parameter from **its own chain reads and its own pinned
config** and signs only if everything reconciles: payload against `calldataHash`, chain and target
binding, the swap window and max-block bound, placement amount against its own computed surplus,
min-out against its own pool quote, exact canonical NAV at the signed pins and next epoch, capital movement within the executor's
balance. Unknown task types are refused.

Without that re-derivation an operator set is five rubber stamps and a 4-of-N threshold means
nothing: a compromised aggregator would simply have `minOut = 1` signed and sandwich the swap. **The
independence is the product.** Which is why you use your own RPC endpoints, derive your own NAV
inventory, and generate your own key — accepting any of those from Ditto adds a seat but no safety.

## Requirements

- A host that stays up 24/7. The reference deployment is Linux with Docker. **1–2 vCPU, 2 GB RAM
  and about 20 GB of disk are enough.** Measured on the current code (2026-09-28): the reconciler's
  first run over the September 23 stack's history peaked at 33 MB, a BLS signature took 0.4 s and
  33 MB on an Apple M4 (a small cloud vCPU is slower, well inside the signer's 10 s timeout), and
  Ditto's own seats run capped at 512 MB each.
- Docker + Compose (reference deployment), or Node 22 + Python 3 + `py_ecc==8.0.0` + Foundry `cast`
- **Two independent RPC endpoints per chain** (Mezo 31612, Ethereum 1), over HTTPS. They must serve:
  - **signing:** recent state only. Reads are pinned 6 Mezo / 12 Ethereum blocks behind head and at
    most a few minutes old, so any full node serves them;
  - **the reconciler's first run:** logs and historical state from the deployment blocks (for the
    September 23 stack, Mezo 12045502 and Ethereum 26040402). On Ethereum that means archive state,
    which most paid plans include. You do not need an archive node of your own;
  - **`eth_getLogs` ranges** of at least 150 blocks on Ethereum, ideally 5,000 on Mezo. Smaller
    limits still work, because the reconciler splits requests, at the cost of more calls;
  - **about 1–3 requests per second**, using `eth_blockNumber`, `eth_getBlockByNumber`,
    `eth_getLogs` and `eth_call`.

  The first sync is bound by provider latency and grows with the stack's age. On public endpoints
  the September 23 stack's first five days took 11 minutes. Use paid providers for a production seat.
- WireGuard connectivity to Ditto's aggregator

Your RPC providers are **inside your seat's trust boundary**. Canonical prices are pinned by block
number *and* hash, so an endpoint that is merely behind or on a stale fork makes your seat deny
rather than sign — but a genuinely malicious provider can fabricate a header and consistent state
beneath it and steer your verdict. The threshold contains that; your provider choice is what avoids
it. Prefer two organisationally independent providers.

## Getting this repository

Clone it from GitHub (while the repository is private, Ditto adds you as a read-only
collaborator), or use a tarball of the agreed commit. However you received it, verify before you
build:

```bash
sha256sum -c MANIFEST.sha256
sha256sum MANIFEST.sha256       # compare with the digest Ditto confirmed for this release
```

That manifest is the artifact agreement between the two organisations. A tree that fails it is not
the release you agreed to run. Compare the manifest's own digest with Ditto's separately supplied
value, including for a tarball. A documentation-only export has a different manifest even when
its runtime files are unchanged.

Three tests **skip by design** on your copy (two in `npm test`, one in the reconciler suite) — they
read a retired NAV inventory fixture that is deliberately not exported, because shipping a
plausible-looking wrong inventory is the one mistake the threshold cannot catch. A skip there means
your distribution is correct, not incomplete; at `85f7cab` that is 154 passed / 2 skipped and
184 passed / 1 skipped.

## Getting started

**[`docs/ONBOARD.md`](docs/ONBOARD.md) is the procedure** — config, inventory, key, start, enrolment,
signing. It runs everything through the image, so you need Docker and nothing else on the host.

The short version: prepare a shadow seat through **your own RPC endpoints**, exchange connection
details and the per-seat HMAC secret with Ditto, sign one identity-ownership message, and let Ditto
handle enrolment on both chains. Compare a real shadow proposal, then enable signing and confirm
your seat's inclusion in a transaction with Ditto.

Start with the guide's [handoff checklist](docs/ONBOARD.md#0a-connection-details-and-the-handoff-to-ditto).
It lists exactly what you send and what Ditto returns: the pinned release, WireGuard peer details,
assigned tunnel IP, report URL and private HMAC delivery channel. Kubernetes behind NAT is supported;
the guide includes the routing requirements and a peer template with `PersistentKeepalive = 25`.

## Interfaces

| | |
|---|---|
| `POST /sign` | With `REPORT_URL` configured, accepted work receives a `202` acknowledgement; verification and the verdict follow asynchronously |
| `POST` → `REPORT_URL` | Your seat's verdict, pushed to the aggregator. **Plain HTTP over WireGuard** — `/report` has no TLS; the tunnel and the HMAC are the security, not transport |
| `GET /health` | Liveness. Unauthenticated, exposes no config or key material |

Both signing endpoints authenticate with **HMAC-SHA256 over `JSON.stringify([2, method, pathWithQuery, timestamp, body])`**, ±30s window, using
**one secret unique to your seat**, also required in shadow mode. Share the same configured
`OPERATOR_SECRET` privately with Ditto; keep it stable across restarts. It authenticates the channel,
never the content — an authenticated proposal is not a trusted one, which is what the re-derivation
is for.

The aggregator dispatches to every configured active seat and proceeds once the threshold is met.
It combines exactly that many available partials in ascending seat-index order; it does not wait
for every seat. A successful signing response does not guarantee inclusion in the transaction's
bitmap. See the guide's [selection explanation](docs/ONBOARD.md#which-partial-signatures-are-included).

## Shadow mode is a smoke test, not a probation

`OPERATOR_SHADOW_ONLY=1` performs the complete verification and reports the verdict, but creates no
partial signature and loads no BLS key. You can prepare and reconcile locally before enrolment;
real proposal comparison starts **after** Ditto enrols the seat and adds it to the aggregator.
Run it long enough to see **one real proposal** agree with the fleet. There is no fixed waiting
period: at n=6 the threshold is 4 and the five existing seats can
still sign, so a misconfigured new seat simply does not contribute — it cannot stall the vault and it
cannot authorize anything alone. Coordinate completion of the comparison with Ditto, then remove
the setting and restart.

## Joining the set

Ditto records the onboarding agreement and sends a complete, one-time challenge message. You review
and sign it with your identity wallet to prove control of the address and bind it to your BLS key
and deployment. This is an off-chain message signature and costs no gas.

Enrolment then uses both guardian slots on **both** Mezo and Ethereum: one proposes and the other
confirms. Both slots are currently controlled by Ditto; Ditto performs those transactions and updates
the aggregator. You supply the identity address, compressed BLS pubkey, `pubkeyG1`, `popG2`, WireGuard
details and the returned identity signature. Separately, share the per-seat **HMAC secret** through
the agreed private channel. Your **BLS and identity private keys** remain under your control.

Full procedure: [`docs/ONBOARD.md`](docs/ONBOARD.md). Suspension, key rotation and leaving also need
guardian actions; coordinate them with Ditto.

## One writer, enforced by the kernel

Your signature log (`PARTIAL_SIG_DB`) is this seat's anti-equivocation evidence: it is what makes a
retry of the same round return the *same* signature instead of producing a second one over different
content. Two operator processes on one log would each hold their own in-memory snapshot and export it
whole, so whichever wrote last would silently erase the other's record — and the seat would
equivocate with nothing reporting a fault.

The image therefore starts the operator under `flock --no-fork -n`, holding a lock beside the
database. A second start fails immediately rather than queueing, and the kernel releases the lock
when the process dies, so a crash or `kill -9` never leaves a stale lock for a human to clear.

Confirm all four on your own host before you sign:

```bash
docker compose up -d operator                 # 1. starts
docker compose run --rm operator              # 2. a second one REFUSES, immediately
docker compose restart operator               # 3. an ordinary restart still works
docker compose kill -s KILL operator && docker compose up -d operator   # 4. and so does this
```

Keep `/sigs` on a local volume. `flock` semantics over NFS are not something to rely on for this.

## Verifying your copy

```bash
sha256sum -c MANIFEST.sha256                      # every file as exported
docker compose run --rm tools npm test            # the tests for what is shipped here
```

## Licence

BUSL-1.1 — Automation Labs Ltd. Production use is granted only for operating a seat in an operator
set authorised by the Licensor. See [`LICENSE`](LICENSE).
