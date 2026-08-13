// Per-network configuration for deployment. External on-chain addresses are
// VERIFIED FROM OFFICIAL DOCS at build time, not trusted from memory:
//   - Sepolia ETH/USD feed: Chainlink reference data directory
//     (feeds-ethereum-testnet-sepolia.json) — 0x694A..5306, 8 decimals, 3600s heartbeat.
//   - CCIP router / LINK / chain selectors: to be re-verified against the current
//     Chainlink CCIP directory at the M6 (cross-chain) milestone.

export interface ExternalAddresses {
  /** Chainlink ETH/USD aggregator. If undefined, the deploy script deploys a mock. */
  ethUsdFeed?: string;
  /** CCIP router (M6). */
  ccipRouter?: string;
  /** LINK token (M6, CCIP fees). */
  linkToken?: string;
  /** CCIP chain selector for this chain. */
  chainSelector: bigint;
}

export interface DeployConfig {
  /** Human label for logs. */
  label: string;
  /**
   * "home"   — hosts agent wallets, governance, staking (Sepolia).
   * "remote" — settlement-only counterparty: token, registry, escrow, router,
   *            and a mirrored parameter store. No DAO, no wallets (Base Sepolia).
   */
  role: "home" | "remote";
  external: ExternalAddresses;

  /** Fixed APT supply minted to the deployer at construction (wei). */
  initialSupply: bigint;

  /** Demo APT<->ETH peg (whole APT per 1 ETH) and price-feed staleness (seconds). */
  aptPerEth: bigint;
  /**
   * Max acceptable feed answer age. Set generously on testnets because their
   * feeds update irregularly and would otherwise trip `StalePrice` mid-demo. A
   * production deployment would use the real heartbeat (3600s) plus a small margin.
   */
  maxStaleness: bigint;
  /** Initial mock-feed answer (8-decimal USD) when a mock is deployed (local only). */
  mockInitialEthUsd: bigint;

  governance: {
    votingDelayBlocks: bigint;
    votingPeriodBlocks: bigint;
    proposalThresholdVotes: bigint;
    quorumPercent: bigint;
    timelockMinDelaySeconds: bigint;
  };

  /** Initial IPolicyParameters values (treasury defaults to the deployer). */
  policy: {
    maxPerTxUsd: bigint; // 8-decimal USD
    defaultDailyBudgetUsd: bigint; // 8-decimal USD
    slashBps: bigint;
    disputeWindow: bigint; // seconds; 0 = immediate escrow settlement
    providerMinStake: bigint; // APT wei
  };
}

const USD = (d: number) => BigInt(Math.round(d * 1e8));
const APT = (n: number) => BigInt(n) * 10n ** 18n;

// Shared demo defaults used across networks unless overridden.
const commonPolicy = {
  maxPerTxUsd: USD(10), // $10 per-tx ceiling
  defaultDailyBudgetUsd: USD(100), // $100 default daily budget
  slashBps: 1000n, // 10%
  disputeWindow: 0n, // immediate settlement for the M5 single-chain demo
  providerMinStake: APT(100), // 100 APT
};

const commonGovernance = {
  votingDelayBlocks: 1n,
  votingPeriodBlocks: 50n, // ~10 min on Sepolia (~12s blocks)
  proposalThresholdVotes: 0n,
  quorumPercent: 4n,
  timelockMinDelaySeconds: 60n, // short for the demo; a real DAO uses hours/days
};

export const CONFIGS: Record<string, DeployConfig> = {
  // Local Hardhat / localhost: no real feed => the deploy script deploys a mock.
  hardhat: {
    label: "Hardhat (local)",
    role: "home",
    external: { chainSelector: 16015286601757825753n },
    initialSupply: APT(10_000_000),
    aptPerEth: 3000n,
    maxStaleness: 86_400n,
    mockInitialEthUsd: USD(3000),
    governance: commonGovernance,
    policy: commonPolicy,
  },
  localhost: {
    label: "Hardhat (localhost node)",
    role: "home",
    external: { chainSelector: 16015286601757825753n },
    initialSupply: APT(10_000_000),
    aptPerEth: 3000n,
    maxStaleness: 86_400n,
    mockInitialEthUsd: USD(3000),
    governance: commonGovernance,
    policy: commonPolicy,
  },
  sepolia: {
    label: "Ethereum Sepolia",
    role: "home",
    external: {
      // Verified: Chainlink Sepolia ETH/USD proxy (8 decimals, 3600s heartbeat).
      ethUsdFeed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
      // Verified from the CCIP directory (testnet, ethereum-testnet-sepolia).
      ccipRouter: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
      linkToken: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
      chainSelector: 16015286601757825753n,
    },
    initialSupply: APT(10_000_000),
    aptPerEth: 3000n,
    maxStaleness: 86_400n, // 24h: testnet feed can lag; see field docs
    mockInitialEthUsd: USD(3000), // unused on Sepolia (real feed present)
    governance: commonGovernance,
    policy: commonPolicy,
  },
  baseSepolia: {
    label: "Base Sepolia",
    role: "remote",
    external: {
      // Base Sepolia ETH/USD — verified on-chain (description "ETH / USD",
      // 8 decimals) and against the Chainlink feed directory
      // (feeds-ethereum-testnet-sepolia-base-1.json, 1200s heartbeat). The
      // earlier config value had an invalid EIP-55 checksum (a mis-cased 'F');
      // this is the canonical address.
      ethUsdFeed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
      // Verified from the CCIP directory (testnet, Base Sepolia).
      ccipRouter: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
      linkToken: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
      chainSelector: 10344971235874465080n,
    },
    initialSupply: APT(10_000_000),
    aptPerEth: 3000n,
    maxStaleness: 86_400n,
    mockInitialEthUsd: USD(3000),
    governance: commonGovernance,
    policy: commonPolicy,
  },
};

export function getConfig(networkName: string): DeployConfig {
  const cfg = CONFIGS[networkName];
  if (!cfg) {
    throw new Error(
      `No deploy config for network "${networkName}". Add it to config/networks.ts.`,
    );
  }
  return cfg;
}
