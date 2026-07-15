# Deployed Addresses

Generated/curated as deployments happen (M5 single-chain, M6 cross-chain). Until
then this is a placeholder. Each row links to the block explorer and records the
deploy transaction hash.

## Ethereum Sepolia (home chain, chainId 11155111)

| Contract | Address | Deploy tx | Explorer |
|----------|---------|-----------|----------|
| AgentPayToken | _pending_ | _pending_ | |
| PolicyGovernor | _pending_ | _pending_ | |
| PriceFeedAdapter | _pending_ | _pending_ | |
| ServiceRegistry | _pending_ | _pending_ | |
| ProviderStaking | _pending_ | _pending_ | |
| SettlementEscrow | _pending_ | _pending_ | |
| AgentWalletFactory | _pending_ | _pending_ | |
| CrossChainSpendRouter (sender) | _pending_ | _pending_ | |

## Base Sepolia (remote chain, chainId 84532)

| Contract | Address | Deploy tx | Explorer |
|----------|---------|-----------|----------|
| PriceFeedAdapter | _pending_ | _pending_ | |
| ServiceRegistry | _pending_ | _pending_ | |
| SettlementEscrow | _pending_ | _pending_ | |
| CrossChainSpendRouter (receiver) | _pending_ | _pending_ | |

## External dependencies (verify from Chainlink docs at deploy time)

| Item | Sepolia | Base Sepolia |
|------|---------|--------------|
| ETH/USD Data Feed | _verify from docs_ | _verify from docs_ |
| CCIP Router | _verify from docs_ | _verify from docs_ |
| LINK token | _verify from docs_ | _verify from docs_ |
| Chain selector | 16015286601757825753 | 10344971235874465080 |

> Chain selectors above are the commonly published CCIP selectors; re-verify against
> the current Chainlink CCIP directory before the M6 cross-chain deploy.
