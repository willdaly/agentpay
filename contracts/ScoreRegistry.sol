// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ScoreRegistry
/// @notice Commit-reveal quality scoring of service providers (lineage: the
///         Module 7 midterm's `EvaluationRegistry`, repurposed from model
///         evaluations to provider ratings).
///
/// @dev WHY COMMIT-REVEAL — this contract is the platform's privacy anchor.
///      Scores are submitted as `keccak256(...)` commitments during a commit
///      window and only revealed afterwards. During the commit window nobody —
///      not the provider, not other raters — can read a score. That kills three
///      failure modes an open scoreboard has:
///        1. **Herding**: raters copying whatever score is already showing.
///        2. **Retaliation**: a provider seeing a bad score while it can still
///           act against that rater.
///        3. **Last-mover advantage**: waiting to see the average, then voting
///           to drag it to a target.
///      Reveal is voluntary but useless to fake: the commitment binds the score,
///      the salt, the rater, AND the round, so a commitment cannot be replayed
///      into another round or by another address, and a rater cannot change
///      their mind after seeing others' reveals.
///
///      SELECTIVE DISCLOSURE (the enterprise-compliance story): a rater keeps
///      the salt off-chain. They can prove to an auditor exactly what they
///      scored — by handing over (score, salt) for the on-chain commitment —
///      without that score ever being public. The chain stores the binding
///      commitment; the rater controls disclosure.
///
///      SCOPE: scores are informational in the core build — they surface in the
///      agent CLI and demo. Having `AgentWallet` reject providers below a
///      minimum score is deliberate future work (it would need a governance
///      parameter and a liveness story for new providers with no ratings).
contract ScoreRegistry {
    /// @notice Minimum and maximum permitted score (inclusive).
    uint8 public constant MIN_SCORE = 1;
    uint8 public constant MAX_SCORE = 100;

    struct Round {
        address provider; // who is being scored
        uint64 commitEnd; // commits accepted while block.timestamp < commitEnd
        uint64 revealEnd; // reveals accepted while commitEnd <= now < revealEnd
        uint32 revealCount; // number of revealed scores
        uint256 scoreSum; // sum of revealed scores
    }

    /// @notice roundId (from 1) => round.
    mapping(uint256 => Round) private _rounds;

    /// @notice Number of rounds ever opened; also the highest valid roundId.
    uint256 public totalRounds;

    /// @notice roundId => rater => commitment (bytes32(0) = none).
    mapping(uint256 => mapping(address => bytes32)) public commitmentOf;

    /// @notice roundId => rater => revealed.
    mapping(uint256 => mapping(address => bool)) public hasRevealed;

    // --- Lifetime aggregates, across every round ---

    /// @notice provider => sum of all revealed scores.
    mapping(address => uint256) public lifetimeScoreSum;

    /// @notice provider => count of all revealed scores.
    mapping(address => uint256) public lifetimeRevealCount;

    event RoundOpened(
        uint256 indexed roundId,
        address indexed provider,
        address indexed opener,
        uint64 commitEnd,
        uint64 revealEnd
    );
    event ScoreCommitted(uint256 indexed roundId, address indexed rater);
    event ScoreRevealed(uint256 indexed roundId, address indexed rater, uint8 score);

    error UnknownRound(uint256 roundId);
    error ZeroProvider();
    error ZeroWindow();
    error CommitClosed(uint256 roundId, uint64 commitEnd);
    error CommitStillOpen(uint256 roundId, uint64 commitEnd);
    error RevealClosed(uint256 roundId, uint64 revealEnd);
    error AlreadyCommitted(uint256 roundId, address rater);
    error NoCommitment(uint256 roundId, address rater);
    error AlreadyRevealed(uint256 roundId, address rater);
    error CommitmentMismatch(uint256 roundId, address rater);
    error ScoreOutOfRange(uint8 score);
    error EmptyCommitment();

    /// @notice Open a scoring round for `provider`.
    /// @dev Permissionless, mirroring `ServiceRegistry`: the economic gate is
    ///      staking, not a role here. Anyone may open a round; a round with no
    ///      reveals simply contributes nothing to the aggregate.
    /// @param provider The provider being scored.
    /// @param commitWindow Seconds the commit phase stays open.
    /// @param revealWindow Seconds the reveal phase stays open after commits close.
    /// @return roundId The new round's id (>= 1).
    function openRound(address provider, uint64 commitWindow, uint64 revealWindow)
        external
        returns (uint256 roundId)
    {
        if (provider == address(0)) revert ZeroProvider();
        if (commitWindow == 0 || revealWindow == 0) revert ZeroWindow();

        uint64 commitEnd = uint64(block.timestamp) + commitWindow;
        uint64 revealEnd = commitEnd + revealWindow;

        roundId = ++totalRounds;
        _rounds[roundId] = Round({
            provider: provider,
            commitEnd: commitEnd,
            revealEnd: revealEnd,
            revealCount: 0,
            scoreSum: 0
        });

        emit RoundOpened(roundId, provider, msg.sender, commitEnd, revealEnd);
    }

    /// @notice Commit to a score. The score itself stays private until reveal.
    /// @param roundId The round to score in.
    /// @param commitment {computeCommitment}(roundId, score, salt, msg.sender).
    function commit(uint256 roundId, bytes32 commitment) external {
        Round storage r = _requireRound(roundId);
        if (block.timestamp >= r.commitEnd) revert CommitClosed(roundId, r.commitEnd);
        if (commitment == bytes32(0)) revert EmptyCommitment();
        if (commitmentOf[roundId][msg.sender] != bytes32(0)) {
            // One commitment per rater per round: letting a rater overwrite would
            // let them re-decide after watching others commit.
            revert AlreadyCommitted(roundId, msg.sender);
        }

        commitmentOf[roundId][msg.sender] = commitment;
        emit ScoreCommitted(roundId, msg.sender);
    }

    /// @notice Reveal a previously committed score, after the commit window closes.
    /// @param roundId The round.
    /// @param score The score committed to, in [MIN_SCORE, MAX_SCORE].
    /// @param salt The secret salt used in the commitment.
    function reveal(uint256 roundId, uint8 score, bytes32 salt) external {
        Round storage r = _requireRound(roundId);
        // Revealing early would leak scores while commits are still open —
        // exactly what the scheme exists to prevent.
        if (block.timestamp < r.commitEnd) revert CommitStillOpen(roundId, r.commitEnd);
        if (block.timestamp >= r.revealEnd) revert RevealClosed(roundId, r.revealEnd);

        bytes32 commitment = commitmentOf[roundId][msg.sender];
        if (commitment == bytes32(0)) revert NoCommitment(roundId, msg.sender);
        if (hasRevealed[roundId][msg.sender]) revert AlreadyRevealed(roundId, msg.sender);
        if (score < MIN_SCORE || score > MAX_SCORE) revert ScoreOutOfRange(score);
        if (computeCommitment(roundId, score, salt, msg.sender) != commitment) {
            revert CommitmentMismatch(roundId, msg.sender);
        }

        hasRevealed[roundId][msg.sender] = true;
        r.revealCount += 1;
        r.scoreSum += score;

        lifetimeRevealCount[r.provider] += 1;
        lifetimeScoreSum[r.provider] += score;

        emit ScoreRevealed(roundId, msg.sender, score);
    }

    // --- Views ---

    /// @notice The binding commitment for a (round, score, salt, rater) tuple.
    /// @dev Binds the rater AND the round, so a commitment cannot be replayed
    ///      into a different round or lifted by a different address. Raters
    ///      compute this off-chain and keep `salt` private; disclosing
    ///      (score, salt) later proves what they scored, to whoever they choose.
    function computeCommitment(
        uint256 roundId,
        uint8 score,
        bytes32 salt,
        address rater
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(roundId, score, salt, rater));
    }

    /// @notice Full round record. Reverts for an unknown id.
    function getRound(uint256 roundId) external view returns (Round memory) {
        _requireRound(roundId);
        return _rounds[roundId];
    }

    /// @notice True if the id has been opened.
    function exists(uint256 roundId) public view returns (bool) {
        return roundId != 0 && roundId <= totalRounds;
    }

    /// @notice Average revealed score for a round, scaled by 100 (so 8750 = 87.50).
    ///         Returns 0 when nothing has been revealed.
    function roundAverageScoreX100(uint256 roundId) external view returns (uint256) {
        _requireRound(roundId);
        Round storage r = _rounds[roundId];
        if (r.revealCount == 0) return 0;
        return (r.scoreSum * 100) / r.revealCount;
    }

    /// @notice Provider's lifetime average revealed score, scaled by 100.
    ///         Returns 0 when the provider has never been scored.
    /// @dev The headline number the agent CLI and demo surface.
    function providerAverageScoreX100(address provider)
        external
        view
        returns (uint256)
    {
        uint256 count = lifetimeRevealCount[provider];
        if (count == 0) return 0;
        return (lifetimeScoreSum[provider] * 100) / count;
    }

    /// @notice Current phase of a round: 0 = commit, 1 = reveal, 2 = closed.
    function phaseOf(uint256 roundId) external view returns (uint8) {
        Round storage r = _requireRound(roundId);
        if (block.timestamp < r.commitEnd) return 0;
        if (block.timestamp < r.revealEnd) return 1;
        return 2;
    }

    function _requireRound(uint256 roundId) private view returns (Round storage r) {
        if (!exists(roundId)) revert UnknownRound(roundId);
        r = _rounds[roundId];
    }
}
