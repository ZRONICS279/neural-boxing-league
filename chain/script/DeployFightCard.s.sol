// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/FightCardCLOB.sol";
import "../contracts/FightCardReader.sol";
import "../contracts/FightCardParlay.sol";
import "../contracts/TestUSD.sol";

/**
 * @title DeployFightCard
 * @notice Deploys the fight-night order book, its view companion, and the
 *         parimutuel parlay card that sits beside it.
 *
 *  Deployed with forge rather than hardhat on purpose: hardhat.config.js
 *  compiles with `revertStrings: "strip"` so the oversized legacy contracts
 *  fit, which would throw away this contract's revert codes. FightCardCLOB has
 *  room to spare, so it keeps them.
 *
 *  Usage:
 *    forge script script/DeployFightCard.s.sol:DeployFightCard \
 *      --rpc-url $ROBINHOOD_RPC_URL --broadcast --verify
 *
 *  Required env:
 *    DEPLOYER_PRIVATE_KEY  deployer + contract owner
 *  Optional env:
 *    COLLATERAL_TOKEN      ERC-20 traders post (6–18 decimals). Left unset, the
 *                          script deploys a TestUSD faucet and uses that —
 *                          which is what you want on a testnet, where no real
 *                          stablecoin exists to point at.
 *    FIGHT_OPERATOR        league backend key. Defaults to the deployer, so a
 *                          testnet deploy needs one key and no setup.
 *    FIGHT_FEE_RECIPIENT   defaults to the deployer
 *    FIGHT_TAKER_FEE_BPS   defaults to 0; hard ceiling is 100 (1%)
 */
contract DeployFightCard is Script {
    function run() external returns (FightCardCLOB clob, FightCardReader reader, FightCardParlay parlay) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address token = vm.envOr("COLLATERAL_TOKEN", address(0));
        address operator = vm.envOr("FIGHT_OPERATOR", deployer);
        address feeRecipient = vm.envOr("FIGHT_FEE_RECIPIENT", deployer);
        uint256 takerFeeBps = vm.envOr("FIGHT_TAKER_FEE_BPS", uint256(0));

        console.log("Chain id:      ", block.chainid);
        console.log("Deployer:      ", deployer);
        console.log("Operator:      ", operator);
        console.log("Fee recipient: ", feeRecipient);
        console.log("Taker fee bps: ", takerFeeBps);

        vm.startBroadcast(pk);

        // No collateral named means a chain that has no stablecoin to name.
        // Deploy the faucet token rather than failing, so bringing the book up
        // on a fresh testnet is one command and not a chicken-and-egg.
        if (token == address(0)) {
            token = address(new TestUSD());
            console.log("Collateral:     (deployed TestUSD)", token);
        } else {
            console.log("Collateral:    ", token);
        }

        clob = new FightCardCLOB(token, operator, feeRecipient, takerFeeBps);
        reader = new FightCardReader(address(clob));
        // Reads outcomes from the book, holds its own pot; it can never touch
        // order-book collateral.
        parlay = new FightCardParlay(address(clob), operator, feeRecipient);
        vm.stopBroadcast();

        console.log("FightCardCLOB:  ", address(clob));
        console.log("FightCardReader:", address(reader));
        console.log("FightCardParlay:", address(parlay));
        console.log("One collateral unit:", clob.oneUnit());

        _writeDeployment(address(clob), address(reader), address(parlay), token, operator, feeRecipient, takerFeeBps, deployer);
    }

    /// @dev Same `deployments/<network>.json` shape the backend and frontend
    ///      already read, so pointing them at a new chain is one file.
    function _writeDeployment(
        address _clob,
        address _reader,
        address _parlay,
        address _token,
        address _operator,
        address _feeRecipient,
        uint256 _takerFeeBps,
        address _deployer
    ) internal {
        string memory network = vm.envOr("DEPLOY_NETWORK", string("robinhood"));
        string memory obj = "fightcard";

        vm.serializeString(obj, "network", network);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "fightCardCLOBAddress", _clob);
        vm.serializeAddress(obj, "fightCardReaderAddress", _reader);
        vm.serializeAddress(obj, "fightCardParlayAddress", _parlay);
        vm.serializeAddress(obj, "collateralToken", _token);
        vm.serializeAddress(obj, "fightOperator", _operator);
        vm.serializeAddress(obj, "feeRecipient", _feeRecipient);
        vm.serializeUint(obj, "takerFeeBps", _takerFeeBps);
        // The block the book came up in. Anything reading fill history bounds
        // its `eth_getLogs` at this — there is provably nothing before it, and
        // scanning from genesis on an Orbit chain that is already 96M blocks
        // deep is the difference between a chart and a timeout.
        //
        // `block.number` inside a *deployed* Arbitrum contract approximates the
        // L1 block and would be useless here. In a forge script it is the fork's
        // block, which foundry takes from the node's `eth_blockNumber` — the L2
        // height. Verified against `cast block-number` on the testnet.
        vm.serializeUint(obj, "startBlock", block.number);
        vm.serializeUint(obj, "collateralDecimals", IERC20Decimals(_token).decimals());
        string memory json = vm.serializeAddress(obj, "deployer", _deployer);

        string memory path = string.concat("deployments/", network, "-fightcard.json");
        vm.writeJson(json, path);
        console.log("Wrote", path);
    }
}
