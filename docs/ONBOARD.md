# Joining the operator set

Everything an external operator needs. Written for the Compose deployment; adapt freely if you run
Kubernetes or systemd — Ditto supports the software and configuration interface, not your
infrastructure.

Ditto's internal runbooks, host layout, guardian incident procedures and audit material are
deliberately **not** part of this repository. Nothing here depends on them.

---

## 0. What you agree with Ditto first

The September 23 mainnet stack verifies per-leg HEARTBEAT tasks after 13 idle days. They use
the normal quorum/signature path, never publish NAV or move capital, and cannot clear an armed
dead-man. Both new contracts support this; the older pilot does not.

**Which release.** Agree the exact commit and manifest with Ditto before installing. Ditto's
seats on the new stack run the runtime files exported from canonical `5cd9d0c` (operator export
`f90a575`); documentation-only exports do not change the running code. There is no rc2 tag yet.
This HMAC-v2 distribution cannot talk to the older pilot runtime (see `CHANGELOG.md`). The new
stack's deployment record ships as `ops/deployments/mainnet-2026-09-23.addresses.json`; confirm it
and the configuration policy with Ditto. The 2026-08-11 pilot record in `ops/deployments/` is
historical, not the onboarding target. Installing
the software does not add a seat: readiness, agreement and guardian enrolment are still required.

**Getting this repository at all.** Clone `dittonetwork/mezo-stable-yield-operator` from GitHub
(while it is private, Ditto adds you as a read-only collaborator), or use a tarball of the agreed
commit. Whichever it is, **verify before you build** — the manifest is the artifact agreement, not a formality:

```bash
sha256sum -c MANIFEST.sha256      # every line OK, and no "FAILED" anywhere
git rev-parse HEAD                # if you got a git tree: must equal the agreed commit
```

If you were sent a tarball, that checksum run *is* your provenance. Do not build a tree that fails it.

| | |
|---|---|
| Release | the commit/tag of this repository, and its `MANIFEST.sha256` |
| **Deployment record** | `<deployment>.addresses.json` — WHICH deployment you join. Its addresses are what your config is corroborated against (§2a), its `deployedAtBlock` seeds your reconciler (§3), its `deployment` is the id you sign in the challenge (§2d). For the September 23 stack it is `ops/deployments/mainnet-2026-09-23.addresses.json` in this repository; the 2026-08-11 pilot's record is kept for history, and for any other deployment Ditto sends the file. There is no default: the software refuses to start a seat without one |
| Your identity address | an address that labels your seat on chain. Its key signs the onboarding ownership challenge, not vault tasks or routine transactions; keep access to it for that proof |
| Transport | WireGuard endpoints both ways: Ditto reaches your `/sign`, you reach their `/report` |
| Secrets | one unique 64-hex HMAC secret for your seat, exchanged out of band |

**Making the identity address.** Use an address whose key you control and can use for the signed
challenge in §2d. It needs no funds for this message signature; Ditto receives the address and proof,
never the private key. If you do not already have one to spare, mint one
after `docker compose build` (§2):

```bash
docker compose run --rm tools cast wallet new
```

That prints an address **and a private key**. **Keep the private key** — store it as carefully as
any other key, `0600`, on this host. The seat never uses it to transact, but you will sign one
message with it (§2d) to prove you actually control the address, and Ditto will not enrol an address
nobody has proven they hold. Send Ditto the **address** only; the private key never leaves this host,
exactly like the BLS key.

**Artifact approval, for a deployment:** both organisations publish the checksum and you rebuild
independently. Record the tag, commit, artifact hash and both approvals. Do **not** describe it as
on-chain build approval — it is a two-organisation agreement, and the difference matters if it is
ever disputed.

## 0b. What your seat is and is not — read this before you commit resources

The threshold is `ceil(2n/3)`, recomputed on chain whenever the set changes. Ditto currently holds
five seats, so:

| set | n | threshold | can Ditto's five sign alone? | external signatures required |
|---|---:|---:|---|---:|
| 5 Ditto | 5 | 4 | yes | 0 |
| 5 Ditto + **you** | 6 | 4 | **yes** | 0 |
| 5 Ditto + 2 external | 7 | 5 | **yes** | 0 |
| 5 Ditto + 3 external | 8 | 6 | **no** | **≥ 1** |

