# Security policy

This repository is the operator-seat software for the Ditto × Mezo dMUSD vault. A seat verifies
tasks against its own chain reads and signs with its own BLS key; the contracts it signs for hold
real funds on Mezo and Ethereum mainnet.

## Reporting a vulnerability

Report privately. Do not open a public issue or pull request for a security problem.

- **On GitHub:** use **Report a vulnerability** on this repository's **Security** tab.
- **If you run a seat:** use the contact channel agreed with Ditto during onboarding.

Include the commit you looked at, the affected file and function, and a reproduction if you have
one. Never test against the mainnet deployments with funds you do not own, and never include a
private key, HMAC secret or credentialed RPC URL in a report.

## If your seat's keys may be exposed

Tell Ditto immediately through the onboarding channel. Suspending a seat takes one guardian
transaction, and suspension is how a leaked BLS key or HMAC secret stops counting toward quorum.
Generate new key material on the host; never send a private key to anyone, including Ditto.

## Scope

This software, its configuration generator and its documentation, and the deployments listed in
`ops/deployments/`. The contracts themselves live in Ditto's canonical repository; report contract
issues through the same private channel.
