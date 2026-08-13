# AI Assistance Disclosure

This project was built with substantial AI assistance (Anthropic's Claude, via the
Claude Code CLI). Academic integrity requires this be disclosed transparently. This
log records, at **milestone granularity**, what was AI-generated versus
hand-authored or hand-modified by the student (Will Daly). It is maintained from the
first commit and updated at the close of each milestone.

## How to read this log

- **AI-generated**: initial code/tests/docs produced by Claude from the build brief.
- **Human-directed**: the student set the architecture, constraints, and acceptance
  criteria (see `CAPSTONE_BUILD_BRIEF.md`), reviewed all output, and decided what to
  keep, change, or reject.
- **Hand-modified**: files the student edited directly after generation.

All third-party dependencies (OpenZeppelin, Chainlink) are attributed with versions
and licenses in the README.

---

## Milestone log

### M1 — Foundation (repo scaffold, token, price adapter, service registry)

**Date:** 2026-07-15

**AI-generated (Claude Code):**
- Project scaffold: `package.json`, `hardhat.config.ts`, `tsconfig.json`,
  `.solhint.json`, `.solcover.js`, `.env.example`, `.gitignore` additions.
- Contracts: `AgentPayToken.sol`, `PriceFeedAdapter.sol`, `ServiceRegistry.sol`,
  interfaces `IPolicyParameters.sol` / `IPriceFeedAdapter.sol`, test mocks
  (`MockV3Aggregator.sol` re-export, `ManipulableFeed.sol`).
- Test suites for all three M1 contracts (100% line/branch coverage on product code).
- CI workflow (`.github/workflows/ci.yml`), coverage gate script
  (`scripts/check-coverage.js`).
- Initial docs: this file, `SECURITY_NOTES.md`, `addresses.md`, README.

**Design decisions made by the student (recorded in the build brief) and applied by AI:**
- Chains, oracle strategy, token model, framework, contract suite, and milestone
  order were all specified up front in `CAPSTONE_BUILD_BRIEF.md`.
- Notable implementation choice surfaced during the build: APT is priced by combining
  the **live** Chainlink ETH/USD feed with a fixed, documented APT↔ETH demo peg, so
  the oracle genuinely gates on-chain behavior (a graded requirement) rather than a
  static rate doing nothing. Documented in `PriceFeedAdapter.sol` NatSpec.

**Hand-modified:** _(record any direct edits here as they happen)_

---

### M2 — The product (`AgentWallet` + factory, full policy enforcement)

**Date:** 2026-07-15

**AI-generated (Claude Code):**
- `AgentWallet.sol` (the product) with full `spend()` policy enforcement in
  checks-effects-interactions order + `nonReentrant`: pause layering, allowlist,
  registration/active + cross-chain guard, provider-staking gate, per-tx cap
  (min of local/global), rolling day-bucketed budget, live-oracle read, balance
  check; typed custom errors; rich `SpendExecuted` event with a policy-snapshot
  hash. `AgentWalletFactory.sol`.
- Interface extraction: `IServiceRegistry` (struct moved here; `ServiceRegistry`
  now implements it), new `IProviderStaking` / `ISettlementEscrow` interfaces.
- Mocks: `MockPolicyParameters`, `MockProviderStaking`, `MockSettlementEscrow`.
- Dense test suites (`AgentWallet.test.ts`, `AgentWalletFactory.test.ts`):
  cap boundaries (exactly-at / one-over), day rollover, allowlist, pause
  layering, staleness revert, understaked rejection, role auth, snapshot-hash
  verification. Product contracts remain at 100% lines / 94% branches.

**Design decisions made by the student (from the brief) and applied by AI:**
- **Role split (owner vs agent).** The brief's demo has the *owner* set the
  allowlist/budget and the *agent* spend. AgentWallet therefore separates an
  admin `owner` (sets policy, funds, appoints the operator) from an `agent`
  operator key that may only `spend()` within limits and cannot raise them. This
  makes "access-controlled agent wallets" a real control rather than illusory.

