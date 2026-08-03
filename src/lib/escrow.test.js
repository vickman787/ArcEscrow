import { describe, expect, it } from 'vitest'
import {
  buildEscrowRecord,
  formatTokenAmount,
  getCreateFormError,
  getDismissedEscrowsStorageKey,
  getDisplayError,
  getEscrowRole,
  getEscrowVolumeStartBlock,
  getListingsStorageKey,
  getHistoryActionLabel,
  getNextEscrowStep,
  isActiveEscrowState,
  isTerminalEscrowState,
  shortenAddress,
} from './escrow.js'

const BUYER = '0x1111111111111111111111111111111111111111'
const SELLER = '0x2222222222222222222222222222222222222222'
const ARBITER = '0x3333333333333333333333333333333333333333'

describe('shortenAddress', () => {
  it('shortens a full address', () => {
    expect(shortenAddress(BUYER)).toBe('0x1111...1111')
  })

  it('returns a placeholder for an empty value', () => {
    expect(shortenAddress('')).toBe('Not connected')
    expect(shortenAddress(null)).toBe('Not connected')
  })
})

describe('formatTokenAmount', () => {
  it('formats a bigint amount with the given decimals', () => {
    expect(formatTokenAmount(1_500_000n, 6)).toBe('1.5')
  })

  it('defaults to 6 decimals', () => {
    expect(formatTokenAmount(2_000_000n)).toBe('2')
  })

  it('returns a placeholder for null/undefined', () => {
    expect(formatTokenAmount(null)).toBe('--')
    expect(formatTokenAmount(undefined)).toBe('--')
  })

  it('returns a placeholder when formatting throws', () => {
    expect(formatTokenAmount('not-a-bigint', 6)).toBe('--')
  })
})

describe('isActiveEscrowState / isTerminalEscrowState', () => {
  it('treats Created and Funded as active', () => {
    expect(isActiveEscrowState('Created')).toBe(true)
    expect(isActiveEscrowState('Funded')).toBe(true)
  })

  it('does not treat Delivered or Disputed as active', () => {
    expect(isActiveEscrowState('Delivered')).toBe(false)
    expect(isActiveEscrowState('Disputed')).toBe(false)
  })

  it('only treats Released, Refunded, and Cancelled as terminal', () => {
    expect(isTerminalEscrowState('Released')).toBe(true)
    expect(isTerminalEscrowState('Refunded')).toBe(true)
    expect(isTerminalEscrowState('Cancelled')).toBe(true)
  })

  it('does not treat still-changeable states as terminal', () => {
    expect(isTerminalEscrowState('Created')).toBe(false)
    expect(isTerminalEscrowState('Funded')).toBe(false)
    expect(isTerminalEscrowState('Delivered')).toBe(false)
    expect(isTerminalEscrowState('Disputed')).toBe(false)
  })
})

describe('getNextEscrowStep', () => {
  it('maps every known state to a next step', () => {
    expect(getNextEscrowStep('Created')).toBe('Approve and fund')
    expect(getNextEscrowStep('Funded')).toBe('Deliver, release, refund, or dispute')
    expect(getNextEscrowStep('Delivered')).toBe('Release, refund, or dispute')
    expect(getNextEscrowStep('Disputed')).toBe('Await arbiter resolution')
    expect(getNextEscrowStep('Released')).toBe('Completed')
    expect(getNextEscrowStep('Refunded')).toBe('Closed')
    expect(getNextEscrowStep('Cancelled')).toBe('Closed')
  })

  it('falls back for an unknown state', () => {
    expect(getNextEscrowStep('Unknown')).toBe('Review')
  })
})

describe('getHistoryActionLabel', () => {
  it('maps known event names to friendly labels', () => {
    expect(getHistoryActionLabel('EscrowCreated')).toBe('Escrow Created')
    expect(getHistoryActionLabel('EscrowCancelled')).toBe('Escrow Cancelled')
    expect(getHistoryActionLabel('TimeoutVoteCast')).toBe('Timeout Vote Cast')
  })

  it('falls back to the raw name for unknown events', () => {
    expect(getHistoryActionLabel('SomethingElse')).toBe('SomethingElse')
  })
})

describe('buildEscrowRecord', () => {
  it('maps a raw contract tuple into a display record', () => {
    const record = buildEscrowRecord({
      id: 3n,
      buyer: BUYER,
      seller: SELLER,
      arbiter: ARBITER,
      amount: 1_000_000n,
      state: 1,
      disputeOpenedAt: 0n,
    })

    expect(record).toEqual({
      id: '3',
      buyer: BUYER,
      seller: SELLER,
      arbiter: ARBITER,
      amount: 1_000_000n,
      state: 'Funded',
      disputeOpenedAt: 0,
    })
  })

  it('falls back to Unknown for an out-of-range state', () => {
    const record = buildEscrowRecord({
      id: 0n,
      buyer: BUYER,
      seller: SELLER,
      arbiter: ARBITER,
      amount: 0n,
      state: 99,
      disputeOpenedAt: 0n,
    })

    expect(record.state).toBe('Unknown')
  })
})

describe('getEscrowRole', () => {
  const escrow = { buyer: BUYER, seller: SELLER, arbiter: ARBITER }

  it('identifies the buyer', () => {
    expect(getEscrowRole(escrow, BUYER)).toBe('Buyer')
  })

  it('identifies the seller', () => {
    expect(getEscrowRole(escrow, SELLER)).toBe('Seller')
  })

  it('identifies the arbiter', () => {
    expect(getEscrowRole(escrow, ARBITER)).toBe('Arbiter')
  })

  it('is case-insensitive', () => {
    expect(getEscrowRole(escrow, BUYER.toUpperCase())).toBe('Buyer')
  })

  it('returns empty string for an unrelated wallet', () => {
    expect(getEscrowRole(escrow, '0x9999999999999999999999999999999999999999')).toBe('')
  })

  it('returns empty string when no wallet is connected', () => {
    expect(getEscrowRole(escrow, '')).toBe('')
  })
})