**Be clear about what that means.** As the first or second external seat you are *participating* in
the operator set — you independently verify every proposal, you refuse anything that does not
reconcile, and your refusals are visible. You are **not** yet a check on Ditto: at n=6 and n=7 the
five existing seats still meet the threshold without you, so your absence or disagreement cannot
block a task. That changes at n=8, and only if Ditto does not add seats in step.

This is stated here rather than left to be worked out because it should inform how much you invest
now, and because an operator who discovers it later is right to be annoyed.

**What your seat does buy from day one**, stated precisely: it is an independently operated instance
of the same verifier software, running on infrastructure, RPC providers, configuration and NAV
inventory that Ditto does not control. That is **operational** independence — it defends against a
compromised or failing Ditto host, a lying or stale RPC provider, and a mistaken config or inventory
on Ditto's side, because your seat re-derives every proposal from its own reads and refuses what does
not reconcile.

It is **not implementation diversity**. Both organisations run the same reviewed code, so a bug in
that code affects your seat exactly as it affects Ditto's, and no number of seats catches it. That is
what the external audit is for, and it is why the threshold and the audit are separate defences
rather than substitutes.

## 1. Endpoints

Two **independent** RPC providers per chain — Mezo (31612) and Ethereum (1). You do not need to
operate a full node, but the providers must serve historical state and logs from the deployment
blocks. The first reconciliation reads a balance at the block before deployment; catch-up and
rebuild need historical balances and sequence tips, not just recent logs. Pinned NAV calls use
EIP-1898 `eth_call` with `{blockHash, requireCanonical: true}`; no number-only fallback is allowed.

**Bring your own.** These are examples, not endorsements, and not defaults baked into anything:

| chain | examples |
|---|---|
| Mezo 31612 | `https://mezo-mainnet.boar.network` · `https://mezo.drpc.org` · `https://mainnet.mezo.public.validationcloud.io` |
| Ethereum 1 | `https://eth.drpc.org` · `https://ethereum-rpc.publicnode.com` · `https://cloudflare-eth.com` |

Measured while onboarding a real external seat (2026-08-22), so you do not rediscover them:

- **`https://rpc_evm-mezo.imperator.co` returned HTTP 405 on `eth_chainId`.** It is listed publicly
  as a Mezo endpoint; it did not serve this workload.
- **`ethereum-rpc.publicnode.com` would not serve the historical USDC `getLogs` walk** that
  first-run bridge catch-up needs. The fallback (`eth.drpc.org`) completed it. This is why the
  generator takes `*_RPC_FALLBACK` and why not every free endpoint supports onboarding:
  the seat needs `eth_getLogs` over a range, and free tiers cap that differently.

Pick the pair per chain from **different organisations**. Two endpoints from one provider is one
provider with two URLs, and the point of the fallback is that a single failing or lying operator
cannot serve both.

Your providers are **inside your seat's trust boundary**. Canonical prices are pinned by block number
*and* hash, so an endpoint that is merely behind or on a stale fork makes your seat deny rather than
sign. A genuinely malicious provider can fabricate a header and consistent state beneath it and steer
your verdict — the threshold contains that, your provider choice avoids it. Two organisationally
independent providers means one compromised provider cannot serve both your primary and fallback.

## 2. Config, inventory and key — all through the image

No host Node, Python or `cast` required. Build once:

```bash
# Your seat's HMAC secret. Export it FIRST: Compose interpolates the whole file before running
# anything, and the operator service declares OPERATOR_SECRET as required — so without it even
# `docker compose run --rm tools` refuses, long before any service starts.
export OPERATOR_SECRET=$(openssl rand -hex 32)
echo "$OPERATOR_SECRET"     # send this to Ditto out of band; it is unique to your seat

# The deployment record Ditto sent you (§0) — WHICH deployment this seat joins. Compose needs its
# two start blocks in the environment before it will run ANY command, `build` and `run --rm tools`
# included, for the same reason as the secret: it interpolates the whole file first, and the
# reconciler service requires them. There is no default, because a default would be some other
# deployment's blocks. Read them off the record and export them next to the secret:
mkdir -p config secrets
cp <the record Ditto sent you> config/addresses.json   # for the September 23 stack: ops/deployments/mainnet-2026-09-23.addresses.json
grep -A2 deployedAtBlock config/addresses.json         # prints  "mezo": N,  "eth": M
export RECON_START_MEZO=<N>
export RECON_START_ETH=<M>

docker compose build

# Mode FIRST, owner SECOND. Reversing them breaks: once `chown` hands the directory to 10001 you no
# longer own it, and the unsudoed `chmod` that follows fails with EPERM.
chmod 700 config secrets
sudo chown 10001:10001 config secrets
```

