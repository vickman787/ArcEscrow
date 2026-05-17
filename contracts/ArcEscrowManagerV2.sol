// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ArcEscrowManagerV2 {
    enum EscrowState {
        Created,
        Funded,
        Delivered,
        Disputed,
        Released,
        Refunded
    }

    struct Escrow {
        uint256 id;
        address buyer;
        address seller;
        address arbiter;
        uint256 amount;
        EscrowState state;
    }

    address public immutable usdc;
    uint256 public nextEscrowId;

    mapping(uint256 => Escrow) public escrows;

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        address arbiter,
        uint256 amount
    );
    event EscrowFunded(uint256 indexed escrowId, address indexed buyer, uint256 amount);
    event DeliveryMarked(uint256 indexed escrowId, address indexed seller);
    event EscrowReleased(uint256 indexed escrowId, address indexed seller, uint256 amount);
    event EscrowRefunded(uint256 indexed escrowId, address indexed buyer, uint256 amount);
    event DisputeOpened(uint256 indexed escrowId, address indexed openedBy);
    event DisputeResolved(
        uint256 indexed escrowId,
        address indexed arbiter,
        address indexed recipient,
        uint256 amount,
        bool releasedToSeller
    );

    modifier escrowExists(uint256 escrowId) {
        require(escrowId < nextEscrowId, "Escrow does not exist");
        _;
    }

    modifier onlyBuyer(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].buyer, "Only buyer can call this");
        _;
    }

    modifier onlySeller(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].seller, "Only seller can call this");
        _;
    }

    modifier onlyParticipant(uint256 escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(
            msg.sender == escrow.buyer || msg.sender == escrow.seller,
            "Only escrow participants can call this"
        );
        _;
    }

    modifier onlyArbiter(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].arbiter, "Only arbiter can call this");
        _;
    }

    constructor(address usdcToken) {
        require(usdcToken != address(0), "Invalid USDC address");
        usdc = usdcToken;
    }

    function createEscrow(
        address seller,
        address arbiter,
        uint256 amount
    ) external returns (uint256) {
        require(seller != address(0), "Invalid seller address");
        require(arbiter != address(0), "Invalid arbiter address");
        require(seller != msg.sender, "Buyer and seller cannot be the same");
        require(arbiter != msg.sender, "Buyer cannot be arbiter");
        require(arbiter != seller, "Seller cannot be arbiter");
        require(amount > 0, "Amount must be greater than zero");

        uint256 escrowId = nextEscrowId;
        escrows[escrowId] = Escrow({
            id: escrowId,
            buyer: msg.sender,
            seller: seller,
            arbiter: arbiter,
            amount: amount,
            state: EscrowState.Created
        });

        nextEscrowId++;

        emit EscrowCreated(escrowId, msg.sender, seller, arbiter, amount);
        return escrowId;
    }

    function fundEscrow(uint256 escrowId) external escrowExists(escrowId) onlyBuyer(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.Created, "Escrow is not in Created state");

        bool success = IERC20(usdc).transferFrom(msg.sender, address(this), escrow.amount);
        require(success, "USDC transfer failed");

        escrow.state = EscrowState.Funded;

        emit EscrowFunded(escrowId, msg.sender, escrow.amount);
    }

    function markDelivered(uint256 escrowId) external escrowExists(escrowId) onlySeller(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.Funded, "Escrow must be funded");

        escrow.state = EscrowState.Delivered;

        emit DeliveryMarked(escrowId, msg.sender);
    }

    function releaseFunds(uint256 escrowId) external escrowExists(escrowId) onlyBuyer(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(
            escrow.state == EscrowState.Funded || escrow.state == EscrowState.Delivered,
            "Escrow cannot be released"
        );

        escrow.state = EscrowState.Released;

        bool success = IERC20(usdc).transfer(escrow.seller, escrow.amount);
        require(success, "USDC release failed");

        emit EscrowReleased(escrowId, escrow.seller, escrow.amount);
    }

    function refundBuyer(uint256 escrowId) external escrowExists(escrowId) onlyBuyer(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(
            escrow.state == EscrowState.Funded || escrow.state == EscrowState.Delivered,
            "Escrow cannot be refunded"
        );

        escrow.state = EscrowState.Refunded;

        bool success = IERC20(usdc).transfer(escrow.buyer, escrow.amount);
        require(success, "USDC refund failed");

        emit EscrowRefunded(escrowId, escrow.buyer, escrow.amount);
    }

    function sellerRefundBuyer(uint256 escrowId) external escrowExists(escrowId) onlySeller(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(
            escrow.state == EscrowState.Funded || escrow.state == EscrowState.Delivered,
            "Escrow cannot be refunded"
        );

        escrow.state = EscrowState.Refunded;

        bool success = IERC20(usdc).transfer(escrow.buyer, escrow.amount);
        require(success, "USDC refund failed");

        emit EscrowRefunded(escrowId, escrow.buyer, escrow.amount);
    }

    function openDispute(uint256 escrowId) external escrowExists(escrowId) onlyParticipant(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(
            escrow.state == EscrowState.Funded || escrow.state == EscrowState.Delivered,
            "Escrow cannot enter dispute"
        );

        escrow.state = EscrowState.Disputed;

        emit DisputeOpened(escrowId, msg.sender);
    }

    function resolveDispute(
        uint256 escrowId,
        bool releaseToSeller
    ) external escrowExists(escrowId) onlyArbiter(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == EscrowState.Disputed, "Escrow is not disputed");

        address recipient;
        if (releaseToSeller) {
            escrow.state = EscrowState.Released;
            recipient = escrow.seller;
        } else {
            escrow.state = EscrowState.Refunded;
            recipient = escrow.buyer;
        }

        bool success = IERC20(usdc).transfer(recipient, escrow.amount);
        require(success, "USDC dispute transfer failed");

        emit DisputeResolved(escrowId, msg.sender, recipient, escrow.amount, releaseToSeller);
    }

    function getEscrow(
        uint256 escrowId
    )
        external
        view
        escrowExists(escrowId)
        returns (
            uint256 id,
            address buyer,
            address seller,
            address arbiter,
            uint256 amount,
            EscrowState state
        )
    {
        Escrow memory escrow = escrows[escrowId];
        return (
            escrow.id,
            escrow.buyer,
            escrow.seller,
            escrow.arbiter,
            escrow.amount,
            escrow.state
        );
    }

    function contractUsdcBalance() external view returns (uint256) {
        return IERC20(usdc).balanceOf(address(this));
    }
}
