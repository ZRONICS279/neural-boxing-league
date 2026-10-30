// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FightCardReader — view-only companion to FightCardCLOB
 * @notice Everything a frontend needs in one call per screen. Split out of the
 *         market itself purely for bytecode size: nothing here holds state or
 *         can move funds, so it can be redeployed against the same market any
 *         time the UI wants a different shape of data.
 */

interface IFightCardCLOB {
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

    function orders(uint64 orderId) external view returns (
        address owner,
        uint96 shares,
        uint64 id,
        uint64 boutId,
        uint8 price,
        uint8 side,
        bool isBuy
    );

    function collateral() external view returns (address);
    function nextBoutId() external view returns (uint256);
    function collateralPool(uint256 boutId) external view returns (uint256);
    function totalShares(uint256 boutId, uint8 side) external view returns (uint256);
    function sharesOf(uint256 boutId, uint8 side, address user) external view returns (uint256);
    function escrowedOf(uint256 boutId, uint8 side, address user) external view returns (uint256);
    function bestBid(uint256 boutId, uint8 side) external view returns (uint8);
    function bestAsk(uint256 boutId, uint8 side) external view returns (uint8);
    function priceOf(uint256 boutId, uint8 side) external view returns (uint256);
    function levelDepth(uint256 boutId, uint8 side, uint8 price, bool isBid) external view returns (uint256);
    function levelLive(uint256 boutId, uint8 side, uint8 price, bool isBid) external view returns (uint16);
    function userOrders(address user, uint256 index) external view returns (uint64);
    function userOrderCount(address user) external view returns (uint256);
    function pendingWithdrawal(address user) external view returns (uint256);
    function totalCollateral() external view returns (uint256);
    function totalBidCollateral() external view returns (uint256);
    function totalPendingWithdrawal() external view returns (uint256);
    function accFees() external view returns (uint256);
    function totalObligations() external view returns (uint256);
}

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