`config/` is 700 as well as `secrets/`, deliberately: `operator-config.json` and
`reconciler-addresses.json` embed your **RPC endpoint URLs**, and most providers put the API key in
the path. Those are credentials — treat that directory like the key directory.

Keep all three — `OPERATOR_SECRET`, `RECON_START_MEZO`, `RECON_START_ETH` — exported for every
command below, or put them in a `.env` beside `compose.yaml`; Compose reads that automatically.

**a. Your seat's config.** Put the deployment record where the image sees it, then generate. The
generator re-reads every anchor address in the record from the chain through *your* endpoints and
writes nothing if one disagrees:

```bash
docker compose run --rm \
  -e ADDRESSES_JSON=/config/addresses.json \
  -e MEZO_RPC=https://... -e ETH_RPC=https://... \
  -e MEZO_RPC_FALLBACK=https://... -e ETH_RPC_FALLBACK=https://... \
  -e REPORT_URL=http://<aggregator-wireguard-ip>:4500/report \
  -e OUT=/config tools python3 ops/gen-external-operator-config.py
```

`SEAT_INDEX` is optional and assigned at enrolment — leave it unset.

`REPORT_URL` is **required by the generator but useless before the tunnel exists**. If you are
standing the seat up before the WireGuard exchange — which is the sensible order, since everything
up to §4 is yours alone — point it at a local sink and correct it later:

```bash
-e REPORT_URL=http://127.0.0.1:4500/report
```

Re-run this generator with the real aggregator address before enrolment. A seat left on the loopback
value verifies every proposal correctly and posts its verdict into nothing; the readiness check warns
about exactly this, because from the outside it is indistinguishable from a seat that never answers.

**b. Your NAV inventory.** The previous command prints this one with addresses filled in; run it the
same way. **Derive it; do not accept a copy.** It is the list of custody addresses your canonical NAV
sums over, and it is the one input the threshold cannot check for you: if it is wrong, every seat
re-derives the same wrong price and every seat signs it.

**c. Your BLS key**, generated here and never transmitted:

```bash
docker compose run --rm tools python3 ops/drills/signer.py keygen /secrets/operator.bls.key
```

`signer.py` creates it `0600` and prints only the public material. Send Ditto that — compressed
pubkey, `pubkeyG1`, `popG2`.

**The BLS private key never leaves this host** and must never appear in chat, a ticket, or a shared
password manager. Ditto will never ask for it. (That is a different secret from `OPERATOR_SECRET`
above, which you *do* send Ditto — the HMAC secret authenticates the transport between your seat and
the aggregator; the BLS key is what signs, and nobody but this host ever needs it.)

Because the directory is already owned by 10001, the key it writes is too, and the operator container
can read it back with no further chown. Confirm before starting:

```bash
ls -ln secrets/operator.bls.key      # expect  -rw------- 1 10001 10001
```

**d. Prove you control the identity address.** Ditto sends you a one-time **challenge** string when
they add you to their approved-operator manifest. Sign this exact message with the identity key from
§0 — it binds the deployment, your address and both pieces of BLS key material to that challenge, so
a signature collected for one onboarding cannot be reused for another:

```bash
DEPLOYMENT=$(jq -r .deployment config/addresses.json)      # the record's id (the September 23 record says mainnet-2026-09-23)
MSG=$(printf 'ditto-operator-enrolment\ndeployment=%s\nidentity=%s\npubkeyG1=%s\npopG2=%s\nchallenge=%s' \
  "$DEPLOYMENT" "$IDENTITY_ADDR" "$PUBKEY_G1" "$POP_G2" "$CHALLENGE")
docker compose run --rm tools cast wallet sign --private-key "$IDENTITY_KEY" "$MSG"
```

