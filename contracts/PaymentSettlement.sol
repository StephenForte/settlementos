// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PaymentSettlement — escrow contract for stablecoin payment settlement.
/// @notice Locks an approved ERC-20 stablecoin per payment, then settles, cancels,
///         or refunds under operator control. Payment IDs are idempotent: a given
///         paymentId can only be initiated once.
contract PaymentSettlement {
    enum PaymentState {
        NONE,
        INITIATED,
        SETTLED,
        CANCELLED,
        REFUNDED,
        FAILED
    }

    struct Payment {
        address sender;
        address recipient;
        address asset;
        uint256 amount;
        PaymentState state;
    }

    address public admin;
    mapping(address => bool) public operators;
    mapping(address => bool) public approvedAssets;
    mapping(bytes32 => Payment) public payments;

    event OperatorSet(address indexed operator, bool enabled);
    event AssetApproved(address indexed asset, bool enabled);

    event PaymentInitiated(
        bytes32 indexed paymentId,
        address indexed sender,
        address indexed recipient,
        address asset,
        uint256 amount,
        string sourceCurrency,
        string destinationCurrency
    );

    event PaymentSettled(
        bytes32 indexed paymentId,
        bytes32 routeId,
        uint256 settledAmount,
        string destinationAsset
    );

    event PaymentCancelled(bytes32 indexed paymentId);

    event PaymentRefunded(bytes32 indexed paymentId, address indexed refundedTo, uint256 amount);

    event PaymentFailed(bytes32 indexed paymentId, string reason);

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlyOperator() {
        require(operators[msg.sender], "not operator");
        _;
    }

    constructor() {
        admin = msg.sender;
        operators[msg.sender] = true;
        emit OperatorSet(msg.sender, true);
    }

    function setOperator(address operator, bool enabled) external onlyAdmin {
        operators[operator] = enabled;
        emit OperatorSet(operator, enabled);
    }

    function setApprovedAsset(address asset, bool enabled) external onlyAdmin {
        approvedAssets[asset] = enabled;
        emit AssetApproved(asset, enabled);
    }

    /// @notice Lock `amount` of `asset` from `sender` into escrow for `paymentId`.
    ///         Sender must have approved this contract beforehand.
    function initiatePayment(
        bytes32 paymentId,
        address sender,
        address recipient,
        address asset,
        uint256 amount,
        string calldata sourceCurrency,
        string calldata destinationCurrency
    ) external onlyOperator {
        require(payments[paymentId].state == PaymentState.NONE, "payment exists");
        require(approvedAssets[asset], "asset not approved");
        require(amount > 0, "zero amount");

        payments[paymentId] = Payment({
            sender: sender,
            recipient: recipient,
            asset: asset,
            amount: amount,
            state: PaymentState.INITIATED
        });

        require(IERC20(asset).transferFrom(sender, address(this), amount), "escrow transfer failed");

        emit PaymentInitiated(paymentId, sender, recipient, asset, amount, sourceCurrency, destinationCurrency);
    }

    /// @notice Release escrowed funds to the settlement treasury (or recipient) and
    ///         mark the payment settled. `settledAmount`/`destinationAsset` describe
    ///         the post-FX destination leg for the audit trail.
    function settlePayment(
        bytes32 paymentId,
        bytes32 routeId,
        address releaseTo,
        uint256 settledAmount,
        string calldata destinationAsset
    ) external onlyOperator {
        Payment storage p = payments[paymentId];
        require(p.state == PaymentState.INITIATED, "not initiated");
        p.state = PaymentState.SETTLED;

        require(IERC20(p.asset).transfer(releaseTo, p.amount), "release transfer failed");

        emit PaymentSettled(paymentId, routeId, settledAmount, destinationAsset);
    }

    /// @notice Cancel before settlement; escrow returns to sender.
    function cancelPayment(bytes32 paymentId) external onlyOperator {
        Payment storage p = payments[paymentId];
        require(p.state == PaymentState.INITIATED, "not initiated");
        p.state = PaymentState.CANCELLED;

        require(IERC20(p.asset).transfer(p.sender, p.amount), "cancel refund failed");

        emit PaymentCancelled(paymentId);
    }

    /// @notice Mark a payment failed and refund escrow to sender.
    function failAndRefund(bytes32 paymentId, string calldata reason) external onlyOperator {
        Payment storage p = payments[paymentId];
        require(p.state == PaymentState.INITIATED, "not initiated");
        p.state = PaymentState.REFUNDED;

        require(IERC20(p.asset).transfer(p.sender, p.amount), "refund failed");

        emit PaymentFailed(paymentId, reason);
        emit PaymentRefunded(paymentId, p.sender, p.amount);
    }

    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return payments[paymentId];
    }
}
