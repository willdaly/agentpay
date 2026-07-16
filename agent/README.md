# AgentPay Agent CLI

The off-chain half of AgentPay: an autonomous agent that decides what to buy, and
a control plane that decides whether it may.

**The LLM proposes, the contract disposes.**

```bash
agent quote "summarize this support ticket for under $1"   # the model chooses
agent spend 1                                              # on-chain policy rules
agent audit                                                # rebuild history from logs
```

## Setup

```bash
cd agent && npm install

# From the repo root: compile (the CLI reads ABIs from ../artifacts)
# and deploy (it reads addresses from ../deployments/<network>.json).
npm run compile
npx hardhat run scripts/deploy/deploy.ts --network localhost
```

Configuration comes from the **repo-root `.env`** (gitignored):

| Variable | Purpose |
|---|---|
| `AGENTPAY_NETWORK` | Home chain. Default `localhost`. |
| `AGENTPAY_REMOTE_NETWORK` | Also read the service catalog from this chain. |
| `AGENT_WALLET_ADDRESS` | The wallet to drive. Otherwise read from the demo context file. |
| `AGENT_PRIVATE_KEY` | The agent operator key (falls back to `DEPLOYER_PRIVATE_KEY`). |
| `ANTHROPIC_API_KEY` | Enables real LLM decisions. Without it, a deterministic fallback is used and clearly labelled. |
| `PROVIDER_SIM_URL` | provider-sim endpoint, so a paid-for service is actually collected. |

## Commands

### `agent quote "<need>"`

Reads the live `ServiceRegistry` on **every** configured chain, enriches each
service with the provider's stake and commit-reveal score, and asks Claude
(`claude-opus-4-8`) to choose one. Spends nothing.

The decision is defended in three layers:

1. **Wire format** — structured outputs (`messages.parse` + a zod schema) make the
   response schema-valid by construction; a fence-stripping text parser is the
   fallback if there's no structured output at all.
2. **Semantics** — structured outputs can't stop the model naming a service that
   doesn't exist or an absurd price. Those are checked against the real catalog.
3. **On-chain policy** — the only enforcement that counts.

An **over-budget decision is deliberately not repaired**. Clamping it would hide
exactly the failure the platform exists to catch; it's flagged and allowed
through so the typed on-chain revert proves the control plane works.

`--no-llm` uses the deterministic fallback (cheapest service).

### `agent spend <serviceId>`

Submits through `AgentWallet.spend()`. Two outcomes, both worth seeing:

- **ALLOWED** → decoded `SpendExecuted`, then the provider-sim is called to
  actually deliver the service just paid for.
- **REJECTED** → the **typed** custom error naming the exact policy that said no
  (`ExceedsDailyBudget`, `ExceedsPerTxCap`, `Paused`, `ProviderUnderstaked`,
  `CounterpartyNotAllowed`, `StalePrice`, …), with a plain-English gloss.

A pre-flight `previewSpend` static call reports the verdict before spending gas.

`--wallet <address>` overrides the wallet; `--no-deliver` skips collection.

### `agent audit`

Rebuilds the wallet's entire spend history from `SpendExecuted` logs — no
indexer, no database, no trust in this CLI. Anyone with an RPC endpoint can
reproduce the same table, which is what makes the trail credible. Each row's
`policySnapshot` hash pins the governance + local policy in force at that block.

## provider-sim

A minimal service provider whose only job is to answer one question honestly:
*"was I actually paid for this, on-chain, and not already served?"*

```bash
npm run provider-sim     # listens on :8787
export PROVIDER_SIM_URL=http://127.0.0.1:8787
```

`POST /infer { serviceId, txHash, prompt }` verifies, in order:

1. the transaction mined successfully;
2. it carries a `SettlementEscrow` credit event (the escrow really recorded money owed);
3. the credit names **this** service's registered provider and **this** serviceId;
4. the amount covers the registered price;
5. the payment hasn't already been redeemed — **one payment, one delivery**.

It trusts the caller for nothing and reads every fact from the chain. Only then
does it serve the inference (via the Anthropic API, or a deterministic stand-in
without a key).

## Full demo

Runs all seven steps of the build brief's demo — including this CLI:

```bash
npx hardhat node                                                  # terminal 1
npx hardhat run scripts/deploy/deploy.ts --network localhost      # terminal 2
cd agent && npm run provider-sim                                  # terminal 3
export PROVIDER_SIM_URL=http://127.0.0.1:8787                     # terminal 2
npx hardhat run scripts/demo/full-demo.ts --network localhost
```