Everything lowercase, and the values must be byte-identical to what you send Ditto — the signature
covers them, so a mismatch reads as "did not sign this" rather than as a typo. `deployment` is the
record's `deployment` field and must equal the id in Ditto's own manifest; Ditto states it when
sending the challenge, and a signature over another id — another deployment, or a rehearsal — does
not verify. Send back the signature. If Ditto's preflight cannot verify it, enrolment stops there,
by design.

## 3. Start

```bash
export OPERATOR_BIND=10.x.x.x            # your WireGuard address, NOT 0.0.0.0
# RECON_START_MEZO / RECON_START_ETH are still exported from §2 (or in .env): they are the
# reconciler's first-run start, and compose refuses to bring it up without them.

# DECIDE THIS NOW, not later. If you want the shadow smoke test (§5), set it before the first start
# and leave it set through enrolment — a seat that has already signed cannot un-sign, so switching
# into shadow afterwards proves nothing about the round it took part in.
export OPERATOR_SHADOW_ONLY=1            # optional; remove it at §6 when you enable signing

docker compose up -d
```

The reconciler starts first and must reach both chain heads before your seat can agree with the set.
Until then it denies price-setting tasks — correct, and indistinguishable from a broken seat if you
do not know to expect it.

**Expect the first start to sit on NOT READY for several minutes, with no output.** It replays from
the deployment blocks to head. Measured on a real first run (2026-08-22, 2 vCPU / 4 GB): **~8 minutes
and ~2 GiB peak RSS**, most of it a silent Ethereum USDC `getLogs` walk. Two consequences:

- **Do not use a 2 GB host for the first start.** 4 GB is comfortable; 2 GB is not, and the failure
  would come during catch-up rather than at boot.
- **Watch the reconciler, not the clock** — this is the only place that shows progress:
  ```bash
  docker compose logs -f reconciler
  ```
  `check-operator-ready.sh` can only say the inventory does not exist yet, which reads identically to
  a hung reconciler. It is not hung until the reconciler log stops moving.

Then check readiness — the gate is **READY**, not `/health` and not `docker ps`:

```bash
docker compose run --rm tools ops/check-operator-ready.sh /var/lib/ditto-operator/nav-inventory.json
```

**An in-flight bridge transfer is not automatically a 100% loss.** The reconciler keeps a
protocol-attributed transfer in flight until settlement evidence resolves it. A confirmed loss
can carry a haircut; ambiguous attribution closes price-setting instead of silently assigning a
confident balance. Diagnose that condition from the reconciler log, not from `/health`.

`/health` answering `ok` means the process parsed its config and is listening. It does **not** contact
either RPC or read the inventory. **Use the readiness check to decide whether the seat is ready** —
not `/health`, and not `docker ps`.

## 4. Enrolment — NOT A STEP YOU PERFORM

> **Everything above this line is yours alone.** You can run all of it, today, on your own hardware,
> and reach a healthy shadow seat without involving anyone.
>
> **This section is not.** Enrolment is performed by Ditto's and Mezo's guardians, on two chains, and
> nothing you type makes it happen. It is described here so you know what will happen to you and in
> what order — not as a checklist to work through. §5 and §6 *are* yours again, but only once this
> ceremony has actually completed; they are meaningless before it.
>
> **If you are evaluating, rehearsing, or doing a dry run: stop at §3.** A shadow seat at READY is
> the complete rehearsal. There is nothing further to test that does not involve permanently
> changing a live quorum on two chains — and on **2026-08-22** a dry-run seat did exactly that, in 22
> seconds, using an identity its own operator had called disposable. That is the reason this section
> now opens with a boundary instead of a step number.

**Before enrolment can even be requested**, all of these must already be true:

- a real agreement exists between your organisation and Ditto that you will operate a seat
- **you are that organisation** — not a contractor, agent or evaluator acting on its behalf without
  its knowledge
- your identity address and `pubkeyG1` are the ones named in that agreement, generated on the host
  you will actually run, and not a throwaway from a test
- you have read §0b and accept that at n=6 and n=7 your seat cannot block anything

