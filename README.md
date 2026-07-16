# AgentPay — Policy-Governed AI Agent Payments

AgentPay is an on-chain **control plane** that lets autonomous AI agents spend
cryptocurrency on services under enforceable, governable policy: per-transaction USD
caps, rolling daily budgets, counterparty allowlists, oracle-priced limits, staked
providers, a full audit trail, and an emergency stop. A token-weighted DAO governs
the global risk parameters, and payments work across two testnets via Chainlink CCIP.
The thesis in one line: **enterprises will not let AI agents hold wallets without a
control plane — this is that control plane.**

> Academic capstone (Northeastern AAI6850). **Testnets only, valueless tokens, never
> mainnet, never real funds.** Optimized for engineering quality, test coverage,
> security posture, and a live multi-chain demo.

## Status

Milestones **M1–M7** complete:
- **M1 Foundation:** repo + CI scaffold, `AgentPayToken`, `PriceFeedAdapter`
  (live-oracle USD↔APT with staleness/sanity guards), `ServiceRegistry`.
- **M2 The product:** `AgentWallet` + `AgentWalletFactory` enforcing the full spend
  policy at `spend()` time (pause layering, allowlist, per-tx cap, daily budget,
  provider-staking gate, oracle gating) with an owner/agent role split.
- **M3 Economics:** `ProviderStaking` (cooldown unstake, governance slashing to
  treasury) and `SettlementEscrow` (pull-over-push, optional dispute-window release,
  reentrancy-safe).
- **M4 Governance:** `PolicyGovernor` — an OpenZeppelin Governor + Timelock that is
  *also* the live `IPolicyParameters` store. A passed proposal changes system-wide
  behavior with **no redeploy** (asserted by the signature governance test).
- **M5 Single-chain deploy:** idempotent, network-aware deploy scripts
  (`scripts/deploy/`) that write `deployments/<network>.json`, wire the timelock
  roles, and hand staking ownership to the DAO; plus an end-to-end demo
  (`scripts/demo/spend.ts`). Validated green against a local Hardhat node.
