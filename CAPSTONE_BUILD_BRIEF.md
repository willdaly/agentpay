# Build Brief: Policy-Governed AI Agent Payments Platform

**Project codename:** AgentPay (rename freely)
**Course context:** AAI6850 Capstone (15.1, "Enterprise-Ready Blockchain-AI Platform"), Northeastern University
**Student:** Will Daly
**Hard deadline:** Sunday, August 16, 2026, 11:59 p.m. EST. One submission attempt. Plan to be code-complete at least 5 days early so documentation, audit report, and demo recording are not rushed.

This brief is the opening prompt for Claude Code. It records decisions already made in a planning session; do not relitigate them. Where this brief says "verify from docs," fetch current values rather than trusting training data.

---

## 1. What we are building and why

A platform that lets autonomous AI agents spend cryptocurrency on services (model inference, data feeds, other agents' outputs) under enforceable on-chain policy: per-transaction caps, daily budgets, counterparty allowlists, oracle-priced limits, audit logging, and an emergency stop. Service providers stake collateral and can be slashed for bad service. A token-weighted DAO governs global risk parameters. Payments work across two testnets via cross-chain messaging.

The pitch in one line: enterprises will not let AI agents hold wallets without a control plane; this is the control plane.

This is a graded academic capstone, not a commercial launch. Everything runs on testnets with valueless tokens. Optimize for: production-quality engineering, test coverage, security posture, and a compelling live demo.

## 2. Non-negotiable constraints

1. **Testnets only.** Sepolia and Base Sepolia. Never target mainnet. Never handle real funds.
2. **Secrets hygiene.** Private keys and RPC URLs live in `.env`, which is gitignored from the first commit. Include `.env.example` with placeholder values. Never print private keys in logs or commit them in any form. Deployment uses a dedicated throwaway key funded only with testnet ETH/LINK.
3. **Course deliverables drive scope.** The graded package requires: production-ready code with 90%+ test coverage, a security audit report from automated tools (findings + fixes), technical documentation, a business case, a live demo on multiple testnets, and a portfolio-ready GitHub repository. Anything that does not serve one of those is out of scope.
4. **Academic integrity.** All AI-assisted code generation must be disclosable. Maintain a `docs/AI_DISCLOSURE.md` from day one logging, at milestone granularity, what was AI-generated vs. hand-modified. Original work or proper attribution for everything; note OpenZeppelin and Chainlink dependencies with versions and licenses in the README.
5. **Course toolchain defaults:** Solidity 0.8.24, OpenZeppelin Contracts 5.x, Slither for static analysis.
6. **Some patterns are inherited deliberately.** Sections below mark lineage from the student's Module 7 midterm (an AI model marketplace). Preserve those patterns; they are part of the narrative ("productized the reusable core of the midterm").

## 3. Locked architecture decisions

| Decision | Choice | Notes |
|---|---|---|
| Chains | Ethereum Sepolia (home chain) + Base Sepolia (remote chain) | Agent wallets and governance live on Sepolia; at least one provider registered on Base Sepolia to force a real cross-chain payment. |
| Cross-chain messaging | Chainlink CCIP | Verify the current Sepolia <-> Base Sepolia lane, router addresses, and LINK fee token addresses from official Chainlink docs at build time. Do not hardcode from memory. |
| Oracle | Chainlink Data Feed (ETH/USD) on each chain | Policy caps are USD-denominated; the feed converts caps to wei at spend time, so oracle data directly gates on-chain behavior (a graded requirement). Include staleness and answer-sanity checks. A Chainlink Functions-based provider risk score is a stretch goal, not core. |
| Token model | Single ERC-20, `APT` (AgentPay Token), testnet only | Triple duty: governance voting weight (ERC20Votes), provider staking collateral, and the unit agents spend for services. Native ETH is used only for gas and CCIP fees (or LINK for CCIP fees; pick whichever the current CCIP docs make simpler and document the choice). |
| Framework | Hardhat + TypeScript | With `solidity-coverage` for the 90% gate, `hardhat-gas-reporter`, and TypeChain. Foundry is acceptable if coverage tooling proves materially better, but decide in the first hour and do not switch mid-project. |
| Agent client | Node.js + TypeScript CLI in `agent/` | Calls an LLM API to make a spend decision, then submits through the on-chain spend controller. See section 6. |

## 4. Contract suite

Modular, single-responsibility contracts, each well under the 24 KB EVM limit (a discipline carried over from the midterm). Core set first; stretch items only if the timeline holds.

### Core contracts

**`AgentPayToken.sol`** (new)
ERC-20 + ERC20Votes + ERC20Permit. Fixed supply minted to deployer for demo distribution. No mint-after-deploy except a faucet function gated to testnet demo use (document it as demo-only in NatSpec).

**`PolicyGovernor.sol`** (lineage: midterm `MarketplaceGovernor`)
Token-weighted DAO (proposal, vote, timelocked execute; OpenZeppelin Governor stack is fine) that is *also* the live parameter store. Implements `IPolicyParameters` exposing global risk parameters: `maxPerTxUsd`, `defaultDailyBudgetUsd`, `slashBps`, `disputeWindow`, `treasury`, `providerMinStake`, `globalPause`. **Critical inherited pattern:** consumers hold an `IPolicyParameters` reference and read values at transaction time. A passed proposal changes behavior with no redeploy and no migration. This governance boundary is the architectural centerpiece; call it out in NatSpec.

**`AgentWallet.sol`** (new; the product)
A per-agent smart account, deployed via an `AgentWalletFactory`. Holds APT and enforces, at `spend()` time, in checks-effects-interactions order:
- global pause (from `IPolicyParameters`) and local owner pause
- counterparty allowlist (service IDs or provider addresses, owner-managed)
- per-transaction USD cap: min(owner-set local cap, global `maxPerTxUsd`), converted to token terms via the price adapter
- rolling daily budget (track a day-bucketed spent counter)
- target service must be registered and its provider staked above `providerMinStake`

Every spend emits a rich `SpendExecuted` event (agent, service ID, provider, amount, USD value at feed price, chain selector, policy snapshot hash) so the audit trail is reconstructable purely from logs. Rejections revert with typed custom errors (`ExceedsPerTxCap`, `ExceedsDailyBudget`, `CounterpartyNotAllowed`, `Paused`, `ProviderUnderstaked`) because the live demo shows these firing.

**`ServiceRegistry.sol`** (lineage: midterm `AIModelNFT` metadata pattern, minus the NFT)
Providers register services: on-chain struct with provider address, price in USD cents, terms-of-service hash, IPFS CID for full terms/endpoint spec, active flag, home chain selector. Role-gated registration is unnecessary; permissionless registration is fine because the staking requirement is the quality gate. Include an integrity-hash field so a consumer can verify the off-chain terms document matches what was registered (same on-chain-hash / off-chain-artifact pattern as the midterm's model NFTs).

**`ProviderStaking.sol`** (new)
Providers stake APT per service (or per provider; per provider is simpler, choose it). Unstake has a cooldown equal to `disputeWindow`. Slashing callable only by `PolicyGovernor` execution (a passed proposal) in the core version; slashed funds go to `treasury`. Keep dispute mechanics minimal: governance-voted slashing is enough for the capstone, and an automated dispute oracle is explicitly out of scope.

**`SettlementEscrow.sol`** (lineage: midterm `ModelMarketplace` pull-payment flow)
Spends credit provider balances; providers call `withdraw()`. Pull-over-push, exactly as in the midterm: a provider that reverts on receipt must never block an agent's spend. If the dispute window is enabled for a payment, funds unlock to the provider after the window with no dispute filed. (If timeline pressure hits, immediate settlement with pull-withdrawal alone is acceptable; document the simplification.)

**`PriceFeedAdapter.sol`** (new, small)
Wraps the Chainlink ETH/USD (and, if pricing APT synthetically, a documented fixed APT/USD demo rate; be explicit that a real deployment would need a real APT market or a stable payment token). Enforces max staleness and positive-answer checks; reverts with `StalePrice` otherwise. Deployed per chain.

**`CrossChainSpendRouter.sol`** (new)
CCIP sender on Sepolia, receiver on Base Sepolia. Flow: `AgentWallet.spend()` targeting a remote-chain service escrows tokens locally and sends a CCIP message; the receiver on Base Sepolia credits the provider in the remote `SettlementEscrow`. Use CCIP's token-transfer-plus-data message type if the current docs support it cleanly for this lane; otherwise burn/lock-and-credit with data-only messaging and document the trust assumptions honestly. Include `allowlistedSourceChains` / `allowlistedSenders` checks on the receiver (standard CCIP hygiene). Policy checks always run on the home chain before anything is sent.

**`ScoreRegistry.sol`** (lineage: midterm `EvaluationRegistry`, repurposed)
Commit-reveal quality scoring of providers: raters commit `keccak256(score, salt)` during a window, reveal after. Aggregated score is readable on-chain. Core version: score is informational and surfaces in the demo dashboard/CLI. Stretch: `AgentWallet` enforces a minimum score. This contract is also the privacy-requirement anchor (see section 8).

### Explicitly out of scope
ERC-4337 account abstraction, real token economics or liquidity, automated dispute resolution, mainnet anything, upgradeable proxies (deploy immutable; note upgradeability as future work in docs), a web frontend (CLI + block-explorer links are the demo surface; a minimal static dashboard is stretch-only).

## 5. Repository structure

```
agentpay/
  contracts/            # Solidity per section 4, one file per contract + interfaces/
  test/                 # Hardhat tests, mirrors contracts/ 1:1, plus integration/
  scripts/
    deploy/             # idempotent per-chain deploy scripts, writes deployments.json
    demo/               # scripted demo actions (register, stake, fund agent, spend)
  agent/                # the off-chain AI agent CLI (own package.json ok)
  docs/
    AI_DISCLOSURE.md
    SECURITY_NOTES.md   # running log feeding the audit report
    addresses.md        # generated: deployed addresses + tx hashes per chain
  .github/workflows/ci.yml
  .env.example
  README.md
  hardhat.config.ts
```

README must be portfolio-grade: what it is (three sentences), architecture diagram placeholder (final diagram produced separately), quickstart, test/coverage instructions, deployed testnet addresses table with block-explorer links, demo walkthrough with screenshots, license, and the dependency-attribution section.

## 6. The agent client (`agent/`)

A TypeScript CLI that makes the demo real rather than simulated:

1. `agent quote <need>`: sends a natural-language need ("summarize this text under $0.05") plus the on-chain service catalog (read from `ServiceRegistry` on both chains) to an LLM (Anthropic API; key from `.env`), which returns a JSON decision: chosen service ID, max acceptable price, rationale.
2. `agent spend <serviceId>`: submits the spend through `AgentWallet`, prints the tx hash, decodes success events or the typed revert reason.
3. `agent audit`: reconstructs the full spend history from `SpendExecuted` events and prints a table (this is the "monitoring/logging" evidence).
4. If the purchased service is inference, actually call the provider's endpoint after payment confirmation. For the demo, the "provider" can be a tiny local HTTP server in `agent/provider-sim/` that verifies on-chain payment (reads the escrow event) before serving the response. This closes the loop: real decision, real payment, real service delivery.

Parse LLM output defensively (strip code fences, validate JSON schema, clamp price fields); the LLM proposes, the contract disposes. A malformed or over-budget LLM decision must be caught by on-chain policy, and that is a feature to demonstrate, not a bug to hide.

## 7. Testing plan (the 90% gate)

- Unit tests per contract mirroring `contracts/` structure. Cover every custom error path explicitly; the revert paths are the product.
- `AgentWallet` gets the densest suite: cap boundaries (exactly at cap, one wei over), day-bucket rollover for the daily budget, allowlist add/remove, pause layering (global vs. local), price-feed staleness reverts, understaked-provider rejection.
- Governance lifecycle test: propose parameter change, vote, execute after timelock, assert `AgentWallet` behavior changes with no redeploy (the signature midterm-inherited property; make this test prominent).
- Staking: cooldown enforcement, slashing only via governor, slashed funds to treasury.
- Commit-reveal: cannot reveal early, wrong salt fails, double-commit rules.
- Pull payments: reentrancy attempt via a malicious receiver mock; provider that reverts on receipt cannot block spends.
- CCIP: use Chainlink Local (their local simulator) if it works smoothly for this lane; otherwise a `MockRouter` capturing messages and replaying them to the receiver. Test source/sender allowlist rejections.
- Fuzz where cheap (budget accounting invariants: total spent never exceeds budget, escrow balance conservation).
- CI-enforced coverage threshold: fail the build under 90% lines/branches on `contracts/` (exclude mocks). Also run `slither .` in CI (allow-fail initially, required-pass by the audit milestone) and `solhint`.

## 8. Mapping to the six graded components (keep this table updated in README)

| Course requirement | Where it lives |
|---|---|
| Multi-chain marketplace + cross-chain workflow | `ServiceRegistry` on both chains; `CrossChainSpendRouter` CCIP payment Sepolia -> Base Sepolia |
| Tokenomics + staking + governance | `AgentPayToken`, `ProviderStaking` (+slashing), `PolicyGovernor` full proposal lifecycle |
| Oracle integration affecting on-chain behavior | `PriceFeedAdapter`: USD caps enforced at spend time via live feed |
| Privacy features for enterprise compliance | `ScoreRegistry` commit-reveal; audit-trail design (events + policy snapshot hashes) enabling selective disclosure to an auditor; access-controlled agent wallets |
| Security audit preparation | Slither in CI, `docs/SECURITY_NOTES.md` findings log, mitigations documented per finding, final audit report assembled from it |
| DevOps pipeline + monitoring | GitHub Actions (build, lint, test, coverage gate, Slither); `agent audit` event-log monitoring; gas reporter output |

## 9. Milestone order (each ends green: tests pass, coverage holds, committed)

1. **M1, foundation:** repo scaffold, CI skeleton, `AgentPayToken`, `PriceFeedAdapter` (with mock feed), `ServiceRegistry`. Local tests only.
2. **M2, the product:** `AgentWallet` + factory with full policy enforcement against mock feed and registry. Densest test milestone.
3. **M3, economics:** `ProviderStaking`, `SettlementEscrow`, wire understaked-rejection into `AgentWallet`.
4. **M4, governance:** `PolicyGovernor` + timelock, the live-parameter-read integration test, transfer parameter control to the DAO.
5. **M5, single-chain deploy:** deploy scripts, deploy everything to Sepolia with real ETH/USD feed, run a real spend end-to-end, record addresses/hashes into `docs/addresses.md`.
6. **M6, cross-chain:** `CrossChainSpendRouter`, deploy receiver side to Base Sepolia, execute a real CCIP payment across the lane. This is the highest-risk milestone; start it no later than the project's midpoint, and if CCIP fights back for more than two working days, fall back to a documented lock-and-credit bridge with data-only messaging.
7. **M7, agent + demo:** `agent/` CLI, provider-sim, scripted demo flow (section 10), `ScoreRegistry`.
8. **M8, hardening:** Slither clean-or-documented, coverage to 90%+, gas notes, README polish, freeze code. Everything after M8 is documentation and demo recording (handled outside Claude Code).

## 10. Demo script the build must support (record end-to-end on testnets)

1. Provider registers an inference service on Base Sepolia and stakes APT.
2. Agent wallet on Sepolia funded with APT; owner sets allowlist and a $5/day budget.
3. `agent quote` -> LLM picks the service; `agent spend` -> CCIP payment lands, provider-sim verifies payment and serves the inference. Show both explorers.
4. Second spend exceeds the daily budget -> on-chain revert `ExceedsDailyBudget`, shown live.
5. Governance proposal raises `maxPerTxUsd`; after execution the same spend that failed a cap check now succeeds, no redeploy.
6. Global pause via governance -> all agent spends halt; unpause.
7. `agent audit` prints the reconstructed spend log.

## 11. What Claude Code should hand back for the documentation phase

At M8, produce a `HANDOFF.md` containing: final contract inventory with sizes and addresses on both chains (plus explorer links and deploy tx hashes), coverage summary, Slither findings table (finding, severity, status, mitigation), gas report highlights, CI badge/links, demo tx hashes for every step in section 10, and any deviations from this brief with one-line rationales. The technical documentation PDF, business case, and audit report narrative are written from that file in a separate environment; make it complete enough that no re-derivation is needed.
