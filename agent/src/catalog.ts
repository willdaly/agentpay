import { fmtUsd, readContract, usdFromCents } from "./chain";
import { homeNetwork, loadDeployments, remoteNetwork } from "./config";

// Reads the service catalog from the on-chain ServiceRegistry on EVERY
// configured chain — the marketplace is multi-chain, so the agent's view of it
// must be too. Enriched with the provider's stake and commit-reveal score so the
// LLM can weigh quality, not just price.

export interface CatalogEntry {
  network: string;
  serviceId: number;
  provider: string;
  priceUsdCents: number;
  priceUsd: string;
  metadataURI: string;
  homeChainSelector: string;
  active: boolean;
  /** Provider's active stake in APT (whole tokens, rounded). */
  stakedApt: number;
  /** Lifetime average commit-reveal score, 0-100. 0 means "never rated". */
  score: number;
  /** True if this service settles on a different chain than the agent's wallet. */
  isRemote: boolean;
}

async function readChainCatalog(
  network: string,
  localSelector: string,
): Promise<CatalogEntry[]> {
  const registry = readContract(network, "ServiceRegistry");
  const total: bigint = await registry.totalServices();
  if (total === 0n) return [];

  // Staking and scoring live on the home chain only; a remote chain may not
  // have them deployed, so treat them as optional enrichment.
  const deployments = loadDeployments(network);
  const staking = deployments.contracts["ProviderStaking"]
    ? readContract(network, "ProviderStaking")
    : undefined;
  const scores = deployments.contracts["ScoreRegistry"]
    ? readContract(network, "ScoreRegistry")
    : undefined;

  const out: CatalogEntry[] = [];
  for (let id = 1n; id <= total; id++) {
    const s = await registry.getService(id);
    const staked = staking ? await staking.stakedOf(s.provider) : 0n;
    const scoreX100 = scores
      ? await scores.providerAverageScoreX100(s.provider)
      : 0n;

    out.push({
      network,
      serviceId: Number(id),
      provider: s.provider,
      priceUsdCents: Number(s.priceUsdCents),
      priceUsd: fmtUsd(usdFromCents(s.priceUsdCents)),
      metadataURI: s.metadataURI,
      homeChainSelector: String(s.homeChainSelector),
      active: s.active,
      stakedApt: Math.floor(Number(staked / 10n ** 15n) / 1000),
      score: Number(scoreX100) / 100,
      isRemote: String(s.homeChainSelector) !== localSelector,
    });
  }
  return out;
}

/**
 * The full catalog the agent can see, across the home chain and (if configured)
 * the remote chain. Only active services are returned — an inactive service can
 * never be spent on, so offering it to the LLM only invites a wasted decision.
 */
export async function loadCatalog(): Promise<CatalogEntry[]> {
  const home = homeNetwork();
  const factory = readContract(home, "AgentWalletFactory");
  const localSelector: string = String(await factory.localChainSelector());

  const entries = await readChainCatalog(home, localSelector);

  const remote = remoteNetwork();
  if (remote && remote !== home) {
    try {
      entries.push(...(await readChainCatalog(remote, localSelector)));
    } catch (e) {
      console.warn(
        `! could not read the remote catalog on ${remote}: ${(e as Error).message}`,
      );
    }
  }

  return entries.filter((e) => e.active);
}

/** Compact projection handed to the LLM — no addresses it might hallucinate into. */
export function catalogForPrompt(entries: CatalogEntry[]) {
  return entries.map((e) => ({
    serviceId: e.serviceId,
    priceUsd: Number((e.priceUsdCents / 100).toFixed(4)),
    description: e.metadataURI,
    providerScore: e.score, // 0 = never rated
    providerStakedApt: e.stakedApt,
    settlesOnChain: e.isRemote ? "remote" : "home",
  }));
}

export function renderCatalog(entries: CatalogEntry[]): string {
  if (entries.length === 0) return "  (no active services registered)";
  const lines = entries.map(
    (e) =>
      `  #${String(e.serviceId).padEnd(3)} ${e.priceUsd.padEnd(8)} ` +
      `score ${(e.score || 0).toFixed(1).padStart(5)}  ` +
      `stake ${String(e.stakedApt).padStart(6)} APT  ` +
      `${e.isRemote ? "remote" : "home  "}  ${e.metadataURI}`,
  );
  return lines.join("\n");
}
