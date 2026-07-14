// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

/// @title TokenizedMMF — simulated tokenized money-market fund for idle treasury balances.
/// @notice Institutions park idle settlement stablecoin here and redeem T+0. Shares are
///         priced off a monotonic `currentIndex` (1e18 = par); the operator advances the
///         index to simulate accrued yield. Testnet only: yield is simulated, not earned.
///
///         Segregation: this contract holds its own asset balance and never calls, holds
///         funds for, or is called by PaymentSettlement. Payment escrow and parked
///         treasury liquidity are strictly separate pools.
///
///         Yield funding: advancing the index raises redemption value without adding asset
///         to the contract, so redemptions of accrued yield draw on a yield buffer that must
///         be funded externally (the mock asset is freely mintable on testnet). An
///         underfunded buffer makes redeem revert rather than shortchange a redeemer.
contract TokenizedMMF {
    /// @dev Fixed-point scale for the share index. 1e18 == 1.0 == par.
    uint256 public constant INDEX_SCALE = 1e18;

    address public admin;
    address public immutable asset;

    /// @notice Asset per share, scaled by INDEX_SCALE. Monotonically non-decreasing.
    uint256 public currentIndex = INDEX_SCALE;
    uint256 public totalShares;

    mapping(address => bool) public operators;
    mapping(address => uint256) public sharesOf;

    event OperatorSet(address indexed operator, bool enabled);
    event Subscribed(address indexed account, uint256 assetAmount, uint256 shares);
    event Redeemed(address indexed account, uint256 shares, uint256 assetAmount);
    event Accrued(uint256 oldIndex, uint256 newIndex);

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlyOperator() {
        require(operators[msg.sender], "not operator");
        _;
    }

    constructor(address asset_) {
        require(asset_ != address(0), "zero asset");
        admin = msg.sender;
        asset = asset_;
        operators[msg.sender] = true;
        emit OperatorSet(msg.sender, true);
    }

    function setOperator(address operator, bool enabled) external onlyAdmin {
        operators[operator] = enabled;
        emit OperatorSet(operator, enabled);
    }

    /// @notice Park `assetAmount` of the fund asset on behalf of `onBehalfOf`, minting shares
    ///         at the current index. `onBehalfOf` must have approved this contract for the asset.
    function subscribe(address onBehalfOf, uint256 assetAmount) external onlyOperator returns (uint256 shares) {
        require(onBehalfOf != address(0), "zero account");
        require(assetAmount > 0, "zero amount");

        shares = (assetAmount * INDEX_SCALE) / currentIndex;
        require(shares > 0, "zero shares");

        sharesOf[onBehalfOf] += shares;
        totalShares += shares;

        require(IERC20(asset).transferFrom(onBehalfOf, address(this), assetAmount), "subscribe transfer failed");

        emit Subscribed(onBehalfOf, assetAmount, shares);
    }

    /// @notice Redeem `shares` held by `onBehalfOf` at the current index, returning the asset
    ///         (principal plus accrued yield) to `onBehalfOf`.
    function redeem(address onBehalfOf, uint256 shares) external onlyOperator returns (uint256 assetAmount) {
        require(shares > 0, "zero shares");
        require(sharesOf[onBehalfOf] >= shares, "insufficient shares");

        assetAmount = (shares * currentIndex) / INDEX_SCALE;

        sharesOf[onBehalfOf] -= shares;
        totalShares -= shares;

        require(IERC20(asset).transfer(onBehalfOf, assetAmount), "redeem transfer failed");

        emit Redeemed(onBehalfOf, shares, assetAmount);
    }

    /// @notice Advance the share index to simulate accrued yield. Monotonic: the index can
    ///         never move down, so a parked position's value never decreases.
    function accrue(uint256 newIndex) external onlyOperator {
        require(newIndex >= currentIndex, "index must not decrease");
        uint256 oldIndex = currentIndex;
        currentIndex = newIndex;
        emit Accrued(oldIndex, newIndex);
    }

    /// @notice Current asset value of `account`'s shares at the live index.
    function assetValueOf(address account) external view returns (uint256) {
        return (sharesOf[account] * currentIndex) / INDEX_SCALE;
    }

    /// @notice Asset the contract holds beyond what all outstanding shares are worth — the
    ///         buffer available to pay simulated yield on redemption.
    function yieldBuffer() external view returns (uint256) {
        uint256 held = IERC20(asset).balanceOf(address(this));
        uint256 owed = (totalShares * currentIndex) / INDEX_SCALE;
        return held > owed ? held - owed : 0;
    }
}
