import * as fs from "fs";
import * as path from "path";

// Machine-readable record of deployed addresses per network. Gitignored (see
// .gitignore); the curated, committed record is docs/addresses.md.

export interface DeploymentEntry {
  address: string;
  txHash?: string;
  blockNumber?: number;
  deployedAt: string; // ISO timestamp
  args?: unknown[];
}

export interface DeploymentFile {
  network: string;
  chainId: number;
  contracts: Record<string, DeploymentEntry>;
}

const DIR = path.join(__dirname, "..", "..", "deployments");

function filePath(network: string): string {
  return path.join(DIR, `${network}.json`);
}

export function loadDeployments(network: string, chainId: number): DeploymentFile {
  const p = filePath(network);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, "utf8")) as DeploymentFile;
  }
  return { network, chainId, contracts: {} };
}

// Serialize BigInt (nested anywhere, e.g. constructor-arg structs) as a string.
const bigIntReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

export function saveDeployments(data: DeploymentFile): void {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    filePath(data.network),
    JSON.stringify(data, bigIntReplacer, 2) + "\n",
  );
}

/** Address already recorded for `name`, or undefined. */
export function existing(data: DeploymentFile, name: string): string | undefined {
  return data.contracts[name]?.address;
}

/** Record a deployment and persist immediately (so a crash mid-run is resumable). */
export function record(
  data: DeploymentFile,
  name: string,
  address: string,
  extra: Partial<DeploymentEntry> = {},
): void {
  data.contracts[name] = {
    address,
    deployedAt: new Date().toISOString(),
    ...extra,
  };
  saveDeployments(data);
}