Ditto runs `enrol-preflight` against a manifest of agreed operators before any guardian proposes.
**An identity that is not in that manifest is refused**, deliberately — so a rehearsal key cannot be
enrolled even if someone asks nicely. Do not treat a refusal as a bug to work around.

### Who holds the guardian roles today

The contract has two guardian slots and enforces that a proposal is confirmed by the **other** one:
`_requireOtherOrg` means one slot cannot confirm its own proposal, and that is real in the code.

**Both slots are currently controlled by Ditto**, as externally owned accounts, on the September 23
stack as on the pilot. The same key that occupies the Ditto guardian slot also owns every
`ProxyAdmin`, so upgrade authority and guardian authority are the same authority. Deposits on the
September 23 stack are public.

Read the AND-gate accordingly: against a mistake or a single stolen operator key it does what it
says; against Ditto itself it separates nothing today. Ditto plans to move `ProxyAdmin` ownership and
the Ditto guardian slot to Ditto-owned Safe multisigs; until that is executed and announced, assume
the arrangement described here.

You are being told this because the paragraph below says "two-organisation ceremony", and that
describes the mechanism rather than today's custody. Judge what your seat is worth to you with the
real arrangement in front of you.

### What actually happens

Installing this software does not join you to the consensus, and never will. Enrolment is a manual
**two-organisation** ceremony in the contract's sense: one guardian slot proposes your identity
address and public key, the other confirms — on **both** Mezo and Ethereum. Proof of possession is
verified on chain, so a key you do not hold is rejected by the contract.

You send Ditto, out of band: your identity address, `pubkeyG1`, `popG2`, the compressed pubkey, and
your `OPERATOR_SECRET`. **Ditto then performs both halves of the enrolment** — one call from each
guardian slot, both slots being Ditto's today (see above) — and adds your seat to the
aggregator's config — index, URL, compressed pubkey — and restarts it. The aggregator's startup
preflight refuses to serve unless both chains and its own config agree, so a half-finished ceremony
stops the round rather than producing short ones.

**This is where your index comes from.** It is assigned on chain by the enrolment, which is why
`SEAT_INDEX` was optional in step 2.

## 5. Optional: compare one shadow proposal

Ordering matters here, and it is the opposite of what people assume: **shadow comparison comes after
enrolment, not before it.** Your seat's verdict is identified by its HMAC secret against the
aggregator's operator list — so until you are enrolled and in that config, there is nothing for a
verdict to be compared against.

You set `OPERATOR_SHADOW_ONLY=1` back at §3 and it has been in force since — the seat has been
running, verifying and reporting, without ever holding a key or producing a signature. Nothing to
change here; just watch.

Your seat performs the complete independent verification and reports its verdict, but creates no
partial signature and loads no BLS key. Watch **one real proposal** agree with the fleet, then remove
the setting and restart. That is the whole check.

There is no reason to wait days. Threshold is `ceil(2n/3)`: at n=6 it is still 4, so the existing
seats keep signing and a misconfigured new seat simply does not contribute — it cannot stall the
vault and cannot authorize anything alone. Take longer only if *you* want the confidence.

## 6. Enable signing

Remove `OPERATOR_SHADOW_ONLY`, restart, and prove one signed round with your bit set in
`TaskVerified.signerBitmap`. You are in the set.

## 7. Running it

| | |
|---|---|
| `POST /sign` | Ditto proposes; your seat re-derives against its own reads and returns a partial signature, or `422` with a reason |
| `POST` → `REPORT_URL` | your verdict, pushed back. **Plain HTTP over WireGuard** — `/report` has no TLS; the tunnel and HMAC are the security |
| `GET /health` | liveness, unauthenticated, exposes nothing |

A `422` is your seat working. Investigate the reason before assuming it is a bug: refusing a task the
rest of the set signs is exactly what an independent operator is for.

**Keep running:** both services up, the reconciler never stopped for long (it must stay near both
heads), your two providers healthy, and your key backed up somewhere only you control. If you need to
step away, tell Ditto — a seat that is enrolled but silent reduces the set's margin without reducing
its threshold.

**Key rotation and leaving** are two-organisation ceremonies too; ask Ditto to walk them with you.

## 8. Verifying your copy

```bash
sha256sum -c MANIFEST.sha256
docker compose run --rm tools npm test
```
