# Deployed Addresses & Deployment Runbook

The machine-readable record lives in `deployments/<network>.json` (gitignored),
written by the deploy script. This file is the curated, committed record — fill
the tables from a real testnet deploy (M5 Sepolia, M6 Base Sepolia).

## Deployment runbook

```bash
# 0. One-time: fund a DEDICATED THROWAWAY key with Sepolia ETH (+ LINK for M6).
cp .env.example .env    # set SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, *SCAN_API_KEY

# 1. Deploy the full stack (idempotent — re-run to resume; writes deployments/sepolia.json)
npx hardhat run scripts/deploy/deploy.ts --network sepolia

# 2. Run a real end-to-end spend (register -> stake -> fund -> spend -> settle -> audit)
npx hardhat run scripts/demo/spend.ts --network sepolia

# Dry-run everything locally first (deploys a mock ETH/USD feed automatically):
npx hardhat node                                                  # terminal 1
npx hardhat run scripts/deploy/deploy.ts --network localhost      # terminal 2
npx hardhat run scripts/demo/spend.ts   --network localhost
```

The deploy script is **idempotent**: it reuses everything already in
`deployments/<network>.json` and deploys only what is missing, so a crash
mid-run is resumable. It also wires the timelock roles and hands `ProviderStaking`
ownership to the timelock (DAO-only slashing).

> **Validated locally (M5):** the full deploy + demo-spend flow runs green against
> a local Hardhat node — register → stake 100 APT → create wallet → fund → spend
> $0.50 (0.5 APT at the live-oracle price) → provider withdraws from escrow →
> `audit` reconstructs the spend from `SpendExecuted` logs. Live Sepolia figures
> below are filled from the funded-key deploy.

## Ethereum Sepolia (home chain, chainId 11155111)

| Contract | Address | Deploy tx | Explorer |
|----------|---------|-----------|----------|
| AgentPayToken | _pending_ | _pending_ | |
| PriceFeedAdapter | _pending_ | _pending_ | |
| ServiceRegistry | _pending_ | _pending_ | |
| TimelockController | _pending_ | _pending_ | |
| PolicyGovernor | _pending_ | _pending_ | |
| ProviderStaking | _pending_ | _pending_ | |
| SettlementEscrow | _pending_ | _pending_ | |
| AgentWalletFactory | _pending_ | _pending_ | |
| CrossChainSpendRouter (sender) | _M6_ | _M6_ | |

## Base Sepolia (remote chain, chainId 84532)

| Contract | Address | Deploy tx | Explorer |
|----------|---------|-----------|----------|
| PriceFeedAdapter | _M6_ | _M6_ | |
| ServiceRegistry | _M6_ | _M6_ | |
| SettlementEscrow | _M6_ | _M6_ | |
| CrossChainSpendRouter (receiver) | _M6_ | _M6_ | |

## External dependencies (verified from official docs)

| Item | Sepolia | Base Sepolia |
|------|---------|--------------|
| ETH/USD Data Feed | `0x694AA1769357215DE4FAC081bf1f309aDC325306` ✓ (8 dp, 3600s) | `0x4aDC67696bA383F43DD60A9e78F2C97FbbFc7cb1` (re-verify) |
| CCIP Router | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` ✓ | `0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93` ✓ |
| LINK token | `0x779877A7B0D9E8603169DdbD7836e478b4624789` ✓ | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` ✓ |
| Chain selector | `16015286601757825753` ✓ | `10344971235874465080` ✓ |

> Sepolia ETH/USD verified from Chainlink's reference data directory
> (`feeds-ethereum-testnet-sepolia.json`). CCIP router / LINK / chain-selector
> values verified from the Chainlink CCIP directory (testnet), which also confirms
> **Sepolia → Base Sepolia is a live lane**. LINK addresses are recorded for
> completeness only: this build pays CCIP fees in **native ETH** (see below).

## Cross-chain lane runbook (M6)

```bash
# 1. Deploy each side (idempotent; roles come from config/networks.ts)
npx hardhat run scripts/deploy/deploy.ts --network sepolia       # home:   full stack
npx hardhat run scripts/deploy/deploy.ts --network baseSepolia   # remote: settlement only

# 2. Open the lane — run once per side, AFTER both are deployed
npx hardhat run scripts/deploy/wire-lane.ts --network sepolia      # opens lane + funds ETH fees
npx hardhat run scripts/deploy/wire-lane.ts --network baseSepolia  # allowlists + seeds liquidity
```

The home side needs native ETH on the router for CCIP fees; the remote side needs
APT liquidity on its router to settle incoming spends. `wire-lane.ts` provisions
both and is idempotent.
