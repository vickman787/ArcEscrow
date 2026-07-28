import { useEffect, useMemo, useRef, useState } from 'react'
import { ethers } from 'ethers'
import {
  buildEscrowRecord,
  buildTrendPath,
  getDismissedEscrowsStorageKey,
  getEscrowRole,
  getEscrowVolumeStartBlock,
  getHistoryActionLabel,
  isActiveEscrowState,
  isTerminalEscrowState,
  queryEventsInChunks,
  setDisplayError,
  shortenAddress,
} from '../lib/escrow'

// Owns the connected wallet's escrow list, dashboard filters, dismissed-escrow bookkeeping,
// and the transaction-history feed (plus the 7-day activity trend derived from it). Deliberately
// does not own global/contract-wide stats (e.g. total escrow volume across all users) - those
// aren't wallet-specific and stay in App.jsx.
export function useEscrowDashboard({
  escrowContract,
  usdcContract,
  activeWalletAddress,
  contractAddress,
  activePage,
  provider,
  publicProvider,
  tokenDecimals,
  setError,
}) {
  const [myEscrows, setMyEscrows] = useState([])
  const [dismissedEscrowIds, setDismissedEscrowIds] = useState([])
  const [dashboardFilter, setDashboardFilter] = useState('all')
  const [isDashboardLoading, setIsDashboardLoading] = useState(false)
  const [transactionHistory, setTransactionHistory] = useState([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const escrowRecordCacheRef = useRef(new Map())

  const visibleMyEscrows = useMemo(() => {
    if (!dismissedEscrowIds.length) {
      return myEscrows
    }

    const dismissedIds = new Set(dismissedEscrowIds)
    return myEscrows.filter((escrow) => !dismissedIds.has(escrow.id))
  }, [dismissedEscrowIds, myEscrows])

  const dashboardCounts = useMemo(() => ({
    all: visibleMyEscrows.length,
    buyer: visibleMyEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Buyer')).length,
    seller: visibleMyEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Seller')).length,
    arbiter: visibleMyEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Arbiter')).length,
    active: visibleMyEscrows.filter((escrow) => isActiveEscrowState(escrow.state)).length,
    completed: visibleMyEscrows.filter((escrow) => !isActiveEscrowState(escrow.state)).length,
  }), [activeWalletAddress, visibleMyEscrows])

  const filteredMyEscrows = useMemo(() => {
    switch (dashboardFilter) {
      case 'buyer':
        return visibleMyEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Buyer'))
      case 'seller':
        return visibleMyEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Seller'))
      case 'arbiter':
        return visibleMyEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Arbiter'))
      case 'active':
        return visibleMyEscrows.filter((escrow) => isActiveEscrowState(escrow.state))
      case 'completed':
        return visibleMyEscrows.filter((escrow) => !isActiveEscrowState(escrow.state))
      default:
        return visibleMyEscrows
    }
  }, [activeWalletAddress, dashboardFilter, visibleMyEscrows])

  const recentEscrows = useMemo(() => visibleMyEscrows.slice(0, 5), [visibleMyEscrows])

  const walletTrend = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const buckets = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today)
      date.setDate(today.getDate() - (6 - index))
      return {
        key: date.toISOString().slice(0, 10),
        label: formatter.format(date),
        value: 0,
        volume: 0,
        count: 0,
      }
    })

    const volumeActions = new Set(['Escrow Funded', 'Funds Released', 'Buyer Refunded'])

    transactionHistory.forEach((entry) => {
      if (!entry.timestamp) {
        return
      }

      const entryDate = new Date(entry.timestamp * 1000)
      entryDate.setHours(0, 0, 0, 0)
      const bucketKey = entryDate.toISOString().slice(0, 10)
      const bucket = buckets.find((item) => item.key === bucketKey)

      if (!bucket) {
        return
      }

      bucket.count += 1

      if (volumeActions.has(entry.action)) {
        bucket.volume += Number(ethers.formatUnits(entry.amount ?? 0n, tokenDecimals))
      }
    })

    const hasVolumeData = buckets.some((bucket) => bucket.volume > 0)
    const hasAnyActivity = buckets.some((bucket) => bucket.count > 0)

    buckets.forEach((bucket) => {
      bucket.value = hasVolumeData ? bucket.volume : bucket.count
    })

    const path = buildTrendPath(buckets, 480, 220, {
      top: 18,
      right: 14,
      bottom: 24,
      left: 14,
    })

    return {
      buckets,
      path,
      hasData: hasAnyActivity,
      isVolumeBased: hasVolumeData,
      total: buckets.reduce((sum, bucket) => sum + bucket.value, 0),
      peak: Math.max(...buckets.map((bucket) => bucket.value), 0),
    }
  }, [tokenDecimals, transactionHistory])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const storageKey = getDismissedEscrowsStorageKey(contractAddress, activeWalletAddress)

    if (!storageKey) {
      setDismissedEscrowIds([])
      return
    }

    const storedIds = window.localStorage.getItem(storageKey)

    if (!storedIds) {
      setDismissedEscrowIds([])
      return
    }

    try {
      const parsedIds = JSON.parse(storedIds)
      setDismissedEscrowIds(Array.isArray(parsedIds) ? parsedIds.map(String) : [])
    } catch {
      window.localStorage.removeItem(storageKey)
      setDismissedEscrowIds([])
    }
  }, [activeWalletAddress, contractAddress])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const storageKey = getDismissedEscrowsStorageKey(contractAddress, activeWalletAddress)

    if (!storageKey) {
      return
    }

    if (dismissedEscrowIds.length) {
      window.localStorage.setItem(storageKey, JSON.stringify(dismissedEscrowIds))
    } else {
      window.localStorage.removeItem(storageKey)
    }
  }, [activeWalletAddress, contractAddress, dismissedEscrowIds])

  const loadMyEscrows = async () => {
    if (!escrowContract || !activeWalletAddress) {
      setMyEscrows([])
      return
    }

    try {
      setIsDashboardLoading(true)
      const nextEscrowId = await escrowContract.nextEscrowId()
      const totalEscrows = Number(nextEscrowId)

      if (!totalEscrows) {
        setMyEscrows([])
        return
      }

      const escrowIndexes = Array.from({ length: totalEscrows }, (_, index) => index)
      const cache = escrowRecordCacheRef.current
      const getCacheKey = (escrowId) => `${contractAddress.toLowerCase()}:${escrowId}`
      const idsToFetch = escrowIndexes.filter((escrowId) => !cache.has(getCacheKey(escrowId)))

      const freshRecords = await Promise.all(
        idsToFetch.map((escrowId) => escrowContract.getEscrow(escrowId)),
      )
      const freshByEscrowId = new Map()

      idsToFetch.forEach((escrowId, index) => {
        const escrow = buildEscrowRecord(freshRecords[index])
        freshByEscrowId.set(escrowId, escrow)

        // Only cache terminal states forever - Created/Funded/Delivered/Disputed can still change.
        if (isTerminalEscrowState(escrow.state)) {
          cache.set(getCacheKey(escrowId), escrow)
        }
      })

      const normalizedWallet = activeWalletAddress.toLowerCase()
      const walletEscrows = escrowIndexes
        .map((escrowId) => cache.get(getCacheKey(escrowId)) || freshByEscrowId.get(escrowId))
        .filter((escrow) =>
          escrow.buyer.toLowerCase() === normalizedWallet ||
          escrow.seller.toLowerCase() === normalizedWallet ||
          escrow.arbiter.toLowerCase() === normalizedWallet,
        )
        .sort((left, right) => Number(right.id) - Number(left.id))

      setMyEscrows(walletEscrows)
    } catch (dashboardError) {
      setDisplayError(setError, dashboardError)
    } finally {
      setIsDashboardLoading(false)
    }
  }

  const loadTransactionHistory = async () => {
    const readProvider = provider || publicProvider

    if (!escrowContract || !readProvider || !activeWalletAddress || !usdcContract) {
      setTransactionHistory([])
      return
    }

    try {
      setIsHistoryLoading(true)
      const normalizedWallet = activeWalletAddress.toLowerCase()
      const latestBlock = await readProvider.getBlockNumber()
      const fromBlock = getEscrowVolumeStartBlock(contractAddress, latestBlock)
      const [approvalEvents, createdEvents, fundedEvents, deliveredEvents, releasedEvents, refundedEvents, disputeOpenedEvents, disputeResolvedEvents, cancelledEvents, timeoutVoteEvents] = await Promise.all([
        queryEventsInChunks(usdcContract, usdcContract.filters.Approval(activeWalletAddress, contractAddress), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.EscrowCreated(), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.EscrowFunded(), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.DeliveryMarked(), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.EscrowReleased(), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.EscrowRefunded(), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.DisputeOpened(), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.DisputeResolved(), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.EscrowCancelled(), fromBlock, latestBlock),
        queryEventsInChunks(escrowContract, escrowContract.filters.TimeoutVoteCast(), fromBlock, latestBlock),
      ])
      const escrowEvents = [
        ...createdEvents,
        ...fundedEvents,
        ...deliveredEvents,
        ...releasedEvents,
        ...refundedEvents,
        ...disputeOpenedEvents,
        ...disputeResolvedEvents,
        ...cancelledEvents,
        ...timeoutVoteEvents,
      ]
      const allEvents = [...approvalEvents, ...escrowEvents]

      if (!allEvents.length) {
        setTransactionHistory([])
        return
      }

      const uniqueEscrowIds = [
        ...new Set(escrowEvents.map((event) => event.args?.escrowId?.toString()).filter(Boolean)),
      ]
      const escrowRecords = uniqueEscrowIds.length
        ? await Promise.all(
            uniqueEscrowIds.map(async (escrowId) => [escrowId, buildEscrowRecord(await escrowContract.getEscrow(escrowId))]),
          )
        : []
      const escrowMap = new Map(escrowRecords)

      const filteredEvents = allEvents.filter((event) => {
        if (event.fragment.name === 'Approval') {
          return (
            event.args?.owner?.toLowerCase() === normalizedWallet &&
            event.args?.spender?.toLowerCase() === contractAddress.toLowerCase()
          )
        }

        const escrowId = event.args?.escrowId?.toString()
        const record = escrowMap.get(escrowId)

        if (!record) {
          return false
        }

        return (
          record.buyer.toLowerCase() === normalizedWallet ||
          record.seller.toLowerCase() === normalizedWallet ||
          record.arbiter.toLowerCase() === normalizedWallet
        )
      })

      if (!filteredEvents.length) {
        setTransactionHistory([])
        return
      }

      const uniqueBlockNumbers = [...new Set(filteredEvents.map((event) => event.blockNumber))]
      const blocks = await Promise.all(
        uniqueBlockNumbers.map(async (blockNumber) => [blockNumber, await readProvider.getBlock(blockNumber)]),
      )
      const blockMap = new Map(blocks)

      const nextHistory = filteredEvents
        .map((event) => {
          if (event.fragment.name === 'Approval') {
            const block = blockMap.get(event.blockNumber)

            return {
              id: `${event.transactionHash}-${event.index ?? 0}`,
              escrowId: '--',
              action: getHistoryActionLabel(event.fragment.name),
              amount: event.args?.value ?? 0n,
              state: 'Allowance',
              txHash: event.transactionHash,
              timestamp: block?.timestamp ?? null,
              actor: 'You',
            }
          }

          const escrowId = event.args?.escrowId?.toString()
          const record = escrowMap.get(escrowId)
          const block = blockMap.get(event.blockNumber)

          return {
            id: `${event.transactionHash}-${event.index ?? 0}`,
            escrowId,
            action: getHistoryActionLabel(event.fragment.name),
            amount: record?.amount ?? event.args?.amount ?? 0n,
            state: record?.state ?? 'Unknown',
            txHash: event.transactionHash,
            timestamp: block?.timestamp ?? null,
            actor: (() => {
              if (record?.buyer.toLowerCase() === normalizedWallet) {
                return 'You'
              }
              if (record?.seller.toLowerCase() === normalizedWallet) {
                return 'You'
              }
              if (record?.arbiter.toLowerCase() === normalizedWallet) {
                return 'You'
              }
              return shortenAddress(event.args?.buyer || event.args?.seller || event.args?.arbiter || '')
            })(),
          }
        })
        .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))

      setTransactionHistory(nextHistory)
    } catch (historyError) {
      setDisplayError(setError, historyError)
    } finally {
      setIsHistoryLoading(false)
    }
  }

  useEffect(() => {
    if (!activeWalletAddress || !escrowContract || (activePage !== 'manage' && activePage !== 'home')) {
      if (!activeWalletAddress) {
        setMyEscrows([])
      }

      return
    }

    loadMyEscrows()
  }, [activeWalletAddress, escrowContract, activePage])

  useEffect(() => {
    if (!activeWalletAddress || !escrowContract || !(provider || publicProvider) || (activePage !== 'manage' && activePage !== 'home')) {
      if (!activeWalletAddress) {
        setTransactionHistory([])
      }

      return
    }

    loadTransactionHistory()
  }, [activeWalletAddress, escrowContract, provider, publicProvider, activePage])

  const dismissEscrowId = (escrowId) => {
    setDismissedEscrowIds((current) => (
      current.includes(escrowId) ? current : [...current, escrowId]
    ))
  }

  return {
    myEscrows,
    visibleMyEscrows,
    dashboardCounts,
    filteredMyEscrows,
    recentEscrows,
    walletTrend,
    dashboardFilter,
    setDashboardFilter,
    isDashboardLoading,
    transactionHistory,
    isHistoryLoading,
    dismissedEscrowIds,
    dismissEscrowId,
    loadMyEscrows,
    loadTransactionHistory,
  }
}
