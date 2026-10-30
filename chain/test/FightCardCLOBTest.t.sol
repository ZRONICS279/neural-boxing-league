// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/FightCardCLOB.sol";
import "../contracts/FightCardReader.sol";

// ═══════════════════════════════════════════════════════════════
//  MOCK COLLATERAL — USDC-shaped: 6 decimals, no return value
// ═══════════════════════════════════════════════════════════════

contract MockUSDC {
    string public name = "Mock USD";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    // Deliberately returns nothing, like real USDC on mainnet.
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "BAL");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "BAL");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ALW");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract BadDecimals {
    uint8 public decimals = 2;
}

// ═══════════════════════════════════════════════════════════════
//  HARNESS
// ═══════════════════════════════════════════════════════════════

contract FightCardBase is Test {
    FightCardCLOB  public clob;
    FightCardReader public reader;
    MockUSDC public usdc;

    address deployer = address(0xD1);
    address operator = address(0x0F);
    address feeSink  = address(0xFE);
    address alice    = address(0xA);
    address bob      = address(0xB);
    address carol    = address(0xC);

    uint8 constant A = 0;
    uint8 constant B = 1;

    uint256 constant ONE = 1e6;          // 1 collateral unit
    uint64 constant CARD = 7;
    bytes32 constant FIGHTER_A = bytes32("kestrel-01");
    bytes32 constant FIGHTER_B = bytes32("mercury-04");

    uint256 boutId;

    function setUp() public virtual {
        usdc = new MockUSDC();

        vm.prank(deployer);
        clob = new FightCardCLOB(address(usdc), operator, feeSink, 0);
        reader = new FightCardReader(address(clob));

        vm.prank(operator);
        boutId = clob.createBout(
            CARD, FIGHTER_A, FIGHTER_B,
            uint64(block.timestamp + 1 days),
            uint64(block.timestamp + 3 days)
        );

        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    function _fund(address who) internal {
        usdc.mint(who, 1_000_000 * ONE);
        vm.prank(who);
        usdc.approve(address(clob), type(uint256).max);
    }

    /// @dev The one thing that must never break: the contract holds at least
    ///      everything it owes.
    function _assertSolvent() internal view {
        assertGe(
            usdc.balanceOf(address(clob)),
            clob.totalObligations(),
            "insolvent: balance below obligations"
        );
    }

    /// @dev Collateral backs exactly one A share and one B share, always.
    function _assertConserved(uint256 _bout) internal view {
        assertEq(clob.collateralPool(_bout), clob.totalShares(_bout, A), "pool != totalA");
        assertEq(clob.collateralPool(_bout), clob.totalShares(_bout, B), "pool != totalB");
    }

    function _mint(address who, uint256 amount) internal {
        vm.prank(who);
        clob.mint(boutId, amount);
    }

    function _buy(address who, uint8 side, uint8 price, uint256 shares) internal returns (uint64) {
        vm.prank(who);
        return clob.placeBuyOrder(boutId, side, price, shares, FightCardCLOB.OrderType.GTC);
    }

    function _sell(address who, uint8 side, uint8 price, uint256 shares) internal returns (uint64) {
        vm.prank(who);
        return clob.placeSellOrder(boutId, side, price, shares, FightCardCLOB.OrderType.GTC);
    }

    function _withdraw(address who) internal returns (uint256) {
        vm.prank(who);
        return clob.withdraw();
    }
}

// ═══════════════════════════════════════════════════════════════
//  MINT / BURN
// ═══════════════════════════════════════════════════════════════

contract FightCardMintBurnTest is FightCardBase {
    function test_MintCreatesCompleteSet() public {
        _mint(alice, 100 * ONE);

        assertEq(clob.sharesOf(boutId, A, alice), 100 * ONE);
        assertEq(clob.sharesOf(boutId, B, alice), 100 * ONE);
        assertEq(clob.collateralPool(boutId), 100 * ONE);
        assertEq(usdc.balanceOf(address(clob)), 100 * ONE);
        _assertConserved(boutId);
        _assertSolvent();
    }

    function test_BurnReturnsCollateral() public {
        _mint(alice, 100 * ONE);

        vm.prank(alice);
        clob.burn(boutId, 40 * ONE);

        assertEq(clob.sharesOf(boutId, A, alice), 60 * ONE);
        assertEq(clob.pendingWithdrawal(alice), 40 * ONE);
        assertEq(_withdraw(alice), 40 * ONE);
        assertEq(usdc.balanceOf(address(clob)), 60 * ONE);
        _assertConserved(boutId);
        _assertSolvent();
    }

    function test_BurnNeedsBothSides() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 100 * ONE); // escrows every A share

        vm.prank(alice);
        vm.expectRevert(bytes("IA"));
        clob.burn(boutId, 100 * ONE);
    }

    function test_MintRejectsSubGranularity() public {
        vm.prank(alice);
        vm.expectRevert(bytes("GRAN"));
        clob.mint(boutId, 1_000_050);
    }

    function test_ConstructorRejectsTinyDecimals() public {
        BadDecimals bad = new BadDecimals();
        vm.expectRevert(bytes("DEC"));
        new FightCardCLOB(address(bad), operator, feeSink, 0);
    }
}

