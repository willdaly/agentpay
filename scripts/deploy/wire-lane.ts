import { ethers, network } from "hardhat";
import { getConfig, CONFIGS } from "../../config/networks";
import { loadDeployments, existing } from "../util/deployments";

// Opens the CCIP lane between the home and remote chains. Run ONCE PER NETWORK
// after scripts/deploy/deploy.ts has run on BOTH:
//
//   npx hardhat run scripts/deploy/wire-lane.ts --network sepolia      # home side
//   npx hardhat run scripts/deploy/wire-lane.ts --network baseSepolia  # remote side
//
// Home side  : open the lane to the remote router + fund the native CCIP fee budget.
// Remote side: allowlist the home chain and the home router as sender + seed the
//              settlement liquidity the router credits providers from.
//
// Idempotent: every step checks current on-chain state before acting.

// Which network is the counterpart of which. Keep in sync with config/networks.ts.
const PEER: Record<string, string> = {
  sepolia: "baseSepolia",
  baseSepolia: "sepolia",
};

// Native ETH kept on the home router to pay CCIP fees, and APT liquidity seeded
// on the remote router to settle incoming spends. FEE_BUDGET is sized for a
// demo's worth of data-only sends (each costs a small fraction of an ETH on this
// testnet lane) while leaving the deployer enough Sepolia ETH for demo gas; top
// the router up with fundNative() for heavier use. Overridable via env.
const FEE_BUDGET = ethers.parseEther(process.env.CCIP_FEE_BUDGET_ETH ?? "0.02");
const REMOTE_LIQUIDITY = ethers.parseEther("10000");

async function main() {
  const cfg = getConfig(network.name);
  const peerName = PEER[network.name];
  if (!peerName) {
    throw new Error(
      `No CCIP peer configured for "${network.name}". Known: ${Object.keys(PEER).join(", ")}`,
    );
  }
  const peerCfg = CONFIGS[peerName];

  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const local = loadDeployments(network.name, chainId);
  // The peer's chainId is irrelevant here; we only read its recorded addresses.
  const peer = loadDeployments(peerName, 0);

  const localRouter = existing(local, "CrossChainSpendRouter");
  const peerRouter = existing(peer, "CrossChainSpendRouter");
  if (!localRouter) {
    throw new Error(`No CrossChainSpendRouter in deployments/${network.name}.json — deploy first.`);
  }
  if (!peerRouter) {
    throw new Error(
      `No CrossChainSpendRouter in deployments/${peerName}.json — deploy the peer chain first.`,
    );
  }

  console.log(`\n== Wiring CCIP lane on ${cfg.label} (${cfg.role}) ==`);
  console.log(`Local router:  ${localRouter}`);
  console.log(`Peer  router:  ${peerRouter} (${peerCfg.label})\n`);

  const router = await ethers.getContractAt("CrossChainSpendRouter", localRouter);

  if (cfg.role === "home") {
    // Outbound: open the lane to the peer.
    const current = await router.destinationRouter(peerCfg.external.chainSelector);
    if (current.toLowerCase() !== peerRouter.toLowerCase()) {
      await (
        await router.setDestinationRouter(peerCfg.external.chainSelector, peerRouter)
      ).wait();
      console.log(`~ opened lane -> ${peerCfg.label} (${peerCfg.external.chainSelector})`);
    } else {
      console.log("= lane already open");
    }

    // Fees are paid in native ETH (feeToken = address(0)), so the router needs a balance.
    const bal = await ethers.provider.getBalance(localRouter);
    if (bal < FEE_BUDGET) {
      const top = FEE_BUDGET - bal;
      await (await router.fundNative({ value: top })).wait();
      console.log(`~ funded ${ethers.formatEther(top)} ETH for CCIP fees`);
    } else {
      console.log(`= fee budget already ${ethers.formatEther(bal)} ETH`);
    }
  } else {
    // Inbound: accept only the home chain, and only its router as sender.
    if (!(await router.allowlistedSourceChains(peerCfg.external.chainSelector))) {
      await (
        await router.setAllowlistedSourceChain(peerCfg.external.chainSelector, true)
      ).wait();
      console.log(`~ allowlisted source chain ${peerCfg.label}`);
    } else {
      console.log("= source chain already allowlisted");
    }

    if (
      !(await router.allowlistedSenders(peerCfg.external.chainSelector, peerRouter))
    ) {
      await (
        await router.setAllowlistedSender(
          peerCfg.external.chainSelector,
          peerRouter,
          true,
        )
      ).wait();
      console.log(`~ allowlisted sender ${peerRouter}`);
    } else {
      console.log("= sender already allowlisted");
    }

    // Seed the liquidity the router credits providers from. This is the honest
    // cost of lock-and-credit: the remote side must hold real APT.
    const tokenAddr = existing(local, "AgentPayToken")!;
    const token = await ethers.getContractAt("AgentPayToken", tokenAddr);
    const liq = await token.balanceOf(localRouter);
    if (liq < REMOTE_LIQUIDITY) {
      const top = REMOTE_LIQUIDITY - liq;
      const have = await token.balanceOf(deployer.address);
      if (have < top) {
        console.log(
          `! deployer holds ${ethers.formatEther(have)} APT, wanted ${ethers.formatEther(top)} — seeding what is available`,
        );
      }
      const amount = have < top ? have : top;
      if (amount > 0n) {
        await (await token.transfer(localRouter, amount)).wait();
        console.log(`~ seeded ${ethers.formatEther(amount)} APT of settlement liquidity`);
      }
    } else {
      console.log(`= liquidity already ${ethers.formatEther(liq)} APT`);
    }
  }

  console.log("\nLane wiring complete for this side.");
  if (cfg.role === "home") {
    console.log(`Now run the same script with --network ${peerName}.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
