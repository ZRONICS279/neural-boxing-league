// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FightCardParlay — Parimutuel Parlay Card
 * @notice Pick the winner of every fight on a short card. All stakes go into one
 *         pot; whoever calls them all splits it.
 *
 *  Why parimutuel and not a priced parlay:
 *    A parlay is a bet on a conjunction, and the per-bout order books in
 *    FightCardCLOB have no counterparty for a conjunction — nobody there is
 *    selling "A wins fight 3 AND B wins fight 7". The alternatives are a
 *    combinatorial market (2^legs outcomes, one book per leg-set, liquidity goes
 *    to zero) or a house-banked vault priced off those books, which is
 *    exploitable while the books are thin: shove a market to 5¢, buy a 20×
 *    parlay, let it revert. A pot needs no pricing at all. Crowded picks pay
 *    less and contrarian picks pay more, automatically, and the payout is
 *    bounded by the money actually staked — so this contract cannot become
 *    insolvent no matter what the legs do.
 *
 *  Tickets:
 *    A ticket is a bitmask over the card's legs — bit i clear = fighter A of
 *    leg i, bit i set = fighter B. Legs are capped at 8, so the whole combo
 *    space is at most 256 and settlement can enumerate every one of them. That
 *    cap is what keeps this contract small and its gas flat.
 *
 *  Payout:
 *    payout = stake × (pot − rake) ÷ total staked on your combo
 *
 *    Perfect tickets take PERFECT_SHARE_BPS of the payable pot; the best
 *    imperfect tier splits the rest, so a night is never dead. If nobody is
 *    perfect the whole pot goes to the best tier present. Ties within a tier
 *    are split pro-rata by stake.
 *
 *  Timing:
 *    Betting closes at the first leg's opening bell, so the pot — and therefore
 *    every ticket's exact payout — is final *before any fight in the parlay has
 *    happened*. The number only moves while people are still betting.
 *
 *  Void legs:
 *    A drawn bout resolves VOID in the CLOB. That leg is then a hit for
 *    everyone, which shortens the parlay rather than killing it — the same way
 *    a sportsbook drops a voided leg. A card where every leg voids pays every
 *    ticket its stake back.
 *
 *  Safety:
 *    - Holds its own pot; it can never touch CLOB collateral
 *    - Outcomes are read from the CLOB, never written
 *    - refundAfter backstop: if the legs never resolve, everyone takes their
 *      stake back and no rake is charged
 */

import { IERC20, IERC20Decimals } from "./FightCardCLOB.sol";

interface IFightMarket {
    /// @dev Mirrors the public `bouts` mapping getter. Outcome: 0=UNRESOLVED, 1=A, 2=B, 3=VOID.
    function bouts(uint256 boutId) external view returns (
        uint64 cardId,
        bytes32 fighterA,
        bytes32 fighterB,
        uint64 latestCloseAt,
        uint64 voidAfter,
        uint8 outcome,
        bool closed,
        bool resolved
    );
    function collateral() external view returns (address);
}