contract FightCardReader {
    uint8 internal constant SIDE_A = 0;
    uint8 internal constant SIDE_B = 1;

    IFightCardCLOB public immutable clob;

    struct BoutView {
        uint256 boutId;
        uint64  cardId;
        bytes32 fighterA;
        bytes32 fighterB;
        uint64  latestCloseAt;
        uint64  voidAfter;
        uint8   outcome;
        bool    closed;
        bool    resolved;
        uint256 pool;
        uint256 totalA;
        uint256 totalB;
        uint256 priceA;   // bps of one collateral unit; 5000 = 50¢
        uint256 priceB;
        uint8   bestBidA;
        uint8   bestAskA;
        uint8   bestBidB;
        uint8   bestAskB;
    }

    struct PositionView {
        uint256 boutId;
        uint256 sharesA;
        uint256 sharesB;
        uint256 escrowA;
        uint256 escrowB;
        /// @dev What redeem() would pay right now. Zero until the bout resolves.
        uint256 claimable;
    }

    struct OrderView {
        uint64  id;
        uint64  boutId;
        uint96  shares;
        uint8   price;
        uint8   side;
        bool    isBuy;
    }

    constructor(address _clob) {
        clob = IFightCardCLOB(_clob);
    }

    // ═══════════════════════════════════════════
    //  BOUTS
    // ═══════════════════════════════════════════

    function getBout(uint256 _boutId) public view returns (BoutView memory v) {
        v.boutId = _boutId;
        (
            v.cardId, v.fighterA, v.fighterB,
            v.latestCloseAt, v.voidAfter,
            v.outcome, v.closed, v.resolved
        ) = clob.bouts(_boutId);

        v.pool = clob.collateralPool(_boutId);
        v.totalA = clob.totalShares(_boutId, SIDE_A);
        v.totalB = clob.totalShares(_boutId, SIDE_B);
        v.priceA = clob.priceOf(_boutId, SIDE_A);
        v.priceB = clob.priceOf(_boutId, SIDE_B);
        v.bestBidA = clob.bestBid(_boutId, SIDE_A);
        v.bestAskA = clob.bestAsk(_boutId, SIDE_A);
        v.bestBidB = clob.bestBid(_boutId, SIDE_B);
        v.bestAskB = clob.bestAsk(_boutId, SIDE_B);
    }

    function getBouts(uint256[] calldata _boutIds) external view returns (BoutView[] memory views) {
        views = new BoutView[](_boutIds.length);
        for (uint256 i = 0; i < _boutIds.length; i++) views[i] = getBout(_boutIds[i]);
    }

    /// @notice Every bout booked on one night, in id order.
    function getCard(uint64 _cardId, uint256 _fromBoutId, uint256 _maxScan) external view returns (
        BoutView[] memory views, uint256 nextIdx
    ) {
        uint256 end = _fromBoutId + _maxScan;
        uint256 last = clob.nextBoutId();
        if (end > last) end = last;

        uint256 count = 0;
        for (uint256 i = _fromBoutId; i < end; i++) {
            (uint64 cardId,,,,,,,) = clob.bouts(i);
            if (cardId == _cardId) count++;
        }

        views = new BoutView[](count);
        uint256 idx = 0;
        for (uint256 i = _fromBoutId; i < end; i++) {
            (uint64 cardId,,,,,,,) = clob.bouts(i);
            if (cardId == _cardId) {
                views[idx] = getBout(i);
                idx++;
            }
        }
        nextIdx = end;
    }

    // ═══════════════════════════════════════════
    //  ORDER BOOK
    // ═══════════════════════════════════════════

    /// @notice Resting depth for one side of one bout, indexed by price in cents.
    ///         Index 0 and 100 are always empty — ticks run 1–99.
    function getBookSide(uint256 _boutId, uint8 _side) public view returns (
        uint256[100] memory bidDepth, uint256[100] memory askDepth
    ) {
        for (uint8 p = 1; p < 100; p++) {
            if (clob.levelLive(_boutId, _side, p, true) > 0) {
                bidDepth[p] = clob.levelDepth(_boutId, _side, p, true);
            }
            if (clob.levelLive(_boutId, _side, p, false) > 0) {
                askDepth[p] = clob.levelDepth(_boutId, _side, p, false);
            }
        }
    }

    /// @notice Both sides of a bout in one call — the whole trading screen.
    function getFullBook(uint256 _boutId) external view returns (
        uint256[100] memory bidA, uint256[100] memory askA,
        uint256[100] memory bidB, uint256[100] memory askB
    ) {
        (bidA, askA) = getBookSide(_boutId, SIDE_A);
        (bidB, askB) = getBookSide(_boutId, SIDE_B);
    }

    // ═══════════════════════════════════════════
    //  ACCOUNTS
    // ═══════════════════════════════════════════

    function getPosition(uint256 _boutId, address _user) public view returns (PositionView memory p) {
        p.boutId = _boutId;
        p.sharesA = clob.sharesOf(_boutId, SIDE_A, _user);
        p.sharesB = clob.sharesOf(_boutId, SIDE_B, _user);
        p.escrowA = clob.escrowedOf(_boutId, SIDE_A, _user);
        p.escrowB = clob.escrowedOf(_boutId, SIDE_B, _user);

        (,,,,, uint8 outcome,, bool resolved) = clob.bouts(_boutId);
        if (!resolved) return p;

        // redeem() pulls escrowed shares back before settling, so count them here too.
        uint256 a = p.sharesA + p.escrowA;
        uint256 b = p.sharesB + p.escrowB;

        if (outcome == 3) {
            // VOID: every share, both sides, takes a pro-rata slice of the pool
            uint256 total = clob.totalShares(_boutId, SIDE_A) + clob.totalShares(_boutId, SIDE_B);
            if (total > 0) p.claimable = ((a + b) * clob.collateralPool(_boutId)) / total;
        } else if (outcome == 1) {
            p.claimable = a;
        } else if (outcome == 2) {
            p.claimable = b;
        }
    }

    function getPortfolio(address _user, uint256[] calldata _boutIds) external view returns (
        PositionView[] memory positions, uint256 totalClaimable, uint256 pending
    ) {
        positions = new PositionView[](_boutIds.length);
        for (uint256 i = 0; i < _boutIds.length; i++) {
            positions[i] = getPosition(_boutIds[i], _user);
            totalClaimable += positions[i].claimable;
        }
        pending = clob.pendingWithdrawal(_user);
    }

    function getUserOrders(address _user, uint256 _startIdx, uint256 _maxBatch) external view returns (
        OrderView[] memory open, uint256 nextIdx
    ) {
        uint256 end = _startIdx + _maxBatch;
        uint256 total = clob.userOrderCount(_user);
        if (end > total) end = total;

        uint64[] memory ids = new uint64[](end > _startIdx ? end - _startIdx : 0);
        uint256 count = 0;
        for (uint256 i = _startIdx; i < end; i++) {
            uint64 id = clob.userOrders(_user, i);
            (, uint96 shares,,,,,) = clob.orders(id);
            if (shares > 0) {
                ids[count] = id;
                count++;
            }
        }

        open = new OrderView[](count);
        for (uint256 i = 0; i < count; i++) {
            (, uint96 shares, uint64 id, uint64 boutId, uint8 price, uint8 side, bool isBuy) = clob.orders(ids[i]);
            open[i] = OrderView(id, boutId, shares, price, side, isBuy);
        }
        nextIdx = end;
    }

    // ═══════════════════════════════════════════
    //  SOLVENCY
    // ═══════════════════════════════════════════

    /// @notice The monitoring hook: `solvent` must never go false.
    function getSolvencyInfo() external view returns (
        uint256 balance,
        uint256 obligations,
        uint256 totalCollateral,
        uint256 totalBidCollateral,
        uint256 totalPendingWithdrawal,
        uint256 accFees,
        bool solvent
    ) {
        balance = IERC20Balance(clob.collateral()).balanceOf(address(clob));
        obligations = clob.totalObligations();
        totalCollateral = clob.totalCollateral();
        totalBidCollateral = clob.totalBidCollateral();
        totalPendingWithdrawal = clob.totalPendingWithdrawal();
        accFees = clob.accFees();
        solvent = balance >= obligations;
    }

    /// @notice Per-bout share conservation — the pool always covers what is still
    ///         owed on that bout. A break here means the accounting is wrong, not
    ///         that a fight went badly.
    function checkBoutInvariant(uint256 _boutId) external view returns (
        uint256 pool, uint256 totalA, uint256 totalB, bool conserved
    ) {
        pool = clob.collateralPool(_boutId);
        totalA = clob.totalShares(_boutId, SIDE_A);
        totalB = clob.totalShares(_boutId, SIDE_B);

        (,,,,, uint8 outcome,, bool resolved) = clob.bouts(_boutId);

        if (!resolved) {
            // Every unit of collateral backs exactly one A share and one B share.
            conserved = (pool == totalA && pool == totalB);
        } else if (outcome == 1) {
            conserved = pool >= totalA;          // unredeemed A shares pay 1:1
        } else if (outcome == 2) {
            conserved = pool >= totalB;
        } else {
            conserved = 2 * pool >= totalA + totalB;  // VOID pays every share 0.50
        }
    }
}
