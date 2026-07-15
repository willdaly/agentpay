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

_Add one section per milestone (M2–M8) as the project progresses._