**Deviations from the brief (with rationale, per brief §11):**
- The **provider-staking check was included in M2** rather than deferred to M3.
  The brief sequences it into M3 ("wire understaked-rejection into AgentWallet"),
  but adding it later would churn the core contract and its dense test suite.
  AgentWallet depends on the `IProviderStaking` *interface* (mock now, real
  `ProviderStaking` in M3), so no rework is needed when M3 lands — only the
  concrete dependency is swapped at deploy time.

**Hand-modified:** _(record any direct edits here as they happen)_

---

### M3 — Economics (`ProviderStaking`, `SettlementEscrow`)

**Date:** 2026-07-15

**AI-generated (Claude Code):**
- `ProviderStaking.sol`: per-provider APT collateral; stake, cooldown unstake
  (cooldown = live `disputeWindow`, still slashable while cooling down),
  `cancelUnstake`, `withdraw`, and authority-gated `slash` of `slashBps` of total
  collateral to the live `treasury`. All economic parameters read live from
  `IPolicyParameters`.
- `SettlementEscrow.sol`: pull-over-push settlement with two modes selected by the
  live `disputeWindow` — immediate withdrawable (window 0) or a time-locked
  payment released after the window by a permissionless crank. `withdraw` is
  checks-effects-interactions + `nonReentrant`. Only wallets vouched for by the
  `IWalletAuthorizer` (the factory) may `credit`.
- `IWalletAuthorizer` interface; `AgentWalletFactory` now implements it.
- Test mocks: `MockWalletAuthorizer`, and a genuine reentrancy harness
  (`ReentrantToken` ERC-777-style hook + `ReentrantAttacker`) plus
  `RevertingReceiver`.
- Test suites: `ProviderStaking.test.ts`, `SettlementEscrow.test.ts` (incl. a real
  reentrant-withdraw attack blocked by the guard, and the reverting-provider
  cannot-block-a-spend property), and `integration/Economics.integration.test.ts`
  exercising the full real stack (stake → spend → windowed release → withdraw,
  plus governance slash and understaked-rejection).
- Coverage gate script filters to product contracts; 100% lines, ~97% branches.

**Design decisions (from the brief) applied by AI:**
- Cooldown = `disputeWindow` with cooling-down collateral kept slashable: a
  provider cannot stake, misbehave, then yank collateral before governance acts.
- Escrow↔factory constructor cycle broken in the integration test by predicting
  the factory's CREATE address (documented in the test).

**Notes / accepted limitations:**
- Automated payment clawback / dispute arbitration is out of scope per the brief;
  the recourse for bad service is governance slashing the provider's stake. The
  escrow's dispute window is a settlement time-lock, not an arbitration flow.
- 5 uncovered branches are `nonReentrant` guard revert-paths (would require a
  per-function reentrancy attack to hit); left uncovered as low-value defensive
  paths. Aggregate branch coverage stays well above the 90% gate.

**Hand-modified:** _(record any direct edits here as they happen)_

---

### M4 — Governance (`PolicyGovernor` as the live parameter store)

**Date:** 2026-07-16

**AI-generated (Claude Code):**
- `PolicyGovernor.sol`: an OpenZeppelin Governor (Settings + CountingSimple +
  Votes + VotesQuorumFraction + TimelockControl) that ALSO implements
  `IPolicyParameters`. The seven risk parameters live in its storage; each setter
  is `onlyGovernance`, so it is callable only by the timelock executing a passed
  proposal. Constructor validates `slashBps <= 10000` and non-zero treasury.
- `PolicyGovernor.test.ts` (initial values, Governor settings, constructor
  validation, every setter rejects a direct non-governance call).
- `integration/Governance.integration.test.ts` — the SIGNATURE test and more:
  propose → vote → queue → timelock delay → execute, asserting the SAME
  `AgentWallet.spend()` that failed a cap check now succeeds with NO redeploy;
  global pause/unpause via governance; every risk parameter mutated in one
  multi-action proposal; proposal cancellation; and DAO-only provider slashing
  (staking owned by the timelock).

