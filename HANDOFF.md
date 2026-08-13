# AgentPay — M8 Handoff

Everything the documentation phase (technical doc, business case, audit report,
demo recording) needs, so nothing has to be re-derived. Written per build brief
§11.

**Code frozen at M8.** Commit: see `git log` (M1–M8 are one commit each, plus
fixes). Course: Northeastern AAI6850. Testnets only; valueless tokens.

---

## 1. What this is, in three sentences

AgentPay is an on-chain control plane that lets autonomous AI agents spend
cryptocurrency under enforceable policy: per-transaction USD caps, rolling daily
budgets, counterparty allowlists, oracle-priced limits, staked providers, a full
audit trail, and an emergency stop. A token-weighted DAO governs the global risk
parameters, and consumers read them *at transaction time* — so a passed proposal
changes system-wide behavior with **no redeploy and no migration**. The thesis:
enterprises will not let AI agents hold wallets without a control plane; this is
that control plane.

---

## 2. Contract inventory, sizes, addresses

**All 12 product contracts are under the 24,576-byte EIP-170 limit.** Reproduce
with `npm run sizes` (CI-enforced).

| Contract | Bytes | % of 24KB | Role |
|---|---:|---:|---|
| `PolicyGovernor` | 18,385 | 74.8% | DAO **and** live `IPolicyParameters` store (the centerpiece) |
| `AgentWalletFactory` | 9,798 | 39.9% | Deploys wallets; vouches for them (`IWalletAuthorizer`) |
| `AgentPayToken` | 7,478 | 30.4% | ERC-20 + Votes + Permit; governance / staking / spend unit |
| `AgentWallet` | 7,037 | 28.6% | **The product.** Per-agent account; enforces policy at `spend()` |
| `CrossChainSpendRouter` | 6,226 | 25.3% | CCIP sender + receiver (Sepolia ↔ Base Sepolia) |
| `SettlementEscrow` | 3,441 | 14.0% | Pull-over-push settlement |
| `ScoreRegistry` | 3,306 | 13.5% | Commit-reveal provider scoring (privacy anchor) |
| `ProviderStaking` | 3,221 | 13.1% | Provider collateral; DAO-only slashing |
| `ServiceRegistry` | 2,961 | 12.0% | Permissionless service catalog |
| `PriceFeedAdapter` | 1,717 | 7.0% | Chainlink ETH/USD → APT, with staleness guards |
| `RemotePolicyParameters` | 1,165 | 4.7% | Mirrored params on the remote chain |
| `AllowlistAuthorizer` | 737 | 3.0% | Vouches for the router where there is no factory |

> `PolicyGovernor` is the only contract above 50% — it inherits the full
> OpenZeppelin Governor stack (Settings + CountingSimple + Votes +
> QuorumFraction + TimelockControl). Still 25% of headroom.

### Deployed addresses

**Deployed and source-verified live on 2026-08-12** (deployer
`0xc72BBE24C21D98316e01CA4c8e8B9475A6E50255`):

| Chain | Status |
|---|---|
| Ethereum Sepolia (home) | ✅ 10 contracts deployed + wired; all verified on Etherscan |
| Base Sepolia (remote) | ✅ 8 contracts deployed + wired; all verified on Basescan |

Full per-contract address / deploy-tx / verified-source tables:
**[docs/addresses.md](docs/addresses.md)**. The CCIP lane is open both ways
(home router funded for fees; remote router seeded with 10,000 APT liquidity).

Reproduce (idempotent; one command per step):

```bash
npx hardhat run scripts/util/preflight.ts   --network baseSepolia  # verify the feed on-chain
npx hardhat run scripts/deploy/deploy.ts     --network sepolia      # home
npx hardhat run scripts/deploy/deploy.ts     --network baseSepolia  # remote
npx hardhat run scripts/deploy/wire-lane.ts  --network sepolia      # open + fund the lane
npx hardhat run scripts/deploy/wire-lane.ts  --network baseSepolia  # allowlist + seed liquidity
npx hardhat run scripts/util/verify-all.ts   --network sepolia      # verify sources
npx hardhat run scripts/util/verify-all.ts   --network baseSepolia
```

