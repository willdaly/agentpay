import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// The agent is a separate package but reads the monorepo's build outputs:
// contract ABIs from ../artifacts and addresses from ../deployments. That keeps
// exactly one source of truth for both — no hand-copied ABIs to drift.

export const ROOT = path.join(__dirname, "..", "..");

dotenv.config({ path: path.join(ROOT, ".env") });

export interface ChainConfig {
  name: string;
  rpcUrl: string;
  chainId: number;
}

export interface DeploymentFile {
  network: string;
  chainId: number;
  contracts: Record<string, { address: string; txHash?: string }>;
}

/** The network the agent operates on (its home chain). */
export function homeNetwork(): string {
  return process.env.AGENTPAY_NETWORK ?? "localhost";
}

/** The remote chain to also read the service catalog from, if configured. */
export function remoteNetwork(): string | undefined {
  return process.env.AGENTPAY_REMOTE_NETWORK || undefined;
}

const DEFAULT_RPC: Record<string, string> = {
  localhost: "http://127.0.0.1:8545",
  hardhat: "http://127.0.0.1:8545",
};

export function rpcUrlFor(network: string): string {
  const explicit =
    network === "sepolia"
      ? process.env.SEPOLIA_RPC_URL
      : network === "baseSepolia"
        ? process.env.BASE_SEPOLIA_RPC_URL
        : undefined;
  const url = explicit ?? DEFAULT_RPC[network];
  if (!url) {
    throw new Error(
      `No RPC URL for network "${network}". Set SEPOLIA_RPC_URL / BASE_SEPOLIA_RPC_URL in .env.`,
    );
  }
  return url;
}

export function loadDeployments(network: string): DeploymentFile {
  const p = path.join(ROOT, "deployments", `${network}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(
      `No deployments for "${network}" at ${p}.\n` +
        `Run: npx hardhat run scripts/deploy/deploy.ts --network ${network}`,
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as DeploymentFile;
}

export function addressOf(network: string, contract: string): string {
  const d = loadDeployments(network);
  const entry = d.contracts[contract];
  if (!entry) {
    throw new Error(`${contract} is not deployed on ${network}.`);
  }
  return entry.address;
}

/** Read a contract ABI straight from the Hardhat build output. */
export function abiOf(contract: string): any[] {
  const p = path.join(
    ROOT,
    "artifacts",
    "contracts",
    `${contract}.sol`,
    `${contract}.json`,
  );
  if (!fs.existsSync(p)) {
    throw new Error(`No artifact for ${contract} at ${p}. Run: npm run compile`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

// --- Agent runtime context (which wallet this agent drives) ---

export interface AgentContext {
  wallet: string;
  /**
   * The operator address this wallet authorizes to call spend(). On a local node
   * (unlocked accounts) the CLI signs as this address, which keeps the
   * owner/agent role split real in the demo instead of collapsing it onto one
   * key. On a testnet, AGENT_PRIVATE_KEY supplies the key instead.
   */
  agentOperator?: string;
  /** Optional: provider-sim endpoint for inference services. */
  providerEndpoint?: string;
}

function contextPath(network: string): string {
  return path.join(ROOT, "deployments", `${network}.agent.json`);
}

/**
 * The agent's wallet comes from AGENT_WALLET_ADDRESS, or from the context file
 * written by scripts/demo/*. Keeping it out of deployments/<network>.json means
 * the demo can create fresh wallets without rewriting the deployment record.
 */
export function loadContext(network: string): AgentContext {
  const fromEnv = process.env.AGENT_WALLET_ADDRESS;
  if (fromEnv) return { wallet: fromEnv, providerEndpoint: providerEndpoint() };

  const p = contextPath(network);
  if (!fs.existsSync(p)) {
    throw new Error(
      `No agent wallet configured for "${network}".\n` +
        `Either set AGENT_WALLET_ADDRESS in .env, or run the demo setup:\n` +
        `  npx hardhat run scripts/demo/full-demo.ts --network ${network}`,
    );
  }
  const ctx = JSON.parse(fs.readFileSync(p, "utf8")) as AgentContext;
  return { ...ctx, providerEndpoint: providerEndpoint() ?? ctx.providerEndpoint };
}

export function saveContext(network: string, ctx: AgentContext): void {
  const dir = path.join(ROOT, "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(contextPath(network), JSON.stringify(ctx, null, 2) + "\n");
}

export function providerEndpoint(): string | undefined {
  return process.env.PROVIDER_SIM_URL || undefined;
}

/** The key the agent signs spends with. Distinct from the wallet's owner/admin. */
export function agentPrivateKey(): string {
  const k = process.env.AGENT_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!k) {
    throw new Error(
      "No AGENT_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env — the agent needs a key to submit spends.",
    );
  }
  return k;
}

export function anthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || undefined;
}
