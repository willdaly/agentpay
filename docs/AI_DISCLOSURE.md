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

_Add one section per milestone (M3–M8) as the project progresses._