// ═══════════════════════════════════════════════════════════════
//  MATCHING
// ═══════════════════════════════════════════════════════════════

contract FightCardMatchingTest is FightCardBase {
    function test_DirectMatchBuyAgainstAsk() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 100 * ONE);

        assertEq(clob.bestAsk(boutId, A), 60);
        assertEq(clob.escrowedOf(boutId, A, alice), 100 * ONE);

        _buy(bob, A, 60, 100 * ONE);

        assertEq(clob.sharesOf(boutId, A, bob), 100 * ONE);
        assertEq(clob.escrowedOf(boutId, A, alice), 0);
        assertEq(clob.pendingWithdrawal(alice), 60 * ONE);
        assertEq(clob.bestAsk(boutId, A), 100, "level should be empty");
        // Bob paid, nobody minted: pool unchanged.
        assertEq(clob.collateralPool(boutId), 100 * ONE);
        _assertConserved(boutId);
        _assertSolvent();
    }

    function test_BuyerPaysNoMoreThanLimit() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 40, 100 * ONE);

        uint256 before = usdc.balanceOf(bob);
        _buy(bob, A, 60, 100 * ONE); // crosses at the resting 40, not at 60

        assertEq(before - usdc.balanceOf(bob), 40 * ONE, "should fill at the maker's price");
    }

    function test_ComplementaryMatchMintsSet() public {
        _buy(alice, A, 40, 100 * ONE);   // rests: 40c for A
        assertEq(clob.bestBid(boutId, A), 40);
        assertEq(clob.totalBidCollateral(), 40 * ONE);

        _buy(bob, B, 60, 100 * ONE);     // 40 + 60 = 100 -> mints a set

        assertEq(clob.sharesOf(boutId, A, alice), 100 * ONE);
        assertEq(clob.sharesOf(boutId, B, bob), 100 * ONE);
        assertEq(clob.collateralPool(boutId), 100 * ONE, "set should be minted");
        assertEq(clob.totalBidCollateral(), 0, "maker collateral consumed");
        assertEq(clob.bestBid(boutId, A), 0);
        _assertConserved(boutId);
        _assertSolvent();
    }

    function test_ComplementaryRequiresExactSum() public {
        _buy(alice, A, 40, 100 * ONE);
        _buy(bob, B, 55, 100 * ONE);   // 95 != 100 -> both just rest

        assertEq(clob.sharesOf(boutId, A, alice), 0);
        assertEq(clob.sharesOf(boutId, B, bob), 0);
        assertEq(clob.bestBid(boutId, A), 40);
        assertEq(clob.bestBid(boutId, B), 55);
        assertEq(clob.collateralPool(boutId), 0);
        _assertSolvent();
    }

    /// @dev A limit is the worst price a taker will accept, not the only one.
    ///      This used to look at the single level exactly mirroring the limit, so
    ///      a buy of A at 45 matched a B bid at 55 and would not touch a B bid at
    ///      70 — an effective offer of 30, and a better price for the buyer.
    ///      Every market order carries slippage tolerance, so in practice every
    ///      market order matched nothing at all rather than matching well.
    function test_ComplementaryBuyTakesTheBestPriceAvailable() public {
        _buy(carol, B, 70, 100 * ONE);   // an effective offer of A at 30
        _buy(bob, B, 55, 100 * ONE);     // an effective offer of A at 45
        assertEq(clob.bestBid(boutId, B), 70);

        uint256 before = usdc.balanceOf(alice);
        _buy(alice, A, 45, 100 * ONE);   // willing to pay 45, should be charged 30

        assertEq(clob.sharesOf(boutId, A, alice), 100 * ONE, "taker filled");
        assertEq(before - usdc.balanceOf(alice), 30 * ONE, "taker paid its limit, not the market");
        assertEq(clob.sharesOf(boutId, B, carol), 100 * ONE, "the best bid is the one that trades");
        assertEq(clob.sharesOf(boutId, B, bob), 0, "the worse bid must be left alone");
        assertEq(clob.bestBid(boutId, B), 55, "pointer follows the drain down to the next live level");
        _assertConserved(boutId);
        _assertSolvent();
    }

    /// @dev The limit still binds downward: a complementary bid that would price
    ///      the taker above what they asked for is not reachable at all.
    function test_ComplementaryBuyWillNotPayAboveItsLimit() public {
        _buy(bob, B, 40, 100 * ONE);     // an effective offer of A at 60

        _buy(alice, A, 45, 100 * ONE);   // will not pay 60

        assertEq(clob.sharesOf(boutId, A, alice), 0, "filled above its own limit");
        assertEq(clob.bestBid(boutId, A), 45, "the unmatched buy should rest");
        assertEq(clob.bestBid(boutId, B), 40, "the untouched bid stays put");
        _assertSolvent();
    }

    /// @dev A corner is offered from two places at once: an ask on that corner,
    ///      and a bid on the other corner (which funds the other half of a set).
    ///      Both are offers of the same thing, so a taker must be charged the
    ///      cheaper of the two — the buy path used to drain asks in full before
    ///      it looked at complementary bids at all, and overpaid whenever the
    ///      complementary side was better.
    function test_BuyTakesTheCheaperOfAskAndComplementary() public {
        // Bob asks 60 for A.
        _mint(bob, 100 * ONE);
        _sell(bob, A, 60, 100 * ONE);
        // Carol bids 55 on B, which offers A at 45 — cheaper than Bob's ask.
        _buy(carol, B, 55, 100 * ONE);

        uint256 before = usdc.balanceOf(alice);
        _buy(alice, A, 65, 100 * ONE);   // would take either; must take the 45

        assertEq(clob.sharesOf(boutId, A, alice), 100 * ONE, "taker filled");
        assertEq(before - usdc.balanceOf(alice), 45 * ONE, "taker paid the ask, not the cheaper set");
        assertEq(clob.sharesOf(boutId, B, carol), 100 * ONE, "the cheaper offer is the one that trades");
        assertEq(clob.escrowedOf(boutId, A, bob), 100 * ONE, "the dearer ask must be left alone");
        assertEq(clob.bestAsk(boutId, A), 60, "the ask stays as the book's offer");
        _assertConserved(boutId);
        _assertSolvent();
    }

    /// @dev The mirror: when the ask is the cheaper of the two it wins instead,
    ///      and the complementary bid is the one left standing.
    function test_BuyTakesTheAskWhenTheAskIsCheaper() public {
        _mint(bob, 100 * ONE);
        _sell(bob, A, 40, 100 * ONE);   // offers A at 40
        _buy(carol, B, 45, 100 * ONE);   // offers A at 55

        uint256 before = usdc.balanceOf(alice);
        _buy(alice, A, 65, 100 * ONE);

        assertEq(clob.sharesOf(boutId, A, alice), 100 * ONE, "taker filled");
        assertEq(before - usdc.balanceOf(alice), 40 * ONE, "taker should have paid the cheaper ask");
        assertEq(clob.sharesOf(boutId, B, carol), 0, "the dearer complementary bid must be left alone");
        assertEq(clob.bestBid(boutId, B), 45, "and stays as the book's bid");
        _assertSolvent();
    }

    /// @dev Regression: after a complementary drain the best-bid pointer must
    ///      still name a level that is actually live. CLOBMarket.sol lowers it
    ///      unconditionally, which strands the better bid.
    function test_ComplementaryDrainLeavesBestBidOnALiveLevel() public {
        _buy(carol, B, 70, 100 * ONE);
        _buy(bob, B, 55, 100 * ONE);

        _buy(alice, A, 45, 100 * ONE);   // walks the 70 level out entirely

        assertEq(clob.bestBid(boutId, B), 55, "pointer must name the surviving level");

        // And the pointer still works: a sell into it finds bob's 55 bid.
        _mint(alice, 10 * ONE);
        _sell(alice, B, 55, 10 * ONE);
        assertEq(clob.sharesOf(boutId, B, bob), 10 * ONE, "55 bid should have filled");
        _assertSolvent();
    }

    function test_SellMatchesRestingBid() public {
        _buy(bob, A, 35, 100 * ONE);
        _mint(alice, 100 * ONE);

        uint256 pendingBefore = clob.pendingWithdrawal(alice);
        _sell(alice, A, 30, 100 * ONE);  // crosses the 35 bid

        assertEq(clob.sharesOf(boutId, A, bob), 100 * ONE);
        assertEq(clob.pendingWithdrawal(alice) - pendingBefore, 35 * ONE, "fills at the bid");
        assertEq(clob.totalBidCollateral(), 0);
        _assertConserved(boutId);
        _assertSolvent();
    }

    function test_FifoAcrossTwoMakersAtOneLevel() public {
        _mint(alice, 100 * ONE);
        _mint(carol, 100 * ONE);
        _sell(alice, A, 50, 100 * ONE);   // first in
        _sell(carol, A, 50, 100 * ONE);   // second in

        _buy(bob, A, 50, 150 * ONE);      // consumes alice fully, carol partially

        assertEq(clob.pendingWithdrawal(alice), 50 * ONE, "first maker filled in full");
        assertEq(clob.pendingWithdrawal(carol), 25 * ONE, "second maker filled by the remainder");
        assertEq(clob.escrowedOf(boutId, A, carol), 50 * ONE);
        assertEq(clob.sharesOf(boutId, A, bob), 150 * ONE);
        _assertSolvent();
    }

    function test_PartialFillKeepsMakerAtHeadOfQueue() public {
        _mint(alice, 100 * ONE);
        _mint(carol, 100 * ONE);
        _sell(alice, A, 50, 100 * ONE);
        _sell(carol, A, 50, 100 * ONE);

        _buy(bob, A, 50, 40 * ONE);   // partial fill of alice only
        assertEq(clob.pendingWithdrawal(alice), 20 * ONE);
        assertEq(clob.pendingWithdrawal(carol), 0, "carol must not jump the queue");

        _buy(bob, A, 50, 60 * ONE);   // finishes alice
        assertEq(clob.pendingWithdrawal(alice), 50 * ONE);
        assertEq(clob.pendingWithdrawal(carol), 0);
    }

    function test_FokRevertsWhenUnfillable() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 40 * ONE);

        vm.prank(bob);
        vm.expectRevert(bytes("FK"));
        clob.placeBuyOrder(boutId, A, 60, 100 * ONE, FightCardCLOB.OrderType.FOK);
    }

    function test_FakDropsRemainder() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 40 * ONE);

        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        clob.placeBuyOrder(boutId, A, 60, 100 * ONE, FightCardCLOB.OrderType.FAK);

        assertEq(clob.sharesOf(boutId, A, bob), 40 * ONE, "only the available part fills");
        assertEq(before - usdc.balanceOf(bob), 24 * ONE, "pays only for what filled");
        assertEq(clob.bestBid(boutId, A), 0, "nothing rests");
    }

    function test_FakSellReturnsUnfilledShares() public {
        _mint(alice, 100 * ONE);
        _buy(bob, A, 50, 30 * ONE);

        vm.prank(alice);
        clob.placeSellOrder(boutId, A, 50, 100 * ONE, FightCardCLOB.OrderType.FAK);

        assertEq(clob.sharesOf(boutId, A, alice), 70 * ONE, "unfilled shares come straight back");
        assertEq(clob.escrowedOf(boutId, A, alice), 0);
        _assertConserved(boutId);
    }

    function test_RejectsBadPriceAndSide() public {
        vm.prank(alice);
        vm.expectRevert(bytes("P1"));
        clob.placeBuyOrder(boutId, A, 100, 100 * ONE, FightCardCLOB.OrderType.GTC);

        vm.prank(alice);
        vm.expectRevert(bytes("SI"));
        clob.placeBuyOrder(boutId, 2, 50, 100 * ONE, FightCardCLOB.OrderType.GTC);
    }
}