**Design decisions (from the brief) applied by AI:**
- `PolicyGovernor` is simultaneously the DAO and the parameter store, exactly per
  the brief's "critical inherited pattern": consumers read `IPolicyParameters`
  live at tx time, so a passed proposal changes behavior with no redeploy.
- `ProviderStaking` ownership is transferred to the timelock in the governance
  integration so slashing is possible only via a passed proposal.

**Notes / accepted limitations:**
- `globalPause` is set via governance (through the timelock), matching the brief's
  demo. A production system would add a fast-path guardian role for instant
  emergency pause (unpause still via governance); noted as future work in
  `SECURITY_NOTES.md`. For the demo the timelock delay is set short.
- 7 uncovered branches remain, all `nonReentrant` guard revert-paths across the
  economics contracts (not reachable without a per-function reentrancy attack);
  100% lines / functions on product contracts.

**Hand-modified:** _(record any direct edits here as they happen)_

---

### M5 — Single-chain deploy (idempotent scripts + local validation)

**Date:** 2026-07-16

**AI-generated (Claude Code):**
- `config/networks.ts`: per-network deploy config. External addresses verified
  from official docs — Sepolia ETH/USD feed
  `0x694AA1769357215DE4FAC081bf1f309aDC325306` (8 dp, 3600s heartbeat) from
  Chainlink's reference data directory.
- `scripts/util/deployments.ts`: read/write helper for `deployments/<network>.json`
  (gitignored machine record), BigInt-safe serialization, crash-resumable.
- `scripts/deploy/deploy.ts`: idempotent full-stack deploy (token → feed/mock →
  adapter → registry → timelock → governor → staking → escrow+factory), wires
  timelock roles, hands `ProviderStaking` ownership to the timelock. Deploys a
  mock ETH/USD feed automatically on local networks, uses the real feed on Sepolia.
- `scripts/demo/spend.ts`: end-to-end demo — register service, stake, create
  wallet, fund, allowlist + $5/day budget, spend, settle (provider withdraws),
  and reconstruct the spend from `SpendExecuted` logs (`audit`).
- `docs/addresses.md` runbook; README + AI_DISCLOSURE updates.

**Verified by running (not just asserting):**
- Full deploy + demo-spend validated GREEN against a local Hardhat node:
  register → stake 100 APT → wallet → fund → spend $0.50 (0.5 APT at the
  live-oracle price) → provider withdraws → audit reconstructs from logs.
- Deploy re-run confirmed idempotent (all contracts reused, no duplicate wiring).

**Design decisions / notes:**
- The escrow↔factory constructor cycle is broken in the deploy script the same
  way as in tests: predict the factory's CREATE address so the escrow can
  reference it (deployed as a consecutive-nonce pair).
- The deployer keeps the timelock admin role on testnet for recoverability; a
  production deploy would renounce it (see `SECURITY_NOTES.md`).
- **The live Sepolia deploy itself is the student's to run** (needs a funded
  throwaway key + RPC in `.env`); the scripts and runbook make it a one-command
  operation, and the flow is proven locally.

**Hand-modified:** _(record any direct edits here as they happen)_

---

### M6 — Cross-chain (CCIP Sepolia → Base Sepolia)

**Date:** 2026-07-16

**Verified from official docs (not memory), at build time:**
- CCIP directory (testnet): Sepolia router `0x0BF3…3A59`, selector
  `16015286601757825753`, LINK `0x7798…4789`; Base Sepolia router `0xD3b0…8a93`,
  selector `10344971235874465080`, LINK `0xE4aB…2410`. **Sepolia → Base Sepolia
  confirmed as a live lane.**
- CCIP contracts live in a separate package (`@chainlink/contracts-ccip@2.0.0`),
  not `@chainlink/contracts`. Installed and pragma-checked against solc 0.8.24.

**AI-generated (Claude Code):**
- `CrossChainSpendRouter.sol` — CCIP sender + receiver in one contract:
  `routeSpend` (authorizer-gated), `ccipReceive` (router-only + source-chain and
  sender allowlists), native-ETH fee handling, liquidity/native rescue.
