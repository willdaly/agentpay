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

_Add one section per milestone (M5–M8) as the project progresses._
