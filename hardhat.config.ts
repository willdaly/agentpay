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

// Only attach an account if a key is actually present, so `hardhat test` works
// with no .env at all. Deployment scripts assert the key exists themselves.
const deployerAccounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

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
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY ?? "",
      baseSepolia: BASESCAN_API_KEY ?? "",
    },
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
