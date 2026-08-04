import { ethers } from 'ethers'

export const DEFAULT_CONTRACT_ADDRESS =
  import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS?.trim() ||
  '0x0D7B925BaFE6E197Cd168A31100a282fF8Ab89F2'

const DISMISSED_ESCROWS_STORAGE_PREFIX = 'arc-escrow-dismissed-escrows'
const LOG_QUERY_BLOCK_SPAN = 9999
// The public Arc RPC rate limits, and a full volume scan is hundreds of eth_getLogs calls that only
// grows as the chain advances. Pause briefly between chunks and back off when the RPC pushes back,
// otherwise the scan dies partway through and the UI reports a raw "rate limit exceeded".
const LOG_QUERY_CHUNK_DELAY_MS = 120
const LOG_QUERY_MAX_RETRIES = 5
const LOG_QUERY_BASE_BACKOFF_MS = 500
const FALLBACK_VOLUME_LOOKBACK_BLOCKS = 5_000_000
// Deployment block of DEFAULT_CONTRACT_ADDRESS above - update this alongside that address on every
// redeploy, or the volume scan will waste RPC calls scanning blocks before the contract existed.
const DEFAULT_VOLUME_START_BLOCK = 54_061_860

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

// Saved listings used to live under one global key, so every wallet on a shared browser saw the
// same drafts. Scope them per wallet instead. LEGACY_LISTINGS_STORAGE_KEY is only read once, to
// migrate a device's existing drafts to their owner.
export const LEGACY_LISTINGS_STORAGE_KEY = 'arc-escrow-listings'

export function getListingsStorageKey(walletAddress) {
  if (!walletAddress) {
    return ''
  }

  return `${LEGACY_LISTINGS_STORAGE_KEY}:${walletAddress.toLowerCase()}`
}

// Settled volume is immutable once a block is final, so a completed scan never needs repeating.
// Without this every page load re-scanned from the deployment block - already over a million blocks
// and growing daily - which is what tripped the RPC's rate limit.
const VOLUME_CACHE_STORAGE_PREFIX = 'arc-escrow-volume'

export function getVolumeCacheStorageKey(contractAddress) {
  if (!contractAddress) {
    return ''
  }

  return `${VOLUME_CACHE_STORAGE_PREFIX}:${contractAddress.toLowerCase()}`
}

export function readVolumeCache(contractAddress) {
  const key = getVolumeCacheStorageKey(contractAddress)

  if (!key || typeof window === 'undefined') {
    return null
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || 'null')

    if (!parsed || typeof parsed.lastBlock !== 'number' || typeof parsed.volume !== 'string') {
      return null
    }

    return { lastBlock: parsed.lastBlock, volume: BigInt(parsed.volume) }
  } catch {
    return null
  }
}

export function writeVolumeCache(contractAddress, lastBlock, volume) {
  const key = getVolumeCacheStorageKey(contractAddress)

  if (!key || typeof window === 'undefined') {
    return
  }

  try {
    // volume is a bigint, which JSON cannot represent - store it as a decimal string.
    window.localStorage.setItem(key, JSON.stringify({ lastBlock, volume: volume.toString() }))
  } catch {
    // A full or unavailable storage quota only costs us the cache, so carry on.
  }
}

export function getDismissedEscrowsStorageKey(contractAddress, walletAddress) {
  if (!contractAddress || !walletAddress) {
    return ''
  }

  return `${DISMISSED_ESCROWS_STORAGE_PREFIX}:${contractAddress.toLowerCase()}:${walletAddress.toLowerCase()}`
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function isRateLimitError(error) {
  if (error?.code === -32005 || error?.info?.error?.code === -32005 || error?.status === 429) {
    return true
  }

  const text = [
    error?.shortMessage,
    error?.message,
    error?.info?.error?.message,
    error?.error?.message,
  ]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()

  return (
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('exceeds defined limit')
  )
}

export async function queryEventsInChunks(contract, filter, fromBlock, toBlock) {
  const events = []
  let isFirstChunk = true

  for (let from = fromBlock; from <= toBlock; from += LOG_QUERY_BLOCK_SPAN + 1) {
    const to = Math.min(from + LOG_QUERY_BLOCK_SPAN, toBlock)

    if (!isFirstChunk) {
      await sleep(LOG_QUERY_CHUNK_DELAY_MS)
    }

    isFirstChunk = false

    for (let attempt = 0; ; attempt += 1) {
      try {
        events.push(...await contract.queryFilter(filter, from, to))
        break
      } catch (error) {
        // Only rate limits are worth retrying; anything else is a real failure and retrying it just
        // delays the error the caller needs to see.
        if (attempt >= LOG_QUERY_MAX_RETRIES || !isRateLimitError(error)) {
          throw error
        }

        await sleep(LOG_QUERY_BASE_BACKOFF_MS * 2 ** attempt)
      }
    }
  }

  return events
}

export function buildTrendPath(points, width, height, padding) {
  if (!points.length) {
    return ''
  }

  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const maxValue = Math.max(...points.map((point) => point.value), 1)
  const stepX = points.length > 1 ? innerWidth / (points.length - 1) : 0

  const coordinates = points.map((point, index) => {
    const x = padding.left + stepX * index
    const normalized = point.value / maxValue
    const y = padding.top + innerHeight - normalized * innerHeight
    return { x, y }
  })

  if (coordinates.length === 1) {
    return `M ${coordinates[0].x} ${coordinates[0].y}`
  }

  return coordinates.reduce((path, point, index) => {
    if (index === 0) {
      return `M ${point.x} ${point.y}`
    }

    const previous = coordinates[index - 1]
    const controlX = (previous.x + point.x) / 2
    return `${path} C ${controlX} ${previous.y}, ${controlX} ${point.y}, ${point.x} ${point.y}`
  }, '')
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

// Pulls the human revert string out of a failed transaction. A require() message only reaches
// error.reason when the node returned revert data; gas estimation often fails without any, leaving
// ethers to report the useless "missing revert data" while the real text ("execution reverted:
// Buyer and seller cannot be the same") sits in the nested JSON-RPC error. Check the nested payload
// before falling back so users see the actual rule they broke.
function findRevertReason(error) {
  const candidates = [
    error?.info?.error?.message,
    error?.error?.message,
    error?.info?.error?.data?.message,
    error?.data?.message,
  ]

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue
    }

    const match = /execution reverted:?\s*(.*)/i.exec(candidate)

    if (match) {
      return match[1].trim() || candidate.trim()
    }

    return candidate.trim()
  }

  return ''
}

export function getDisplayError(error) {
  if (typeof error?.reason === 'string' && error.reason.trim()) {
    return error.reason.trim()
  }

  const nested = findRevertReason(error)

  if (nested) {
    return nested
  }

  const message = error?.shortMessage || error?.message || 'Something went wrong.'

  if (typeof message === 'string' && message.toLowerCase().includes('could not coalesce error')) {
    return ''
  }

  // Nothing usable came back, so describe what happened rather than leaking ethers internals.
  // Kept deliberately neutral: this path covers reads as well as writes, so it must not assert a
  // cause it cannot know. If you were creating an escrow the three-wallet rule is the usual culprit.
  if (typeof message === 'string' && message.toLowerCase().includes('missing revert data')) {
    return 'The contract rejected this request without giving a reason. If you were creating an escrow, check that the buyer, seller, and arbiter are three different wallets.'
  }

  return message
}

export function setDisplayError(setError, error) {
  const message = getDisplayError(error)

  setError(message)
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
