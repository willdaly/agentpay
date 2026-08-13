import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// --- Environment (all optional for local dev; required only for live deploys) ---
const {
  SEPOLIA_RPC_URL,
  BASE_SEPOLIA_RPC_URL,
  DEPLOYER_PRIVATE_KEY,
  ETHERSCAN_API_KEY,
  BASESCAN_API_KEY,
  COINMARKETCAP_API_KEY,
  REPORT_GAS,
} = process.env;

// Attach an account only if the key is genuinely well-formed, so `hardhat test`
// and local development work with no .env, an empty key, OR a half-filled one
// still carrying the .env.example placeholder. Hardhat validates accounts when
// it LOADS this config, so a malformed value here breaks every command — local
// tests included — not just testnet deploys. Deployment scripts assert the key
// exists themselves.
//
// A 32-byte hex key is accepted with OR without the `0x` prefix (a common
// export ambiguity) and normalized to the 0x form Hardhat requires.
function normalizePrivateKey(k?: string): string | undefined {
  if (typeof k !== "string") return undefined;
  const t = k.trim();
  const withPrefix = t.startsWith("0x") ? t : t.length === 64 ? `0x${t}` : t;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix) ? withPrefix : undefined;
}

const normalizedDeployerKey = normalizePrivateKey(DEPLOYER_PRIVATE_KEY);

if (DEPLOYER_PRIVATE_KEY && !normalizedDeployerKey) {
  // Non-empty but unusable: warn rather than fail, but never stay silent — a
  // typo'd key would otherwise surface as a confusing "no accounts" error later.
  console.warn(
    "[hardhat.config] DEPLOYER_PRIVATE_KEY is set but is not a 32-byte hex key " +
      "(64 hex chars, optionally 0x-prefixed) — ignoring it. Testnet deploys " +
      "will have no account.",
  );
}

const deployerAccounts = normalizedDeployerKey ? [normalizedDeployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // evmVersion pinned for reproducible builds across the two target chains.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL ?? "",
      accounts: deployerAccounts,
      chainId: 11155111,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL ?? "",
      accounts: deployerAccounts,
      chainId: 84532,
    },
  },
  // Etherscan V2: a single Etherscan API key verifies every supported chain
  // (Sepolia AND Base Sepolia, chainid 84532) through the unified endpoint, so
  // no separate Basescan key is needed. A legacy per-chain BASESCAN_API_KEY, if
  // set, still overrides for Base.
  etherscan: {
    apiKey: BASESCAN_API_KEY
      ? { sepolia: ETHERSCAN_API_KEY ?? "", baseSepolia: BASESCAN_API_KEY }
      : (ETHERSCAN_API_KEY ?? ""),
  },
  gasReporter: {
    enabled: REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: COINMARKETCAP_API_KEY,
    excludeContracts: ["mocks/"],
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
