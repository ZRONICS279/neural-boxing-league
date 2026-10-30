// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/FightCardCLOB.sol";
import "../contracts/FightCardParlay.sol";

// ═══════════════════════════════════════════════════════════════
//  MOCK COLLATERAL — USDC-shaped: 6 decimals, no return value
// ═══════════════════════════════════════════════════════════════

contract ParlayUSDC {
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

// ═══════════════════════════════════════════════════════════════
//  HARNESS — a real CLOB with a real 3-fight card behind the parlay
// ═══════════════════════════════════════════════════════════════

contract ParlayBase is Test {
    FightCardCLOB   public clob;
    FightCardParlay public parlay;
    ParlayUSDC      public usdc;

    address deployer = address(0xD1);
    address operator = address(0x0F);
    address feeSink  = address(0xFE);
    address alice    = address(0xA);
    address bob      = address(0xB);
    address carol    = address(0xC);
    address dave     = address(0xD);

    uint256 constant ONE = 1e6;
    uint64  constant CARD = 7;
    uint8   constant LEGS = 3;

    uint256[] legs;
    uint256 parlayId;

    // Combos over 3 legs. Bit i set = fighter B took leg i.
    uint8 constant AAA = 0;      // 000
    uint8 constant BAA = 1;      // 001
    uint8 constant ABA = 2;      // 010
    uint8 constant BBA = 3;      // 011
    uint8 constant AAB = 4;      // 100
    uint8 constant BAB = 5;      // 101
    uint8 constant ABB = 6;      // 110
    uint8 constant BBB = 7;      // 111

    function setUp() public virtual {
        usdc = new ParlayUSDC();

        vm.startPrank(deployer);
        clob = new FightCardCLOB(address(usdc), operator, feeSink, 0);
        parlay = new FightCardParlay(address(clob), operator, feeSink);
        vm.stopPrank();

        vm.startPrank(operator);
        for (uint256 i = 0; i < LEGS; i++) {
            legs.push(clob.createBout(
                CARD,
                bytes32(uint256(0xA0 + i)),
                bytes32(uint256(0xB0 + i)),
                uint64(block.timestamp + 1 days),
                uint64(block.timestamp + 3 days)
            ));
        }
        parlayId = parlay.createParlay(
            CARD, legs,
            uint64(block.timestamp + 12 hours),
            uint64(block.timestamp + 5 days),
            0
        );
        vm.stopPrank();

        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(dave);
        _fund(operator);
    }

    function _fund(address who) internal {
        usdc.mint(who, 1_000_000 * ONE);
        vm.prank(who);
        usdc.approve(address(parlay), type(uint256).max);
    }

    function _bet(address who, uint8 combo, uint256 amount) internal {
        vm.prank(who);
        parlay.placeTicket(parlayId, combo, amount);
    }

    /// @dev Resolve every leg. `outcomes[i]` is the CLOB outcome for leg i.
    function _resolveLegs(FightCardCLOB.Outcome[3] memory outcomes) internal {
        vm.startPrank(operator);
        for (uint256 i = 0; i < LEGS; i++) {
            clob.resolveBout(legs[i], outcomes[i]);
        }
        vm.stopPrank();
    }

    function _allAWins() internal {
        _resolveLegs([
            FightCardCLOB.Outcome.FIGHTER_A,
            FightCardCLOB.Outcome.FIGHTER_A,
            FightCardCLOB.Outcome.FIGHTER_A
        ]);
    }

    function _claim(address who, uint8 combo) internal returns (uint256) {
        vm.prank(who);
        return parlay.claim(parlayId, combo);
    }

    /// @dev The contract must always hold at least what it still owes.
    function _assertSolvent() internal view {
        assertTrue(parlay.solvent(), "parlay insolvent");
    }
}

// ═══════════════════════════════════════════════════════════════
//  BETTING
// ═══════════════════════════════════════════════════════════════

contract ParlayBettingTest is ParlayBase {
    function test_TicketAddsToPotAndCombo() public {
        _bet(alice, AAA, 100 * ONE);
        _bet(bob, BBB, 250 * ONE);

        (, , , , , , , , uint256 pot, , ) = parlay.getParlay(parlayId);
        assertEq(pot, 350 * ONE, "pot");
        assertEq(parlay.comboStake(parlayId, AAA), 100 * ONE, "combo AAA");
        assertEq(parlay.stakeOf(parlayId, AAA, alice), 100 * ONE, "alice stake");
        assertEq(usdc.balanceOf(address(parlay)), 350 * ONE, "held");
        _assertSolvent();
    }

    function test_SameUserCanBackSeveralCombos() public {
        _bet(alice, AAA, 100 * ONE);
        _bet(alice, BBB, 40 * ONE);

        assertEq(parlay.stakeOf(parlayId, AAA, alice), 100 * ONE);
        assertEq(parlay.stakeOf(parlayId, BBB, alice), 40 * ONE);
    }

    function test_RejectsComboOutsideLegSpace() public {
        // Only 3 legs, so 8 is out of range.
        vm.prank(alice);
        vm.expectRevert(bytes("CB"));
        parlay.placeTicket(parlayId, 8, 100 * ONE);
    }

    function test_RejectsDustStake() public {
        vm.prank(alice);
        vm.expectRevert(bytes("SM"));
        parlay.placeTicket(parlayId, AAA, 1);
    }

    function test_CannotBetAfterOperatorCloses() public {
        _bet(alice, AAA, 100 * ONE);

        vm.prank(operator);
        parlay.closeParlay(parlayId);

        vm.prank(bob);
        vm.expectRevert(bytes("CL"));
        parlay.placeTicket(parlayId, BBB, 100 * ONE);
    }

    function test_CannotBetAfterClosesAtEvenIfNobodyClosed() public {
        vm.warp(block.timestamp + 13 hours);
        vm.prank(alice);
        vm.expectRevert(bytes("CT"));
        parlay.placeTicket(parlayId, AAA, 100 * ONE);
    }

    function test_AnyoneCanCloseAfterDeadline() public {
        vm.warp(block.timestamp + 13 hours);
        vm.prank(dave);
        parlay.closeParlay(parlayId);

        (, , , , , bool closed, , , , , ) = parlay.getParlay(parlayId);
        assertTrue(closed, "closed");
    }

    function test_OnlyOperatorCreatesAndClosesEarly() public {
        uint256[] memory two = new uint256[](2);
        two[0] = legs[0];
        two[1] = legs[1];

        vm.prank(alice);
        vm.expectRevert(bytes("NP"));
        parlay.createParlay(CARD, two, uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 days), 0);

        vm.prank(alice);
        vm.expectRevert(bytes("NA"));
        parlay.closeParlay(parlayId);
    }

    function test_RejectsDuplicateAndStartedLegs() public {
        uint256[] memory dup = new uint256[](2);
        dup[0] = legs[0];
        dup[1] = legs[0];

        vm.prank(operator);
        vm.expectRevert(bytes("DUP"));
        parlay.createParlay(CARD, dup, uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 days), 0);

        // A bout that already had its opening bell can't be a leg.
        vm.prank(operator);
        clob.closeBout(legs[0]);

        uint256[] memory started = new uint256[](2);
        started[0] = legs[0];
        started[1] = legs[1];

        vm.prank(operator);
        vm.expectRevert(bytes("BC"));
        parlay.createParlay(CARD, started, uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 days), 0);
    }
}

