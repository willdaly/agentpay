# AgentPay — Policy-Governed AI Agent Payments

[![CI](https://github.com/willdaly/agentpay/actions/workflows/ci.yml/badge.svg)](https://github.com/willdaly/agentpay/actions/workflows/ci.yml)

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

**198 tests · 100% line / 95.5% branch coverage** on 19 product contracts ·
**Slither clean** · all 12 contracts under the 24KB limit.

```bash
npm run audit   # lint -> tests -> coverage >=90% -> 24KB sizes -> Slither
```

- Unit tests mirror `contracts/` 1:1; every custom-error revert path is covered
  explicitly (the revert paths are the product).
- The 90% lines/branches gate is CI-enforced by `scripts/check-coverage.js`; mocks are
  excluded via `.solcover.js`.
- `npm run gas` produces a gas report; `npm run slither` runs static analysis;
  `npm run sizes` enforces the 24KB EVM limit. `npm run audit` runs every gate.
- Slither is **required-pass** in CI. Findings are fixed, or excluded with a
  written rationale in `slither.config.json` — never silently suppressed.

## Deployed addresses

**Deployed live on 2026-08-12:** the full home stack on Ethereum Sepolia and the
settlement stack on Base Sepolia, every contract source-verified on Etherscan /
Basescan. A real single-chain spend and a real **Sepolia → Base Sepolia
cross-chain spend over CCIP** both landed end-to-end — home policy check → CCIP
message → remote credit → provider withdrawal.

See [docs/addresses.md](docs/addresses.md) for the deploy + cross-chain lane
runbooks, verified external addresses (feeds, CCIP routers, chain selectors), the
per-contract address tables, and the live demo-transaction hashes.

## Mapping to the six graded components

| Course requirement | Where it lives |
|---|---|
| Multi-chain marketplace + cross-chain workflow | `ServiceRegistry` on both chains; `CrossChainSpendRouter` CCIP payment Sepolia → Base Sepolia |
| Tokenomics + staking + governance | `AgentPayToken`, `ProviderStaking` (+ slashing), `PolicyGovernor` full proposal lifecycle |
| Oracle integration affecting on-chain behavior | `PriceFeedAdapter`: USD caps enforced at spend time via the live ETH/USD feed |
| Privacy features for enterprise compliance | `ScoreRegistry` commit-reveal (scores hidden during commit; selective disclosure via salt); audit trail of events + policy-snapshot hashes; owner/agent role-split wallets |
| Security audit preparation | Slither **required-pass** in CI; [`docs/SECURITY_NOTES.md`](docs/SECURITY_NOTES.md) findings log (31 triaged: 2 fixed, 29 documented) |
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
