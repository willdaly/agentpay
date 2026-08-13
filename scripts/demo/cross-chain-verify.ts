import { ethers, network } from "hardhat";
import { loadDeployments, existing } from "../util/deployments";

// Confirm a cross-chain spend LANDED on Base Sepolia: the remote router's
// ccipReceive credited the provider in the remote SettlementEscrow. Run after
// the CCIP message shows "Success" on https://ccip.chain.link (~15-20 min).
//
//   PROVIDER=0x... npx hardhat run scripts/demo/cross-chain-verify.ts --network baseSepolia
//
// Reads CrossChainSpendReceived events on the remote router and the provider's
// withdrawable balance on the remote escrow — proof the value settled remotely.

async function main() {
  if (network.name !== "baseSepolia") {
    throw new Error(`Run on baseSepolia (the remote chain), not ${network.name}.`);
  }
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const d = loadDeployments(network.name, chainId);
  const need = (n: string) => {
    const a = existing(d, n);
    if (!a) throw new Error(`${n} not deployed on ${network.name}.`);
    return a;
  };

  const router = await ethers.getContractAt("CrossChainSpendRouter", need("CrossChainSpendRouter"));
  const escrow = await ethers.getContractAt("SettlementEscrow", need("SettlementEscrow"));

  console.log(`\n== Cross-chain settlement check on Base Sepolia ==`);
  console.log(`Remote router: ${await router.getAddress()}`);
  console.log(`Remote escrow: ${await escrow.getAddress()}\n`);

  // Base's RPC caps eth_getLogs at a 10,000-block range, so scan a recent window
  // (Base ~2s blocks => ~9,000 blocks is several hours, well past a 15-min CCIP
  // delivery). Override the start with FROM_BLOCK for older messages.
  const latest = await ethers.provider.getBlockNumber();
  const fromBlock = process.env.FROM_BLOCK
    ? Number(process.env.FROM_BLOCK)
    : Math.max(0, latest - 9000);
  // The DEFINITIVE settlement signal is the provider's withdrawable balance
  // (an eth_call, robust to the flaky log-query RPC). Check it FIRST and always —
  // an earlier version returned early on an empty log result and so couldn't
  // distinguish "not landed" from "landed but the RPC dropped the logs".
  const provider = process.env.PROVIDER;
  if (provider) {
    const claimable = await escrow.withdrawable(provider);
    if (claimable > 0n) {
      console.log(
        `SETTLED: provider ${provider} is owed ${ethers.formatEther(claimable)} APT ` +
          `in the remote escrow — the cross-chain spend credited on Base.`,
      );
    } else {
      console.log(
        `Provider ${provider} withdrawable: 0 APT — not settled yet ` +
          `(if ccip.chain.link shows the message delivered/success but this stays 0, ` +
          `the receiver's ccipReceive was skipped; see SECURITY_NOTES).`,
      );
    }
  }

  const events = await router.queryFilter(
    router.filters.CrossChainSpendReceived(),
    fromBlock,
    latest,
  );
  if (events.length === 0) {
    console.log("(no CrossChainSpendReceived events found in the scanned window)");
    return;
  }

  console.log(`\n${events.length} cross-chain spend(s) received (from logs):`);
  for (const e of events) {
    const a = (e as ethers.EventLog).args;
    console.log(
      `  block ${e.blockNumber}  service #${a.serviceId}  ` +
        `${ethers.formatEther(a.amount)} APT -> ${a.provider}  msgId ${a.messageId}`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
