# Security Notes

A running log of security-relevant design decisions, known assumptions, and static-
analysis findings. This file feeds the final audit report assembled at M8. Each
finding is tracked with severity, status, and mitigation.

## Threat model (summary)

AgentPay is a control plane that constrains what an autonomous AI agent can spend.
The adversaries we defend against:

1. **A compromised or misbehaving agent / its LLM** proposing an over-budget,
   disallowed, or malicious spend. Defense: **on-chain policy is authoritative** —
   the LLM proposes, the contract disposes. Every limit is re-checked on-chain at
   `spend()` time; a bad off-chain decision reverts.
2. **A malicious service provider** that stakes too little, reverts on payment
   receipt to grief agents, or serves nothing. Defense: minimum-stake gate,
   pull-payment settlement (M3), governance slashing (M4).
3. **Oracle failure** (stale or manipulated price). Defense: `PriceFeedAdapter`
   enforces staleness, positive-answer, and complete-round checks; reverts rather
   than acting on a suspect price.
4. **Governance capture / emergency.** Defense: token-weighted DAO with timelock
   (M4) and a global pause switch readable by every consumer.

## Design decisions with security rationale

| Decision | Rationale |
|---|---|
| Immutable deploys (no proxies) | Removes upgrade/admin-key attack surface; upgradeability noted as future work. |
| Custom errors on every revert path | Cheaper, and the typed reasons are surfaced live in the demo. |
| `IPolicyParameters` read at tx time, never cached | A governance change takes effect everywhere with no redeploy; no stale-parameter windows. |
| Checks-effects-interactions + pull payments (M3+) | Reentrancy resistance; a reverting provider cannot block an agent's spend. |
| Live oracle gates conversions | USD caps convert to token terms via a freshness-checked feed, so the oracle materially affects whether a spend passes. |

## Static-analysis findings log (Slither)

Slither runs in CI (allow-fail until the M8 audit milestone, then required-pass).
Findings are triaged here.

| ID | Tool | Severity | Contract | Finding | Status | Mitigation / rationale |
|----|------|----------|----------|---------|--------|------------------------|
| — | — | — | — | _No findings triaged yet (first Slither pass pending in CI)._ | — | — |

## Governance & access-control notes (M4)

- **Live parameter store.** `PolicyGovernor` implements `IPolicyParameters`; every
  setter is `onlyGovernance`, so parameters change only via a passed proposal
  executed by the timelock. Consumers read values live at tx time — no stale-cache
  window, no redeploy. Verified by the signature governance integration test.
- **Slashing is DAO-only.** `ProviderStaking` ownership is transferred to the
  timelock, so `slash` is reachable only through governance execution.
- **`globalPause` goes through governance/timelock.** This matches the graded demo
  but means the emergency stop inherits the timelock delay. FUTURE WORK: add a
  fast-path guardian role that can pause instantly (unpause still via governance).
  For the testnet demo the timelock delay is configured short.
- **`SettlementEscrow` owner is currently unused** (no `onlyOwner` function yet).
  It is reserved for a future admin/rescue path; flagged so Slither's
  "owner-never-used" note is expected and triaged, not a surprise.

## Known assumptions / accepted limitations (testnet demo)

- **`AgentPayToken.faucet()`** breaks the fixed-supply invariant and is a deliberate
  testnet-only affordance. It MUST be removed for any non-testnet deployment.
- **Synthetic APT price.** APT has no real market; its USD price is derived from a
  fixed APT↔ETH demo peg times the live ETH/USD feed. A production system would need
  a real APT market or settlement in a priced stable token.
- **Valueless tokens, testnets only.** No real funds are ever at risk.