contract FightCardParlay {
    uint8   public constant MAX_LEGS = 8;
    uint8   public constant MIN_LEGS = 2;
    uint256 public constant MAX_RAKE_BPS = 500;          // 5% ceiling
    uint256 public constant PERFECT_SHARE_BPS = 8000;    // perfect tier takes 80%

    uint8 internal constant OUTCOME_A = 1;
    uint8 internal constant OUTCOME_B = 2;
    uint8 internal constant OUTCOME_VOID = 3;

    IFightMarket public immutable clob;
    IERC20  public immutable collateral;
    uint256 public immutable minStake;

    address public owner;
    address public operator;
    address public feeRecipient;

    struct Parlay {
        uint64  cardId;
        uint8   legCount;
        uint16  rakeBps;
        uint64  closesAt;     // anyone may close after this
        uint64  refundAfter;  // anyone may refund after this, if unsettled
        bool    closed;
        bool    settled;
        bool    refunded;
        uint256 pot;    // everything in the middle: staked tickets + seed
        uint256 seed;   // operator money, won by the bettors, never a ticket
    }

    /// @dev Written once at settlement; every claim reads it and does no scanning.
    struct Settlement {
        uint8   winningCombo;  // bit i set = fighter B took leg i
        uint8   voidMask;      // bit i set = leg i voided, so it hits for everyone
        uint8   runnerUpHits;
        uint256 payablePot;
        uint256 perfectStake;
        uint256 perfectPool;
        uint256 runnerUpStake;
        uint256 runnerUpPool;
    }

    uint256 public nextParlayId = 1;
    mapping(uint256 => Parlay) public parlays;
    mapping(uint256 => Settlement) public settlements;
    mapping(uint256 => uint256[]) internal _legs;

    // [parlayId][combo] and [parlayId][combo][user]
    mapping(uint256 => mapping(uint8 => uint256)) public comboStake;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public stakeOf;

    uint256 public totalPots;   // every unsettled + unclaimed stake this contract owes
    uint256 public accFees;

    uint256 private _locked = 1;

    event ParlayCreated(uint256 indexed parlayId, uint64 indexed cardId, uint256[] legs, uint64 closesAt, uint64 refundAfter, uint16 rakeBps);
    event TicketPlaced(uint256 indexed parlayId, address indexed better, uint8 combo, uint256 amount, uint256 pot);
    event PotSeeded(uint256 indexed parlayId, address indexed from, uint256 amount, uint256 pot);
    event SeedReclaimed(uint256 indexed parlayId, address indexed to, uint256 amount);
    event ParlayClosed(uint256 indexed parlayId, uint256 pot, address closedBy);
    event ParlaySettled(uint256 indexed parlayId, uint8 winningCombo, uint8 voidMask, uint256 payablePot, uint256 perfectStake, uint8 runnerUpHits);
    event ParlayRefunded(uint256 indexed parlayId, address refundedBy);
    event TicketClaimed(uint256 indexed parlayId, address indexed better, uint8 combo, uint256 payout);
    event OperatorUpdated(address operator);
    event FeeRecipientUpdated(address feeRecipient);

    modifier onlyOwner() {
        require(msg.sender == owner, "NO");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "NP");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, "RE");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address _clob, address _operator, address _feeRecipient) {
        require(_clob != address(0) && _operator != address(0), "A0");

        clob = IFightMarket(_clob);
        address token = IFightMarket(_clob).collateral();
        collateral = IERC20(token);

        // Same unit as the order book, so the frontend never converts between them.
        uint256 one = 10 ** uint256(IERC20Decimals(token).decimals());
        minStake = one / 100; // 0.01 collateral

        owner = msg.sender;
        operator = _operator;
        feeRecipient = _feeRecipient;
    }

    // ═══════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════

    function setOwner(address _owner) external onlyOwner {
        require(_owner != address(0), "A0");
        owner = _owner;
    }

    function setOperator(address _operator) external onlyOwner {
        require(_operator != address(0), "A0");
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    function claimFees() external nonReentrant {
        require(msg.sender == feeRecipient || msg.sender == owner, "NA");
        uint256 amount = accFees;
        require(amount > 0, "NF");
        accFees = 0;
        _push(feeRecipient, amount);
    }

    // ═══════════════════════════════════════════
    //  CARD LIFECYCLE
    // ═══════════════════════════════════════════

    /**
     * @notice Open a parlay card over bouts that already exist in the CLOB.
     * @param _boutIds The legs, in the order they appear on the ticket. Bit i of
     *        a combo refers to _boutIds[i].
     * @param _closesAt Wall-clock backstop. Betting should be closed by the
     *        operator at the first leg's opening bell; this only guarantees it
     *        cannot stay open forever.
     * @param _refundAfter Past this, if the card still hasn't settled, anyone can
     *        open refunds and every ticket takes back exactly what it staked.
     */
    function createParlay(
        uint64 _cardId,
        uint256[] calldata _boutIds,
        uint64 _closesAt,
        uint64 _refundAfter,
        uint16 _rakeBps
    ) external onlyOperator returns (uint256 parlayId) {
        uint256 n = _boutIds.length;
        require(n >= MIN_LEGS && n <= MAX_LEGS, "LN");
        require(_closesAt > block.timestamp, "CT");
        require(_refundAfter > _closesAt, "RT");
        require(_rakeBps <= MAX_RAKE_BPS, "RK");
        require(_rakeBps == 0 || feeRecipient != address(0), "FR");

        for (uint256 i = 0; i < n; i++) {
            (, , , uint64 latestCloseAt, , , bool closed, ) = clob.bouts(_boutIds[i]);
            require(latestCloseAt != 0, "NB");  // bout exists
            require(!closed, "BC");             // and hasn't started
            for (uint256 j = 0; j < i; j++) {
                require(_boutIds[j] != _boutIds[i], "DUP");
            }
        }

        parlayId = nextParlayId++;

        Parlay storage p = parlays[parlayId];
        p.cardId = _cardId;
        p.legCount = uint8(n);
        p.rakeBps = _rakeBps;
        p.closesAt = _closesAt;
        p.refundAfter = _refundAfter;

        _legs[parlayId] = _boutIds;

        emit ParlayCreated(parlayId, _cardId, _boutIds, _closesAt, _refundAfter, _rakeBps);
    }

    /// @notice First leg's opening bell. Operator any time; anyone once closesAt passes.
    function closeParlay(uint256 _parlayId) public {
        Parlay storage p = parlays[_parlayId];
        require(p.legCount != 0, "NC");
        require(!p.closed, "CL");
        require(msg.sender == operator || block.timestamp >= p.closesAt, "NA");

        p.closed = true;
        emit ParlayClosed(_parlayId, p.pot, msg.sender);
    }

    /**
     * @notice Add money to the pot that isn't a ticket — a guaranteed pot.
     *
     *  A parimutuel payout is capped by how much is staked, not by how hard the
     *  picks were, so a quiet night pays badly however good the calls. Seeding
     *  fixes the cold start: the seed is won by whoever settles best, and it
     *  shows up in every `quote` immediately, so early bettors see a real number
     *  instead of a rounding error.
     *
     *  Cost is bounded and known up front, which is the whole difference between
     *  this and backing parlays off a vault. It is not rakeable — the house
     *  doesn't take a cut of its own promotional money — and it comes back via
     *  `reclaimSeed` if the card refunds or nobody turns up.
     */
    function seedPot(uint256 _parlayId, uint256 _amount) external onlyOperator nonReentrant {
        Parlay storage p = parlays[_parlayId];
        require(p.legCount != 0, "NC");
        require(!p.closed, "CL");
        require(block.timestamp < p.closesAt, "CT");
        require(_amount > 0, "A0");

        p.pot += _amount;
        p.seed += _amount;
        totalPots += _amount;

        _pull(msg.sender, _amount);
        emit PotSeeded(_parlayId, msg.sender, _amount, p.pot);
    }

    /**
     * @notice Take the seed back when it was never won — either the card
     *         refunded, or not a single ticket was sold.
     */
    function reclaimSeed(uint256 _parlayId) external nonReentrant returns (uint256 amount) {
        Parlay storage p = parlays[_parlayId];
        require(msg.sender == operator || msg.sender == owner, "NA");

        Settlement storage s = settlements[_parlayId];
        bool nobodyPlayed = p.settled && s.perfectStake == 0 && s.runnerUpStake == 0;
        require(p.refunded || nobodyPlayed, "NE");

        amount = p.seed;
        require(amount > 0, "NF");

        p.seed = 0;
        totalPots -= amount;

        _push(operator, amount);
        emit SeedReclaimed(_parlayId, operator, amount);
    }

    // ═══════════════════════════════════════════
    //  BETTING
    // ═══════════════════════════════════════════

    /**
     * @notice Back one combination of winners.
     * @param _combo Bit i clear = fighter A of leg i, bit i set = fighter B.
     */
    function placeTicket(uint256 _parlayId, uint8 _combo, uint256 _amount) external nonReentrant {
        Parlay storage p = parlays[_parlayId];
        require(p.legCount != 0, "NC");
        require(!p.closed, "CL");
        require(block.timestamp < p.closesAt, "CT");
        require(_amount >= minStake, "SM");
        require(_combo <= _comboMask(p.legCount), "CB");

        comboStake[_parlayId][_combo] += _amount;
        stakeOf[_parlayId][_combo][msg.sender] += _amount;
        p.pot += _amount;
        totalPots += _amount;

        _pull(msg.sender, _amount);
        emit TicketPlaced(_parlayId, msg.sender, _combo, _amount, p.pot);
    }

    // ═══════════════════════════════════════════
    //  SETTLEMENT
    // ═══════════════════════════════════════════

    /**
     * @notice Permissionless once every leg has resolved in the CLOB.
     * @dev Enumerates the whole combo space — at most 256 iterations of pure
     *      arithmetic — and records the two paying tiers, so each claim is O(1).
     */
    function settleParlay(uint256 _parlayId) external {
        Parlay storage p = parlays[_parlayId];
        require(p.legCount != 0, "NC");
        require(!p.settled && !p.refunded, "AS");

        uint256[] storage legs = _legs[_parlayId];
        uint8 winningCombo = 0;
        uint8 voidMask = 0;

        for (uint256 i = 0; i < legs.length; i++) {
            (, , , , , uint8 outcome, , bool resolved) = clob.bouts(legs[i]);
            require(resolved, "NR");
            if (outcome == OUTCOME_B) winningCombo |= uint8(1 << i);
            else if (outcome == OUTCOME_VOID) voidMask |= uint8(1 << i);
        }

        p.closed = true;
        p.settled = true;

        // The seed is promotional money, not stake — it isn't raked.
        uint256 rake = ((p.pot - p.seed) * p.rakeBps) / 10000;
        uint256 payable_ = p.pot - rake;

        Settlement storage s = settlements[_parlayId];
        s.winningCombo = winningCombo;
        s.voidMask = voidMask;
        s.payablePot = payable_;

        // Bucket every combo by how many legs it called correctly.
        uint8 n = p.legCount;
        uint16 combos = uint16(1) << n;
        uint8 bestImperfect = 0;
        bool anyImperfect = false;

        for (uint16 c = 0; c < combos; c++) {
            uint256 stake = comboStake[_parlayId][uint8(c)];
            if (stake == 0) continue;

            uint8 hits = _hitsFor(uint8(c), winningCombo, voidMask, n);
            if (hits == n) {
                s.perfectStake += stake;
            } else if (!anyImperfect || hits > bestImperfect) {
                bestImperfect = hits;
                anyImperfect = true;
                s.runnerUpStake = stake;
            } else if (hits == bestImperfect) {
                s.runnerUpStake += stake;
            }
        }

        s.runnerUpHits = bestImperfect;

        if (s.perfectStake > 0 && s.runnerUpStake > 0) {
            s.perfectPool = (payable_ * PERFECT_SHARE_BPS) / 10000;
            s.runnerUpPool = payable_ - s.perfectPool;
        } else if (s.perfectStake > 0) {
            s.perfectPool = payable_;   // everyone was perfect
        } else if (s.runnerUpStake > 0) {
            s.runnerUpPool = payable_;  // nobody was perfect, best tier takes it all
        }

        if (rake > 0 && p.pot > 0) {
            accFees += rake;
            totalPots -= rake;
        }

        emit ParlaySettled(_parlayId, winningCombo, voidMask, payable_, s.perfectStake, bestImperfect);
    }

    /**
     * @notice Safety valve. If the legs never resolved and refundAfter has passed,
     *         anyone can open refunds — every ticket takes back exactly its stake
     *         and no rake is taken.
     */
    function refundParlay(uint256 _parlayId) external {
        Parlay storage p = parlays[_parlayId];
        require(p.legCount != 0, "NC");
        require(!p.settled && !p.refunded, "AS");
        require(block.timestamp >= p.refundAfter, "TE");

        p.closed = true;
        p.refunded = true;
        emit ParlayRefunded(_parlayId, msg.sender);
    }

    // ═══════════════════════════════════════════
    //  CLAIMING
    // ═══════════════════════════════════════════

    function claim(uint256 _parlayId, uint8 _combo) public nonReentrant returns (uint256 payout) {
        Parlay storage p = parlays[_parlayId];
        require(p.settled || p.refunded, "NS");

        uint256 stake = stakeOf[_parlayId][_combo][msg.sender];
        require(stake > 0, "NT");

        stakeOf[_parlayId][_combo][msg.sender] = 0;
        payout = p.refunded ? stake : _payoutFor(_parlayId, _combo, stake);

        if (payout > 0) {
            totalPots -= payout;
            _push(msg.sender, payout);
        }
        emit TicketClaimed(_parlayId, msg.sender, _combo, payout);
    }

    /// @notice Claim across several cards in one transaction.
    function claimMany(uint256[] calldata _parlayIds, uint8[] calldata _combos) external returns (uint256 total) {
        require(_parlayIds.length == _combos.length, "LEN");
        for (uint256 i = 0; i < _parlayIds.length; i++) {
            if (stakeOf[_parlayIds[i]][_combos[i]][msg.sender] == 0) continue;
            Parlay storage p = parlays[_parlayIds[i]];
            if (!p.settled && !p.refunded) continue;
            total += claim(_parlayIds[i], _combos[i]);
        }
    }

    function _payoutFor(uint256 _parlayId, uint8 _combo, uint256 _stake) internal view returns (uint256) {
        Settlement storage s = settlements[_parlayId];
        uint8 n = parlays[_parlayId].legCount;
        uint8 hits = _hitsFor(_combo, s.winningCombo, s.voidMask, n);

        if (hits == n && s.perfectStake > 0) {
            return (_stake * s.perfectPool) / s.perfectStake;
        }
        if (hits == s.runnerUpHits && s.runnerUpStake > 0 && s.runnerUpPool > 0) {
            return (_stake * s.runnerUpPool) / s.runnerUpStake;
        }
        return 0;
    }

    // ═══════════════════════════════════════════
    //  VIEWS — the tote board
    // ═══════════════════════════════════════════

    /**
     * @notice What a ticket would pay if betting closed right now.
     * @dev The honest live number: it assumes this stake joins the pot and its
     *      combo wins outright. It moves as more money arrives — up when others
     *      back different combos, down when they pile onto this one — and it is
     *      final the moment the card closes, which is before any leg is fought.
     */
    function quote(uint256 _parlayId, uint8 _combo, uint256 _amount)
        external view returns (uint256 payout, uint256 pot, uint256 comboTotal)
    {
        Parlay storage p = parlays[_parlayId];
        pot = p.pot + _amount;
        comboTotal = comboStake[_parlayId][_combo] + _amount;
        if (comboTotal == 0) return (0, pot, 0);

        uint256 payable_ = pot - ((pot - p.seed) * p.rakeBps) / 10000;

        // If any other combination is backed, it lands in the runner-up tier at
        // settlement and takes its cut. If this is the only combination with
        // money on it, every ticket is perfect together and the pot comes back
        // whole. Checking that here is what makes this number exact rather than
        // 20% optimistic.
        uint256 winnersPool = payable_;
        uint256 combos = uint256(1) << p.legCount;
        for (uint256 c = 0; c < combos; c++) {
            if (uint8(c) == _combo) continue;
            if (comboStake[_parlayId][uint8(c)] > 0) {
                winnersPool = (payable_ * PERFECT_SHARE_BPS) / 10000;
                break;
            }
        }

        payout = (_amount * winnersPool) / comboTotal;
    }

    /// @notice Every combo's staked total, indexed by combo. For rendering the board.
    function comboStakes(uint256 _parlayId) external view returns (uint256[] memory stakes) {
        uint8 n = parlays[_parlayId].legCount;
        uint256 combos = uint256(1) << n;
        stakes = new uint256[](combos);
        for (uint256 c = 0; c < combos; c++) {
            stakes[c] = comboStake[_parlayId][uint8(c)];
        }
    }

    function getParlay(uint256 _parlayId) external view returns (
        uint64 cardId, uint8 legCount, uint16 rakeBps,
        uint64 closesAt, uint64 refundAfter,
        bool closed, bool settled, bool refunded,
        uint256 pot, uint256 seed, uint256[] memory legs
    ) {
        Parlay storage p = parlays[_parlayId];
        return (
            p.cardId, p.legCount, p.rakeBps,
            p.closesAt, p.refundAfter,
            p.closed, p.settled, p.refunded,
            p.pot, p.seed, _legs[_parlayId]
        );
    }

    /// @notice How many legs a combo called right. Only meaningful once settled.
    function hitsFor(uint256 _parlayId, uint8 _combo) external view returns (uint8) {
        Settlement storage s = settlements[_parlayId];
        return _hitsFor(_combo, s.winningCombo, s.voidMask, parlays[_parlayId].legCount);
    }

    function claimable(uint256 _parlayId, uint8 _combo, address _user) external view returns (uint256) {
        uint256 stake = stakeOf[_parlayId][_combo][_user];
        if (stake == 0) return 0;
        if (parlays[_parlayId].refunded) return stake;
        if (!parlays[_parlayId].settled) return 0;
        return _payoutFor(_parlayId, _combo, stake);
    }

    /// @notice True while the contract holds at least what it owes every ticket.
    function solvent() external view returns (bool) {
        return collateral.balanceOf(address(this)) >= totalPots + accFees;
    }

    // ═══════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═══════════════════════════════════════════

    /// @dev A voided leg is a hit for every ticket, which shortens the parlay
    ///      rather than voiding it.
    function _hitsFor(uint8 _combo, uint8 _winning, uint8 _voidMask, uint8 _legCount)
        internal pure returns (uint8)
    {
        uint8 missed = (_combo ^ _winning) & ~_voidMask & _comboMask(_legCount);
        return _legCount - _popcount(missed);
    }

    function _comboMask(uint8 _legCount) internal pure returns (uint8) {
        return uint8((uint16(1) << _legCount) - 1);
    }

    function _popcount(uint8 _x) internal pure returns (uint8 count) {
        uint8 x = _x;
        while (x != 0) {
            x &= x - 1;
            count++;
        }
    }

    function _pull(address _from, uint256 _amount) internal {
        uint256 before = collateral.balanceOf(address(this));
        _tokenCall(abi.encodeWithSelector(IERC20.transferFrom.selector, _from, address(this), _amount));
        require(collateral.balanceOf(address(this)) - before == _amount, "FOT");
    }

    function _push(address _to, uint256 _amount) internal {
        _tokenCall(abi.encodeWithSelector(IERC20.transfer.selector, _to, _amount));
    }

    function _tokenCall(bytes memory _data) internal {
        (bool ok, bytes memory ret) = address(collateral).call(_data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "TF");
    }
}
