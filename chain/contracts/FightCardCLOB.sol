// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FightCardCLOB — On-Chain Order Book for Fight Night
 * @notice One contract for every bout on every card. Each bout is a two-outcome
 *         market: FIGHTER_A or FIGHTER_B. 1 winning share = 1 collateral unit.
 *
 *  Core Model:
 *    - A + B shares. mint(): N collateral → N A shares + N B shares
 *                    burn(): N A + N B → N collateral back
 *    - Shares are internal balances (not ERC-20)
 *    - Collateral is one ERC-20 fixed at deploy (6–18 decimals)
 *
 *  Price Ticks: 1–99 (cents). 1¢ = 0.01 collateral units per share.
 *
 *  Matching Engine (per bout, per side):
 *    1. Direct:        A bid at P matches A ask at ≤ P
 *    2. Complementary: A bid at P matches B bid at exactly (100−P)
 *                      → mints a complete set out of the combined collateral
 *    3. Remainder:     GTC rests on the book. FOK reverts. FAK is dropped.
 *
 *  Scalability / Gas:
 *    - Head-based FIFO queue per level: time priority, amortized O(1) tombstone skipping
 *    - O(1) cancel: tombstone (shares=0) + per-level live counters, no array mutation
 *    - Best price pointers driven by live counters, never by scanning arrays
 *    - _autoCompact() during matching rebuilds a level and resets its head
 *
 *  Lifecycle. The league runs on its own broadcast clock, which an admin can
 *  pause or fast-forward, so a bout's opening bell can't be pinned to a
 *  wall-clock timestamp at creation. The bell is an operator call, with
 *  wall-clock backstops behind it so nothing can hang forever:
 *
 *    OPEN --closeBout()--> CLOSED --resolveBout()--> RESOLVED --redeem()
 *      ↑ anyone may close after `latestCloseAt`
 *                                  ↑ anyone may void after `voidAfter`
 *
 *  Draws. A bout with no winner resolves VOID, and every share — A and B alike —
 *  redeems for its pro-rata slice of that bout's pool. Collateral only enters on
 *  mint and only leaves on burn/redeem (trading moves it between users, never
 *  out), so `collateralPool == totalShares[A] == totalShares[B]` holds at all
 *  times and a void is fully funded by construction. It pays 0.50 per share; it
 *  does not refund cost basis, which no order book can do — the counterparty
 *  already walked off with the difference.
 *
 *  Safety:
 *    - Pull-based withdrawals for every collateral outflow
 *    - Solvency invariant enforced before any transfer out
 *    - No native-token paths: the contract never holds or moves ETH
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

