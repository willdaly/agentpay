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

> **Deployed & verified live (2026-08-12):** the full home stack is on Ethereum
> Sepolia and the settlement stack on Base Sepolia; every contract's source is
> verified on the respective explorer (click **code**). A real single-chain spend
> and a real Sepolia→Base **cross-chain** spend over CCIP both landed — see
> [Live demo transactions](#live-demo-transactions-2026-08-12) below.
>
> Deployer / demo actor for this run: `0xc72BBE24C21D98316e01CA4c8e8B9475A6E50255`.

## Ethereum Sepolia (home chain, chainId 11155111)

| Contract | Address | Deploy tx | Source |
|----------|---------|-----------|--------|
| AgentPayToken | `0xcbBEB5Ae90F0F2a9Cc4D8a98D77775BfDc0b8863` | [`0x11edcd4c…`](https://sepolia.etherscan.io/tx/0x11edcd4cc5a97094cf82a23077e460d33da0a6cecdbeadc271338333afcbfe83) | [code](https://sepolia.etherscan.io/address/0xcbBEB5Ae90F0F2a9Cc4D8a98D77775BfDc0b8863#code) |
| PriceFeedAdapter | `0xfC7E7408D1B870c699B5417c641EffB2Cc4214E8` | [`0x5402a5e0…`](https://sepolia.etherscan.io/tx/0x5402a5e01f60bd0a193194ab827538bc2497bf103fd40dac0cd2f5fde1961242) | [code](https://sepolia.etherscan.io/address/0xfC7E7408D1B870c699B5417c641EffB2Cc4214E8#code) |
| ServiceRegistry | `0x3f1005c5d4a0113de21b80DC6463D9b3CE9C950E` | [`0x9ce5fde0…`](https://sepolia.etherscan.io/tx/0x9ce5fde05ad927b12208dfd9b9306675fa98d813b61b8d2c5cfe2b8512b24c84) | [code](https://sepolia.etherscan.io/address/0x3f1005c5d4a0113de21b80DC6463D9b3CE9C950E#code) |
| ScoreRegistry | `0x09c4EEBF778a3c7fd5827dD9ac30E432E14A2e35` | [`0x8cdba39b…`](https://sepolia.etherscan.io/tx/0x8cdba39b30f53495020fc2e18b002d3c7d03956411cc639370465715330f0bf1) | [code](https://sepolia.etherscan.io/address/0x09c4EEBF778a3c7fd5827dD9ac30E432E14A2e35#code) |
| TimelockController | `0x9643Cfcf16FDe871120a11958727Dbc4D1De6032` | [`0xde8bf9ce…`](https://sepolia.etherscan.io/tx/0xde8bf9ce4d8641df3f1edc766d45b24d0c1235235315b54a490b9cc826d52586) | [code](https://sepolia.etherscan.io/address/0x9643Cfcf16FDe871120a11958727Dbc4D1De6032#code) |
| PolicyGovernor | `0xf5Ddc4D09D2b42164F571C192d61814c5B0E1a51` | [`0x29a51eab…`](https://sepolia.etherscan.io/tx/0x29a51eabb4baea5355eb45317ca1bb1f8b433c110183399ef9b293cfbf8a30f3) | [code](https://sepolia.etherscan.io/address/0xf5Ddc4D09D2b42164F571C192d61814c5B0E1a51#code) |
| ProviderStaking | `0x60c9d79a50F81CE14F4E3B5AC59272F004972da3` | [`0xb277c86d…`](https://sepolia.etherscan.io/tx/0xb277c86d7255df24657e1bd6b55d24af1eeb7e7a8712d470b6cd4b058da0ff83) | [code](https://sepolia.etherscan.io/address/0x60c9d79a50F81CE14F4E3B5AC59272F004972da3#code) |
| SettlementEscrow | `0xBcd28310eC75ff9661ac9c5E195C7A95d1fB2481` | [`0xbf529483…`](https://sepolia.etherscan.io/tx/0xbf529483ca7bbff69a84acc6714707cdbec501f444b65be8d87de5849a275609) | [code](https://sepolia.etherscan.io/address/0xBcd28310eC75ff9661ac9c5E195C7A95d1fB2481#code) |
| CrossChainSpendRouter (sender) | `0x6Fe631C8F4DD7A43e021296A7aa3e495B325A692` | [`0x0dee9a77…`](https://sepolia.etherscan.io/tx/0x0dee9a77ff31b95cddd4379db61f1633b609b911f4d5234408a061cff7f88218) | [code](https://sepolia.etherscan.io/address/0x6Fe631C8F4DD7A43e021296A7aa3e495B325A692#code) |
| AgentWalletFactory | `0xf5A044fa177dF04cE5F0e0ff50F95A1f2ddCd734` | [`0xdfdd54de…`](https://sepolia.etherscan.io/tx/0xdfdd54de4b5fbd65d2f5d94e063ad40cc47965b1b1b1312b8e9891bca71a47c8) | [code](https://sepolia.etherscan.io/address/0xf5A044fa177dF04cE5F0e0ff50F95A1f2ddCd734#code) |

## Base Sepolia (remote chain, chainId 84532)

| Contract | Address | Deploy tx | Source |
|----------|---------|-----------|--------|
| AgentPayToken | `0xcbBEB5Ae90F0F2a9Cc4D8a98D77775BfDc0b8863` | [`0xc4e16a35…`](https://sepolia.basescan.org/tx/0xc4e16a3581d5a232c127290d59edc5cad9cc0263d073b3a0e9ae267ab4ef1e78) | [code](https://sepolia.basescan.org/address/0xcbBEB5Ae90F0F2a9Cc4D8a98D77775BfDc0b8863#code) |
| PriceFeedAdapter | `0xfC7E7408D1B870c699B5417c641EffB2Cc4214E8` | [`0x5dcde878…`](https://sepolia.basescan.org/tx/0x5dcde8785e8d711c58464c1e05d69906649e968eef1c3ba90a39a12b6f778ea4) | [code](https://sepolia.basescan.org/address/0xfC7E7408D1B870c699B5417c641EffB2Cc4214E8#code) |
| ServiceRegistry | `0x3f1005c5d4a0113de21b80DC6463D9b3CE9C950E` | [`0x887d942c…`](https://sepolia.basescan.org/tx/0x887d942cacff49d6008059c38b027a032646b546aedf2b2b22fd916d9142a75e) | [code](https://sepolia.basescan.org/address/0x3f1005c5d4a0113de21b80DC6463D9b3CE9C950E#code) |
| ScoreRegistry | `0x09c4EEBF778a3c7fd5827dD9ac30E432E14A2e35` | [`0x155c9042…`](https://sepolia.basescan.org/tx/0x155c9042d338de0bf7f0a160460972bb099b3b53fe98164166fe40489aa5baf2) | [code](https://sepolia.basescan.org/address/0x09c4EEBF778a3c7fd5827dD9ac30E432E14A2e35#code) |
| RemotePolicyParameters | `0x9643Cfcf16FDe871120a11958727Dbc4D1De6032` | [`0xab59c4f1…`](https://sepolia.basescan.org/tx/0xab59c4f1df2d68d0e93267760ae68e597ddb6ec981d686c80690d9740c96650b) | [code](https://sepolia.basescan.org/address/0x9643Cfcf16FDe871120a11958727Dbc4D1De6032#code) |
| SettlementEscrow | `0xf5Ddc4D09D2b42164F571C192d61814c5B0E1a51` | [`0x27cd757b…`](https://sepolia.basescan.org/tx/0x27cd757bf0ba7d5b867a21bbe1f5e38c2b266277790f343ad6ef68c0682375c2) | [code](https://sepolia.basescan.org/address/0xf5Ddc4D09D2b42164F571C192d61814c5B0E1a51#code) |
| CrossChainSpendRouter (receiver) | `0x664079B23Db022344b08F8952b5Cb7964a65BfCd` | [`0x6c6db7a5…`](https://sepolia.basescan.org/tx/0x6c6db7a5862f1284bc93799d7aa524badf6b932519e1a3a855c877b73d9475e6) | [code](https://sepolia.basescan.org/address/0x664079B23Db022344b08F8952b5Cb7964a65BfCd#code) |
| AllowlistAuthorizer | `0xBcd28310eC75ff9661ac9c5E195C7A95d1fB2481` | [`0x905eccc0…`](https://sepolia.basescan.org/tx/0x905eccc0b641f26892217c4e4d061ff7623c6c4b4c26af8e4d2c1dca8c0ddd86) | [code](https://sepolia.basescan.org/address/0xBcd28310eC75ff9661ac9c5E195C7A95d1fB2481#code) |

## External dependencies (verified from official docs)

| Item | Sepolia | Base Sepolia |
|------|---------|--------------|
| ETH/USD Data Feed | `0x694AA1769357215DE4FAC081bf1f309aDC325306` ✓ (8 dp, 3600s) | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` ✓ (8 dp, 1200s, on-chain verified) |
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

## Live demo transactions (2026-08-12)

Deployer / demo actor: `0xc72BBE24C21D98316e01CA4c8e8B9475A6E50255`.

### Single-chain spend (Ethereum Sepolia)

| # | Step | Evidence |
|---|------|----------|
| 1 | Provider registers a service + stakes APT | [register](https://sepolia.etherscan.io/tx/0xb37c3624aad3c5e6670694d6fa8d3d50b9c6adbb71d3bea1b2d8647af119fa0d) · [stake](https://sepolia.etherscan.io/tx/0x00ec5da69022106c5608522459a415669996340276c7e7122e887e8d22ab8066) |
| 2 | Wallet funded; owner sets allowlist + budget | wallet `0x8595…011f35`, funded 100 APT, allowlist + $10/day |
| 3 | Spend lands; payment settles | [`0x0245e6…`](https://sepolia.etherscan.io/tx/0x0245e6e8d62281aa72800daf3f11061a3ea658c9b1f1d42aa43558b906eed9b7) — $0.50, provider withdrew |
| 7 | `agent audit` rebuilds the log | spend reconstructed from `SpendExecuted` logs against the live RPC |

Steps 4–6 (daily-budget rejection, governance raising `maxPerTxUsd`, global pause)
exercise the governance lifecycle, whose `votingPeriod` (50 blocks) + timelock
delay make each live parameter change a ~30-minute, multi-proposal affair. They
are proven by `Governance.integration.test.ts` and the localhost `full-demo.ts`
run, which drive the same on-chain code paths. The live run prioritized the
cross-chain spend — the only milestone that genuinely required two real chains.

### Cross-chain spend, Sepolia → Base Sepolia over CCIP — settled end-to-end

| Leg | Evidence |
|-----|----------|
| Home spend routes over CCIP (Sepolia) | [`0xbb161b…`](https://sepolia.etherscan.io/tx/0xbb161b7b05f2231cc59ea6429113e8dc9535f0d1bdb78cddfbde8060c47ca9ea) — `SpendExecuted` 3.194 APT ($2.00), APT locked in the home router |
| CCIP message | [`0xa14142dd…`](https://ccip.chain.link/msg/0xa14142dd2258f03b7fc04e41902195b29de06d3ca2e1fbef071b5944ba07d9e3) — delivered ~15 min later |
| `ccipReceive` executes on Base | [`0x21ff2f30…`](https://sepolia.basescan.org/tx/0x21ff2f30948acf460e54a6a8bde3ef87b24958cc5f9f1592f72a839be363cfef) (block 45409567) — `CrossChainSpendReceived`, provider credited **3.194 APT** from remote liquidity |
| Provider withdraws on Base | [`0xa1530d01…`](https://sepolia.basescan.org/tx/0xa1530d01689c8bd7426c0d656af8b264146ccb5c79b54699a6797c15739b3601) — 3.194 APT pulled from the remote escrow. Loop closed. |

> **A real bug this live milestone caught.** The *first* live attempt (message
> [`0x242734…`](https://ccip.chain.link/msg/0x242734f9a11c531dcee16b7c2de32b5b7615bd49d9d3e4c369089aac8be5f6db))
> showed CCIP `state: SUCCESS` yet never credited the provider. A real CCIP
> OffRamp calls `receiver.supportsInterface(IAny2EVMMessageReceiver)` (ERC-165)
> *before* invoking `ccipReceive`, and silently skips the callback — still marking
> the message success — if that check reverts. The router implemented
> `ccipReceive` but not `supportsInterface`, so every cross-chain spend
> "succeeded" at the CCIP layer while settling nothing. The M6 suite missed it
> because the mock router called `ccipReceive` directly, bypassing the gate. The
> router now declares ERC-165 support (verified on-chain:
> `supportsInterface(0x85572ffb) => true`), the mock enforces the same gate so the
> suite catches any regression, and a focused test asserts it. The Base receiver
> was redeployed with the fix (`0x664079B23Db022344b08F8952b5Cb7964a65BfCd`,
> re-verified on Basescan) and the spend above settled. Full analysis:
> [SECURITY_NOTES.md](SECURITY_NOTES.md) → Finding X-01.
