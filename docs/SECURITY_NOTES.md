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

**Tool:** Slither 0.11.5 · **Scope:** `contracts/` excluding `mocks/` (test
scaffolding) and `node_modules` (OpenZeppelin / Chainlink, audited upstream) ·
**Status: REQUIRED-PASS in CI as of M8.**

First full pass produced **31 findings: 0 High, 6 Medium, 13 Low, 12
Informational.** Two were real and were **fixed**; the other 29 are false
positives or accepted design decisions, each excluded with a written rationale in
`slither.config.json`. `slither . --config-file slither.config.json` now exits 0,
so any NEW finding fails the build rather than being silently absorbed.

### Fixed

| ID | Severity | Contract | Finding | Mitigation |
|----|----------|----------|---------|------------|
| S-01 | Informational (but real) | `CrossChainSpendRouter` | `missing-inheritance`: the router never formally implemented `ICrossChainSpendRouter`, the interface `AgentWallet` depends on. Signatures matched by coincidence, so **the compiler could not catch drift** — exactly what the interface exists to prevent. | **Fixed:** router now declares `is ICrossChainSpendRouter` with `override`. Verified by deliberately drifting the interface and confirming the build fails (`should be marked as abstract`). |
| S-02 | Low | `CrossChainSpendRouter.ccipReceive` | `reentrancy-events`: `CrossChainSpendReceived` was emitted *after* the `token.safeTransfer` + `escrow.credit` external calls. | **Fixed:** emit moved before the external calls (strict checks-effects-interactions). A revert rolls the log back, so ordering it first is equally truthful. |

### Accepted / false positive (excluded with rationale)

| ID | Severity | Count | Detector | Verdict |
|----|----------|-------|----------|---------|
| S-03 | Medium | 4 | `incorrect-equality` | **False positive.** 3 are day-bucket comparisons (`today == currentDay`) — equality on an integer *day index* is the intended semantic, and there is no balance to manipulate. 1 is `SettlementEscrow.getPayment`'s `amount == 0` existence sentinel, safe because `credit()` rejects zero amounts (`ZeroAmount`), so 0 unambiguously means "no such payment". |
| S-04 | Medium | 2 | `unused-return` | **False positive / accepted.** `PriceFeedAdapter.latestUsdPrice` *does* consume `roundId`/`answer`/`updatedAt`/`answeredInRound` — only `startedAt` is skipped in the destructure, which trips the detector. `AgentWallet.spend` discards `routeSpend`'s CCIP `messageId`; the router emits `CrossChainSpendSent(messageId, …)` in the same transaction, so the cross-chain audit handle is already on-chain and correlates by tx hash. |
| S-05 | Low | 10 | `timestamp` | **Accepted.** Every time window here is hours-to-days: the daily budget bucket (86400s), unstake cooldown / dispute window, commit-reveal windows, oracle staleness. A miner can nudge `block.timestamp` by seconds; worst case an agent's daily budget resets a few seconds early. Bounded and inherent to the brief's day-bucketed design. |
| S-06 | Low | 2 | `missing-zero-check` | **Accepted — intentional.** `agent = address(0)` is the documented way to *clear* the operator. Safe because `msg.sender` can never be `address(0)`, so a zero agent means "only the owner may spend". |
| S-07 | Informational | 1 | `low-level-calls` | **Accepted.** `to.call{value: …}("")` is the *recommended* way to send native ETH (`transfer`/`send` forward a fixed 2300 gas and break on contract recipients). Return value is checked; function is `onlyOwner`. |
| S-08 | Informational | 8 | `naming-convention` | **Accepted.** Leading-underscore constructor/setter params that shadow state vars — standard Solidity convention, used consistently, matches OpenZeppelin's own style. |
| S-09 | Informational | 2 | `unindexed-event-address` | **Accepted.** Low-frequency governance events read by scanning one contract's history, not by filtering on an address topic. An index would cost gas with no consumer. |
| S-10 | Informational | 1 | `solc-version` | **Accepted.** The compiler is pinned to 0.8.24 by the course toolchain (brief §2.5). Pinning is the deliberate reproducible-build choice. |

> Reproduce: `npm run slither` (or the full gate: `npm run audit`).

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
