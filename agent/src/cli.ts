import { quote } from "./commands/quote";
import { spend } from "./commands/spend";
import { audit } from "./commands/audit";
import { homeNetwork } from "./config";

// AgentPay agent CLI.
//
//   agent quote "<need>"     decide what to buy (LLM proposes)
//   agent spend <serviceId>  pay for it        (the contract disposes)
//   agent audit              rebuild the spend history from logs
//
// Network comes from AGENTPAY_NETWORK (default: localhost).

const USAGE = `AgentPay agent — the LLM proposes, the contract disposes.

Usage:
  agent quote "<what you need>"   Ask the model to pick a service from the live
                                  on-chain catalog. Spends nothing.
      --no-llm                    Use the deterministic fallback (cheapest service)
                                  instead of calling the model.

  agent spend <serviceId>         Submit the spend through AgentWallet. Prints the
                                  tx hash and decoded event, or the TYPED policy
                                  error that rejected it.
      --wallet <address>          Override the agent wallet address.
      --no-deliver                Skip calling the provider after payment.

  agent audit                     Rebuild the full spend history from
                                  SpendExecuted logs (no indexer).
      --wallet <address>          Override the agent wallet address.
      --from-block <n>            Start scanning at this block.

Environment (from the repo-root .env):
  AGENTPAY_NETWORK          home chain (default: localhost)
  AGENTPAY_REMOTE_NETWORK   also read the catalog from this chain
  AGENT_WALLET_ADDRESS      the wallet to drive (else read from the demo context)
  AGENT_PRIVATE_KEY         the agent operator key (falls back to DEPLOYER_PRIVATE_KEY)
  ANTHROPIC_API_KEY         enables real LLM decisions (else the fallback is used)
  PROVIDER_SIM_URL          provider-sim endpoint for service delivery
`;

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "quote": {
      const need = rest.filter((a) => !a.startsWith("--")).join(" ");
      await quote(need, { noLlm: flag(rest, "no-llm") });
      break;
    }
    case "spend": {
      const serviceId = rest.find((a) => !a.startsWith("--"));
      if (!serviceId) throw new Error("usage: agent spend <serviceId>");
      await spend(serviceId, {
        wallet: opt(rest, "wallet"),
        noDeliver: flag(rest, "no-deliver"),
      });
      break;
    }
    case "audit":
      await audit({ wallet: opt(rest, "wallet"), fromBlock: opt(rest, "from-block") });
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      console.log(`  (current network: ${homeNetwork()})\n`);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\nError: ${e.message ?? e}\n`);
  process.exitCode = 1;
});