// ═══════════════════════════════════════════════════════════════
//  SETTLEMENT & PAYOUT
// ═══════════════════════════════════════════════════════════════

contract ParlaySettlementTest is ParlayBase {
    function test_SoleWinnerTakesPerfectPool() public {
        _bet(alice, AAA, 100 * ONE);   // will be perfect
        _bet(bob, BBB, 300 * ONE);     // 0 hits
        _bet(carol, BAA, 100 * ONE);   // 2 hits — runner up

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _allAWins();
        parlay.settleParlay(parlayId);

        // 500 pot, no rake. Perfect tier takes 80% = 400, runner-up 20% = 100.
        assertEq(_claim(alice, AAA), 400 * ONE, "alice perfect");
        assertEq(_claim(carol, BAA), 100 * ONE, "carol runner-up");

        vm.prank(bob);
        assertEq(parlay.claim(parlayId, BBB), 0, "bob lost");
        _assertSolvent();
    }

    function test_TwoPerfectTicketsSplitProRata() public {
        _bet(alice, AAA, 100 * ONE);
        _bet(bob, AAA, 300 * ONE);
        _bet(carol, BBB, 100 * ONE);

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _allAWins();
        parlay.settleParlay(parlayId);

        // 500 pot → perfect pool 400, split 1:3.
        assertEq(_claim(alice, AAA), 100 * ONE, "alice quarter");
        assertEq(_claim(bob, AAA), 300 * ONE, "bob three quarters");
        _assertSolvent();
    }

    function test_NoPerfectTicketMeansBestTierTakesEverything() public {
        _bet(alice, BAA, 100 * ONE);   // 2 hits
        _bet(bob, BBA, 100 * ONE);     // 1 hit
        _bet(carol, BBB, 200 * ONE);   // 0 hits

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _allAWins();
        parlay.settleParlay(parlayId);

        // Nobody perfect, so the whole 400 goes to the 2-hit tier.
        assertEq(_claim(alice, BAA), 400 * ONE, "best tier takes all");
        assertEq(_claim(bob, BBA), 0, "second best gets nothing");
        _assertSolvent();
    }

    function test_EveryoneOnOneComboGetsWholePot() public {
        _bet(alice, AAA, 100 * ONE);
        _bet(bob, AAA, 100 * ONE);

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _allAWins();
        parlay.settleParlay(parlayId);

        // No imperfect tier exists, so there's no 20% to carve off.
        assertEq(_claim(alice, AAA), 100 * ONE);
        assertEq(_claim(bob, AAA), 100 * ONE);
        _assertSolvent();
    }

    function test_VoidLegIsAHitForEveryone() public {
        _bet(alice, AAA, 100 * ONE);   // leg2 pick A
        _bet(bob, AAB, 100 * ONE);     // leg2 pick B — differs only on the void leg
        _bet(carol, BBB, 200 * ONE);

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _resolveLegs([
            FightCardCLOB.Outcome.FIGHTER_A,
            FightCardCLOB.Outcome.FIGHTER_A,
            FightCardCLOB.Outcome.VOID
        ]);
        parlay.settleParlay(parlayId);

        // The drawn leg counts for both, so both tickets are perfect and split
        // the perfect pool evenly.
        assertEq(parlay.hitsFor(parlayId, AAA), 3, "AAA perfect");
        assertEq(parlay.hitsFor(parlayId, AAB), 3, "AAB perfect too");
        assertEq(_claim(alice, AAA), 160 * ONE, "alice half of 320");
        assertEq(_claim(bob, AAB), 160 * ONE, "bob half of 320");
        _assertSolvent();
    }

    function test_AllLegsVoidReturnsEveryStake() public {
        _bet(alice, AAA, 100 * ONE);
        _bet(bob, BBB, 300 * ONE);

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _resolveLegs([
            FightCardCLOB.Outcome.VOID,
            FightCardCLOB.Outcome.VOID,
            FightCardCLOB.Outcome.VOID
        ]);
        parlay.settleParlay(parlayId);

        // Everyone is perfect, so the pot comes back in proportion to stake —
        // which is exactly what each of them put in.
        assertEq(_claim(alice, AAA), 100 * ONE, "alice whole stake");
        assertEq(_claim(bob, BBB), 300 * ONE, "bob whole stake");
        _assertSolvent();
    }

    function test_SettleRequiresEveryLegResolved() public {
        _bet(alice, AAA, 100 * ONE);

        vm.prank(operator);
        parlay.closeParlay(parlayId);

        vm.prank(operator);
        clob.resolveBout(legs[0], FightCardCLOB.Outcome.FIGHTER_A);

        vm.expectRevert(bytes("NR"));
        parlay.settleParlay(parlayId);
    }

    function test_SettlementIsPermissionless() public {
        _bet(alice, AAA, 100 * ONE);
        _allAWins();

        vm.prank(dave);   // not the operator
        parlay.settleParlay(parlayId);

        (, , , , , , bool settled, , , , ) = parlay.getParlay(parlayId);
        assertTrue(settled, "settled by a stranger");
    }

    function test_CannotClaimTwice() public {
        _bet(alice, AAA, 100 * ONE);
        _allAWins();
        parlay.settleParlay(parlayId);

        _claim(alice, AAA);

        vm.prank(alice);
        vm.expectRevert(bytes("NT"));
        parlay.claim(parlayId, AAA);
    }

    function test_RakeGoesToFeeSink() public {
        vm.prank(operator);
        uint256 raked = parlay.createParlay(
            CARD, legs,
            uint64(block.timestamp + 12 hours),
            uint64(block.timestamp + 5 days),
            300   // 3%
        );

        vm.prank(alice);
        parlay.placeTicket(raked, AAA, 1000 * ONE);
        _allAWins();
        parlay.settleParlay(raked);

        assertEq(parlay.accFees(), 30 * ONE, "3% rake");

        vm.prank(alice);
        assertEq(parlay.claim(raked, AAA), 970 * ONE, "payout net of rake");

        vm.prank(feeSink);
        parlay.claimFees();
        assertEq(usdc.balanceOf(feeSink), 30 * ONE, "rake paid out");
    }
}