// ═══════════════════════════════════════════════════════════════
//  CANCELS
// ═══════════════════════════════════════════════════════════════

contract FightCardCancelTest is FightCardBase {
    function test_CancelBidRefundsCollateral() public {
        uint64 id = _buy(alice, A, 40, 100 * ONE);
        assertEq(clob.totalBidCollateral(), 40 * ONE);

        vm.prank(alice);
        clob.cancelOrder(id);

        assertEq(clob.totalBidCollateral(), 0);
        assertEq(clob.pendingWithdrawal(alice), 40 * ONE);
        assertEq(clob.bestBid(boutId, A), 0);
        assertEq(_withdraw(alice), 40 * ONE);
        _assertSolvent();
    }

    function test_CancelAskReturnsShares() public {
        _mint(alice, 100 * ONE);
        uint64 id = _sell(alice, A, 60, 100 * ONE);
        assertEq(clob.sharesOf(boutId, A, alice), 0);

        vm.prank(alice);
        clob.cancelOrder(id);

        assertEq(clob.sharesOf(boutId, A, alice), 100 * ONE);
        assertEq(clob.escrowedOf(boutId, A, alice), 0);
        assertEq(clob.bestAsk(boutId, A), 100);
        _assertConserved(boutId);
    }

    function test_CancelOnlyByOwner() public {
        uint64 id = _buy(alice, A, 40, 100 * ONE);
        vm.prank(bob);
        vm.expectRevert(bytes("NY"));
        clob.cancelOrder(id);
    }

    function test_BestBidStepsDownOnCancel() public {
        _buy(alice, A, 40, 100 * ONE);
        uint64 high = _buy(alice, A, 55, 100 * ONE);
        assertEq(clob.bestBid(boutId, A), 55);

        vm.prank(alice);
        clob.cancelOrder(high);
        assertEq(clob.bestBid(boutId, A), 40, "pointer should fall to the next live level");
    }

    function test_CancelMyOrdersBatch() public {
        _buy(alice, A, 30, 100 * ONE);
        _buy(alice, A, 31, 100 * ONE);
        _buy(alice, A, 32, 100 * ONE);

        vm.prank(alice);
        clob.cancelMyOrders(0, 10);

        assertEq(clob.pendingWithdrawal(alice), 93 * ONE);
        assertEq(clob.activeOrderCount(alice), 0);
        assertEq(clob.totalBidCollateral(), 0);
        _assertSolvent();
    }

    function test_SweepLevelAfterResolve() public {
        _buy(alice, A, 40, 100 * ONE);
        _buy(bob, A, 40, 100 * ONE);

        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_B);

        clob.sweepLevel(boutId, A, 40, true);   // permissionless cleanup

        assertEq(clob.pendingWithdrawal(alice), 40 * ONE);
        assertEq(clob.pendingWithdrawal(bob), 40 * ONE);
        assertEq(clob.totalBidCollateral(), 0);
        _assertSolvent();
    }
}

