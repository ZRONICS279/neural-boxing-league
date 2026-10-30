// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TestUSD — faucet collateral for testnets
 * @notice A six-decimal ERC-20 shaped like USDC, with an open faucet. Deploy it
 *         anywhere the fight book needs collateral and no real stablecoin
 *         exists yet — Robinhood Chain testnet, a local anvil, a fork.
 *
 *  Six decimals on purpose. `FightCardCLOB` requires order sizes to be a
 *  multiple of 100 base units so `shares × price / 100` is exact, which on a
 *  6-decimal token makes the smallest tradeable size 0.0001 — small enough that
 *  the rule is invisible. On an 18-decimal token the same rule is invisible for
 *  a different reason, but the numbers a tester reads stop matching what a real
 *  USDC deployment would show.
 *
 *  The faucet is deliberately open: on a testnet, making people ask an operator
 *  for play money is the thing that stops them testing. `DRIP` per call, one
 *  call per `COOLDOWN`, so a script cannot mint a supply large enough to make
 *  every number on a UI unreadable.
 *
 *  Never deploy this to a mainnet. There is nothing behind it.
 */
contract TestUSD {
    string public constant name = "Forge Test USD";
    string public constant symbol = "tUSD";
    uint8  public constant decimals = 6;

    /// @notice What one `drip()` hands out: 10,000 tUSD.
    uint256 public constant DRIP = 10_000e6;
    /// @notice How long a caller waits between drips.
    uint256 public constant COOLDOWN = 4 hours;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// @notice When each address may call `drip()` again.
    mapping(address => uint256) public nextDripAt;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    // ═══════════════════════════════════════════
    //  ERC-20
    // ═══════════════════════════════════════════

    function transfer(address _to, uint256 _amount) external returns (bool) {
        _move(msg.sender, _to, _amount);
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _amount) external returns (bool) {
        uint256 allowed = allowance[_from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= _amount, "ALLOW");
            allowance[_from][msg.sender] = allowed - _amount;
        }
        _move(_from, _to, _amount);
        return true;
    }

    function approve(address _spender, uint256 _amount) external returns (bool) {
        allowance[msg.sender][_spender] = _amount;
        emit Approval(msg.sender, _spender, _amount);
        return true;
    }

    // ═══════════════════════════════════════════
    //  FAUCET
    // ═══════════════════════════════════════════

    /// @notice Hand the caller a stack of play money.
    function drip() external {
        require(block.timestamp >= nextDripAt[msg.sender], "WAIT");
        nextDripAt[msg.sender] = block.timestamp + COOLDOWN;
        _issue(msg.sender, DRIP);
    }

    /// @notice Same as `drip()`, but the money lands somewhere else — how a
    ///         deploy script stocks a set of test accounts in one transaction.
    ///         Rate-limited against the caller, not the recipient.
    function dripTo(address _to) external {
        require(block.timestamp >= nextDripAt[msg.sender], "WAIT");
        nextDripAt[msg.sender] = block.timestamp + COOLDOWN;
        _issue(_to, DRIP);
    }

    // ═══════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════

    function _issue(address _to, uint256 _amount) internal {
        require(_to != address(0), "ZERO");
        totalSupply += _amount;
        balanceOf[_to] += _amount;
        emit Transfer(address(0), _to, _amount);
    }

    function _move(address _from, address _to, uint256 _amount) internal {
        require(_to != address(0), "ZERO");
        uint256 bal = balanceOf[_from];
        require(bal >= _amount, "BAL");
        unchecked {
            balanceOf[_from] = bal - _amount;
            balanceOf[_to] += _amount;
        }
        emit Transfer(_from, _to, _amount);
    }
}