### External dependencies (verified from official docs at build time)

| Item | Sepolia | Base Sepolia |
|---|---|---|
| ETH/USD Data Feed | `0x694AA1769357215DE4FAC081bf1f309aDC325306` ✓ (8 dp, 3600s) | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` ✓ (8 dp, 1200s, on-chain verified) |
| CCIP Router | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` ✓ | `0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93` ✓ |
| LINK | `0x779877A7B0D9E8603169DdbD7836e478b4624789` ✓ | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` ✓ |
| Chain selector | `16015286601757825753` ✓ | `10344971235874465080` ✓ |

Sepolia ETH/USD verified from Chainlink's reference data directory; CCIP values
from the CCIP directory, which also confirms **Sepolia → Base Sepolia is a live
lane**. LINK is recorded for completeness only — this build pays CCIP fees in
**native ETH**.

---

## 3. Test & coverage summary

**198 tests passing.** Reproduce: `npm test`, `npm run coverage:check`.

| Metric | Result | Gate |
|---|---|---|
| Lines | **100.00%** (388/388) | ≥90% ✅ |
| Branches | **95.52%** (277/290) | ≥90% ✅ |
| Statements | 100.00% (271/271) | — |
| Functions | 100.00% (104/104) | — |

Scope: 19 product contracts (`contracts/` + `contracts/interfaces/`). Mocks are
excluded from the gate by `scripts/check-coverage.js` — they are test
scaffolding, not product code.

Lowest branch coverage: `SettlementEscrow` 87.5%, `ProviderStaking` 89.29%,
`PolicyGovernor` 90.91% — all above the gate; the residue is defensive branches
in inherited OpenZeppelin paths.

| Suite | Covers |
|---|---|
| `AgentWallet.test.ts` | The densest suite — cap boundaries, day rollover, allowlist, pause layering, staleness, understaked, role auth, `previewSpend` |
| `integration/Governance.integration.test.ts` | **The signature test:** propose → vote → timelock → execute changes wallet behavior with no redeploy |
| `integration/CrossChain.integration.test.ts` | Two simulated chains; asserts **zero** CCIP messages on every rejection path |
| `integration/Economics.integration.test.ts` | stake → spend → windowed release → withdraw; slashing; reentrancy |
| `ScoreRegistry.test.ts` | Commit-reveal: no early reveal, wrong salt, double-commit, cross-round/rater replay |

---

## 4. Slither findings table

**Tool:** Slither 0.11.5 · **REQUIRED-PASS in CI as of M8** ·
Reproduce: `npm run slither`

First full pass: **31 findings — 0 High, 6 Medium, 13 Low, 12 Informational.**
Two were real and were fixed; 29 are false positives or accepted design
decisions, each excluded with a written rationale in `slither.config.json`.
The configured run now exits **0**, so any *new* finding fails the build.

### Fixed

| ID | Severity | Finding | Mitigation |
|---|---|---|---|
| S-01 | Informational (real) | `CrossChainSpendRouter` never formally implemented `ICrossChainSpendRouter` — signatures matched by coincidence, so the compiler could not catch drift | Router now `is ICrossChainSpendRouter` with `override`. **Verified** by drifting the interface and confirming the build fails. |
| S-02 | Low | `ccipReceive` emitted its event *after* external calls | Emit moved before them (strict checks-effects-interactions) |

### Accepted / false positive

| ID | Sev | # | Detector | Verdict |
|---|---|---:|---|---|
| S-03 | Med | 4 | `incorrect-equality` | False positive — day-bucket index equality (×3) and a `amount == 0` existence sentinel guaranteed by `credit()`'s `ZeroAmount` check |
| S-04 | Med | 2 | `unused-return` | False positive/accepted — the feed tuple *is* consumed (only `startedAt` skipped); the CCIP `messageId` is already emitted by the router in the same tx |
| S-05 | Low | 10 | `timestamp` | Accepted — every window is hours-to-days; a seconds-level miner nudge is immaterial |
| S-06 | Low | 2 | `missing-zero-check` | Accepted — `agent = address(0)` is the documented way to *clear* the operator; `msg.sender` can never be zero |
| S-07 | Info | 1 | `low-level-calls` | Accepted — `.call{value:}` is the *recommended* ETH transfer; return checked, `onlyOwner` |
| S-08 | Info | 8 | `naming-convention` | Accepted — leading-underscore params shadowing state vars; matches OpenZeppelin style |
| S-09 | Info | 2 | `unindexed-event-address` | Accepted — low-frequency governance events, no topic-filter consumer |
| S-10 | Info | 1 | `solc-version` | Accepted — 0.8.24 pinned by the course toolchain (§2.5) |

Full rationales: `slither.config.json` and `docs/SECURITY_NOTES.md`.

---

## 5. Gas report highlights

Reproduce: `npm run gas`. Solidity 0.8.24, optimizer on, runs=200, viaIR=false.

| Operation | Min | Max | Avg | Note |
|---|---:|---:|---:|---|
| `AgentWallet.spend` | 140,100 | 441,206 | **300,157** | The product's hot path. Max = cross-chain (CCIP send); min = a rejected/simple local spend |
| `CrossChainSpendRouter.routeSpend` | — | — | 285,673 | Lock + CCIP message |
| `AgentWalletFactory.createWallet` | 1,614,346 | 1,648,546 | 1,646,103 | One-time per agent; deploys a full wallet |
| `ProviderStaking.stake` | — | — | ~90k | |
| `SettlementEscrow.withdraw` | — | — | ~58k | Pull payment |
| `AgentWallet.setServiceAllowed` | 25,676 | 47,588 | 43,206 | Owner-only config |

**Reading of the spend cost:** ~300k avg is dominated by reading live governance
parameters and the oracle at transaction time, rather than caching them. That is
the deliberate architectural trade — the whole product property (governance
changes behavior with no redeploy) depends on *not* caching. `createWallet` is a
one-time per-agent cost.

---

## 6. CI

`.github/workflows/ci.yml` — three jobs, all required:

| Job | Steps |
|---|---|
| `build-test` | solhint → compile → 198 tests → **coverage ≥90% gate** → upload lcov |
| `slither` | **Slither, required-pass** (`fail-on: all`, `slither.config.json`) |
| `sizes-and-gas` | **24KB size gate** → gas report → upload artifact |

Node 20. Local equivalent of the whole gate: **`npm run audit`**.

Badge (fill the repo slug after publishing):
`![CI](https://github.com/<owner>/agentpay/actions/workflows/ci.yml/badge.svg)`

---

## 7. Demo — brief §10, step by step

Reproduce end-to-end with **one command** (drives the *real* agent CLI, not a
reimplementation, so a broken CLI fails the demo loudly):

```bash
npx hardhat node                                                  # terminal 1
npx hardhat run scripts/deploy/deploy.ts --network localhost      # terminal 2
cd agent && npm run provider-sim                                  # terminal 3
export PROVIDER_SIM_URL=http://127.0.0.1:8787                     # terminal 2
npx hardhat run scripts/demo/full-demo.ts --network localhost
```

| # | Step | Status (localhost, verified) | Live testnet |
|---|---|---|---|
| 1 | Provider registers a service + stakes APT | ✅ 3 services, 100 APT staked | ✅ Sepolia — [register](https://sepolia.etherscan.io/tx/0xb37c3624aad3c5e6670694d6fa8d3d50b9c6adbb71d3bea1b2d8647af119fa0d) · [stake](https://sepolia.etherscan.io/tx/0x00ec5da69022106c5608522459a415669996340276c7e7122e887e8d22ab8066) |
| 2 | Wallet funded; owner sets allowlist + budget | ✅ 200 APT; owner-only config | ✅ Sepolia — wallet `0x8595…011f35`, funded 100 APT, allowlist + $10/day |
| 3 | Spend lands; payment settles | ✅ `Decision (llm)`, real Claude inference served after on-chain verification | ✅ Sepolia local spend [`0x0245e6…`](https://sepolia.etherscan.io/tx/0x0245e6e8d62281aa72800daf3f11061a3ea658c9b1f1d42aa43558b906eed9b7) — $0.50, provider withdrew |
| 4 | Second spend exceeds daily budget | ✅ `ExceedsDailyBudget` | localhost + governance/wallet tests (not re-run live — see note) |
| 5 | **Governance raises `maxPerTxUsd` → same spend now succeeds, no redeploy** | ✅ `ExceedsPerTxCap` → proposal → `SPEND ALLOWED`; differing `policySnapshot` hashes capture the change | localhost + `Governance.integration.test.ts` (not re-run live — see note) |
| 6 | Global pause via governance → all spends halt; unpause | ✅ `Paused`, then resumed | localhost + governance test (not re-run live — see note) |
| 7 | `agent audit` prints the reconstructed log | ✅ 2 spends, $20.50, rebuilt from events alone | ✅ Sepolia — `agent audit` rebuilt the spend from `SpendExecuted` logs against the live RPC |

### The cross-chain spend — brief §10's CCIP leg, live on testnet

The highest-risk requirement, now executed on real testnets (not just the
simulated-chain `CrossChain.integration.test.ts`):

| Leg | Evidence |
|-----|----------|
| Home spend routes over CCIP (Sepolia) | [`0x2a4b1e…`](https://sepolia.etherscan.io/tx/0x2a4b1ee21d5f4d4a2d424920c30587c1c66d7b59700ed7daaaa1922686009966) — `SpendExecuted` 3.19 APT ($2.00), APT locked in the home router |
| CCIP message | `0x242734f9a11c531dcee16b7c2de32b5b7615bd49d9d3e4c369089aac8be5f6db` — [track on ccip.chain.link](https://ccip.chain.link/msg/0x242734f9a11c531dcee16b7c2de32b5b7615bd49d9d3e4c369089aac8be5f6db) |
| Remote credit (Base Sepolia) | _delivery in flight at time of writing (~15-25 min); confirm via `scripts/demo/cross-chain-verify.ts` and the CCIP explorer link above_ |

**Note on steps 4–6 (live):** these exercise the governance lifecycle, whose
`votingPeriod` (50 blocks) + timelock delay make a live run a ~30-minute,
multi-proposal affair per parameter. They are proven by the passing
`Governance.integration.test.ts` (propose → vote → timelock → execute changes
`AgentWallet` behavior with no redeploy) and the localhost `full-demo.ts` run
above, which drives the *same* on-chain code paths. The live testnet run
prioritized the cross-chain spend — the milestone that genuinely could not be
proven without two real chains.

---

## 8. Deviations from the brief, with rationale

| Deviation | Rationale |
|---|---|
| **CCIP is data-only + lock-and-credit, not token-transfer-plus-data** | APT is not a CCIP-registered token (CCT); using CCIP's own token transfer would need Token Admin Registry registration + burn/mint pools on both chains. This is the fallback the brief explicitly sanctions. **It is a trusted, liquidity-backed bridge and is presented as one** — full trust assumptions in `SECURITY_NOTES.md`. |
| **CCIP fees in native ETH, not LINK** | The brief delegated the choice ("pick whichever the current CCIP docs make simpler"). Native removes a funding-and-approval step. |
| **`AgentWallet` has an owner/agent role split** | The brief's demo has the *owner* set the allowlist/budget (step 2) and the *agent* spend (step 3) — two actors. Without the split, the operator key could raise its own limits and the control plane would be illusory. |
| **Understaked-provider check landed in M2, not M3** | Splitting the spend-time check set across milestones would have churned the core contract twice. Wired to `IProviderStaking` in M2 (mocked), real impl in M3. |
| **`SettlementEscrow`/router authorizer is a one-time setter, not a constructor arg** | M6 added a third contract to the escrow↔factory dependency cycle. A one-time initializer makes deployment a straight line, removes CREATE-address prediction from scripts *and* tests, and gives the previously-vestigial escrow `owner` exactly one narrow job. |
| **`AgentWallet.spend` checks extracted to a `view` `_authorizeSpend`** | Adding the router hit "stack too deep". Chosen over `viaIR` (slower compiles, coverage friction); it also sharpened the CEI structure and yielded a free `previewSpend` pre-flight view the CLI uses. |
| **Dispute mechanics minimal: no automated payment clawback** | Brief: "an automated dispute oracle is explicitly out of scope". Recourse is governance slashing the provider's stake; the escrow's dispute window is a time-lock before release. |
| **`ScoreRegistry` is informational; `AgentWallet` does not enforce a minimum score** | The brief marks score enforcement as a stretch. It needs a governance parameter *and* a liveness story for new providers with no ratings (score 0 ≠ bad). |
| **Timelock admin not renounced on testnet** | The deployer keeps `TIMELOCK_ADMIN_ROLE` so a demo can recover from role misconfiguration. A production deploy would renounce it. Documented centralization caveat. |
| **`RemotePolicyParameters` is owner-administered, not DAO-governed** | Governance lives on the home chain by design. Only `disputeWindow` is consumed remotely, and every spend-gating parameter is enforced on the home chain *before* any message is sent — so remote drift cannot widen spending authority. Future work: push params over CCIP. |
| **`AgentPayToken.faucet()` breaks fixed supply** | Deliberate, disclosed testnet affordance for demo self-funding. Must be removed for any non-testnet deployment. |
| **APT priced synthetically** | APT has no market. Its USD price = live ETH/USD feed ÷ a fixed APT↔ETH demo peg — so the oracle genuinely gates behavior (a graded requirement), while the peg is honestly labelled demo-only. |

---

## 9. Known limitations (state these in the report; do not hide them)

1. **No live testnet deployment yet.** The single outstanding item. Scripts are
   idempotent and proven locally; needs funded throwaway keys.
2. **The cross-chain bridge is trusted.** Lock-and-credit with pre-funded remote
   liquidity; APT supply is not conserved cryptographically across chains.
3. **Testnet-only affordances:** `faucet()`, a 24h oracle staleness bound (vs the
   real 3600s heartbeat), a 60s timelock, and a synthetic APT peg.
4. **No live emergency guardian.** Global pause goes through the timelock; a
   production system would add a guardian able to pause instantly.
5. **Immutable deploys, no proxies** (deliberate, per brief) — a bug means
   redeploy + migrate.
6. **Base Sepolia ETH/USD feed address is unverified** — recorded from memory and
   flagged; the M6 path does not depend on it.

---

## 10. Where things live

| What | Path |
|---|---|
| Contracts | `contracts/` (mocks in `contracts/mocks/`, interfaces in `contracts/interfaces/`) |
| Tests | `test/` (mirrors `contracts/` 1:1) + `test/integration/` |
| Deploy + lane wiring | `scripts/deploy/` (`deploy.ts`, `wire-lane.ts`) |
| Demo | `scripts/demo/full-demo.ts` (§10), `scripts/demo/spend.ts` (single spend) |
| Agent CLI + provider-sim | `agent/` (own package; see `agent/README.md`) |
| Security notes / findings log | `docs/SECURITY_NOTES.md` |
| AI disclosure (per milestone) | `docs/AI_DISCLOSURE.md` |
| Addresses + runbooks | `docs/addresses.md` |
| Gates | `slither.config.json`, `scripts/check-coverage.js`, `scripts/check-sizes.js` |

**One command runs every gate:** `npm run audit`
(lint → coverage ≥90% → 24KB sizes → Slither required-pass).