// ═══════════════════════════════════════════════════════════════
//  LIFECYCLE
// ═══════════════════════════════════════════════════════════════

contract FightCardLifecycleTest is FightCardBase {
    function test_ClosedBoutRejectsTrading() public {
        vm.prank(operator);
        clob.closeBout(boutId);

        vm.prank(alice);
        vm.expectRevert(bytes("CL"));
        clob.placeBuyOrder(boutId, A, 40, 100 * ONE, FightCardCLOB.OrderType.GTC);

        vm.prank(alice);
        vm.expectRevert(bytes("CL"));
        clob.mint(boutId, 100 * ONE);
    }

    function test_CancelStillWorksWhenClosed() public {
        uint64 id = _buy(alice, A, 40, 100 * ONE);
        vm.prank(operator);
        clob.closeBout(boutId);

        vm.prank(alice);
        clob.cancelOrder(id);   // owners can always reclaim
        assertEq(clob.pendingWithdrawal(alice), 40 * ONE);
    }

    function test_AnyoneClosesAfterBackstop() public {
        vm.prank(bob);
        vm.expectRevert(bytes("NA"));
        clob.closeBout(boutId);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(bob);
        clob.closeBout(boutId);

        (,,,,,, bool closed,) = clob.bouts(boutId);
        assertTrue(closed);
    }

    function test_TradingStopsAtBackstopEvenIfNotClosed() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        vm.expectRevert(bytes("MC"));
        clob.placeBuyOrder(boutId, A, 40, 100 * ONE, FightCardCLOB.OrderType.GTC);
    }

    function test_OnlyOperatorResolves() public {
        vm.prank(alice);
        vm.expectRevert(bytes("NP"));
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);
    }

    function test_CannotResolveTwice() public {
        vm.startPrank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);
        vm.expectRevert(bytes("AR"));
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_B);
        vm.stopPrank();
    }

    function test_CannotResolveUnresolvedOutcome() public {
        vm.prank(operator);
        vm.expectRevert(bytes("IO"));
        clob.resolveBout(boutId, FightCardCLOB.Outcome.UNRESOLVED);
    }

    function test_ForceVoidOnlyAfterDeadline() public {
        vm.expectRevert(bytes("TE"));
        clob.forceVoid(boutId);

        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(bob);   // anyone
        clob.forceVoid(boutId);

        (,,,,, FightCardCLOB.Outcome outcome,, bool resolved) = clob.bouts(boutId);
        assertEq(uint8(outcome), uint8(FightCardCLOB.Outcome.VOID));
        assertTrue(resolved);
    }

    function test_CreateCardBooksWholeNight() public {
        bytes32[] memory as_ = new bytes32[](3);
        bytes32[] memory bs = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) {
            as_[i] = bytes32(uint256(0xA00 + i));
            bs[i] = bytes32(uint256(0xB00 + i));
        }

        vm.prank(operator);
        uint256[] memory ids = clob.createCard(
            9, as_, bs, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days)
        );

        assertEq(ids.length, 3);
        for (uint256 i = 0; i < 3; i++) {
            (uint64 cardId,,,,,,,) = clob.bouts(ids[i]);
            assertEq(cardId, 9);
            assertEq(clob.bestAsk(ids[i], A), 100, "ask pointer must start empty");
            assertEq(clob.bestAsk(ids[i], B), 100);
        }
    }

    function test_OnlyOperatorCreates() public {
        vm.prank(alice);
        vm.expectRevert(bytes("NP"));
        clob.createBout(1, FIGHTER_A, FIGHTER_B, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days));
    }
}