- **M6 Cross-chain:** `CrossChainSpendRouter` — CCIP sender + receiver over the
  verified **Sepolia → Base Sepolia** lane, with source-chain/sender allowlists and
  native-ETH fees. Every policy check runs on the home chain *before* a message is
  sent (the cross-chain suite asserts zero messages on every rejection path).
  Value settles via **data-only messaging + lock-and-credit** — a deliberately
  trusted bridge whose assumptions are documented in full in
  [docs/SECURITY_NOTES.md](docs/SECURITY_NOTES.md#cross-chain-notes-m6--read-this-section-before-auditing-the-bridge).
- **M7 Agent + demo:** the [`agent/`](agent/) CLI (`quote` / `spend` / `audit`) —
  Claude picks a service from the live multi-chain catalog, on-chain policy rules
  on it, and the history is rebuilt from events with no indexer. Plus
  `provider-sim` (verifies payment on-chain, one-payment-one-delivery),
  `ScoreRegistry` (commit-reveal scoring), and a scripted
  [full demo](scripts/demo/full-demo.ts) covering all seven steps of the brief.

**198 tests, 100% line / ~95.5% branch coverage** on 19 product contracts. See the
[milestone plan](CAPSTONE_BUILD_BRIEF.md#9-milestone-order-each-ends-green-tests-pass-coverage-holds-committed).

## Architecture

```text
  AI Agent CLI (agent/)                     Ethereum Sepolia (home)          Base Sepolia (remote)
  ├─ agent quote  → LLM picks a service     ┌──────────────────────────┐     ┌────────────────────┐
  ├─ agent spend  → submits on-chain  ───▶  │ AgentWallet (per agent)  │     │ ServiceRegistry    │
  └─ agent audit  ← reconstructs from logs  │   enforces policy at      │     │ SettlementEscrow   │
                                            │   spend() time:           │     │ CrossChainRouter   │
                                            │   caps · budget · allow   │ CCIP│   (receiver)       │
                                            │   pause · staked provider │────▶│                    │
                                            ├──────────────────────────┤     └────────────────────┘
   IPolicyParameters (read at tx time) ◀──  │ PolicyGovernor (DAO +     │
   maxPerTxUsd · dailyBudget · slashBps ·   │   live parameter store)   │
   treasury · minStake · globalPause        ├──────────────────────────┤
                                            │ PriceFeedAdapter (oracle) │
   ETH/USD Chainlink feed ──────────────▶   │ ServiceRegistry ·         │
                                            │ ProviderStaking · Escrow  │
                                            └──────────────────────────┘
```

_(Polished diagram produced separately for the documentation deliverable.)_

The architectural centerpiece is the **governance boundary**: policy consumers hold an
`IPolicyParameters` reference and read risk parameters *at transaction time*. A passed
DAO proposal changes system-wide behavior with **no redeploy and no migration**.

## Quickstart

```bash
git clone <repo> && cd agentpay
npm install
cp .env.example .env      # fill in only for live testnet deploys; not needed for local dev

npm run compile           # solc 0.8.24 + TypeChain
npm test                  # Hardhat test suite
npm run coverage:check    # coverage + enforce the 90% gate on product contracts
npm run lint              # solhint
```

`.env` is gitignored from the first commit. Deployment uses a **dedicated throwaway
key** funded only with testnet ETH/LINK; private keys are never logged or committed.

## Testing & coverage

- Unit tests mirror `contracts/` 1:1; every custom-error revert path is covered
  explicitly (the revert paths are the product).
- The 90% lines/branches gate is CI-enforced by `scripts/check-coverage.js`; mocks are
  excluded via `.solcover.js`.
- `npm run gas` produces a gas report; `npm run slither` runs static analysis.

## Deployed addresses

See [docs/addresses.md](docs/addresses.md) for the deploy + cross-chain lane
runbooks, verified external addresses (feeds, CCIP routers, chain selectors), and
the address tables populated from the live testnet deploy.

## Mapping to the six graded components

| Course requirement | Where it lives |
|---|---|
| Multi-chain marketplace + cross-chain workflow | `ServiceRegistry` on both chains; `CrossChainSpendRouter` CCIP payment Sepolia → Base Sepolia |
| Tokenomics + staking + governance | `AgentPayToken`, `ProviderStaking` (+ slashing), `PolicyGovernor` full proposal lifecycle |
| Oracle integration affecting on-chain behavior | `PriceFeedAdapter`: USD caps enforced at spend time via the live ETH/USD feed |
| Privacy features for enterprise compliance | `ScoreRegistry` commit-reveal (scores hidden during commit; selective disclosure via salt); audit trail of events + policy-snapshot hashes; owner/agent role-split wallets |
| Security audit preparation | Slither in CI, `docs/SECURITY_NOTES.md` findings log, per-finding mitigations, final audit report |
| DevOps pipeline + monitoring | GitHub Actions (build, lint, test, coverage gate, Slither); `agent audit` rebuilds spend history from logs alone; gas reporter |

## Dependencies & attribution

| Dependency | Version | License | Use |
|---|---|---|---|
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | 5.x | MIT | ERC-20 / Votes / Permit, Governor stack, access control |
| [Chainlink Contracts](https://github.com/smartcontractkit/chainlink) | 1.5.x | MIT | `AggregatorV3Interface` price feeds, mock aggregator |
| [Chainlink CCIP Contracts](https://github.com/smartcontractkit/chainlink-ccip) | 2.0.x | MIT | `Client` message structs, `IRouterClient`, `IAny2EVMMessageReceiver` |
| [Hardhat](https://hardhat.org) + toolbox | 2.x | MIT | Build, test, coverage, TypeChain, gas reporter |

AI assistance is disclosed in [docs/AI_DISCLOSURE.md](docs/AI_DISCLOSURE.md).

## License

MIT — see [LICENSE](LICENSE). Testnet demo software; not audited for production use.