- `AllowlistAuthorizer.sol`, `RemotePolicyParameters.sol` — remote-chain support.
- `ICrossChainSpendRouter.sol`; `AgentWallet` remote-spend routing; factory passes
  the router through.
- `mocks/MockCCIPRouter.sol` — captures and replays CCIP messages.
- Tests: `CrossChainSpendRouter.test.ts` (23), `RemoteChainSupport.test.ts`,
  `integration/CrossChain.integration.test.ts` (12, two simulated chains).
- `scripts/deploy/deploy.ts` role branching (home/remote); `scripts/deploy/wire-lane.ts`.
- SECURITY_NOTES cross-chain section; addresses.md lane runbook.

**Engineering decisions worth disclosing:**
- **Data-only messaging + lock-and-credit**, not CCIP token transfer: APT is not a
  CCIP-registered token (CCT), so CCIP moves the *message* and value is settled
  against pre-funded remote liquidity. This is the brief's sanctioned fallback; the
  trust assumptions are documented in full in `SECURITY_NOTES.md` rather than
  glossed. **This is a trusted bridge and is presented as one.**
- **Native ETH for CCIP fees** (`feeToken = address(0)`) over LINK — one less token
  to fund and approve. The brief delegated this choice explicitly.
- **Chainlink's `CCIPReceiver` base class is unusable under Hardhat** (it imports
  `@openzeppelin/contracts@5.3.0/...`, a Foundry-style pinned path npm cannot
  resolve). Verified by probe-compiling. Worked around by implementing
  `IAny2EVMMessageReceiver` directly with an explicit `onlyRouter` check, while
  still using Chainlink's canonical `Client` structs and `IRouterClient` so
  real-router interop stays exact.
- **MockCCIPRouter over Chainlink Local** — the brief permits either; the mock keeps
  CCIP tests deterministic and dependency-light while exercising the real interfaces.
- **`SettlementEscrow` authorizer refactored to a one-time setter.** M6 added a
  third contract to the escrow↔factory dependency cycle, which CREATE-address
  prediction handled poorly. The one-time initializer makes deployment a straight
  line, removes prediction from both scripts and tests, and gives the previously
  vestigial escrow `owner` exactly one narrow job (closing an open Slither triage note).
- **`AgentWallet.spend` hit "stack too deep"** once the router was added. Rather than
  enabling `viaIR` (slower compiles, coverage friction), the CHECKS were extracted
  into a `view` `_authorizeSpend` returning a memory `SpendContext`. This fixed the
  stack, sharpened the CEI structure, and yielded a free `previewSpend` pre-flight
  view the M7 agent CLI can use.

**Verified by running:** 177 tests passing; coverage gate PASS (99.71% lines,
94.88% branches across 18 product contracts); deploy + demo re-validated green and
idempotent on a local node. The cross-chain suite proves every home-chain rejection
path sends **zero** CCIP messages.

**Not done here (honest scope):** the live Sepolia↔Base Sepolia deploy needs funded
throwaway keys on both chains; scripts and runbook are ready and the flow is proven
against simulated chains.

**Hand-modified:** _(record any direct edits here as they happen)_

---

### M7 — Agent client, provider-sim, ScoreRegistry, full demo

**Date:** 2026-07-16

**AI-generated (Claude Code):**
- `ScoreRegistry.sol` — commit-reveal provider scoring (lineage: the midterm's
  `EvaluationRegistry`). Commitment binds round + score + salt + rater, so it
  can't be replayed across rounds or lifted by another address. + 21 tests.
- `agent/` — a separate npm package: `config` / `chain` / `catalog` / `decide`
  and the `quote` / `spend` / `audit` commands. Reads ABIs from `../artifacts`
  and addresses from `../deployments`, so there is exactly one source of truth
  for both and no hand-copied ABIs to drift.
- `agent/provider-sim/server.ts` — verifies on-chain payment (escrow credit +
  provider + serviceId + amount) and enforces one-payment-one-delivery before
  serving.