// ═══════════════════════════════════════════════════════════════
//  SETTLEMENT
// ═══════════════════════════════════════════════════════════════

contract FightCardSettlementTest is FightCardBase {
    function test_WinnerRedeemsOneForOne() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 100 * ONE);
        _buy(bob, A, 60, 100 * ONE);      // bob holds 100 A, alice holds 100 B

        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);

        vm.prank(bob);
        uint256 payout = clob.redeem(boutId);
        assertEq(payout, 100 * ONE, "winning share pays exactly 1");
        assertEq(_withdraw(bob), 100 * ONE);

        // Alice's B shares are worthless; redeem has nothing to pay her.
        vm.prank(alice);
        vm.expectRevert(bytes("NW"));
        clob.redeem(boutId);

        assertEq(clob.collateralPool(boutId), 0, "pool fully paid out");
        _assertSolvent();
    }

    function test_LoserSideRedeemsWhenBWins() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 100 * ONE);
        _buy(bob, A, 60, 100 * ONE);

        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_B);

        vm.prank(alice);
        assertEq(clob.redeem(boutId), 100 * ONE);
        assertEq(clob.collateralPool(boutId), 0);
        _assertSolvent();
    }

    function test_RedeemReclaimsEscrowedShares() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 90, 100 * ONE);   // still resting when the bell goes

        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);

        vm.prank(alice);
        assertEq(clob.redeem(boutId), 100 * ONE, "escrowed shares must still settle");
        assertEq(clob.escrowedOf(boutId, A, alice), 0);
        _assertSolvent();
    }

    /**
     * The draw case, with money already withdrawn from the contract before the
     * void happens — the exact scenario a void has to survive.
     */
    function test_VoidIsFullyFundedAfterWithdrawals() public {
        _mint(alice, 100 * ONE);          // pool = 100
        _sell(alice, A, 60, 50 * ONE);
        _buy(bob, A, 60, 50 * ONE);       // bob pays 30, alice earns 30

        assertEq(_withdraw(alice), 30 * ONE, "alice takes her sale proceeds out");

        // Contract now holds only the 100 of pooled collateral.
        assertEq(usdc.balanceOf(address(clob)), 100 * ONE);

        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.VOID);

        vm.prank(alice);
        uint256 alicePayout = clob.redeem(boutId);   // 50 A + 100 B = 150 shares
        vm.prank(bob);
        uint256 bobPayout = clob.redeem(boutId);     // 50 A

        assertEq(alicePayout, 75 * ONE, "150 of 200 shares -> 75 of the pool");
        assertEq(bobPayout, 25 * ONE, "50 of 200 shares -> 25 of the pool");
        assertEq(alicePayout + bobPayout, 100 * ONE, "void pays out the pool exactly");
        assertEq(clob.collateralPool(boutId), 0);

        _assertSolvent();
        assertEq(_withdraw(alice), 75 * ONE);
        assertEq(_withdraw(bob), 25 * ONE);
        assertEq(usdc.balanceOf(address(clob)), 0, "contract fully drained, nothing stranded");
    }

    function test_VoidPaysHalfPerShareRegardlessOfEntryPrice() public {
        // Bob buys A cheap, carol buys A dear; a void pays both the same per share.
        _buy(alice, B, 90, 100 * ONE);
        _buy(bob, A, 10, 100 * ONE);      // bob pays 10c
        _buy(alice, B, 30, 100 * ONE);
        _buy(carol, A, 70, 100 * ONE);    // carol pays 70c

        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.VOID);

        vm.prank(bob);
        uint256 bobPayout = clob.redeem(boutId);
        vm.prank(carol);
        uint256 carolPayout = clob.redeem(boutId);

        assertEq(bobPayout, 50 * ONE, "0.50 per share");
        assertEq(carolPayout, 50 * ONE, "0.50 per share");
        _assertSolvent();
    }

    function test_VoidAfterForceVoidStillSettles() public {
        _mint(alice, 100 * ONE);
        vm.warp(block.timestamp + 3 days + 1);
        clob.forceVoid(boutId);

        vm.prank(alice);
        assertEq(clob.redeem(boutId), 100 * ONE, "sole holder of both sides gets it all back");
        _assertSolvent();
    }

    function test_CannotRedeemBeforeResolve() public {
        _mint(alice, 100 * ONE);
        vm.prank(alice);
        vm.expectRevert(bytes("NR"));
        clob.redeem(boutId);
    }

    function test_RedeemManySettlesWholeCard() public {
        vm.prank(operator);
        uint256 second = clob.createBout(
            CARD, bytes32("x"), bytes32("y"),
            uint64(block.timestamp + 1 days), uint64(block.timestamp + 3 days)
        );

        _mint(alice, 100 * ONE);
        vm.prank(alice);
        clob.mint(second, 40 * ONE);

        vm.startPrank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);
        clob.resolveBout(second, FightCardCLOB.Outcome.FIGHTER_B);
        vm.stopPrank();

        uint256[] memory ids = new uint256[](2);
        ids[0] = boutId;
        ids[1] = second;

        vm.prank(alice);
        assertEq(clob.redeemMany(ids), 140 * ONE);
        _assertSolvent();
    }
}