contract FightCardCLOB {
    enum Outcome { UNRESOLVED, FIGHTER_A, FIGHTER_B, VOID }
    enum OrderType { GTC, FOK, FAK }

    uint256 public constant MAX_FEE_BPS = 100;          // 1% ceiling on the taker fee
    /// @notice The taker fee splits two ways, and this is the maker's share of
    ///         it: 25%, leaving 75% for the platform. A constant rather than a
    ///         setting — a rebate somebody quoted a market on is not something
    ///         the owner should be able to move out from under them mid-card.
    uint256 public constant MAKER_REBATE_BPS = 2500;
    uint256 internal constant PRICE_PRECISION = 100;    // cents
    uint16  internal constant MAX_ORDERS_PER_LEVEL = 500;
    uint256 internal constant MAX_ORDERS_PER_USER = 500;
    uint256 internal constant MAX_FILLS_PER_ORDER = 50;
    uint256 internal constant AUTO_COMPACT_THRESHOLD = 200;
    uint256 internal constant AUTO_COMPACT_MAX_WORK = 300;

    uint8 public constant SIDE_A = 0;
    uint8 public constant SIDE_B = 1;

    // ── Collateral ──
    IERC20  public immutable collateral;
    uint256 public immutable oneUnit;        // 10 ** decimals
    uint256 public immutable minShares;      // smallest order, in shares
    uint256 public immutable minOrderValue;  // smallest order, in collateral

    // ── Roles ──
    address public owner;         // sets the operator and fee policy
    address public operator;      // the league: creates, closes and resolves bouts
    address public feeRecipient;
    uint256 public takerFeeBps;

    // ── Bouts ──
    struct Bout {
        uint64  cardId;
        bytes32 fighterA;
        bytes32 fighterB;
        uint64  latestCloseAt;  // after this, anyone may close betting
        uint64  voidAfter;      // after this, anyone may force VOID
        Outcome outcome;
        bool    closed;
        bool    resolved;
    }

    uint256 public nextBoutId = 1;
    mapping(uint256 => Bout) public bouts;

    mapping(uint256 => uint256) public collateralPool;                          // [bout]
    mapping(uint256 => mapping(uint8 => uint256)) public totalShares;           // [bout][side]
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public sharesOf;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public escrowedOf;

    // ── Order Book ──
    struct Order {
        address owner;    // slot 1: 20 + 12 bytes
        uint96  shares;   // remaining shares
        uint64  id;       // slot 2
        uint64  boutId;
        uint8   price;    // 1-99 cents
        uint8   side;     // SIDE_A | SIDE_B
        bool    isBuy;    // true=bid, false=ask
    }

    uint64 public nextOrderId = 1;
    mapping(uint64 => Order) public orders;

    // [bout][side][price]
    mapping(uint256 => mapping(uint8 => mapping(uint8 => uint64[]))) internal _bids;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => uint64[]))) internal _asks;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => uint256))) internal _bidsHead;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => uint256))) internal _asksHead;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => uint16))) internal _bidsLive;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => uint16))) internal _asksLive;

    mapping(uint256 => mapping(uint8 => uint8)) public bestBid;  // 0 = none
    mapping(uint256 => mapping(uint8 => uint8)) public bestAsk;  // 100 = none

    mapping(address => uint64[]) public userOrders;
    mapping(address => uint256) public activeOrderCount;

    // ── Pull-based withdrawals ──
    mapping(address => uint256) public pendingWithdrawal;
    uint256 public totalPendingWithdrawal;

    // ── Solvency tracking (global, across every bout) ──
    uint256 public totalCollateral;      // sum of every bout's collateralPool
    uint256 public totalBidCollateral;   // collateral locked in resting bids
    uint256 public accFees;

    // ── Reentrancy guard ──
    uint256 private _locked = 1;

    // ── Events ──
    event BoutCreated(uint256 indexed boutId, uint64 indexed cardId, bytes32 fighterA, bytes32 fighterB, uint64 latestCloseAt, uint64 voidAfter);
    event BoutClosed(uint256 indexed boutId, address closedBy);
    event BoutResolved(uint256 indexed boutId, Outcome outcome, address resolvedBy);
    event OrderPlaced(uint64 indexed orderId, uint256 indexed boutId, address indexed owner, uint8 side, bool isBuy, uint8 price, uint256 shares);
    event OrderFilled(uint64 indexed takerOrderId, uint64 indexed makerOrderId, uint256 indexed boutId, uint256 shares, uint8 price, uint8 side, bool takerIsBuy);
    event OrderCancelled(uint64 indexed orderId, address indexed owner, uint256 refundedShares);
    event SharesMinted(uint256 indexed boutId, address indexed user, uint256 amount);
    event SharesBurned(uint256 indexed boutId, address indexed user, uint256 amount);
    event SharesRedeemed(uint256 indexed boutId, address indexed redeemer, uint256 payout);
    event Withdrawal(address indexed user, uint256 amount);
    event FeesClaimed(address indexed to, uint256 amount);
    event OperatorUpdated(address operator);
    event FeeConfigUpdated(address feeRecipient, uint256 takerFeeBps);

    modifier onlyOwner() {
        require(msg.sender == owner, "NO");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "NP");
        _;
    }

    modifier boutOpen(uint256 _boutId) {
        Bout storage b = bouts[_boutId];
        require(b.latestCloseAt != 0, "NB");
        require(!b.closed, "CL");
        require(block.timestamp < b.latestCloseAt, "MC");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, "RE");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address _collateral, address _operator, address _feeRecipient, uint256 _takerFeeBps) {
        require(_collateral != address(0) && _operator != address(0), "A0");
        require(_takerFeeBps <= MAX_FEE_BPS, "FB");
        require(_feeRecipient != address(0) || _takerFeeBps == 0, "FR");

        uint8 dec = IERC20Decimals(_collateral).decimals();
        require(dec >= 6 && dec <= 18, "DEC");

        collateral = IERC20(_collateral);
        oneUnit = 10 ** dec;
        minShares = (10 ** dec) / 1000;      // 0.001 shares
        minOrderValue = (10 ** dec) / 10000; // 0.0001 collateral

        owner = msg.sender;
        operator = _operator;
        feeRecipient = _feeRecipient;
        takerFeeBps = _takerFeeBps;
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

    /// @dev Only affects fills placed after the change; it never touches a resting order.
    function setFeeConfig(address _feeRecipient, uint256 _takerFeeBps) external onlyOwner {
        require(_takerFeeBps <= MAX_FEE_BPS, "FB");
        require(_feeRecipient != address(0) || _takerFeeBps == 0, "FR");
        feeRecipient = _feeRecipient;
        takerFeeBps = _takerFeeBps;
        emit FeeConfigUpdated(_feeRecipient, _takerFeeBps);
    }

    function claimFees() external {
        require(msg.sender == feeRecipient || msg.sender == owner, "NA");
        uint256 amount = accFees;
        require(amount > 0, "NF");
        accFees = 0;
        _creditWithdrawal(feeRecipient, amount);
        emit FeesClaimed(feeRecipient, amount);
    }

    // ═══════════════════════════════════════════
    //  BOUT LIFECYCLE
    // ═══════════════════════════════════════════

    /**
     * @param _latestCloseAt Wall-clock backstop. Betting stops here even if the
     *        operator never calls closeBout — set it comfortably past the slot's
     *        expected airtime, since the league clock can be paused.
     * @param _voidAfter Wall-clock backstop for resolution. Past this, anyone can
     *        force the bout VOID and everyone redeems pro-rata.
     */
    function createBout(
        uint64 _cardId,
        bytes32 _fighterA,
        bytes32 _fighterB,
        uint64 _latestCloseAt,
        uint64 _voidAfter
    ) external onlyOperator returns (uint256 boutId) {
        return _createBout(_cardId, _fighterA, _fighterB, _latestCloseAt, _voidAfter);
    }

    /// @notice Books a whole night in one transaction.
    function createCard(
        uint64 _cardId,
        bytes32[] calldata _fightersA,
        bytes32[] calldata _fightersB,
        uint64 _latestCloseAt,
        uint64 _voidAfter
    ) external onlyOperator returns (uint256[] memory boutIds) {
        uint256 n = _fightersA.length;
        require(n > 0 && n == _fightersB.length, "LEN");

        boutIds = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            boutIds[i] = _createBout(_cardId, _fightersA[i], _fightersB[i], _latestCloseAt, _voidAfter);
        }
    }

    function _createBout(
        uint64 _cardId,
        bytes32 _fighterA,
        bytes32 _fighterB,
        uint64 _latestCloseAt,
        uint64 _voidAfter
    ) internal returns (uint256 boutId) {
        require(_latestCloseAt > block.timestamp, "CT");
        require(_voidAfter > _latestCloseAt, "VT");
        require(_fighterA != _fighterB, "SF");

        boutId = nextBoutId++;

        Bout storage b = bouts[boutId];
        b.cardId = _cardId;
        b.fighterA = _fighterA;
        b.fighterB = _fighterB;
        b.latestCloseAt = _latestCloseAt;
        b.voidAfter = _voidAfter;

        bestAsk[boutId][SIDE_A] = 100;
        bestAsk[boutId][SIDE_B] = 100;

        emit BoutCreated(boutId, _cardId, _fighterA, _fighterB, _latestCloseAt, _voidAfter);
    }

    /// @notice The opening bell. Operator any time; anyone once `latestCloseAt` passes.
    function closeBout(uint256 _boutId) public {
        Bout storage b = bouts[_boutId];
        require(b.latestCloseAt != 0, "NB");
        require(!b.closed, "CL");
        require(msg.sender == operator || block.timestamp >= b.latestCloseAt, "NA");

        b.closed = true;
        emit BoutClosed(_boutId, msg.sender);
    }

    function closeBouts(uint256[] calldata _boutIds) external {
        for (uint256 i = 0; i < _boutIds.length; i++) closeBout(_boutIds[i]);
    }

    /// @notice Settles a bout. A draw — the league reports no winner — is VOID.
    function resolveBout(uint256 _boutId, Outcome _outcome) public onlyOperator {
        Bout storage b = bouts[_boutId];
        require(b.latestCloseAt != 0, "NB");
        require(!b.resolved, "AR");
        require(
            _outcome == Outcome.FIGHTER_A || _outcome == Outcome.FIGHTER_B || _outcome == Outcome.VOID,
            "IO"
        );

        b.closed = true;
        b.resolved = true;
        b.outcome = _outcome;

        _freezeBook(_boutId);
        emit BoutResolved(_boutId, _outcome, msg.sender);
    }

    function resolveBouts(uint256[] calldata _boutIds, Outcome[] calldata _outcomes) external {
        require(_boutIds.length == _outcomes.length, "LEN");
        for (uint256 i = 0; i < _boutIds.length; i++) resolveBout(_boutIds[i], _outcomes[i]);
    }

    /// @notice Safety valve: if the operator never resolves, anyone can void the
    ///         bout once `voidAfter` passes and every share redeems pro-rata.
    function forceVoid(uint256 _boutId) external {
        Bout storage b = bouts[_boutId];
        require(b.latestCloseAt != 0, "NB");
        require(!b.resolved, "AR");
        require(block.timestamp >= b.voidAfter, "TE");

        b.closed = true;
        b.resolved = true;
        b.outcome = Outcome.VOID;

        _freezeBook(_boutId);
        emit BoutResolved(_boutId, Outcome.VOID, msg.sender);
    }

    /// @dev Resting orders keep their collateral until cancelled or swept; only
    ///      the best-price pointers are cleared so nothing can match again.
    function _freezeBook(uint256 _boutId) internal {
        bestBid[_boutId][SIDE_A] = 0;
        bestBid[_boutId][SIDE_B] = 0;
        bestAsk[_boutId][SIDE_A] = 100;
        bestAsk[_boutId][SIDE_B] = 100;
    }

    // ═══════════════════════════════════════════
    //  MINT / BURN — Complete sets
    // ═══════════════════════════════════════════

    function mint(uint256 _boutId, uint256 _amount) external boutOpen(_boutId) nonReentrant {
        require(_amount >= minShares, "SD");
        require(_amount % PRICE_PRECISION == 0, "GRAN");

        sharesOf[_boutId][SIDE_A][msg.sender] += _amount;
        sharesOf[_boutId][SIDE_B][msg.sender] += _amount;
        totalShares[_boutId][SIDE_A] += _amount;
        totalShares[_boutId][SIDE_B] += _amount;
        collateralPool[_boutId] += _amount;
        totalCollateral += _amount;

        _pull(msg.sender, _amount);
        emit SharesMinted(_boutId, msg.sender, _amount);
    }

    function burn(uint256 _boutId, uint256 _amount) external nonReentrant {
        Bout storage b = bouts[_boutId];
        require(b.latestCloseAt != 0, "NB");
        require(!b.closed, "CL");
        require(_amount > 0, "A0");
        require(sharesOf[_boutId][SIDE_A][msg.sender] >= _amount, "IA");
        require(sharesOf[_boutId][SIDE_B][msg.sender] >= _amount, "IB");

        sharesOf[_boutId][SIDE_A][msg.sender] -= _amount;
        sharesOf[_boutId][SIDE_B][msg.sender] -= _amount;
        totalShares[_boutId][SIDE_A] -= _amount;
        totalShares[_boutId][SIDE_B] -= _amount;
        collateralPool[_boutId] -= _amount;
        totalCollateral -= _amount;

        _creditWithdrawal(msg.sender, _amount);
        emit SharesBurned(_boutId, msg.sender, _amount);
    }

    // ═══════════════════════════════════════════
    //  ORDER PLACEMENT
    // ═══════════════════════════════════════════

    /// @dev Collateral is pulled once, at the end, for exactly what the order
    ///      consumed — so a taker never over-approves for a fill that didn't happen.
    function placeBuyOrder(
        uint256 _boutId,
        uint8 _side,
        uint8 _price,
        uint256 _shares,
        OrderType _orderType
    ) external boutOpen(_boutId) nonReentrant returns (uint64 orderId) {
        _validateOrder(_side, _price, _shares);

        orderId = nextOrderId++;
        uint256 remaining = _shares;
        uint256 spend = 0;
        uint256 fills = 0;

        // A corner is offered from two places at once: an ask on that corner,
        // and a bid on the other one, which funds the other half of a set. Both
        // are offers of the same thing, so the taker is owed whichever is
        // cheaper. Draining asks in full before looking at complementary bids,
        // as this used to, overpaid on every ask sitting above a bid.
        //
        // Each pass caps one matcher at the other's best price, so it takes
        // exactly the levels on which it is the cheaper of the two, and then
        // the two are compared again.
        uint8 otherSide = _side == SIDE_A ? SIDE_B : SIDE_A;

        while (remaining > 0 && fills < MAX_FILLS_PER_ORDER) {
            uint8 askAt = bestAsk[_boutId][_side];
            uint8 bid = bestBid[_boutId][otherSide];
            uint8 compAt = bid == 0 ? uint8(PRICE_PRECISION) : uint8(PRICE_PRECISION - uint256(bid));
            if (askAt > _price && compAt > _price) break;

            uint256 before = remaining;
            if (askAt <= compAt) {
                (remaining, spend, fills) = _matchBuyAgainstAsks(
                    _boutId, orderId, _side, remaining, _price < compAt ? _price : compAt, spend, fills
                );
            } else {
                (remaining, spend, fills) = _matchBuyComplementary(
                    _boutId, orderId, _side, remaining, _price < askAt ? _price : askAt, spend, fills
                );
            }
            // Neither side moved, so nothing reachable is left to take.
            if (remaining == before) break;
        }

        if (_orderType == OrderType.FOK) {
            require(remaining == 0, "FK");
        } else if (_orderType == OrderType.GTC && remaining > 0) {
            require(_bidsLive[_boutId][_side][_price] < MAX_ORDERS_PER_LEVEL, "BF");

            _rest(orderId, _boutId, _side, _price, remaining, true);
            _bids[_boutId][_side][_price].push(orderId);
            _bidsLive[_boutId][_side][_price] += 1;
            if (_price > bestBid[_boutId][_side]) bestBid[_boutId][_side] = _price;

            uint256 locked = (remaining * _price) / PRICE_PRECISION;
            totalBidCollateral += locked;
            spend += locked;
        }

        _pull(msg.sender, spend);
    }

    function placeSellOrder(
        uint256 _boutId,
        uint8 _side,
        uint8 _price,
        uint256 _shares,
        OrderType _orderType
    ) external boutOpen(_boutId) nonReentrant returns (uint64 orderId) {
        _validateOrder(_side, _price, _shares);
        require(sharesOf[_boutId][_side][msg.sender] >= _shares, "IS");
        sharesOf[_boutId][_side][msg.sender] -= _shares;

        orderId = nextOrderId++;
        uint256 remaining = _shares;
        uint256 earned = 0;

        (remaining, earned) = _matchSellAgainstBids(_boutId, orderId, _side, remaining, _price);

        if (_orderType == OrderType.FOK) {
            require(remaining == 0, "FK");
        } else if (_orderType == OrderType.GTC && remaining > 0) {
            require(_asksLive[_boutId][_side][_price] < MAX_ORDERS_PER_LEVEL, "BF");

            _rest(orderId, _boutId, _side, _price, remaining, false);
            _asks[_boutId][_side][_price].push(orderId);
            _asksLive[_boutId][_side][_price] += 1;
            if (_price < bestAsk[_boutId][_side]) bestAsk[_boutId][_side] = _price;

            escrowedOf[_boutId][_side][msg.sender] += remaining;
        } else if (remaining > 0) {
            // FAK: hand the unfilled shares straight back
            sharesOf[_boutId][_side][msg.sender] += remaining;
        }

        if (earned > 0) _creditWithdrawal(msg.sender, earned);
    }

    function _validateOrder(uint8 _side, uint8 _price, uint256 _shares) internal view {
        require(_side <= SIDE_B, "SI");
        require(_price >= 1 && _price <= 99, "P1");
        require(_shares >= minShares, "SD");
        require(_shares <= type(uint96).max, "S96");
        require(_shares % PRICE_PRECISION == 0, "GRAN");
        require((_shares * _price) / PRICE_PRECISION >= minOrderValue, "MS");
    }

    function _rest(uint64 _orderId, uint256 _boutId, uint8 _side, uint8 _price, uint256 _shares, bool _isBuy) internal {
        require(activeOrderCount[msg.sender] < MAX_ORDERS_PER_USER, "UL");

        Order storage o = orders[_orderId];
        o.owner = msg.sender;
        o.shares = uint96(_shares);
        o.id = _orderId;
        o.boutId = uint64(_boutId);
        o.price = _price;
        o.side = _side;
        o.isBuy = _isBuy;

        userOrders[msg.sender].push(_orderId);
        activeOrderCount[msg.sender]++;

        emit OrderPlaced(_orderId, _boutId, msg.sender, _side, _isBuy, _price, _shares);
    }

    /// @dev O(1) cancel: tombstone + counters, no array mutation. Always allowed —
    ///      an owner can reclaim their own collateral in any bout state.
    function cancelOrder(uint64 _orderId) public {
        Order storage o = orders[_orderId];
        require(o.owner == msg.sender, "NY");
        require(o.shares > 0, "AF");

        uint256 remaining = uint256(o.shares);
        uint256 boutId = uint256(o.boutId);
        o.shares = 0;

        if (activeOrderCount[msg.sender] > 0) activeOrderCount[msg.sender]--;

        if (o.isBuy) {
            uint256 refund = (remaining * o.price) / PRICE_PRECISION;
            totalBidCollateral -= refund;
            _creditWithdrawal(msg.sender, refund);
        } else {
            _returnEscrowed(boutId, o.side, msg.sender, remaining);
        }

        _decLiveAndMaybeUpdateBest(boutId, o.side, o.price, o.isBuy);
        emit OrderCancelled(_orderId, msg.sender, remaining);
    }

    /// @notice Paginated bulk cancel — the cleanup path after a card has settled.
    function cancelMyOrders(uint256 _startIdx, uint256 _maxBatch) external returns (uint256 nextIdx) {
        uint64[] storage ords = userOrders[msg.sender];
        uint256 end = _startIdx + _maxBatch;
        if (end > ords.length) end = ords.length;

        for (uint256 i = _startIdx; i < end; i++) {
            if (orders[ords[i]].shares > 0) cancelOrder(ords[i]);
        }
        nextIdx = end;
    }

    /// @notice Permissionless cleanup of a resolved bout's book: refunds every
    ///         resting order at one level back to its owner.
    function sweepLevel(uint256 _boutId, uint8 _side, uint8 _price, bool _isBid) external {
        require(bouts[_boutId].resolved, "NR");
        require(_side <= SIDE_B, "SI");
        require(_price >= 1 && _price <= 99, "P1");

        uint16 live = _isBid ? _bidsLive[_boutId][_side][_price] : _asksLive[_boutId][_side][_price];
        if (live == 0) return;

        uint64[] storage book = _isBid ? _bids[_boutId][_side][_price] : _asks[_boutId][_side][_price];
        uint256 idx = _isBid ? _bidsHead[_boutId][_side][_price] : _asksHead[_boutId][_side][_price];
        uint256 cleared = 0;

        while (idx < book.length && cleared < live) {
            Order storage o = orders[book[idx]];
            idx++;
            if (o.shares == 0) continue;

            uint256 rem = uint256(o.shares);
            o.shares = 0;
            cleared++;

            if (activeOrderCount[o.owner] > 0) activeOrderCount[o.owner]--;

            if (_isBid) {
                uint256 refund = (rem * o.price) / PRICE_PRECISION;
                totalBidCollateral -= refund;
                _creditWithdrawal(o.owner, refund);
            } else {
                _returnEscrowed(_boutId, _side, o.owner, rem);
            }

            emit OrderCancelled(o.id, o.owner, rem);
        }

        require(cleared == live, "INCOMPLETE");
        _deleteLevel(_boutId, _side, _price, _isBid);
    }

    // ═══════════════════════════════════════════
    //  MATCHING ENGINE
    // ═══════════════════════════════════════════

    function _matchBuyAgainstAsks(
        uint256 _boutId,
        uint64 _takerOrderId,
        uint8 _side,
        uint256 _remaining,
        uint8 _maxPrice,
        uint256 _spend,
        uint256 _fills
    ) internal returns (uint256 remaining, uint256 spend, uint256 fills) {
        remaining = _remaining;
        spend = _spend;
        fills = _fills;

        uint8 askPrice = bestAsk[_boutId][_side];

        while (remaining > 0 && askPrice <= _maxPrice && askPrice < 100 && fills < MAX_FILLS_PER_ORDER) {
            if (_asksLive[_boutId][_side][askPrice] == 0) {
                askPrice = _nextAskPrice(_boutId, _side, askPrice);
                continue;
            }

            uint64[] storage book = _asks[_boutId][_side][askPrice];
            uint256 i = _skipZeros(book, _asksHead[_boutId][_side][askPrice]);

            while (i < book.length && remaining > 0 && fills < MAX_FILLS_PER_ORDER) {
                Order storage maker = orders[book[i]];
                if (maker.shares == 0) { i++; continue; }

                uint256 makerShares = uint256(maker.shares);
                uint256 fillQty = remaining < makerShares ? remaining : makerShares;

                uint256 fillValue = (fillQty * askPrice) / PRICE_PRECISION;
                uint256 fee = (fillValue * takerFeeBps) / 10000;

                spend += fillValue + fee;
                _settleFee(maker.owner, fee);

                // maker sold shares they had escrowed; they get the proceeds
                _creditWithdrawal(maker.owner, fillValue);
                escrowedOf[_boutId][_side][maker.owner] -= fillQty;
                sharesOf[_boutId][_side][msg.sender] += fillQty;

                maker.shares = uint96(makerShares - fillQty);
                remaining -= fillQty;

                emit OrderFilled(_takerOrderId, maker.id, _boutId, fillQty, askPrice, _side, true);
                fills++;

                // Only advance once the maker is fully consumed — preserves FIFO on partial fills.
                if (maker.shares == 0) {
                    if (activeOrderCount[maker.owner] > 0) activeOrderCount[maker.owner]--;
                    _asksLive[_boutId][_side][askPrice] -= 1;
                    i++;
                }
            }

            i = _skipZeros(book, i);
            _asksHead[_boutId][_side][askPrice] = i;

            if (_asksLive[_boutId][_side][askPrice] == 0) {
                _deleteLevel(_boutId, _side, askPrice, false);
                askPrice = _nextAskPrice(_boutId, _side, askPrice);
            } else {
                if (i >= AUTO_COMPACT_THRESHOLD && book.length <= i + AUTO_COMPACT_MAX_WORK) {
                    _autoCompact(book, _boutId, _side, askPrice, false);
                }
                break;
            }
        }

        bestAsk[_boutId][_side] = askPrice;
    }

    /// @dev A bid at P on one side pairs with a bid at exactly (100−P) on the
    ///      other: together they fund a whole set, so the contract mints one and
    ///      hands each party the side they asked for.
    function _matchBuyComplementary(
        uint256 _boutId,
        uint64 _takerOrderId,
        uint8 _side,
        uint256 _remaining,
        uint8 _price,
        uint256 _spend,
        uint256 _fills
    ) internal returns (uint256 remaining, uint256 spend, uint256 fills) {
        remaining = _remaining;
        spend = _spend;
        fills = _fills;

        uint8 otherSide = _side == SIDE_A ? SIDE_B : SIDE_A;
        // The cheapest set is minted against the *highest* complementary bid, so
        // this walks down from the best exactly as `_matchSellAgainstBids` does.
        //
        // It used to look at one level only — the single price mirroring the
        // taker's limit — which meant a buy of A at 59 matched a B bid at 41 and
        // nothing else, and would not touch a B bid at 44 even though that is a
        // *better* price for the buyer. Any order carrying slippage tolerance,
        // which is every market order anywhere, therefore filled nothing at all
        // rather than filling well. A limit is a worst acceptable price, not an
        // exact one.
        uint8 minComp = uint8(PRICE_PRECISION - uint256(_price));
        uint8 compPrice = bestBid[_boutId][otherSide];

        while (remaining > 0 && compPrice >= minComp && compPrice >= 1 && fills < MAX_FILLS_PER_ORDER) {
            if (_bidsLive[_boutId][otherSide][compPrice] == 0) {
                compPrice = _prevBidPrice(_boutId, otherSide, compPrice);
                continue;
            }

            // What the taker actually pays, which is at or below their limit.
            uint8 execPrice = uint8(PRICE_PRECISION - uint256(compPrice));

            uint64[] storage book = _bids[_boutId][otherSide][compPrice];
            uint256 i = _skipZeros(book, _bidsHead[_boutId][otherSide][compPrice]);

            while (i < book.length && remaining > 0 && fills < MAX_FILLS_PER_ORDER) {
                Order storage maker = orders[book[i]];
                if (maker.shares == 0) { i++; continue; }

                uint256 makerShares = uint256(maker.shares);
                uint256 fillQty = remaining < makerShares ? remaining : makerShares;

                uint256 takerCost = (fillQty * execPrice) / PRICE_PRECISION;
                uint256 makerLocked = (fillQty * compPrice) / PRICE_PRECISION;
                require(takerCost + makerLocked == fillQty, "MINT_ARITH");

                uint256 fee = (takerCost * takerFeeBps) / 10000;
                spend += takerCost + fee;
                _settleFee(maker.owner, fee);

                // the maker's locked bid collateral becomes part of the new set
                totalBidCollateral -= makerLocked;
                collateralPool[_boutId] += fillQty;
                totalCollateral += fillQty;
                totalShares[_boutId][_side] += fillQty;
                totalShares[_boutId][otherSide] += fillQty;

                sharesOf[_boutId][_side][msg.sender] += fillQty;
                sharesOf[_boutId][otherSide][maker.owner] += fillQty;

                maker.shares = uint96(makerShares - fillQty);
                remaining -= fillQty;

                // The price traded at, not the price asked for — they are no
                // longer the same number once this walks.
                emit OrderFilled(_takerOrderId, maker.id, _boutId, fillQty, execPrice, _side, true);
                fills++;

                if (maker.shares == 0) {
                    if (activeOrderCount[maker.owner] > 0) activeOrderCount[maker.owner]--;
                    _bidsLive[_boutId][otherSide][compPrice] -= 1;
                    i++;
                }
            }

            i = _skipZeros(book, i);
            _bidsHead[_boutId][otherSide][compPrice] = i;

            if (_bidsLive[_boutId][otherSide][compPrice] == 0) {
                _deleteLevel(_boutId, otherSide, compPrice, true);
                compPrice = _prevBidPrice(_boutId, otherSide, compPrice);
            } else {
                if (i >= AUTO_COMPACT_THRESHOLD && book.length <= i + AUTO_COMPACT_MAX_WORK) {
                    _autoCompact(book, _boutId, otherSide, compPrice, true);
                }
                break;
            }
        }

        // Everything above `compPrice` has been consumed, so it is the new best.
        bestBid[_boutId][otherSide] = compPrice;
    }

    function _matchSellAgainstBids(
        uint256 _boutId,
        uint64 _takerOrderId,
        uint8 _side,
        uint256 _remaining,
        uint8 _minPrice
    ) internal returns (uint256 remaining, uint256 earned) {
        remaining = _remaining;
        earned = 0;

        uint256 fills = 0;
        uint8 bidPrice = bestBid[_boutId][_side];

        while (remaining > 0 && bidPrice >= _minPrice && bidPrice >= 1 && fills < MAX_FILLS_PER_ORDER) {
            if (_bidsLive[_boutId][_side][bidPrice] == 0) {
                bidPrice = _prevBidPrice(_boutId, _side, bidPrice);
                continue;
            }

            uint64[] storage book = _bids[_boutId][_side][bidPrice];
            uint256 i = _skipZeros(book, _bidsHead[_boutId][_side][bidPrice]);

            while (i < book.length && remaining > 0 && fills < MAX_FILLS_PER_ORDER) {
                Order storage maker = orders[book[i]];
                if (maker.shares == 0) { i++; continue; }

                uint256 makerShares = uint256(maker.shares);
                uint256 fillQty = remaining < makerShares ? remaining : makerShares;

                uint256 fillValue = (fillQty * bidPrice) / PRICE_PRECISION;
                uint256 fee = (fillValue * takerFeeBps) / 10000;

                earned += fillValue - fee;
                _settleFee(maker.owner, fee);

                // the maker's locked collateral pays for the shares they bid on
                totalBidCollateral -= fillValue;
                sharesOf[_boutId][_side][maker.owner] += fillQty;

                maker.shares = uint96(makerShares - fillQty);
                remaining -= fillQty;

                emit OrderFilled(_takerOrderId, maker.id, _boutId, fillQty, bidPrice, _side, false);
                fills++;

                if (maker.shares == 0) {
                    if (activeOrderCount[maker.owner] > 0) activeOrderCount[maker.owner]--;
                    _bidsLive[_boutId][_side][bidPrice] -= 1;
                    i++;
                }
            }

            i = _skipZeros(book, i);
            _bidsHead[_boutId][_side][bidPrice] = i;

            if (_bidsLive[_boutId][_side][bidPrice] == 0) {
                _deleteLevel(_boutId, _side, bidPrice, true);
                bidPrice = _prevBidPrice(_boutId, _side, bidPrice);
            } else {
                if (i >= AUTO_COMPACT_THRESHOLD && book.length <= i + AUTO_COMPACT_MAX_WORK) {
                    _autoCompact(book, _boutId, _side, bidPrice, true);
                }
                break;
            }
        }

        bestBid[_boutId][_side] = bidPrice;
    }

    // ═══════════════════════════════════════════
    //  REDEMPTION & WITHDRAWAL
    // ═══════════════════════════════════════════

    /**
     * @notice Settles a position once the bout is resolved.
     *         Winner: 1 share = 1 collateral unit. VOID: every share, both sides,
     *         takes a pro-rata slice of the pool. Losing shares are left in place
     *         as the record of the position; they are worth nothing.
     */
    function redeem(uint256 _boutId) public nonReentrant returns (uint256 payout) {
        Bout storage b = bouts[_boutId];
        require(b.resolved, "NR");

        // Shares sitting in unfilled sell orders still belong to the seller.
        _reclaimEscrow(_boutId, SIDE_A);
        _reclaimEscrow(_boutId, SIDE_B);

        if (b.outcome == Outcome.VOID) {
            uint256 a = sharesOf[_boutId][SIDE_A][msg.sender];
            uint256 c = sharesOf[_boutId][SIDE_B][msg.sender];
            require(a + c > 0, "N1");

            uint256 total = totalShares[_boutId][SIDE_A] + totalShares[_boutId][SIDE_B];
            if (total > 0) payout = ((a + c) * collateralPool[_boutId]) / total;

            totalShares[_boutId][SIDE_A] -= a;
            totalShares[_boutId][SIDE_B] -= c;
            sharesOf[_boutId][SIDE_A][msg.sender] = 0;
            sharesOf[_boutId][SIDE_B][msg.sender] = 0;
        } else {
            uint8 winner = b.outcome == Outcome.FIGHTER_A ? SIDE_A : SIDE_B;
            payout = sharesOf[_boutId][winner][msg.sender];
            require(payout > 0, "NW");

            totalShares[_boutId][winner] -= payout;
            sharesOf[_boutId][winner][msg.sender] = 0;
        }

        collateralPool[_boutId] -= payout;
        totalCollateral -= payout;

        _creditWithdrawal(msg.sender, payout);
        emit SharesRedeemed(_boutId, msg.sender, payout);
    }

    /// @notice Settles a whole night at once.
    function redeemMany(uint256[] calldata _boutIds) external returns (uint256 total) {
        for (uint256 i = 0; i < _boutIds.length; i++) total += redeem(_boutIds[i]);
    }

    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = pendingWithdrawal[msg.sender];
        require(amount > 0, "NP");

        pendingWithdrawal[msg.sender] = 0;
        totalPendingWithdrawal -= amount;

        _ensureSolvent();
        _push(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
    }

    // ═══════════════════════════════════════════
    //  VIEWS
    // ═══════════════════════════════════════════

    /// @notice Mid price for a side, in basis points of one collateral unit.
    ///         5000 = 50¢ = an even fight. Falls back to whichever side of the
    ///         book exists, then to 5000 when the book is empty.
    function priceOf(uint256 _boutId, uint8 _side) public view returns (uint256) {
        uint8 bid = bestBid[_boutId][_side];
        uint8 ask = bestAsk[_boutId][_side];

        if (ask < 100 && bid > 0) return (uint256(bid) + uint256(ask)) * 50;
        if (ask < 100) return uint256(ask) * 100;
        if (bid > 0) return uint256(bid) * 100;
        return 5000;
    }

    function getPosition(uint256 _boutId, address _user) external view returns (
        uint256 sharesA, uint256 sharesB, uint256 escrowA, uint256 escrowB
    ) {
        return (
            sharesOf[_boutId][SIDE_A][_user], sharesOf[_boutId][SIDE_B][_user],
            escrowedOf[_boutId][SIDE_A][_user], escrowedOf[_boutId][SIDE_B][_user]
        );
    }

    /// @notice Resting depth at one price level, summed over live orders.
    function levelDepth(uint256 _boutId, uint8 _side, uint8 _price, bool _isBid) public view returns (uint256 depth) {
        uint64[] storage book = _isBid ? _bids[_boutId][_side][_price] : _asks[_boutId][_side][_price];
        uint256 head = _isBid ? _bidsHead[_boutId][_side][_price] : _asksHead[_boutId][_side][_price];

        for (uint256 i = head; i < book.length; i++) {
            depth += uint256(orders[book[i]].shares);
        }
    }

    /// @notice Live order count at one level — lets an off-chain reader skip
    ///         empty levels without pulling the whole book.
    function levelLive(uint256 _boutId, uint8 _side, uint8 _price, bool _isBid) external view returns (uint16) {
        return _isBid ? _bidsLive[_boutId][_side][_price] : _asksLive[_boutId][_side][_price];
    }

    function userOrderCount(address _user) external view returns (uint256) {
        return userOrders[_user].length;
    }

    function totalObligations() public view returns (uint256) {
        return totalCollateral + totalBidCollateral + totalPendingWithdrawal + accFees;
    }

    // ═══════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═══════════════════════════════════════════

    function _creditWithdrawal(address _to, uint256 _amount) internal {
        if (_amount == 0) return;
        pendingWithdrawal[_to] += _amount;
        totalPendingWithdrawal += _amount;
    }

    /// @dev Splits a taker fee between the platform and the resting order that
    ///      got hit. Only the aggressor ever pays — a maker still receives the
    ///      full price of their order and now keeps a quarter of the fee on top.
    ///
    ///      Both destinations are already inside `totalObligations()`, so this
    ///      moves who is owed and never how much: the solvency invariant is
    ///      untouched by construction.
    ///
    ///      Rebating a self-trade is safe and deliberately not special-cased.
    ///      Taking your own order pays 1% and returns 0.25% of it, which is a
    ///      net loss — there is nothing to farm here, and the check would cost
    ///      code in a contract that has little of it left.
    function _settleFee(address _maker, uint256 _fee) internal {
        if (_fee == 0) return;
        uint256 rebate = (_fee * MAKER_REBATE_BPS) / 10000;
        _creditWithdrawal(_maker, rebate);
        accFees += _fee - rebate;
    }

    /// @dev Returns shares from a cancelled sell order; clamped so it can never
    ///      hand back more than is actually escrowed.
    function _returnEscrowed(uint256 _boutId, uint8 _side, address _user, uint256 _amount) internal {
        uint256 esc = escrowedOf[_boutId][_side][_user];
        uint256 ret = _amount < esc ? _amount : esc;
        escrowedOf[_boutId][_side][_user] -= ret;
        sharesOf[_boutId][_side][_user] += ret;
    }

    function _reclaimEscrow(uint256 _boutId, uint8 _side) internal {
        uint256 esc = escrowedOf[_boutId][_side][msg.sender];
        if (esc == 0) return;
        escrowedOf[_boutId][_side][msg.sender] = 0;
        sharesOf[_boutId][_side][msg.sender] += esc;
    }

    function _ensureSolvent() internal view {
        require(collateral.balanceOf(address(this)) >= totalObligations(), "ISV");
    }

    function _pull(address _from, uint256 _amount) internal {
        if (_amount == 0) return;
        uint256 before = collateral.balanceOf(address(this));
        _tokenCall(abi.encodeCall(IERC20.transferFrom, (_from, address(this), _amount)));
        // Fee-on-transfer collateral would silently break every payout invariant.
        require(collateral.balanceOf(address(this)) - before == _amount, "FOT");
    }

    function _push(address _to, uint256 _amount) internal {
        _tokenCall(abi.encodeCall(IERC20.transfer, (_to, _amount)));
    }

    /// @dev Tolerates the tokens that return nothing instead of a bool.
    function _tokenCall(bytes memory _data) internal {
        (bool ok, bytes memory ret) = address(collateral).call(_data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "TF");
    }

    function _skipZeros(uint64[] storage _book, uint256 _i) internal view returns (uint256) {
        while (_i < _book.length && orders[_book[_i]].shares == 0) _i++;
        return _i;
    }

    /// @dev Drops a whole price level in O(1) and resets its head and counter.
    function _deleteLevel(uint256 _boutId, uint8 _side, uint8 _price, bool _isBid) internal {
        if (_isBid) {
            delete _bids[_boutId][_side][_price];
            _bidsHead[_boutId][_side][_price] = 0;
            _bidsLive[_boutId][_side][_price] = 0;
        } else {
            delete _asks[_boutId][_side][_price];
            _asksHead[_boutId][_side][_price] = 0;
            _asksLive[_boutId][_side][_price] = 0;
        }
    }

    /// @dev Rewrites the live orders of a level to the front and resets the head,
    ///      so a level churned by cancels doesn't grow an unbounded tombstone tail.
    function _autoCompact(uint64[] storage _book, uint256 _boutId, uint8 _side, uint8 _price, bool _isBid) internal {
        uint256 head = _isBid ? _bidsHead[_boutId][_side][_price] : _asksHead[_boutId][_side][_price];
        uint256 w = 0;

        for (uint256 r = head; r < _book.length; r++) {
            if (orders[_book[r]].shares > 0) {
                _book[w] = _book[r];
                w++;
            }
        }
        while (_book.length > w) _book.pop();

        if (_isBid) _bidsHead[_boutId][_side][_price] = 0;
        else _asksHead[_boutId][_side][_price] = 0;
    }

    function _decLiveAndMaybeUpdateBest(uint256 _boutId, uint8 _side, uint8 _price, bool _isBid) internal {
        if (_isBid) {
            _bidsLive[_boutId][_side][_price] -= 1;
            if (_bidsLive[_boutId][_side][_price] != 0) return;
            if (_price == bestBid[_boutId][_side]) {
                bestBid[_boutId][_side] = _prevBidPrice(_boutId, _side, _price);
            }
        } else {
            _asksLive[_boutId][_side][_price] -= 1;
            if (_asksLive[_boutId][_side][_price] != 0) return;
            if (_price == bestAsk[_boutId][_side]) {
                bestAsk[_boutId][_side] = _nextAskPrice(_boutId, _side, _price);
            }
        }
    }

    function _nextAskPrice(uint256 _boutId, uint8 _side, uint8 _from) internal view returns (uint8) {
        if (_from >= 99) return 100;

        for (uint8 p = _from + 1; p < 100; p++) {
            if (_asksLive[_boutId][_side][p] > 0) return p;
        }
        return 100;
    }

    function _prevBidPrice(uint256 _boutId, uint8 _side, uint8 _from) internal view returns (uint8) {
        if (_from <= 1) return 0;

        for (uint8 p = _from - 1; p >= 1; p--) {
            if (_bidsLive[_boutId][_side][p] > 0) return p;
        }
        return 0;
    }
}
