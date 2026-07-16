import { ethers } from "ethers";
import { abiOf, addressOf, agentPrivateKey, rpcUrlFor } from "./config";

// Thin chain layer: providers, signers, and typed-ish contract handles built
// from the Hardhat artifacts.

export function providerFor(network: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrlFor(network));
}

/**
 * The agent's signer, in priority order:
 *   1. AGENT_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY (required on any real network).
 *   2. On a local node only: the unlocked account for `preferred` — the wallet's
 *      configured agent operator. Signing as the real operator keeps the
 *      owner/agent role split honest locally instead of collapsing it onto
 *      account 0 (which the wallet would rightly reject).
 *   3. On a local node with no operator known: account 0.
 */
export async function signerFor(
  network: string,
  preferred?: string,
): Promise<ethers.Signer> {
  const provider = providerFor(network);
  const isLocal = network === "localhost" || network === "hardhat";
  try {
    return new ethers.Wallet(agentPrivateKey(), provider);
  } catch (e) {
    if (!isLocal) throw e;
    return await provider.getSigner(preferred ?? 0);
  }
}

export function contractAt(
  network: string,
  name: string,
  runner: ethers.ContractRunner,
  address?: string,
): ethers.Contract {
  return new ethers.Contract(
    address ?? addressOf(network, name),
    abiOf(name),
    runner,
  );
}

export function readContract(
  network: string,
  name: string,
  address?: string,
): ethers.Contract {
  return contractAt(network, name, providerFor(network), address);
}

/**
 * Decode a revert into the contract's typed custom error — the whole point of
 * using custom errors is that a rejection tells the operator exactly which
 * policy said no.
 */
export function decodeRevert(
  err: unknown,
  interfaces: ethers.Interface[],
): { name: string; args: string[] } | null {
  const data =
    (err as any)?.data ??
    (err as any)?.info?.error?.data ??
    (err as any)?.error?.data?.data ??
    (err as any)?.error?.data;
  if (typeof data !== "string" || !data.startsWith("0x")) return null;

  for (const iface of interfaces) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) {
        return {
          name: parsed.name,
          args: parsed.args.map((a: unknown) => String(a)),
        };
      }
    } catch {
      // try the next interface
    }
  }
  return null;
}

/** Every interface whose custom errors a spend might surface. */
export function spendErrorInterfaces(): ethers.Interface[] {
  return [
    new ethers.Interface(abiOf("AgentWallet")),
    new ethers.Interface(abiOf("PriceFeedAdapter")),
    new ethers.Interface(abiOf("SettlementEscrow")),
    new ethers.Interface(abiOf("CrossChainSpendRouter")),
    new ethers.Interface(abiOf("ServiceRegistry")),
  ];
}

/** USD (8-decimal fixed point) -> human string. */
export function fmtUsd(usd8: bigint): string {
  return `$${(Number(usd8) / 1e8).toFixed(2)}`;
}

export function usdFromCents(cents: bigint): bigint {
  return cents * 1_000_000n; // 100 cents == $1 == 1e8
}
