const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArcEscrowManagerV2", function () {
  const ESCROW_AMOUNT = ethers.parseUnits("10", 6);

  async function deployFixture() {
    const [buyer, seller, arbiter, outsider] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const ArcEscrowManagerV2 = await ethers.getContractFactory("ArcEscrowManagerV2");
    const escrow = await ArcEscrowManagerV2.deploy(await usdc.getAddress());
    await escrow.waitForDeployment();

    await usdc.mint(buyer.address, ethers.parseUnits("1000", 6));

    return { buyer, seller, arbiter, outsider, usdc, escrow };
  }

  async function createAndFundEscrow(fixture) {
    const { buyer, seller, arbiter, usdc, escrow } = fixture;

    await escrow.connect(buyer).createEscrow(seller.address, arbiter.address, ESCROW_AMOUNT);
    await usdc.connect(buyer).approve(await escrow.getAddress(), ESCROW_AMOUNT);
    await escrow.connect(buyer).fundEscrow(0);
  }

  it("creates an escrow with buyer, seller, arbiter, and amount", async function () {
    const { buyer, seller, arbiter, escrow } = await deployFixture();

    await expect(
      escrow.connect(buyer).createEscrow(seller.address, arbiter.address, ESCROW_AMOUNT)
    )
      .to.emit(escrow, "EscrowCreated")
      .withArgs(0, buyer.address, seller.address, arbiter.address, ESCROW_AMOUNT);

    const record = await escrow.getEscrow(0);
    expect(record.buyer).to.equal(buyer.address);
    expect(record.seller).to.equal(seller.address);
    expect(record.arbiter).to.equal(arbiter.address);
    expect(record.amount).to.equal(ESCROW_AMOUNT);
    expect(record.state).to.equal(0n);
  });

  it("funds an escrow with approved USDC", async function () {
    const fixture = await deployFixture();
    const { buyer, seller, arbiter, usdc, escrow } = fixture;

    await escrow.connect(buyer).createEscrow(seller.address, arbiter.address, ESCROW_AMOUNT);
    await usdc.connect(buyer).approve(await escrow.getAddress(), ESCROW_AMOUNT);

    await expect(escrow.connect(buyer).fundEscrow(0))
      .to.emit(escrow, "EscrowFunded")
      .withArgs(0, buyer.address, ESCROW_AMOUNT);

    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(ESCROW_AMOUNT);
    const record = await escrow.getEscrow(0);
    expect(record.state).to.equal(1n);
  });

  it("lets the seller mark delivery and the buyer release funds", async function () {
    const fixture = await deployFixture();
    const { buyer, seller, usdc, escrow } = fixture;

    await createAndFundEscrow(fixture);

    await expect(escrow.connect(seller).markDelivered(0))
      .to.emit(escrow, "DeliveryMarked")
      .withArgs(0, seller.address);

    let record = await escrow.getEscrow(0);
    expect(record.state).to.equal(2n);

    await expect(escrow.connect(buyer).releaseFunds(0))
      .to.emit(escrow, "EscrowReleased")
      .withArgs(0, seller.address, ESCROW_AMOUNT);

    record = await escrow.getEscrow(0);
    expect(record.state).to.equal(4n);
    expect(await usdc.balanceOf(seller.address)).to.equal(ESCROW_AMOUNT);
  });

  it("lets the buyer refund while funded or delivered", async function () {
    const fixture = await deployFixture();
    const { buyer, usdc, escrow } = fixture;

    await createAndFundEscrow(fixture);

    await expect(escrow.connect(buyer).refundBuyer(0))
      .to.emit(escrow, "EscrowRefunded")
      .withArgs(0, buyer.address, ESCROW_AMOUNT);

    const record = await escrow.getEscrow(0);
    expect(record.state).to.equal(5n);
    expect(await usdc.balanceOf(buyer.address)).to.equal(ethers.parseUnits("1000", 6));
  });

  it("lets the seller issue a refund", async function () {
    const fixture = await deployFixture();
    const { buyer, seller, usdc, escrow } = fixture;

    await createAndFundEscrow(fixture);

    await expect(escrow.connect(seller).sellerRefundBuyer(0))
      .to.emit(escrow, "EscrowRefunded")
      .withArgs(0, buyer.address, ESCROW_AMOUNT);

    const record = await escrow.getEscrow(0);
    expect(record.state).to.equal(5n);
    expect(await usdc.balanceOf(buyer.address)).to.equal(ethers.parseUnits("1000", 6));
  });

  it("lets either participant open a dispute and the arbiter resolve to the seller", async function () {
    const fixture = await deployFixture();
    const { buyer, seller, arbiter, usdc, escrow } = fixture;

    await createAndFundEscrow(fixture);
    await escrow.connect(seller).markDelivered(0);

    await expect(escrow.connect(buyer).openDispute(0))
      .to.emit(escrow, "DisputeOpened")
      .withArgs(0, buyer.address);

    let record = await escrow.getEscrow(0);
    expect(record.state).to.equal(3n);

    await expect(escrow.connect(arbiter).resolveDispute(0, true))
      .to.emit(escrow, "DisputeResolved")
      .withArgs(0, arbiter.address, seller.address, ESCROW_AMOUNT, true);

    record = await escrow.getEscrow(0);
    expect(record.state).to.equal(4n);
    expect(await usdc.balanceOf(seller.address)).to.equal(ESCROW_AMOUNT);
  });

  it("lets the arbiter resolve a dispute to the buyer", async function () {
    const fixture = await deployFixture();
    const { buyer, seller, arbiter, usdc, escrow } = fixture;

    await createAndFundEscrow(fixture);
    await escrow.connect(seller).markDelivered(0);
    await escrow.connect(seller).openDispute(0);

    await expect(escrow.connect(arbiter).resolveDispute(0, false))
      .to.emit(escrow, "DisputeResolved")
      .withArgs(0, arbiter.address, buyer.address, ESCROW_AMOUNT, false);

    const record = await escrow.getEscrow(0);
    expect(record.state).to.equal(5n);
    expect(await usdc.balanceOf(buyer.address)).to.equal(ethers.parseUnits("1000", 6));
  });

  it("blocks non-participants from opening disputes", async function () {
    const fixture = await deployFixture();
    const { outsider, escrow } = fixture;

    await createAndFundEscrow(fixture);

    await expect(escrow.connect(outsider).openDispute(0)).to.be.revertedWith(
      "Only escrow participants can call this"
    );
  });

  it("blocks non-arbiters from resolving disputes", async function () {
    const fixture = await deployFixture();
    const { buyer, seller, escrow } = fixture;

    await createAndFundEscrow(fixture);
    await escrow.connect(buyer).openDispute(0);

    await expect(escrow.connect(seller).resolveDispute(0, true)).to.be.revertedWith(
      "Only arbiter can call this"
    );
  });
});
