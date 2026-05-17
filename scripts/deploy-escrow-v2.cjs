const hre = require("hardhat");

const DEFAULT_USDC = "0x3600000000000000000000000000000000000000";

async function main() {
  const usdcAddress = process.env.ARC_TESTNET_USDC || DEFAULT_USDC;

  if (!hre.ethers.isAddress(usdcAddress)) {
    throw new Error(`Invalid USDC address: ${usdcAddress}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);

  console.log("Deploying ArcEscrowManagerV2...");
  console.log(`Network: ${hre.network.name}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Native balance: ${hre.ethers.formatEther(balance)} USDC`);
  console.log(`USDC interface: ${usdcAddress}`);

  const ArcEscrowManagerV2 = await hre.ethers.getContractFactory("ArcEscrowManagerV2");
  const escrow = await ArcEscrowManagerV2.deploy(usdcAddress);
  await escrow.waitForDeployment();

  const escrowAddress = await escrow.getAddress();
  const deploymentTx = escrow.deploymentTransaction();

  console.log("");
  console.log(`ArcEscrowManagerV2 deployed to: ${escrowAddress}`);
  if (deploymentTx) {
    console.log(`Deployment tx: ${deploymentTx.hash}`);
    console.log(`Explorer: https://testnet.arcscan.app/tx/${deploymentTx.hash}`);
  }
  console.log(`Contract: https://testnet.arcscan.app/address/${escrowAddress}`);
  console.log("");
  console.log("Next:");
  console.log(`1. Set VITE_ESCROW_CONTRACT_ADDRESS=${escrowAddress}`);
  console.log("2. Update the frontend to point at this V2 deployment");
  console.log("3. Test create -> fund -> delivered -> release/refund -> dispute/resolve");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