- `scripts/demo/full-demo.ts` — all seven steps of brief §10.
- `agent/README.md`; README + AI_DISCLOSURE updates.

**Anthropic API usage (per the `claude-api` skill, loaded before writing the code):**
- Model `claude-opus-4-8`; structured outputs via `messages.parse()` +
  `zodOutputFormat`; adaptive thinking at `effort: "low"` (a scoped selection
  task — keeps the CLI responsive). `stop_reason: "refusal"` is handled.

**Design decisions worth disclosing:**
- **Three defensive layers, not one.** The brief asks for defensive parsing
  (strip fences, validate schema, clamp prices). Structured outputs make schema
  violations nearly impossible, but they cannot stop *semantic* nonsense — a
  hallucinated serviceId or an absurd price. So: structured outputs for the wire
  format, a fence-stripping text parser as fallback, and semantic validation
  against the real catalog.
- **An over-budget decision is deliberately NOT clamped.** Repairing it would
  hide precisely the failure the platform exists to catch. It is flagged and
  allowed through to the chain, where the typed revert demonstrates the control
  plane. Only structurally unusable decisions (unknown serviceId) fail early.
- **Deterministic fallback without an API key**, clearly labelled `(heuristic)`
  in output — so the demo and CI run with no key, without ever pretending a
  heuristic was an LLM.
- **provider-sim marks a payment redeemed BEFORE serving**, so an inference that
  fails can't hand the caller a free retry of a spent payment.
- ScoreRegistry is informational; having `AgentWallet` enforce a minimum score is
  left as future work (it needs a governance parameter and a liveness story for
  new providers with no ratings).

**Verified by running (not just asserting):**
- Full §10 demo GREEN end-to-end on a local node — all 7 steps, driving the real
  CLI via `execFileSync` rather than reimplementing it, so a broken CLI fails the
  demo loudly.
- **The centerpiece is real:** the identical `agent spend 3` command returns
  `ExceedsPerTxCap` before the proposal and `SPEND ALLOWED` after — no redeploy.
  The two spends' `policySnapshot` hashes differ, capturing the policy change.
- provider-sim rejections verified by curl: replayed payment → 409; forged
  txHash → 402 "transaction not found".
- 198 tests passing; coverage gate PASS (100% lines, 95.52% branches over 19
  product contracts); 0 lint errors.

**Bug found and fixed by running it:** the CLI initially signed as local account
0 while the demo's wallet authorized account 3 as its agent operator, so the
first run hit `NotAuthorizedAgent` — the role split working correctly. Fixed by
recording the operator in the agent context and signing as that address locally,
rather than collapsing owner and agent onto one key to make the demo pass.

**Hand-modified:** _(record any direct edits here as they happen)_

---

### M8 — Hardening, audit gates, handoff

**Date:** 2026-07-16

**AI-generated (Claude Code):**
- `slither.config.json` — documented exclusions, one written rationale per
  detector class.
- `scripts/check-sizes.js` — 24KB EIP-170 gate over product contracts.
- `.github/workflows/ci.yml` — Slither flipped to **required-pass**
  (`fail-on: all`); new `sizes-and-gas` job.
- `HANDOFF.md` (brief §11); `docs/SECURITY_NOTES.md` findings log; README polish.
- `npm run audit` — one command for the whole gate.
- Two contract fixes (below).

**Slither: first full pass — 31 findings (0 High, 6 Medium, 13 Low, 12 Info).**
Two were real and were **fixed**; 29 are false positives or accepted design
decisions, each excluded with a rationale. The configured run now exits 0.

**Two real bugs Slither caught:**
- **`missing-inheritance` (the valuable one).** `CrossChainSpendRouter` never
  formally implemented `ICrossChainSpendRouter` — the interface `AgentWallet`
  depends on. Signatures matched by coincidence, so **the compiler could not
  catch drift**, which is the entire reason that interface exists. Fixed with
  `is ICrossChainSpendRouter` + `override`, and **verified by deliberately
  drifting the interface and confirming the build now fails**.
