import { ethers, network } from "hardhat";
import { getConfig } from "../../config/networks";

// Pre-deploy sanity for a live testnet run:
//   - which account will sign, and its ETH balance;
//   - the Chainlink ETH/USD feed configured for this chain is actually the
//     ETH/USD feed (description + decimals), read ON-CHAIN, not trusted from the
//     config comment. A wrong feed address is the kind of thing that deploys
//     fine and then silently misprices every spend.
//
//   npx hardhat run scripts/util/preflight.ts --network baseSepolia

const FEED_ABI = [
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

async function main() {
  const cfg = getConfig(network.name);
  const [signer] = await ethers.getSigners();
  const addr = await signer.getAddress();
  const bal = await ethers.provider.getBalance(addr);

  console.log(`\n== preflight: ${cfg.label} (${network.name}) ==`);
  console.log(`deployer: ${addr}`);
  console.log(`balance:  ${ethers.formatEther(bal)} ETH`);

  const feedAddr = cfg.external.ethUsdFeed;
  if (!feedAddr) {
    console.log(`feed:     none configured (a mock will be deployed)`);
    return;
  }

  console.log(`\nVerifying ETH/USD feed ${feedAddr} on-chain...`);
  const feed = new ethers.Contract(feedAddr, FEED_ABI, ethers.provider);
  const [description, decimals, round] = await Promise.all([
    feed.description(),
    feed.decimals(),
    feed.latestRoundData(),
  ]);

  const price = Number(round.answer) / 10 ** Number(decimals);
  const ageMin = (Math.floor(Date.now() / 1000) - Number(round.updatedAt)) / 60;
  console.log(`  description:     "${description}"`);
  console.log(`  decimals:        ${decimals}`);
  console.log(`  latest answer:   $${price.toFixed(2)} (updated ${ageMin.toFixed(0)} min ago)`);

  const okDesc = description.trim().toUpperCase().replace(/\s+/g, "") === "ETH/USD";
  const okDec = Number(decimals) === 8;
  if (!okDesc || !okDec) {
    throw new Error(
      `FEED MISMATCH on ${network.name}: expected "ETH / USD" @ 8 decimals, ` +
        `got "${description}" @ ${decimals}. STOP — get the correct address from ` +
        `Chainlink's feed directory before deploying.`,
    );
  }
  console.log(`  OK — genuine ETH/USD feed at 8 decimals.\n`);
}

main().catch((e) => {
  console.error(`\n${e.message ?? e}\n`);
  process.exit(1);
});