// ═══════════════════════════════════════════════════════════════
//  THE TOTE BOARD — what the bettor is shown before they commit
// ═══════════════════════════════════════════════════════════════

contract ParlayQuoteTest is ParlayBase {
    /// @dev The number on screen has to be the number they actually receive,
    ///      assuming nobody bets after them. This is the whole product promise.
    function test_QuoteMatchesWhatTheyActuallyGet() public {
        _bet(alice, AAA, 200 * ONE);
        _bet(bob, BBB, 300 * ONE);

        uint256 stake = 100 * ONE;
        (uint256 quoted, uint256 pot, uint256 comboTotal) = parlay.quote(parlayId, AAA, stake);

        assertEq(pot, 600 * ONE, "pot including this bet");
        assertEq(comboTotal, 300 * ONE, "combo total including this bet");

        _bet(carol, AAA, stake);

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _allAWins();
        parlay.settleParlay(parlayId);

        assertEq(_claim(carol, AAA), quoted, "quote must equal payout");
    }

    function test_QuoteRisesWhenOthersBackDifferentCombos() public {
        _bet(alice, AAA, 100 * ONE);

        (uint256 before_, , ) = parlay.quote(parlayId, AAA, 100 * ONE);
        _bet(bob, BBB, 500 * ONE);
        (uint256 after_, , ) = parlay.quote(parlayId, AAA, 100 * ONE);

        assertGt(after_, before_, "money elsewhere should raise the payout");
    }

    function test_QuoteFallsWhenOthersPileOnTheSameCombo() public {
        _bet(alice, AAA, 100 * ONE);
        _bet(bob, BBB, 500 * ONE);

        (uint256 before_, , ) = parlay.quote(parlayId, AAA, 100 * ONE);
        _bet(carol, AAA, 400 * ONE);
        (uint256 after_, , ) = parlay.quote(parlayId, AAA, 100 * ONE);

        assertLt(after_, before_, "crowding should lower the payout");
    }

    /// @dev The pot is final at close, so the figure can't move once the fights
    ///      start — which is the property that makes this honest to display.
    function test_QuoteIsFrozenOnceClosed() public {
        _bet(alice, AAA, 100 * ONE);
        _bet(bob, BBB, 300 * ONE);

        (uint256 atClose, , ) = parlay.quote(parlayId, AAA, 0);

        vm.prank(operator);
        parlay.closeParlay(parlayId);

        vm.prank(carol);
        vm.expectRevert(bytes("CL"));
        parlay.placeTicket(parlayId, BBB, 10_000 * ONE);

        (uint256 after_, , ) = parlay.quote(parlayId, AAA, 0);
        assertEq(after_, atClose, "nothing can move the pot after the bell");
    }
}