- **`reentrancy-events`.** `ccipReceive` emitted its event after external calls;
  moved before them for strict checks-effects-interactions.

**Judgment applied, not blanket suppression:** each of the 29 remaining findings
was read and classified individually. The Medium `incorrect-equality` and
`unused-return` flags are genuine false positives (day-bucket index equality; a
tuple destructure that skips only `startedAt`). The `timestamp` class is accepted
because every window here is hours-to-days, where a seconds-level miner nudge is
immaterial. Exclusions live in `slither.config.json` with the reasoning inline,
so a *new* finding fails the build rather than being absorbed.

**Verified by running:** `npm run audit` exits 0 — solhint (0 errors), 198 tests,
coverage 100% lines / 95.52% branches over 19 product contracts, all 12 contracts
under 24KB (largest: `PolicyGovernor` at 74.8%, inheriting the full OZ Governor
stack), Slither 0 findings.

**Stated honestly in HANDOFF.md rather than glossed:** no live testnet deployment
yet (the one outstanding item); the cross-chain bridge is trusted; the CCIP leg is
proven only against simulated chains; testnet-only affordances (`faucet()`, 24h
staleness bound, 60s timelock, synthetic APT peg) are enumerated.

**Hand-modified:** _(record any direct edits here as they happen)_

---

### Live testnet deployment (post-M8)

**Date:** 2026-08-12

**AI-generated / AI-driven (Claude Code):**
- Full live deployment to Ethereum Sepolia (home, 10 contracts) + Base Sepolia
  (remote, 8 contracts); CCIP lane opened both ways; all 18 contracts
  source-verified on Etherscan/Basescan.
- New tooling: `scripts/util/preflight.ts` (on-chain feed verification),
  `verify-all.ts` (Etherscan V2 unified-key verification of both chains),
  `scripts/demo/cross-chain-{spend,verify}.ts`.
- A real Sepolia→Base cross-chain spend settled end-to-end (home policy → CCIP →
  remote credit → provider withdrawal). Tx hashes in `HANDOFF.md` §7.

**Bugs the live deploy surfaced, each fixed at the root (verified by running):**
1. `DEPLOYER_PRIVATE_KEY` without a `0x` prefix left deploys with no account —
   `hardhat.config` now normalizes both forms.
2. Base ETH/USD feed had an invalid EIP-55 checksum — verified the canonical
   address on-chain + against Chainlink's directory; `deploy.ts` now ASSERTS the
   feed is a genuine 8-dp "ETH / USD" feed before wiring it.
3. `agent audit` scanned logs from block 0, tripping public-RPC `eth_getLogs`
   range caps — added a chunked scan from the wallet's creation block; verified
   working against the live Sepolia RPC.
4. **`CrossChainSpendRouter` was missing ERC165 `supportsInterface`** — a real
   CCIP OffRamp skips `ccipReceive` (marking the message SUCCESS anyway) if the
   receiver doesn't declare `IAny2EVMMessageReceiver` support. The first live
   cross-chain spend "succeeded" per CCIP yet settled nothing. Fixed the contract,
   **hardened the mock to enforce the same ERC165 gate** (the mock's fidelity gap
   was why the M6 suite missed it), added a regression test, redeployed + verified
   the Base receiver, and confirmed a real spend settles. See `SECURITY_NOTES.md`
   → Finding X-01 and `HANDOFF.md` §7.

**Re-verified after the contract change:** 199 tests, 100% line / 95.55% branch
coverage, Slither 0 findings, all sizes under 24KB, solhint 0 errors.

**Honest deviations (in HANDOFF):** governance demo steps 4–6 were not re-run live
(their voting-period + timelock waits make a live run impractical; proven by the
governance integration test + localhost demo); the Sepolia *sender* router was not
redeployed (its receiver path is unused in the Sepolia→Base direction and
redeploying it cascades through the factory + escrow); the public Base RPC was
flaky (retried throughout).

---

_M1–M8 complete; live testnet deployment complete with a real cross-chain spend
settled. Everything after this is documentation and demo recording._
