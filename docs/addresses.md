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
| ETH/USD Data Feed | `0x694AA1769357215DE4FAC081bf1f309aDC325306` ✓ (8 dp, 3600s) | _re-verify at M6_ |
| CCIP Router | _verify at M6_ | _verify at M6_ |
| LINK token | _verify at M6_ | _verify at M6_ |
| Chain selector | `16015286601757825753` | `10344971235874465080` |

> Sepolia ETH/USD verified from Chainlink's reference data directory
> (`feeds-ethereum-testnet-sepolia.json`). CCIP router/LINK/selector values are
> re-verified against the current Chainlink CCIP directory before the M6 deploy.