// ═══════════════════════════════════════════════════════════════
//  SEEDED POT — fixing the cold start
// ═══════════════════════════════════════════════════════════════

contract ParlaySeedTest is ParlayBase {
    function _seed(uint256 amount) internal {
        vm.prank(operator);
        parlay.seedPot(parlayId, amount);
    }

    function test_SeedIsWonByTheBestTicket() public {
        _seed(1000 * ONE);
        _bet(alice, AAA, 100 * ONE);   // perfect
        _bet(bob, BBB, 100 * ONE);     // 0 hits

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _allAWins();
        parlay.settleParlay(parlayId);

        // Pot is 1200. Perfect tier takes 80% = 960 — far more than the 160 the
        // same picks would have paid on stakes alone.
        assertEq(_claim(alice, AAA), 960 * ONE, "alice wins the seed too");
        _assertSolvent();
    }

    function test_SeedLandsInTheQuoteImmediately() public {
        (uint256 bare, , ) = parlay.quote(parlayId, AAA, 100 * ONE);
        _seed(900 * ONE);
        (uint256 seeded, , ) = parlay.quote(parlayId, AAA, 100 * ONE);

        assertEq(bare, 100 * ONE, "unseeded pays back only the stake");
        assertEq(seeded, 1000 * ONE, "seed is visible before anyone bets");
    }

    function test_RakeIsCapped() public {
        vm.prank(operator);
        vm.expectRevert(bytes("RK"));
        parlay.createParlay(
            CARD, legs,
            uint64(block.timestamp + 12 hours),
            uint64(block.timestamp + 5 days),
            501   // one over the 5% ceiling
        );
    }

    function test_RakeOnlyAppliesToStakes() public {
        vm.prank(operator);
        uint256 raked = parlay.createParlay(
            CARD, legs,
            uint64(block.timestamp + 12 hours),
            uint64(block.timestamp + 5 days),
            500   // 5%
        );

        vm.prank(operator);
        parlay.seedPot(raked, 1000 * ONE);
        vm.prank(alice);
        parlay.placeTicket(raked, AAA, 200 * ONE);

        _allAWins();
        parlay.settleParlay(raked);

        // 5% of the 200 staked, not of the 1200 in the middle.
        assertEq(parlay.accFees(), 10 * ONE, "rake on stakes only");

        vm.prank(alice);
        assertEq(parlay.claim(raked, AAA), 1190 * ONE, "alice takes pot less rake");
    }

    function test_ReclaimSeedWhenNobodyTurnedUp() public {
        _seed(500 * ONE);
        uint256 before_ = usdc.balanceOf(operator);

        vm.prank(operator);
        parlay.closeParlay(parlayId);
        _allAWins();
        parlay.settleParlay(parlayId);

        vm.prank(operator);
        assertEq(parlay.reclaimSeed(parlayId), 500 * ONE, "seed returned");
        assertEq(usdc.balanceOf(operator), before_ + 500 * ONE, "operator made whole");
        assertEq(usdc.balanceOf(address(parlay)), 0, "nothing stranded");
    }

    function test_ReclaimSeedAfterRefund() public {
        _seed(500 * ONE);
        _bet(alice, AAA, 100 * ONE);

        vm.warp(block.timestamp + 6 days);
        parlay.refundParlay(parlayId);

        assertEq(_claim(alice, AAA), 100 * ONE, "stake refunded");

        vm.prank(operator);
        assertEq(parlay.reclaimSeed(parlayId), 500 * ONE, "seed refunded too");
        assertEq(usdc.balanceOf(address(parlay)), 0, "drained clean");
    }

    function test_CannotReclaimSeedOnceItWasWon() public {
        _seed(500 * ONE);
        _bet(alice, AAA, 100 * ONE);

        _allAWins();
        parlay.settleParlay(parlayId);

        vm.prank(operator);
        vm.expectRevert(bytes("NE"));
        parlay.reclaimSeed(parlayId);
    }

    function test_CannotSeedAfterClose() public {
        vm.prank(operator);
        parlay.closeParlay(parlayId);

        vm.prank(operator);
        vm.expectRevert(bytes("CL"));
        parlay.seedPot(parlayId, 100 * ONE);
    }

    function test_OnlyOperatorSeeds() public {
        vm.prank(alice);
        vm.expectRevert(bytes("NP"));
        parlay.seedPot(parlayId, 100 * ONE);
    }
}