describe('getCreateFormError', () => {
  const validAddress = SELLER
  const base = { seller: SELLER, arbiter: ARBITER, amount: '10', walletAddress: BUYER, tokenDecimals: 6 }

  it('passes for a fully valid form', () => {
    expect(getCreateFormError(base)).toBe('')
  })

  it('requires a seller address', () => {
    expect(getCreateFormError({ ...base, seller: '' })).toBe('Enter the seller wallet address.')
  })

  it('rejects a malformed seller address', () => {
    expect(getCreateFormError({ ...base, seller: '0xnotanaddress' })).toBe(
      'Seller wallet must be a full valid EVM address.',
    )
  })

  it('rejects the buyer as their own seller', () => {
    expect(getCreateFormError({ ...base, seller: BUYER })).toBe('Buyer and seller cannot be the same wallet.')
  })

  it('rejects the buyer as their own arbiter', () => {
    expect(getCreateFormError({ ...base, arbiter: BUYER })).toBe('Buyer cannot also be the arbiter.')
  })

  it('rejects the seller and arbiter being the same wallet', () => {
    expect(getCreateFormError({ ...base, arbiter: validAddress })).toBe(
      'Seller and arbiter must be different wallets.',
    )
  })

  it('requires an amount', () => {
    expect(getCreateFormError({ ...base, amount: '' })).toBe('Enter the escrow amount.')
  })

  it('rejects a zero amount', () => {
    expect(getCreateFormError({ ...base, amount: '0' })).toBe('Amount must be greater than zero.')
  })

  it('rejects an unparseable amount', () => {
    expect(getCreateFormError({ ...base, amount: 'abc' })).toBe('Enter a valid token amount.')
  })
})

describe('getDisplayError', () => {
  it('prefers a decoded revert reason, then shortMessage, then message', () => {
    expect(getDisplayError({ reason: 'reason' })).toBe('reason')
    expect(getDisplayError({ shortMessage: 'short' })).toBe('short')
    expect(getDisplayError({ message: 'message' })).toBe('message')
  })

  it('falls back to a generic message', () => {
    expect(getDisplayError({})).toBe('Something went wrong.')
    expect(getDisplayError(undefined)).toBe('Something went wrong.')
  })

  it('suppresses the "could not coalesce error" noise', () => {
    expect(getDisplayError({ message: 'could not coalesce error (foo)' })).toBe('')
  })

  // Gas estimation frequently fails without revert data, so ethers surfaces only "missing revert
  // data" while the require() text sits in the nested JSON-RPC error. Users were being shown the
  // useless string instead of the rule they actually broke.
  it('digs the require() string out of a nested JSON-RPC error', () => {
    expect(
      getDisplayError({
        shortMessage: 'missing revert data',
        info: { error: { code: 3, message: 'execution reverted: Escrow does not exist' } },
      }),
    ).toBe('Escrow does not exist')

    expect(
      getDisplayError({
        message: 'call revert exception',
        info: { error: { code: 3, message: 'execution reverted: Buyer and seller cannot be the same' } },
      }),
    ).toBe('Buyer and seller cannot be the same')

    expect(
      getDisplayError({ error: { message: 'execution reverted: Amount must be greater than zero' } }),
    ).toBe('Amount must be greater than zero')
  })

  it('explains a bare "missing revert data" instead of leaking it', () => {
    const message = getDisplayError({ shortMessage: 'missing revert data' })

    expect(message).not.toContain('missing revert data')
    expect(message).toContain('three different wallets')
  })
})

describe('getEscrowVolumeStartBlock', () => {
  it('uses a bounded lookback for a non-default contract address', () => {
    const latestBlock = 10_000_000
    expect(getEscrowVolumeStartBlock(SELLER, latestBlock)).toBe(latestBlock - 5_000_000)
  })

  it('never returns a negative block number', () => {
    expect(getEscrowVolumeStartBlock(SELLER, 100)).toBe(0)
  })
})

describe('getDismissedEscrowsStorageKey', () => {
  it('builds a namespaced, lowercased key', () => {
    expect(getDismissedEscrowsStorageKey(SELLER, BUYER)).toBe(
      `arc-escrow-dismissed-escrows:${SELLER.toLowerCase()}:${BUYER.toLowerCase()}`,
    )
  })

  it('returns an empty string when either address is missing', () => {
    expect(getDismissedEscrowsStorageKey('', BUYER)).toBe('')
    expect(getDismissedEscrowsStorageKey(SELLER, '')).toBe('')
  })
})

describe('getListingsStorageKey', () => {
  it('scopes saved listings to the connected wallet', () => {
    expect(getListingsStorageKey(BUYER)).toBe(`arc-escrow-listings:${BUYER.toLowerCase()}`)
  })

  it('is case-insensitive so a checksummed address maps to the same key', () => {
    expect(getListingsStorageKey(BUYER.toUpperCase())).toBe(getListingsStorageKey(BUYER))
  })

  it('gives different wallets different keys', () => {
    expect(getListingsStorageKey(BUYER)).not.toBe(getListingsStorageKey(SELLER))
  })

  it('returns empty when no wallet is connected, so nothing is persisted unscoped', () => {
    expect(getListingsStorageKey('')).toBe('')
    expect(getListingsStorageKey(undefined)).toBe('')
  })
})
