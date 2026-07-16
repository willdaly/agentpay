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
- **`SettlementEscrow` owner** exists solely to call `setAuthorizer` once at deploy
  time (a one-time initializer, not a live admin lever). Resolved at M6: the owner
  was previously unused and flagged for Slither triage; it now has exactly one
  narrow job and no standing power over funds.

## Cross-chain notes (M6) — read this section before auditing the bridge

### The lane

Chainlink CCIP, **Sepolia → Base Sepolia**, verified as a live lane in the CCIP
directory at build time. Routers, LINK, and chain selectors are recorded in
`docs/addresses.md` and `config/networks.ts` (verified from docs, not memory).

### Decision: data-only messaging + lock-and-credit (NOT CCIP token transfer)

APT is **not** a CCIP-registered cross-chain token. Having CCIP itself move APT
would require registering it in the Token Admin Registry and deploying burn/mint
token pools on both chains (the CCT standard) — out of scope for this capstone.
So CCIP is used for **messaging only**, and value is settled by lock-and-credit.
This is the fallback the build brief explicitly sanctions, and its costs are:

| Assumption | Consequence | Mitigation / status |
|---|---|---|
| Source APT is **locked forever** in the sender router (never burned) | Locked balance grows monotonically; it is not redeemable | Accepted. `rescueLockedTokens` lets the owner recover it. |
| Destination credits come from a **pre-funded APT liquidity pool** on the remote router | Remote APT is a *separate token deployment*, not a canonical bridged asset — total supply is **not** conserved cryptographically across chains | Accepted and documented. A production build registers APT as a CCT so CCIP's token pools enforce conservation. |
| Remote liquidity can run dry | `ccipReceive` reverts with `InsufficientLiquidity`; CCIP will not deliver | Tested. `wire-lane.ts` seeds liquidity; monitoring would alert in production. |
| Router owner is trusted not to drain liquidity | Trusted bridge, not trust-minimized | Accepted for testnet. Ownership is intended to sit with the timelock. |

**This is a trusted bridge.** It is presented as such; no claim of trustlessness.

### What protects the cross-chain path

- **All policy runs on the home chain, before any message is sent.** Pause,
  allowlist, provider stake, per-tx cap, daily budget, and the live oracle price
  are all enforced in `AgentWallet._authorizeSpend` prior to `routeSpend`. The
  remote leg settles value only; it can never widen spending authority. The
  cross-chain integration suite asserts this directly: for each rejection path it
  checks `ccipHome.sentCount() == 0`.
- **Receiver hygiene (standard CCIP).** `ccipReceive` accepts calls only from the
  local CCIP router, only from allowlisted source chains, and only from
  allowlisted senders on those chains. All three rejections are tested.
- **Sender authorization.** `routeSpend` is callable only by an address the
  `IWalletAuthorizer` (the factory) vouches for. Without this, anyone could trigger
  a remote credit without paying — the router's most valuable attack surface.
- **CCIP fees in native ETH** (`feeToken = address(0)`), chosen over LINK to remove
  a funding-and-approval step. The router holds an ETH budget; `routeSpend` reverts
  with `InsufficientNativeForFee` rather than failing opaquely.

### Remote-chain parameter drift (accepted)

Governance lives only on the home chain. The remote escrow still needs to read
`disputeWindow`, so the remote chain runs `RemotePolicyParameters`, an
owner-administered mirror. The two chains **can drift**. This is safe today because
only `disputeWindow` is consumed remotely and every spend-gating parameter is
enforced on the home chain. Future work: push parameter updates over CCIP so the
DAO is the single source of truth on every chain.

## Known assumptions / accepted limitations (testnet demo)

- **`AgentPayToken.faucet()`** breaks the fixed-supply invariant and is a deliberate
  testnet-only affordance. It MUST be removed for any non-testnet deployment.
- **Synthetic APT price.** APT has no real market; its USD price is derived from a
  fixed APT↔ETH demo peg times the live ETH/USD feed. A production system would need
  a real APT market or settlement in a priced stable token.
- **Valueless tokens, testnets only.** No real funds are ever at risk.