// ═══════════════════════════════════════════════════════════════
//  BACKSTOPS & SOLVENCY
// ═══════════════════════════════════════════════════════════════

contract ParlaySafetyTest is ParlayBase {
    function test_RefundBackstopReturnsExactStakes() public {
        _bet(alice, AAA, 100 * ONE);
        _bet(bob, BBB, 300 * ONE);

        // Legs never resolve and the operator goes dark.
        vm.warp(block.timestamp + 6 days);
        vm.prank(dave);
        parlay.refundParlay(parlayId);

        assertEq(_claim(alice, AAA), 100 * ONE, "alice refunded in full");
        assertEq(_claim(bob, BBB), 300 * ONE, "bob refunded in full");
        assertEq(usdc.balanceOf(address(parlay)), 0, "contract drained to zero");
    }

    function test_CannotRefundBeforeDeadline() public {
        _bet(alice, AAA, 100 * ONE);
        vm.expectRevert(bytes("TE"));
        parlay.refundParlay(parlayId);
    }

    function test_CannotRefundOnceSettled() public {
        _bet(alice, AAA, 100 * ONE);
        _allAWins();
        parlay.settleParlay(parlayId);

        vm.warp(block.timestamp + 6 days);
        vm.expectRevert(bytes("AS"));
        parlay.refundParlay(parlayId);
    }

    function test_ParlayCannotTouchOrderBookCollateral() public {
        // Money in the book stays in the book; the parlay holds its own pot.
        vm.prank(alice);
        usdc.approve(address(clob), type(uint256).max);
        vm.prank(alice);
        clob.mint(legs[0], 1000 * ONE);

        _bet(bob, AAA, 500 * ONE);

        assertEq(usdc.balanceOf(address(clob)), 1000 * ONE, "book untouched");
        assertEq(usdc.balanceOf(address(parlay)), 500 * ONE, "pot separate");
        assertGe(usdc.balanceOf(address(clob)), clob.totalObligations(), "book solvent");
        _assertSolvent();
    }

    /// @dev Whatever the picks and whatever the results, the contract can never
    ///      pay out more than was staked. This is the guarantee that a priced
    ///      parlay could not give without a capitalised vault behind it.
    function testFuzz_NeverPaysMoreThanThePot(
        uint8[6] memory combos,
        uint16[6] memory amounts,
        uint8 resultSeed
    ) public {
        uint256 pot;
        address[6] memory betters = [alice, bob, carol, dave, address(0xE1), address(0xE2)];

        for (uint256 i = 0; i < 6; i++) {
            if (i >= 4) _fund(betters[i]);
            uint256 amt = (uint256(amounts[i]) + 1) * ONE;
            uint8 combo = combos[i] % 8;
            vm.prank(betters[i]);
            parlay.placeTicket(parlayId, combo, amt);
            pot += amt;
        }

        vm.prank(operator);
        parlay.closeParlay(parlayId);

        FightCardCLOB.Outcome[3] memory outcomes;
        for (uint256 i = 0; i < 3; i++) {
            uint8 r = uint8((uint256(resultSeed) >> (i * 2)) & 3);
            outcomes[i] = r == 0
                ? FightCardCLOB.Outcome.FIGHTER_A
                : (r == 1 ? FightCardCLOB.Outcome.FIGHTER_B : FightCardCLOB.Outcome.VOID);
        }
        _resolveLegs(outcomes);
        parlay.settleParlay(parlayId);

        uint256 paid;
        for (uint256 i = 0; i < 6; i++) {
            uint8 combo = combos[i] % 8;
            if (parlay.stakeOf(parlayId, combo, betters[i]) == 0) continue;
            vm.prank(betters[i]);
            paid += parlay.claim(parlayId, combo);
        }

        assertLe(paid, pot, "paid out more than was staked");
        _assertSolvent();
    }
}
