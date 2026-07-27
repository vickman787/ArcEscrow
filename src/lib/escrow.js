import { ethers } from 'ethers'

export const DEFAULT_CONTRACT_ADDRESS =
  import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS?.trim() ||
  '0x657BD86C15911E0ACF6DD1a5fC840647435580A3'

const DISMISSED_ESCROWS_STORAGE_PREFIX = 'arc-escrow-dismissed-escrows'
const FALLBACK_VOLUME_LOOKBACK_BLOCKS = 5_000_000
const DEFAULT_VOLUME_START_BLOCK = 42_550_000

const escrowStates = ['Created', 'Funded', 'Delivered', 'Disputed', 'Released', 'Refunded', 'Cancelled']

const TERMINAL_ESCROW_STATES = new Set(['Released', 'Refunded', 'Cancelled'])

export function shortenAddress(value) {
  if (!value) {
    return 'Not connected'
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

export function formatTokenAmount(value, decimals = 6) {
  if (value == null) {
    return '--'
  }

  try {
    return Number(ethers.formatUnits(value, decimals)).toLocaleString(undefined, {
      maximumFractionDigits: 6,
    })
  } catch {
    return '--'
  }
}

export function getEscrowVolumeStartBlock(contractAddress, latestBlock) {
  if (contractAddress?.toLowerCase() === DEFAULT_CONTRACT_ADDRESS.toLowerCase()) {
    return DEFAULT_VOLUME_START_BLOCK
  }

  return Math.max(0, latestBlock - FALLBACK_VOLUME_LOOKBACK_BLOCKS)
}

export function getDismissedEscrowsStorageKey(contractAddress, walletAddress) {
  if (!contractAddress || !walletAddress) {
    return ''
  }

  return `${DISMISSED_ESCROWS_STORAGE_PREFIX}:${contractAddress.toLowerCase()}:${walletAddress.toLowerCase()}`
}

export function buildEscrowRecord(record) {
  return {
    id: record.id.toString(),
    buyer: record.buyer,
    seller: record.seller,
    arbiter: record.arbiter,
    amount: record.amount,
    state: escrowStates[Number(record.state)] || 'Unknown',
    disputeOpenedAt: record.disputeOpenedAt ? Number(record.disputeOpenedAt) : 0,
  }
}

export function getEscrowRole(escrow, walletAddress) {
  if (!walletAddress) {
    return ''
  }

  const normalizedWallet = walletAddress.toLowerCase()
  const isBuyer = escrow.buyer.toLowerCase() === normalizedWallet
  const isSeller = escrow.seller.toLowerCase() === normalizedWallet
  const isArbiter = escrow.arbiter.toLowerCase() === normalizedWallet

  if (isBuyer && isSeller) {
    return 'Buyer & Seller'
  }

  if (isBuyer) {
    return 'Buyer'
  }

  if (isSeller) {
    return 'Seller'
  }

  if (isArbiter) {
    return 'Arbiter'
  }

  return ''
}

export function isActiveEscrowState(state) {
  return state === 'Created' || state === 'Funded'
}

export function isTerminalEscrowState(state) {
  return TERMINAL_ESCROW_STATES.has(state)
}

export function getNextEscrowStep(state) {
  switch (state) {
    case 'Created':
      return 'Approve and fund'
    case 'Funded':
      return 'Deliver, release, refund, or dispute'
    case 'Delivered':
      return 'Release, refund, or dispute'
    case 'Disputed':
      return 'Await arbiter resolution'
    case 'Released':
      return 'Completed'
    case 'Refunded':
      return 'Closed'
    case 'Cancelled':
      return 'Closed'
    default:
      return 'Review'
  }
}

export function getHistoryActionLabel(name) {
  switch (name) {
    case 'Approval':
      return 'USDC Approved'
    case 'EscrowCreated':
      return 'Escrow Created'
    case 'EscrowFunded':
      return 'Escrow Funded'
    case 'DeliveryMarked':
      return 'Delivery Marked'
    case 'EscrowReleased':
      return 'Funds Released'
    case 'EscrowRefunded':
      return 'Buyer Refunded'
    case 'DisputeOpened':
      return 'Dispute Opened'
    case 'DisputeResolved':
      return 'Dispute Resolved'
    case 'EscrowCancelled':
      return 'Escrow Cancelled'
    case 'TimeoutVoteCast':
      return 'Timeout Vote Cast'
    default:
      return name
  }
}

export function getDisplayError(error) {
  const message = error?.shortMessage || error?.reason || error?.message || 'Something went wrong.'

  if (typeof message === 'string' && message.toLowerCase().includes('could not coalesce error')) {
    return ''
  }

  return message
}

export function getCreateFormError({ seller, arbiter, amount, walletAddress, tokenDecimals }) {
  if (!seller) {
    return 'Enter the seller wallet address.'
  }

  if (!ethers.isAddress(seller)) {
    return 'Seller wallet must be a full valid EVM address.'
  }

  if (walletAddress && seller.toLowerCase() === walletAddress.toLowerCase()) {
    return 'Buyer and seller cannot be the same wallet.'
  }

  if (!arbiter) {
    return 'Enter the arbiter wallet address.'
  }

  if (!ethers.isAddress(arbiter)) {
    return 'Arbiter wallet must be a full valid EVM address.'
  }

  if (walletAddress && arbiter.toLowerCase() === walletAddress.toLowerCase()) {
    return 'Buyer cannot also be the arbiter.'
  }

  if (arbiter.toLowerCase() === seller.toLowerCase()) {
    return 'Seller and arbiter must be different wallets.'
  }

  if (!amount) {
    return 'Enter the escrow amount.'
  }

  try {
    const parsedAmount = ethers.parseUnits(amount, tokenDecimals)

    if (parsedAmount <= 0n) {
      return 'Amount must be greater than zero.'
    }
  } catch {
    return 'Enter a valid token amount.'
  }

  return ''
}