// ═══════════════════════════════════════════════════════════════
//  FEES & ADMIN
// ═══════════════════════════════════════════════════════════════

contract FightCardFeeTest is FightCardBase {
    function setUp() public override {
        super.setUp();
        vm.prank(deployer);
        clob.setFeeConfig(feeSink, 100);   // 1%, the ceiling
    }

    function test_TakerPaysFeeOnBuy() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 100 * ONE);

        uint256 before = usdc.balanceOf(bob);
        _buy(bob, A, 60, 100 * ONE);

        // 60 notional + 1% = 60.6 paid; the maker still receives the full 60,
        // and a quarter of the fee on top of it.
        assertEq(before - usdc.balanceOf(bob), 60_600_000);
        assertEq(clob.pendingWithdrawal(alice), 60 * ONE + 150_000);
        assertEq(clob.accFees(), 450_000, "platform keeps 75%");
        _assertSolvent();
    }

    function test_TakerPaysFeeOnSell() public {
        _buy(bob, A, 40, 100 * ONE);
        _mint(alice, 100 * ONE);
        uint256 pendingBefore = clob.pendingWithdrawal(alice);

        _sell(alice, A, 40, 100 * ONE);

        // The aggressor is the seller here, so the rebate goes the other way.
        assertEq(clob.pendingWithdrawal(alice) - pendingBefore, 39_600_000, "40 less 1%");
        assertEq(clob.pendingWithdrawal(bob), 100_000, "maker rebate");
        assertEq(clob.accFees(), 300_000);
        _assertSolvent();
    }

    /// The whole fee, wherever it ended up, is 100% of what the taker paid.
    /// A split that leaked would show up here before it showed up as a hole in
    /// the balance sheet.
    function test_RebateAndPlatformShareAddUpToTheFee() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 100 * ONE);

        uint256 before = usdc.balanceOf(bob);
        _buy(bob, A, 60, 100 * ONE);
        uint256 paid = before - usdc.balanceOf(bob);
        uint256 fee = paid - 60 * ONE;

        uint256 rebate = clob.pendingWithdrawal(alice) - 60 * ONE;
        assertEq(rebate + clob.accFees(), fee, "nothing is created or lost");
        assertEq(rebate * 10000 / fee, clob.MAKER_REBATE_BPS());
        _assertSolvent();
    }

    /// A complementary match mints a set out of two bids. The resting bid is
    /// still the maker and still earns the rebate.
    function test_MakerRebateOnComplementaryFill() public {
        _buy(alice, B, 40, 100 * ONE);          // rests
        _buy(bob, A, 60, 100 * ONE);            // pairs with it, mints the set

        assertEq(clob.sharesOf(boutId, A, bob), 100 * ONE);
        assertEq(clob.sharesOf(boutId, B, alice), 100 * ONE);
        // Taker paid 60 notional, so the fee is 0.6 and a quarter of it is due
        // to the bidder who was already sitting there.
        assertEq(clob.pendingWithdrawal(alice), 150_000);
        assertEq(clob.accFees(), 450_000);
        _assertSolvent();
    }

    /// Taking your own resting order is a net loss, not a rebate farm.
    function test_SelfTradeCannotFarmTheRebate() public {
        uint256 before = usdc.balanceOf(alice);
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 100 * ONE);
        _buy(alice, A, 60, 100 * ONE);

        uint256 recovered = _withdraw(alice) + usdc.balanceOf(alice);
        assertLt(recovered, before, "round-tripping your own order costs money");
        _assertSolvent();
    }

    function test_ClaimFees() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 60, 100 * ONE);
        _buy(bob, A, 60, 100 * ONE);

        vm.prank(feeSink);
        clob.claimFees();

        assertEq(clob.accFees(), 0);
        assertEq(clob.pendingWithdrawal(feeSink), 450_000);
        assertEq(_withdraw(feeSink), 450_000);
        _assertSolvent();
    }

    function test_FeeCeilingEnforced() public {
        vm.prank(deployer);
        vm.expectRevert(bytes("FB"));
        clob.setFeeConfig(feeSink, 101);
    }

    function test_OnlyOwnerSetsFeeAndOperator() public {
        vm.prank(alice);
        vm.expectRevert(bytes("NO"));
        clob.setFeeConfig(feeSink, 10);

        vm.prank(alice);
        vm.expectRevert(bytes("NO"));
        clob.setOperator(alice);
    }

    function test_OperatorRotation() public {
        vm.prank(deployer);
        clob.setOperator(carol);

        vm.prank(carol);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);

        vm.prank(operator);
        vm.expectRevert(bytes("NP"));
        clob.createBout(1, FIGHTER_A, FIGHTER_B, uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days));
    }
}

