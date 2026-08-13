import { ethers, network } from "hardhat";
import { getConfig, CONFIGS } from "../../config/networks";
import { loadDeployments, existing } from "../util/deployments";

// One real cross-chain spend, Sepolia -> Base Sepolia, over Chainlink CCIP.
//
// Run on the HOME chain (Sepolia). Everything up to the CCIP send happens here:
//   1. Register a service whose homeChainSelector is the REMOTE chain's selector,
//      so AgentWallet.spend() routes it cross-chain instead of settling locally.
//   2. Stake the provider on the home chain (policy/staking live on home).
//   3. Create + fund an agent wallet; allowlist the remote service.
//   4. spend() -> home policy passes -> APT locked in the home router -> a
//      data-only CCIP message is sent. We capture the CCIP messageId.
//
//   npx hardhat run scripts/demo/cross-chain-spend.ts --network sepolia
//
// The credit on Base Sepolia arrives autonomously ~15-20 min later. Track it with
//   scripts/demo/cross-chain-verify.ts and on https://ccip.chain.link.

const USD = (d: number) => BigInt(Math.round(d * 1e8));
const SERVICE_PRICE_CENTS = 200n; // $2.00 remote inference

async function main() {
  const cfg = getConfig(network.name);
  if (cfg.role !== "home") {
    throw new Error(`Run this on the home chain (sepolia), not ${network.name}.`);
  }
  const peerName = "baseSepolia";
  const remoteSelector = CONFIGS[peerName].external.chainSelector;

  const [me] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const d = loadDeployments(network.name, chainId);
  const need = (n: string) => {
    const a = existing(d, n);
    if (!a) throw new Error(`${n} not deployed on ${network.name}.`);
    return a;
  };

  const token = await ethers.getContractAt("AgentPayToken", need("AgentPayToken"));
  const registry = await ethers.getContractAt("ServiceRegistry", need("ServiceRegistry"));
  const staking = await ethers.getContractAt("ProviderStaking", need("ProviderStaking"));
  const factory = await ethers.getContractAt("AgentWalletFactory", need("AgentWalletFactory"));
  const governor = await ethers.getContractAt("PolicyGovernor", need("PolicyGovernor"));
  const router = await ethers.getContractAt("CrossChainSpendRouter", need("CrossChainSpendRouter"));

  console.log(`\n== Cross-chain spend: ${cfg.label} -> Base Sepolia (CCIP) ==`);
  console.log(`Actor: ${me.address}\n`);

  // Sanity: the lane must be open and the router funded, or the send reverts.
  const dest = await router.destinationRouter(remoteSelector);
  const feeBal = await ethers.provider.getBalance(await router.getAddress());
  console.log(`Lane -> Base router: ${dest}`);
  console.log(`Router fee budget:   ${ethers.formatEther(feeBal)} ETH`);
  if (dest === ethers.ZeroAddress) throw new Error("Lane not open — run wire-lane.ts first.");

  // 1. Register a REMOTE service (homeChainSelector = Base selector).
  const termsHash = ethers.keccak256(ethers.toUtf8Bytes("remote inference (Base Sepolia) v1"));
  let tx = await registry.registerService(
    SERVICE_PRICE_CENTS,
    termsHash,
    "inference: cross-chain summarization settled on Base Sepolia, $2.00",
    remoteSelector,
  );
  await tx.wait();
  const serviceId = await registry.totalServices();
  console.log(`1. Registered REMOTE service #${serviceId} ($2.00, settles on Base Sepolia)`);
  console.log(`   register tx: ${tx.hash}`);

  // 2. Stake the provider on the home chain.
  const minStake = await governor.providerMinStake();
  const staked = await staking.stakedOf(me.address);
  if (staked < minStake) {
    const top = minStake - staked;
    await (await token.approve(await staking.getAddress(), top)).wait();
    const stx = await staking.stake(top);
    await stx.wait();
    console.log(`2. Staked ${ethers.formatEther(top)} APT (stake tx ${stx.hash})`);
  } else {
    console.log(`2. Provider already staked ${ethers.formatEther(staked)} APT`);
  }

  // 3. Create + fund an agent wallet; allowlist the remote service; set budget.
  tx = await factory.createWallet(me.address, me.address);
  const rcpt = await tx.wait();
  const walletAddr = rcpt!.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "WalletCreated")!.args.wallet as string;
  const wallet = await ethers.getContractAt("AgentWallet", walletAddr);
  await (await token.transfer(walletAddr, ethers.parseEther("100"))).wait();
  await (await wallet.setServiceAllowed(serviceId, true)).wait();
  await (await wallet.setLocalDailyBudgetUsd(USD(10))).wait();
  console.log(`3. Wallet ${walletAddr} funded 100 APT, allowlisted #${serviceId}, $10/day`);

  // 4. Spend -> routes cross-chain. Capture the CCIP messageId.
  console.log(`\n4. Spending on #${serviceId} (routes over CCIP)...`);
  const spendTx = await wallet.spend(serviceId);
  console.log(`   spend tx: ${spendTx.hash} — waiting...`);
  const spendRcpt = await spendTx.wait();

  const parsed = spendRcpt!.logs.map((l) => {
    for (const c of [wallet, router]) {
      try {
        const p = c.interface.parseLog(l);
        if (p) return p;
      } catch {
        /* not this interface */
      }
    }
    return null;
  });

  const spend = parsed.find((e) => e && e.name === "SpendExecuted");
  const sent = parsed.find((e) => e && e.name === "CrossChainSpendSent");
  if (spend) {
    console.log(
      `\n   SpendExecuted: ${ethers.formatEther(spend.args.tokenAmount)} APT ` +
        `($${(Number(spend.args.usdValue) / 1e8).toFixed(2)}) -> ${spend.args.provider}`,
    );
  }
  if (!sent) {
    throw new Error("No CrossChainSpendSent event — the spend did not route cross-chain.");
  }
  const messageId = sent.args.messageId as string;
  console.log(`\n   CCIP messageId: ${messageId}`);
  console.log(`   CCIP fee paid:  ${ethers.formatEther(sent.args.fee)} ETH`);

  console.log(`\n=== Cross-chain spend submitted on the home chain. ===`);
  console.log(`Track delivery (~15-20 min):`);
  console.log(`  https://ccip.chain.link/msg/${messageId}`);
  console.log(`\nThen confirm the Base-side credit with:`);
  console.log(`  npx hardhat run scripts/demo/cross-chain-verify.ts --network baseSepolia`);
  console.log(`\nHANDLES (save these):`);
  console.log(JSON.stringify({
    homeSpendTx: spendTx.hash,
    ccipMessageId: messageId,
    serviceId: Number(serviceId),
    provider: me.address,
    walletAddr,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