// ═══════════════════════════════════════════════════════════════
//  READER
// ═══════════════════════════════════════════════════════════════

contract FightCardReaderTest is FightCardBase {
    function test_BoutViewReportsBookAndPrices() public {
        _buy(alice, A, 40, 100 * ONE);
        _mint(carol, 100 * ONE);
        _sell(carol, A, 55, 100 * ONE);

        FightCardReader.BoutView memory v = reader.getBout(boutId);

        assertEq(v.cardId, CARD);
        assertEq(v.fighterA, FIGHTER_A);
        assertEq(v.bestBidA, 40);
        assertEq(v.bestAskA, 55);
        assertEq(v.priceA, (40 + 55) * 50, "mid of the spread, in bps");
        assertEq(v.totalA, 100 * ONE);
        assertFalse(v.resolved);
    }

    function test_BookSideDepth() public {
        _buy(alice, A, 40, 100 * ONE);
        _buy(bob, A, 40, 50 * ONE);
        _mint(carol, 100 * ONE);
        _sell(carol, A, 70, 100 * ONE);

        (uint256[100] memory bidDepth, uint256[100] memory askDepth) = reader.getBookSide(boutId, A);

        assertEq(bidDepth[40], 150 * ONE, "both bids at the level");
        assertEq(askDepth[70], 100 * ONE);
        assertEq(bidDepth[41], 0);
    }

    function test_PortfolioClaimableTracksOutcome() public {
        _mint(alice, 100 * ONE);
        _sell(alice, A, 90, 40 * ONE);   // part of the position is escrowed

        uint256[] memory ids = new uint256[](1);
        ids[0] = boutId;

        (FightCardReader.PositionView[] memory before,,) = reader.getPortfolio(alice, ids);
        assertEq(before[0].claimable, 0, "nothing claimable before resolution");
        assertEq(before[0].escrowA, 40 * ONE);

        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);

        (FightCardReader.PositionView[] memory pos, uint256 total,) = reader.getPortfolio(alice, ids);
        assertEq(pos[0].claimable, 100 * ONE, "escrowed shares count toward the claim");
        assertEq(total, 100 * ONE);

        vm.prank(alice);
        assertEq(clob.redeem(boutId), total, "reader must agree with the contract");
    }

    function test_UserOrdersSkipsFilledAndCancelled() public {
        uint64 keep = _buy(alice, A, 30, 100 * ONE);
        uint64 kill = _buy(alice, A, 31, 100 * ONE);
        vm.prank(alice);
        clob.cancelOrder(kill);

        (FightCardReader.OrderView[] memory open, uint256 nextIdx) = reader.getUserOrders(alice, 0, 10);

        assertEq(open.length, 1);
        assertEq(open[0].id, keep);
        assertEq(open[0].price, 30);
        assertTrue(open[0].isBuy);
        assertEq(nextIdx, 2);
    }

    function test_SolvencyAndInvariantViews() public {
        _mint(alice, 100 * ONE);
        _buy(bob, A, 40, 100 * ONE);

        (uint256 balance, uint256 obligations,,,,, bool solvent) = reader.getSolvencyInfo();
        assertEq(balance, 140 * ONE);
        assertEq(obligations, 140 * ONE);
        assertTrue(solvent);

        (,,, bool conserved) = reader.checkBoutInvariant(boutId);
        assertTrue(conserved);
    }

    function test_GetCardFiltersByNight() public {
        vm.startPrank(operator);
        clob.createBout(CARD, bytes32("a2"), bytes32("b2"), uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days));
        clob.createBout(99, bytes32("a3"), bytes32("b3"), uint64(block.timestamp + 1 days), uint64(block.timestamp + 2 days));
        vm.stopPrank();

        (FightCardReader.BoutView[] memory views,) = reader.getCard(CARD, 1, 50);
        assertEq(views.length, 2, "only the two bouts on this card");
        assertEq(views[0].cardId, CARD);
        assertEq(views[1].cardId, CARD);
    }
}

// ═══════════════════════════════════════════════════════════════
//  SOLVENCY UNDER LOAD
// ═══════════════════════════════════════════════════════════════

contract FightCardSolvencyTest is FightCardBase {
    /// @dev Random-ish traffic across both sides, asserting the invariants after
    ///      every step. Trading must never move collateral out of the pool.
    function testFuzz_ConservationHoldsThroughTrading(uint8[8] calldata prices, uint16[8] calldata sizes) public {
        for (uint256 i = 0; i < 8; i++) {
            uint8 price = uint8(bound(uint256(prices[i]), 1, 99));
            uint256 shares = bound(uint256(sizes[i]), 1, 500) * ONE;
            address who = i % 3 == 0 ? alice : (i % 3 == 1 ? bob : carol);
            uint8 side = i % 2 == 0 ? A : B;

            if (i % 4 == 3) {
                vm.prank(who);
                clob.mint(boutId, shares);
            } else {
                vm.prank(who);
                clob.placeBuyOrder(boutId, side, price, shares, FightCardCLOB.OrderType.GTC);
            }

            _assertConserved(boutId);
            _assertSolvent();
        }
    }

    function test_EveryoneCanExitAfterResolution() public {
        // Build a book with both a filled trade and orders still resting at the
        // bell, then settle and drain it completely.
        _mint(alice, 200 * ONE);
        _sell(alice, A, 45, 100 * ONE);
        _buy(bob, A, 45, 100 * ONE);       // fills against alice
        _buy(carol, A, 30, 100 * ONE);     // rests: no ask that low, no B bid at 70
        _sell(alice, B, 80, 50 * ONE);     // rests: no B bid that high

        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);

        // Resting orders release their collateral and their shares.
        clob.sweepLevel(boutId, A, 30, true);
        clob.sweepLevel(boutId, B, 80, false);
        assertEq(clob.pendingWithdrawal(carol), 30 * ONE, "unfilled bid refunded");
        assertEq(clob.escrowedOf(boutId, B, alice), 0, "unfilled ask released");

        vm.prank(alice);
        clob.redeem(boutId);
        vm.prank(bob);
        clob.redeem(boutId);

        _assertSolvent();

        _withdraw(alice);
        _withdraw(bob);
        _withdraw(carol);

        assertEq(clob.totalPendingWithdrawal(), 0);
        assertEq(clob.collateralPool(boutId), 0);
        assertEq(usdc.balanceOf(address(clob)), 0, "nothing left stranded in the contract");
    }

    function test_TwoBoutsStayIndependent() public {
        vm.prank(operator);
        uint256 second = clob.createBout(
            CARD, bytes32("x"), bytes32("y"),
            uint64(block.timestamp + 1 days), uint64(block.timestamp + 3 days)
        );

        _mint(alice, 100 * ONE);
        vm.prank(bob);
        clob.mint(second, 250 * ONE);

        assertEq(clob.collateralPool(boutId), 100 * ONE);
        assertEq(clob.collateralPool(second), 250 * ONE);
        assertEq(clob.totalCollateral(), 350 * ONE);

        // Settling one bout must not touch the other's money.
        vm.prank(operator);
        clob.resolveBout(boutId, FightCardCLOB.Outcome.FIGHTER_A);
        vm.prank(alice);
        clob.redeem(boutId);

        assertEq(clob.collateralPool(second), 250 * ONE, "other bout untouched");
        assertEq(clob.totalCollateral(), 250 * ONE);
        _assertSolvent();
    }
}
