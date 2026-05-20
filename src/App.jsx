import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

import { ethers } from 'ethers'
import {
  getCircleSdk,
  hasCircleAppId,
  pickArcWallet,
  pickUsdcBalance,
  postCircleAction,
} from './lib/circle'

const ARC_TESTNET = {
  chainId: 5042002,
  chainIdHex: '0x4cef52',
  chainName: 'Arc Testnet',
  rpcUrl: 'https://rpc.testnet.arc.network',
  blockExplorerUrl: 'https://testnet.arcscan.app',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 18,
  },
}

const DEFAULT_CONTRACT_ADDRESS =
  import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS?.trim() ||
  '0xD69854389Cf48A5f396067873AD6dC58c54a96B7'

const APP_BASE_URL = import.meta.env.VITE_APP_URL?.trim() || ''

const ESCROW_MANAGER_ABI = [
  'function usdc() view returns (address)',
  'function nextEscrowId() view returns (uint256)',
  'function contractUsdcBalance() view returns (uint256)',
  'function createEscrow(address seller, address arbiter, uint256 amount) returns (uint256)',
  'function fundEscrow(uint256 escrowId)',
  'function markDelivered(uint256 escrowId)',
  'function releaseFunds(uint256 escrowId)',
  'function refundBuyer(uint256 escrowId)',
  'function sellerRefundBuyer(uint256 escrowId)',
  'function openDispute(uint256 escrowId)',
  'function resolveDispute(uint256 escrowId, bool releaseToSeller)',
  'function getEscrow(uint256 escrowId) view returns (uint256 id, address buyer, address seller, address arbiter, uint256 amount, uint8 state)',
  'event EscrowCreated(uint256 indexed escrowId, address indexed buyer, address indexed seller, address arbiter, uint256 amount)',
  'event EscrowFunded(uint256 indexed escrowId, address indexed buyer, uint256 amount)',
  'event DeliveryMarked(uint256 indexed escrowId, address indexed seller)',
  'event EscrowReleased(uint256 indexed escrowId, address indexed seller, uint256 amount)',
  'event EscrowRefunded(uint256 indexed escrowId, address indexed buyer, uint256 amount)',
  'event DisputeOpened(uint256 indexed escrowId, address indexed openedBy)',
  'event DisputeResolved(uint256 indexed escrowId, address indexed arbiter, address indexed recipient, uint256 amount, bool releasedToSeller)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]

const escrowStates = ['Created', 'Funded', 'Delivered', 'Disputed', 'Released', 'Refunded']
const NAV_ITEMS = [
  { id: 'home', label: 'Home' },
  { id: 'seller', label: 'Seller' },
  { id: 'buyer', label: 'Buyer' },
  { id: 'manage', label: 'Manage' },
  { id: 'faq', label: 'FAQ' },
]

const WALLET_CONNECT_OPTIONS = [
  { id: 'metamask', label: 'MetaMask', helper: 'Use your injected browser wallet', action: 'browser', icon: 'metamask' },
  { id: 'coinbase', label: 'Coinbase Wallet', helper: 'Use your injected browser wallet', action: 'browser', icon: 'coinbase' },
  { id: 'walletconnect', label: 'WalletConnect', helper: 'Coming soon', action: 'coming-soon', icon: 'walletconnect' },
  { id: 'browser', label: 'Browser Wallet', helper: 'Works with Rabby, MetaMask, and similar wallets', action: 'browser', icon: 'browser' },
]

const initialCreateForm = {
  seller: '',
  arbiter: '',
  amount: '',
  title: '',
  description: '',
}

const initialListingForm = {
  title: '',
  description: '',
  arbiter: '',
  amount: '',
}

const initialActionForm = {
  escrowId: '',
}

const DASHBOARD_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'buyer', label: 'Buyer' },
  { id: 'seller', label: 'Seller' },
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
]

const CIRCLE_SESSION_STORAGE_KEY = 'arc-escrow-circle-session'
const CIRCLE_WALLETS_STORAGE_KEY = 'arc-escrow-circle-wallets'
const CIRCLE_BALANCE_STORAGE_KEY = 'arc-escrow-circle-balance'
const WALLET_MODE_STORAGE_KEY = 'arc-escrow-wallet-mode'

function getInitialTheme() {
  if (typeof window === 'undefined') {
    return 'light'
  }

  const savedTheme = window.localStorage.getItem('arc-escrow-theme')
  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getExplorerUrl(path) {
  return `${ARC_TESTNET.blockExplorerUrl}${path}`
}

function shortenAddress(value) {
  if (!value) {
    return 'Not connected'
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function formatTokenAmount(value, decimals = 6) {
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

function buildEscrowRecord(record) {
  return {
    id: record.id.toString(),
    buyer: record.buyer,
    seller: record.seller,
    arbiter: record.arbiter,
    amount: record.amount,
    state: escrowStates[Number(record.state)] || 'Unknown',
  }
}

function getEscrowRole(escrow, walletAddress) {
  if (!walletAddress) {
    return ''
  }

  const normalizedWallet = walletAddress.toLowerCase()
  const isBuyer = escrow.buyer.toLowerCase() === normalizedWallet
  const isSeller = escrow.seller.toLowerCase() === normalizedWallet

  if (isBuyer && isSeller) {
    return 'Buyer & Seller'
  }

  if (isBuyer) {
    return 'Buyer'
  }

  if (isSeller) {
    return 'Seller'
  }

  return ''
}

function isActiveEscrowState(state) {
  return state === 'Created' || state === 'Funded'
}

function getNextEscrowStep(state) {
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
    default:
      return 'Review'
  }
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return '--'
  }

  return new Date(timestamp * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function getHistoryActionLabel(name) {
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
    default:
      return name
  }
}

function getWelcomeLabel(walletAddress) {
  if (!walletAddress) {
    return 'Welcome'
  }

  return `Welcome, ${shortenAddress(walletAddress)}`
}

function getDisplayError(error) {
  const message = error?.shortMessage || error?.reason || error?.message || 'Something went wrong.'

  if (typeof message === 'string' && message.toLowerCase().includes('could not coalesce error')) {
    return 'The transaction finished, but the app could not refresh contract data right away.'
  }

  return message
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function renderWalletOptionIcon(icon) {
  switch (icon) {
    case 'metamask':
      return (
        <img src="/metamask-logo.png" alt="" />
      )
    case 'coinbase':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="#1652F0" />
          <path fill="#fff" d="M12 7.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 1 0 0-9.6Zm0 2.2a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 1 1 0-5.2Z" />
        </svg>
      )
    case 'walletconnect':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="6" fill="#0F1720" />
          <path fill="#fff" d="M7.4 9.5a6.5 6.5 0 0 1 9.2 0l0.3 0.3-1.1 1.1-0.3-0.3a5 5 0 0 0-7 0l-0.3 0.3-1.1-1.1zm2 2a3.6 3.6 0 0 1 5.2 0l0.3 0.3-1.1 1.1-0.3-0.3a2 2 0 0 0-3 0l-0.3 0.3-1.1-1.1zm1.9 1.9a1 1 0 0 1 1.4 0l0.8 0.8-1.5 1.5-1.5-1.5z" />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )
  }
}

function buildTrendPath(points, width, height, padding) {
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

function getCreateFormError({ seller, arbiter, amount, walletAddress, tokenDecimals }) {
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

function buildListingLink({ seller, arbiter, amount, title, description }) {
  if (typeof window === 'undefined' || !seller || !amount) {
    return ''
  }

  const baseUrl = APP_BASE_URL || `${window.location.origin}${window.location.pathname}`
  const url = new URL(baseUrl)
  url.hash = 'buyer'
  url.searchParams.set('seller', seller)
  if (arbiter) {
    url.searchParams.set('arbiter', arbiter)
  }
  url.searchParams.set('amount', amount)

  if (title) {
    url.searchParams.set('title', title)
  } else {
    url.searchParams.delete('title')
  }

  if (description) {
    url.searchParams.set('description', description)
  } else {
    url.searchParams.delete('description')
  }

  return url.toString()
}

function buildPersistentListingLink(listingId, listing = null) {
  if (typeof window === 'undefined' || !listingId) {
    return ''
  }

  const baseUrl = APP_BASE_URL || `${window.location.origin}${window.location.pathname}`
  const url = new URL(baseUrl)
  url.hash = 'buyer'
  url.searchParams.set('listing', listingId)

  if (listing?.seller) {
    url.searchParams.set('seller', listing.seller)
  }
  if (listing?.arbiter) {
    url.searchParams.set('arbiter', listing.arbiter)
  }
  if (listing?.amount) {
    url.searchParams.set('amount', listing.amount)
  }
  if (listing?.title) {
    url.searchParams.set('title', listing.title)
  }
  if (listing?.description) {
    url.searchParams.set('description', listing.description)
  }

  return url.toString()
}

function getInitialPage() {
  if (typeof window === 'undefined') {
    return 'home'
  }

  const hashPage = window.location.hash.replace('#', '')
  return NAV_ITEMS.some((item) => item.id === hashPage) ? hashPage : 'home'
}

function App() {
  const [provider, setProvider] = useState(null)
  const [signer, setSigner] = useState(null)
  const [walletAddress, setWalletAddress] = useState('')
  const [chainId, setChainId] = useState('')
  const [walletMode, setWalletMode] = useState(null)
  const [contractAddress, setContractAddress] = useState(DEFAULT_CONTRACT_ADDRESS)
  const [listingForm, setListingForm] = useState(initialListingForm)
  const [createForm, setCreateForm] = useState(initialCreateForm)
  const [listingLink, setListingLink] = useState('')
  const [savedListings, setSavedListings] = useState([])
  const [approveForm, setApproveForm] = useState(initialActionForm)
  const [fundForm, setFundForm] = useState(initialActionForm)
  const [deliveredForm, setDeliveredForm] = useState(initialActionForm)
  const [releaseForm, setReleaseForm] = useState(initialActionForm)
  const [refundForm, setRefundForm] = useState(initialActionForm)
  const [disputeForm, setDisputeForm] = useState(initialActionForm)
  const [resolveForm, setResolveForm] = useState({ escrowId: '', releaseToSeller: 'seller' })
  const [lookupId, setLookupId] = useState('')
  const [escrowRecord, setEscrowRecord] = useState(null)
  const [contractBalance, setContractBalance] = useState(null)
  const [usdcAddress, setUsdcAddress] = useState('0x3600000000000000000000000000000000000000')
  const [tokenSymbol, setTokenSymbol] = useState('USDC')
  const [tokenDecimals, setTokenDecimals] = useState(6)
  const [walletBalance, setWalletBalance] = useState(null)
  const [allowance, setAllowance] = useState(null)
  const [myEscrows, setMyEscrows] = useState([])
  const [dashboardFilter, setDashboardFilter] = useState('all')
  const [isDashboardLoading, setIsDashboardLoading] = useState(false)
  const [transactionHistory, setTransactionHistory] = useState([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const [status, setStatus] = useState('Connect a wallet on Arc Network to start using your escrow contract.')
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [activePage, setActivePage] = useState(getInitialPage)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isWalletMenuOpen, setIsWalletMenuOpen] = useState(false)
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false)
  const [hasCopiedWalletAddress, setHasCopiedWalletAddress] = useState(false)
  const [circleEmail, setCircleEmail] = useState('')
  const [circleFlowStep, setCircleFlowStep] = useState('idle')
  const [circleMessage, setCircleMessage] = useState('')
  const [circleOtpRequested, setCircleOtpRequested] = useState(false)
  const [circlePendingChallengeId, setCirclePendingChallengeId] = useState('')
  const [circleDeviceId, setCircleDeviceId] = useState('')
  const [circleDeviceToken, setCircleDeviceToken] = useState('')
  const [circleDeviceEncryptionKey, setCircleDeviceEncryptionKey] = useState('')
  const [circleOtpToken, setCircleOtpToken] = useState('')
  const [circleSession, setCircleSession] = useState(null)
  const [circleWallets, setCircleWallets] = useState([])
  const [circleWalletBalance, setCircleWalletBalance] = useState(null)
  const circleSdkRef = useRef(null)
  const [theme, setTheme] = useState(getInitialTheme)
  const isCircleConfigured = hasCircleAppId()
  const circlePrimaryWallet = pickArcWallet(circleWallets)
  const publicProvider = useMemo(() => new ethers.JsonRpcProvider(ARC_TESTNET.rpcUrl), [])
  const activeWalletAddress = walletMode === 'circle' ? circlePrimaryWallet?.address || '' : walletAddress
  const activeChainId = walletMode === 'circle' ? ARC_TESTNET.chainId.toString() : chainId
  const hasConnectedWallet = Boolean(activeWalletAddress)
  const isCircleWalletActive = walletMode === 'circle' && Boolean(circlePrimaryWallet?.id && circleSession?.userToken)
  const canUseCircleWrites = Boolean(isCircleWalletActive && circlePrimaryWallet?.id && circleSession?.userToken)
  const isCorrectNetwork = walletMode === 'circle'
    ? Boolean(circlePrimaryWallet?.address)
    : chainId === ARC_TESTNET.chainId.toString()
  const walletButtonLabel = activeWalletAddress ? shortenAddress(activeWalletAddress) : 'Connect Wallet'
  const themeButtonLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  const networkLabel = hasConnectedWallet
    ? isCorrectNetwork
      ? ARC_TESTNET.chainName
      : activeChainId
        ? `Wrong network (${activeChainId})`
        : 'Wallet disconnected'
    : 'Wallet disconnected'
  const circleWalletAddress = circlePrimaryWallet?.address || ''
  const circleWalletBalanceLabel = useMemo(() => {
    if (!circleWalletBalance) {
      return ''
    }

    const symbol = circleWalletBalance.token?.symbol || circleWalletBalance.symbol || 'USDC'
    const amount =
      circleWalletBalance.amount ||
      circleWalletBalance.balance ||
      circleWalletBalance.tokenBalance ||
      ''

    return amount ? `${amount} ${symbol}` : symbol
  }, [circleWalletBalance])
  const createFormError = getCreateFormError({
    seller: createForm.seller,
    arbiter: createForm.arbiter,
    amount: createForm.amount,
    walletAddress: activeWalletAddress,
    tokenDecimals,
  })
  const dashboardCounts = useMemo(() => ({
    all: myEscrows.length,
    buyer: myEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Buyer')).length,
    seller: myEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Seller')).length,
    active: myEscrows.filter((escrow) => isActiveEscrowState(escrow.state)).length,
    completed: myEscrows.filter((escrow) => !isActiveEscrowState(escrow.state)).length,
  }), [activeWalletAddress, myEscrows])
  const filteredMyEscrows = useMemo(() => {
    switch (dashboardFilter) {
      case 'buyer':
        return myEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Buyer'))
      case 'seller':
        return myEscrows.filter((escrow) => getEscrowRole(escrow, activeWalletAddress).includes('Seller'))
      case 'active':
        return myEscrows.filter((escrow) => isActiveEscrowState(escrow.state))
      case 'completed':
        return myEscrows.filter((escrow) => !isActiveEscrowState(escrow.state))
      default:
        return myEscrows
    }
  }, [activeWalletAddress, dashboardFilter, myEscrows])
  const dashboardSummary = useMemo(() => {
    const totalVolume = myEscrows.reduce((sum, escrow) => sum + escrow.amount, 0n)

    return [
      {
        id: 'total',
        label: 'Total Escrows',
        value: myEscrows.length.toString(),
        helper: 'All buyer and seller escrows tied to this wallet.',
      },
      {
        id: 'active',
        label: 'Active',
        value: dashboardCounts.active.toString(),
        helper: 'Escrows still waiting for funding or settlement.',
      },
      {
        id: 'completed',
        label: 'Completed',
        value: dashboardCounts.completed.toString(),
        helper: 'Released or refunded escrows already closed.',
      },
      {
        id: 'volume',
        label: `Total Volume (${tokenSymbol})`,
        value: formatTokenAmount(totalVolume, tokenDecimals),
        helper: 'Combined escrow amount across your loaded records.',
      },
    ]
  }, [dashboardCounts.active, dashboardCounts.completed, myEscrows, tokenDecimals, tokenSymbol])
  const recentEscrows = useMemo(() => myEscrows.slice(0, 5), [myEscrows])
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

  const escrowContract = useMemo(() => {
    const readProvider = provider || publicProvider

    if (!readProvider || !contractAddress || !ethers.isAddress(contractAddress)) {
      return null
    }

    return new ethers.Contract(contractAddress, ESCROW_MANAGER_ABI, readProvider)
  }, [provider, publicProvider, contractAddress])

  const signerContract = useMemo(() => {
    if (!signer || !contractAddress || !ethers.isAddress(contractAddress)) {
      return null
    }

    return new ethers.Contract(contractAddress, ESCROW_MANAGER_ABI, signer)
  }, [signer, contractAddress])

  const usdcContract = useMemo(() => {
    const readProvider = provider || publicProvider

    if (!readProvider || !usdcAddress || !ethers.isAddress(usdcAddress)) {
      return null
    }

    return new ethers.Contract(usdcAddress, ERC20_ABI, readProvider)
  }, [provider, publicProvider, usdcAddress])

  const signerUsdcContract = useMemo(() => {
    if (!signer || !usdcAddress || !ethers.isAddress(usdcAddress)) {
      return null
    }

    return new ethers.Contract(usdcAddress, ERC20_ABI, signer)
  }, [signer, usdcAddress])
  const canUseBrowserWrites = Boolean(signerContract)
  const canUseBrowserApprovals = Boolean(signerUsdcContract)
  const canUseActiveWrites = walletMode === 'circle' ? canUseCircleWrites : canUseBrowserWrites
  const canUseActiveApprovals = walletMode === 'circle' ? canUseCircleWrites : canUseBrowserApprovals

  const syncCircleSdk = async ({
    nextDeviceToken = circleDeviceToken,
    nextDeviceEncryptionKey = circleDeviceEncryptionKey,
    nextOtpToken = circleOtpToken,
    nextEmail = circleEmail,
    nextSession = circleSession,
  } = {}) => {
    if (!isCircleConfigured) {
      return null
    }

    const sdk = await getCircleSdk({
      theme,
      onLoginComplete: async (loginError, result) => {
        if (loginError || !result) {
          setCircleFlowStep('otp-sent')
          const nextMessage = loginError?.message || 'Circle email verification failed.'
          setError(nextMessage)
          setCircleMessage(nextMessage)
          return
        }

        setError('')
        setCircleSession({
          userToken: result.userToken,
          encryptionKey: result.encryptionKey,
          refreshToken: result.refreshToken,
        })
        setCircleOtpRequested(false)
        setCirclePendingChallengeId('')
        setCircleDeviceToken('')
        setCircleDeviceEncryptionKey('')
        setCircleOtpToken('')
        setCircleFlowStep('initializing-wallet')
        setCircleMessage('Email verified. Initializing your Circle wallet on Arc Testnet...')

        let setupChallengeId = ''

        try {
          const initPayload = await postCircleAction('initializeUser', {
            userToken: result.userToken,
          })
          setupChallengeId =
            initPayload.challengeId ||
            initPayload.challenge?.challengeId ||
            initPayload.userTokenChallenge?.challengeId ||
            ''

          if (setupChallengeId) {
            setCirclePendingChallengeId(setupChallengeId)
            await completeCircleWalletSetup({
              challengeId: setupChallengeId,
              session: {
                userToken: result.userToken,
                encryptionKey: result.encryptionKey,
                refreshToken: result.refreshToken,
              },
            })
            return
          }

          const nextPrimaryWallet = await refreshCircleWalletSession({
            userToken: result.userToken,
            encryptionKey: result.encryptionKey,
            refreshToken: result.refreshToken,
          })

          setCircleFlowStep('wallet-ready')
          setCircleMessage(
            nextPrimaryWallet?.address
              ? `Circle wallet ready at ${shortenAddress(nextPrimaryWallet.address)}.`
              : 'Circle wallet session is ready.',
          )
          setWalletMode(nextPrimaryWallet?.address ? 'circle' : walletMode)
          setIsWalletModalOpen(false)
          setIsWalletMenuOpen(false)
          setStatus(
            nextPrimaryWallet?.address
              ? `Circle wallet connected at ${shortenAddress(nextPrimaryWallet.address)}. You can now use ArcEscrow with Circle or log out anytime.`
              : 'Circle wallet session is ready. Finish syncing the wallet before sending escrow transactions.',
          )
        } catch (circleFlowError) {
          const nextMessage =
            circleFlowError instanceof Error ? circleFlowError.message : 'Failed to finish Circle wallet setup.'
          if (setupChallengeId) {
            setCirclePendingChallengeId(setupChallengeId)
            setCircleFlowStep('creating-wallet')
            setCircleMessage(`${nextMessage} Tap Finish Wallet Setup to continue without requesting another OTP.`)
          } else {
            setCircleFlowStep('otp-sent')
            setCircleOtpRequested(true)
            setCircleMessage(nextMessage)
          }
          setError(nextMessage)
        }
      },
      onResendOtpEmail: () => {
        void handleCircleOtpSubmit(undefined, true)
      },
    })

    const configs = {
      appSettings: {
        appId: import.meta.env.VITE_CIRCLE_APP_ID?.trim() || '',
      },
    }

    const normalizedEmail = nextEmail.trim()

    if (nextDeviceToken && nextDeviceEncryptionKey) {
      configs.loginConfigs = {
        deviceToken: nextDeviceToken,
        deviceEncryptionKey: nextDeviceEncryptionKey,
        ...(nextOtpToken ? { otpToken: nextOtpToken } : {}),
        ...(normalizedEmail ? { email: { email: normalizedEmail } } : {}),
      }
    }

    sdk.updateConfigs(configs)

    if (nextSession?.userToken && nextSession?.encryptionKey) {
      sdk.setAuthentication({
        userToken: nextSession.userToken,
        encryptionKey: nextSession.encryptionKey,
      })
    }

    circleSdkRef.current = sdk
    return sdk
  }

  const refreshCircleWalletSession = async (nextSession = circleSession) => {
    if (!nextSession?.userToken) {
      setCircleWallets([])
      setCircleWalletBalance(null)
      return null
    }

    const walletPayload = await postCircleAction('listWallets', {
      userToken: nextSession.userToken,
    })
    const nextWallets = walletPayload.wallets || []
    const nextPrimaryWallet = pickArcWallet(nextWallets)

    setCircleWallets(nextWallets)

    if (nextPrimaryWallet?.id) {
      try {
        const balancePayload = await postCircleAction('getTokenBalance', {
          userToken: nextSession.userToken,
          walletId: nextPrimaryWallet.id,
        })
        setCircleWalletBalance(pickUsdcBalance(balancePayload))
      } catch {
        setCircleWalletBalance(null)
      }
    } else {
      setCircleWalletBalance(null)
    }

    return nextPrimaryWallet
  }

  const completeCircleWalletSetup = async ({ challengeId, session = circleSession }) => {
    if (!challengeId) {
      throw new Error('Circle did not return a wallet setup challenge.')
    }

    if (!session?.userToken || !session?.encryptionKey) {
      throw new Error('Verify your email before finishing Circle wallet setup.')
    }

    const sdk = await syncCircleSdk({
      nextDeviceToken: '',
      nextDeviceEncryptionKey: '',
      nextOtpToken: '',
      nextSession: session,
    })

    setCircleFlowStep('creating-wallet')
    setCircleMessage('Circle is opening the secure wallet setup window...')
    sdk.setAuthentication({
      userToken: session.userToken,
      encryptionKey: session.encryptionKey,
    })

    await new Promise((resolve, reject) => {
      sdk.execute(challengeId, (challengeError, challengeResult) => {
        if (challengeError) {
          reject(new Error(challengeError.message || 'Circle wallet setup was cancelled.'))
          return
        }

        if (challengeResult?.status === 'FAILED' || challengeResult?.status === 'EXPIRED') {
          reject(new Error('Circle wallet setup did not complete successfully.'))
          return
        }

        resolve(challengeResult)
      })
    })

    setCirclePendingChallengeId('')
    const nextPrimaryWallet = await refreshCircleWalletSession(session)

    setCircleFlowStep('wallet-ready')
    setCircleMessage(
      nextPrimaryWallet?.address
        ? `Circle wallet ready at ${shortenAddress(nextPrimaryWallet.address)}.`
        : 'Circle wallet session is ready.',
    )
    setWalletMode(nextPrimaryWallet?.address ? 'circle' : walletMode)
    setIsWalletModalOpen(false)
    setIsWalletMenuOpen(false)
    setStatus(
      nextPrimaryWallet?.address
        ? `Circle wallet connected at ${shortenAddress(nextPrimaryWallet.address)}. You can now use ArcEscrow with Circle or log out anytime.`
        : 'Circle wallet session is ready. Finish syncing the wallet before sending escrow transactions.',
    )

    return nextPrimaryWallet
  }

  const resolveCircleTransaction = async ({ challengeId, userToken }) => {
    const maxAttempts = 60
    let lastChallenge = null

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const challengePayload = await postCircleAction('getChallenge', {
        userToken,
        challengeId,
      })
      const challenge =
        challengePayload.challenge ||
        challengePayload.userChallenge ||
        challengePayload

      lastChallenge = challenge

      if (challenge?.status === 'FAILED' || challenge?.status === 'EXPIRED') {
        throw new Error(challenge?.errorReason || 'Circle challenge did not complete successfully.')
      }

      const transactionId =
        challenge?.correlationIds?.find((value) => typeof value === 'string' && value.trim()) ||
        challenge?.correlationId ||
        challenge?.transactionId ||
        ''

      if (transactionId) {
        const transactionPayload = await postCircleAction('getTransaction', {
          userToken,
          transactionId,
        })
        const transaction =
          transactionPayload.transaction ||
          transactionPayload.userTransaction ||
          transactionPayload

        const txHash =
          transaction?.txHash ||
          transaction?.blockchainTxHash ||
          transaction?.transactionHash ||
          transaction?.tx?.txHash ||
          transaction?.tx?.hash ||
          transaction?.tx?.transactionHash ||
          ''

        if (txHash) {
          const readProvider = provider || publicProvider
          const receipt = await readProvider.getTransactionReceipt(txHash)

          if (receipt) {
            return { challenge, transaction, txHash, receipt }
          }
        }

        if (transaction?.state === 'FAILED' || transaction?.status === 'FAILED') {
          throw new Error(
            transaction?.errorReason ||
              transaction?.errorMessage ||
              'Circle transaction failed before reaching the chain.',
          )
        }
      }

      if (challenge?.status === 'COMPLETE' || challenge?.status === 'COMPLETED') {
        setStatus('Circle approved. Waiting for the Arc receipt to arrive...')
      }

      await wait(2000)
    }

    throw new Error(
      lastChallenge?.errorReason ||
        'Circle approved the transaction, but the Arc receipt took too long to show up. Refresh the page and check Manage/lookup to confirm whether it landed.',
    )
  }

  const executeCircleContract = async ({
    contractAddress: targetContract,
    abiFunctionSignature,
    abiParameters = [],
    pendingMessage,
  }) => {
    if (!circleSession?.userToken || !circlePrimaryWallet?.id) {
      throw new Error('Log in with Circle Wallet first.')
    }

    const sdk = await syncCircleSdk({ nextSession: circleSession })

    setStatus(pendingMessage || 'Opening Circle approval...')

    const challengePayload = await postCircleAction('createContractExecutionChallenge', {
      userToken: circleSession.userToken,
      walletId: circlePrimaryWallet.id,
      contractAddress: targetContract,
      abiFunctionSignature,
      abiParameters,
    })

    const challengeId =
      challengePayload.challengeId ||
      challengePayload.challenge?.challengeId ||
      challengePayload.userChallenge?.challengeId ||
      ''

    if (!challengeId) {
      throw new Error('Circle did not return a contract execution challenge.')
    }

    await new Promise((resolve, reject) => {
      sdk.execute(challengeId, (challengeError, challengeResult) => {
        if (challengeError) {
          reject(new Error(challengeError.message || 'Circle contract execution was cancelled.'))
          return
        }

        if (challengeResult?.status === 'FAILED' || challengeResult?.status === 'EXPIRED') {
          reject(new Error('Circle contract execution did not complete successfully.'))
          return
        }

        resolve(challengeResult)
      })
    })

    return resolveCircleTransaction({
      challengeId,
      userToken: circleSession.userToken,
    })
  }

  const handleCircleOtpSubmit = async (event, isResend = false) => {
    event?.preventDefault?.()

    if (!isCircleConfigured) {
      setError('Add VITE_CIRCLE_APP_ID before trying the Circle email flow.')
      return
    }

    if (!circleEmail.trim()) {
      setError('Enter your email address to continue with Circle Wallet.')
      return
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailPattern.test(circleEmail.trim())) {
      setError('Enter a valid email address for Circle Wallet.')
      return
    }

    try {
      setIsBusy(true)
      setError('')
      setCircleMessage(isResend ? 'Requesting a fresh OTP from Circle...' : 'Requesting your Circle OTP...')

      const sdk = await syncCircleSdk()
      const deviceId = circleDeviceId || (await sdk.getDeviceId())

      if (!circleDeviceId) {
        setCircleDeviceId(deviceId)
      }

      const otpPayload = await postCircleAction('requestEmailOtp', {
        email: circleEmail.trim(),
        deviceId,
      })

      setCircleDeviceToken(otpPayload.deviceToken || '')
      setCircleDeviceEncryptionKey(otpPayload.deviceEncryptionKey || '')
      setCircleOtpToken(otpPayload.otpToken || '')
      setCircleOtpRequested(true)
      setCircleFlowStep('otp-sent')
      setCircleMessage(
        isResend
          ? 'A fresh OTP is ready. Open Circle verification and use only the latest code sent to your email inbox.'
          : 'OTP requested. Open Circle verification and enter the code sent to your email inbox.',
      )

      await syncCircleSdk({
        nextDeviceToken: otpPayload.deviceToken || '',
        nextDeviceEncryptionKey: otpPayload.deviceEncryptionKey || '',
        nextOtpToken: otpPayload.otpToken || '',
        nextEmail: circleEmail.trim(),
      })
    } catch (circleOtpError) {
      const nextMessage =
        circleOtpError instanceof Error ? circleOtpError.message : 'Failed to request Circle OTP.'
      setCircleFlowStep('idle')
      setCircleOtpRequested(false)
      setError(nextMessage)
      setCircleMessage(nextMessage)
    } finally {
      setIsBusy(false)
    }
  }

  const openCircleOtpVerifier = (sdk) => {
    const verifyOtp = sdk?.verifyOtp || sdk?.verifyOTP

    if (typeof verifyOtp !== 'function') {
      throw new Error('Circle OTP verifier is not available. Refresh the page and request a new code.')
    }

    verifyOtp.call(sdk)
  }

  const handleCircleVerifyOtp = async () => {
    if (!circleDeviceToken || !circleDeviceEncryptionKey) {
      setError('Request a Circle OTP code first.')
      return
    }

    try {
      setIsBusy(true)
      setError('')
      setCircleFlowStep('verifying')
      setCircleMessage('Circle verification window opened. Enter the OTP code from your email inbox to continue.')

      if (circleSdkRef.current) {
        openCircleOtpVerifier(circleSdkRef.current)
        return
      }

      const sdk = await syncCircleSdk({
        nextDeviceToken: circleDeviceToken,
        nextDeviceEncryptionKey: circleDeviceEncryptionKey,
        nextOtpToken: circleOtpToken,
        nextEmail: circleEmail.trim(),
      })
      openCircleOtpVerifier(sdk)
    } catch (circleVerifyError) {
      const nextMessage =
        circleVerifyError instanceof Error ? circleVerifyError.message : 'Failed to open Circle OTP verification.'
      setCircleFlowStep('otp-sent')
      setCircleOtpRequested(true)
      setError(nextMessage)
      setCircleMessage(nextMessage)
    } finally {
      setIsBusy(false)
    }
  }

  const handleCircleFinishWalletSetup = async () => {
    if (!circlePendingChallengeId) {
      setError('Verify your email first so Circle can prepare wallet setup.')
      return
    }

    try {
      setIsBusy(true)
      setError('')
      await completeCircleWalletSetup({ challengeId: circlePendingChallengeId })
    } catch (finishError) {
      const nextMessage =
        finishError instanceof Error ? finishError.message : 'Failed to finish Circle wallet setup.'
      setCircleFlowStep('creating-wallet')
      setError(nextMessage)
      setCircleMessage(`${nextMessage} You can tap Finish Wallet Setup again without requesting another OTP.`)
    } finally {
      setIsBusy(false)
    }
  }

  useEffect(() => {
    if (walletMode !== 'circle' || !circleSession?.userToken) {
      return
    }

    let isCancelled = false

    const restoreCircleWallet = async () => {
      try {
        setStatus('Restoring your Circle wallet session...')
        const nextPrimaryWallet = await refreshCircleWalletSession(circleSession)

        if (isCancelled) {
          return
        }

        if (nextPrimaryWallet?.address) {
          setStatus(`Circle wallet restored at ${shortenAddress(nextPrimaryWallet.address)}.`)
        }
      } catch (restoreError) {
        if (isCancelled) {
          return
        }

        console.warn('Failed to restore Circle wallet session:', restoreError)
        setCircleSession(null)
        setCircleWallets([])
        setCircleWalletBalance(null)
        setWalletMode(null)
        setError(getDisplayError(restoreError))
        setCircleMessage('Your Circle session expired. Please sign in again.')
        setStatus('Circle session expired. Sign in again to continue.')
      }
    }

    void restoreCircleWallet()

    return () => {
      isCancelled = true
    }
  }, [walletMode, circleSession?.userToken])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.ethereum) {
      return undefined
    }

    const browserProvider = new ethers.BrowserProvider(window.ethereum)
    setProvider(browserProvider)

    const handleAccountsChanged = async (accounts) => {
      const nextAccount = accounts[0] || ''
      setWalletAddress(nextAccount)

      if (nextAccount) {
        setWalletMode((current) => current === 'circle' ? current : 'browser')
        const nextSigner = await browserProvider.getSigner()
        setSigner(nextSigner)
      } else {
        setWalletMode((current) => current === 'browser' ? null : current)
        setSigner(null)
      }
    }

    const handleChainChanged = async (hexChainId) => {
      setChainId(Number.parseInt(hexChainId, 16).toString())

      const accounts = await browserProvider.send('eth_accounts', [])
      await handleAccountsChanged(accounts)
    }

    window.ethereum.request({ method: 'eth_accounts' }).then(handleAccountsChanged)
    window.ethereum
      .request({ method: 'eth_chainId' })
      .then((hexChainId) => setChainId(Number.parseInt(hexChainId, 16).toString()))

    window.ethereum.on('accountsChanged', handleAccountsChanged)
    window.ethereum.on('chainChanged', handleChainChanged)

    return () => {
      window.ethereum.removeListener('accountsChanged', handleAccountsChanged)
      window.ethereum.removeListener('chainChanged', handleChainChanged)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem('arc-escrow-contract-address', contractAddress)
  }, [contractAddress])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const storedListings = window.localStorage.getItem('arc-escrow-listings')
    if (storedListings) {
      try {
        setSavedListings(JSON.parse(storedListings))
      } catch {
        setSavedListings([])
      }
    }

    const storedAddress = window.localStorage.getItem('arc-escrow-contract-address')

    if (storedAddress && !DEFAULT_CONTRACT_ADDRESS) {
      setContractAddress(storedAddress)
    }

    const params = new URLSearchParams(window.location.search)
    const listingId = params.get('listing') || ''
    const arbiter = params.get('arbiter') || ''
    const seller = params.get('seller') || ''
    const amount = params.get('amount') || ''
    const title = params.get('title') || ''
    const description = params.get('description') || ''

    if (listingId && storedListings) {
      try {
        const parsedListings = JSON.parse(storedListings)
        const listing = parsedListings.find((item) => item.id === listingId)

        if (listing) {
          setCreateForm({
            seller: listing.seller,
            arbiter: listing.arbiter || '',
            amount: listing.amount,
            title: listing.title,
            description: listing.description,
          })
          setActivePage('buyer')
          setStatus('Saved seller listing loaded. Buyer can now create the escrow.')
          return
        }
      } catch {
        // Ignore malformed local listing storage and continue with query-param fallback.
      }
    }

    if (seller || amount || title || description) {
      setCreateForm({
        seller,
        arbiter,
        amount,
        title,
        description,
      })
      setActivePage('buyer')
      setStatus('Seller listing loaded. Buyer can now create the escrow.')
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const storedWalletMode = window.localStorage.getItem(WALLET_MODE_STORAGE_KEY)
    const storedCircleSession = window.localStorage.getItem(CIRCLE_SESSION_STORAGE_KEY)
    const storedCircleWallets = window.localStorage.getItem(CIRCLE_WALLETS_STORAGE_KEY)
    const storedCircleBalance = window.localStorage.getItem(CIRCLE_BALANCE_STORAGE_KEY)

    if (storedWalletMode === 'circle') {
      setWalletMode('circle')
    }

    if (storedCircleSession) {
      try {
        setCircleSession(JSON.parse(storedCircleSession))
      } catch {
        window.localStorage.removeItem(CIRCLE_SESSION_STORAGE_KEY)
      }
    }

    if (storedCircleWallets) {
      try {
        setCircleWallets(JSON.parse(storedCircleWallets))
      } catch {
        window.localStorage.removeItem(CIRCLE_WALLETS_STORAGE_KEY)
      }
    }

    if (storedCircleBalance) {
      try {
        setCircleWalletBalance(JSON.parse(storedCircleBalance))
      } catch {
        window.localStorage.removeItem(CIRCLE_BALANCE_STORAGE_KEY)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.location.hash = activePage
    setIsMenuOpen(false)
    setIsWalletMenuOpen(false)
  }, [activePage])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const handleHashChange = () => {
      const nextPage = getInitialPage()
      setActivePage((currentPage) => (currentPage === nextPage ? currentPage : nextPage))
      setIsMenuOpen(false)
      setIsWalletMenuOpen(false)
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem('arc-escrow-listings', JSON.stringify(savedListings))
  }, [savedListings])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    if (walletMode) {
      window.localStorage.setItem(WALLET_MODE_STORAGE_KEY, walletMode)
    } else {
      window.localStorage.removeItem(WALLET_MODE_STORAGE_KEY)
    }
  }, [walletMode])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    if (circleSession?.userToken && circleSession?.encryptionKey) {
      window.localStorage.setItem(CIRCLE_SESSION_STORAGE_KEY, JSON.stringify(circleSession))
    } else {
      window.localStorage.removeItem(CIRCLE_SESSION_STORAGE_KEY)
    }
  }, [circleSession])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    if (circleWallets.length) {
      window.localStorage.setItem(CIRCLE_WALLETS_STORAGE_KEY, JSON.stringify(circleWallets))
    } else {
      window.localStorage.removeItem(CIRCLE_WALLETS_STORAGE_KEY)
    }
  }, [circleWallets])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    if (circleWalletBalance) {
      window.localStorage.setItem(CIRCLE_BALANCE_STORAGE_KEY, JSON.stringify(circleWalletBalance))
    } else {
      window.localStorage.removeItem(CIRCLE_BALANCE_STORAGE_KEY)
    }
  }, [circleWalletBalance])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    window.localStorage.setItem('arc-escrow-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!isWalletModalOpen || typeof window === 'undefined') {
      return undefined
    }

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsWalletModalOpen(false)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isWalletModalOpen])

  useEffect(() => {
    if (!activeWalletAddress) {
      setIsWalletMenuOpen(false)
    }
  }, [activeWalletAddress])

  useEffect(() => {
    const loadContracts = async () => {
      if (!escrowContract) {
        setContractBalance(null)
        return
      }

      try {
        const [nextUsdcAddress, nextBalance] = await Promise.all([
          escrowContract.usdc(),
          escrowContract.contractUsdcBalance(),
        ])

        setUsdcAddress(nextUsdcAddress)
        setContractBalance(nextBalance)
      } catch (contractError) {
        setError(contractError.shortMessage || contractError.message)
      }
    }

    loadContracts()
  }, [escrowContract])

  useEffect(() => {
    const loadTokenMeta = async () => {
      if (!usdcContract) {
        return
      }

      try {
        const [decimals, symbol] = await Promise.all([
          usdcContract.decimals(),
          usdcContract.symbol(),
        ])

        setTokenDecimals(Number(decimals))
        setTokenSymbol(symbol)
      } catch {
        setTokenDecimals(6)
        setTokenSymbol('USDC')
      }
    }

    loadTokenMeta()
  }, [usdcContract])

  useEffect(() => {
    const loadWalletData = async () => {
      if (!activeWalletAddress || !usdcContract || !contractAddress || !ethers.isAddress(contractAddress)) {
        setWalletBalance(null)
        setAllowance(null)
        return
      }

      try {
        const [nextBalance, nextAllowance] = await Promise.all([
          usdcContract.balanceOf(activeWalletAddress),
          usdcContract.allowance(activeWalletAddress, contractAddress),
        ])

        setWalletBalance(nextBalance)
        setAllowance(nextAllowance)
      } catch (walletError) {
        setError(walletError.shortMessage || walletError.message)
      }
    }

    loadWalletData()
  }, [activeWalletAddress, usdcContract, contractAddress, isBusy])

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

  const refreshEscrow = async (escrowId) => {
    if (!escrowContract) {
      return
    }

    const record = await escrowContract.getEscrow(escrowId)
    const nextRecord = buildEscrowRecord(record)

    setEscrowRecord(nextRecord)
  }

  const syncEscrowWorkspace = (escrowId) => {
    setLookupId(escrowId)
    setApproveForm({ escrowId })
    setFundForm({ escrowId })
    setDeliveredForm({ escrowId })
    setReleaseForm({ escrowId })
    setRefundForm({ escrowId })
    setDisputeForm({ escrowId })
    setResolveForm((current) => ({ ...current, escrowId }))
  }

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
      const records = await Promise.all(
        escrowIndexes.map((escrowId) => escrowContract.getEscrow(escrowId)),
      )
      const normalizedWallet = activeWalletAddress.toLowerCase()
      const walletEscrows = records
        .map((record) => buildEscrowRecord(record))
        .filter((escrow) =>
          escrow.buyer.toLowerCase() === normalizedWallet ||
          escrow.seller.toLowerCase() === normalizedWallet,
        )
        .sort((left, right) => Number(right.id) - Number(left.id))

      setMyEscrows(walletEscrows)
    } catch (dashboardError) {
      setError(dashboardError.shortMessage || dashboardError.message)
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
      const [approvalEvents, createdEvents, fundedEvents, deliveredEvents, releasedEvents, refundedEvents, disputeOpenedEvents, disputeResolvedEvents] = await Promise.all([
        usdcContract.queryFilter(usdcContract.filters.Approval(activeWalletAddress, contractAddress)),
        escrowContract.queryFilter(escrowContract.filters.EscrowCreated()),
        escrowContract.queryFilter(escrowContract.filters.EscrowFunded()),
        escrowContract.queryFilter(escrowContract.filters.DeliveryMarked()),
        escrowContract.queryFilter(escrowContract.filters.EscrowReleased()),
        escrowContract.queryFilter(escrowContract.filters.EscrowRefunded()),
        escrowContract.queryFilter(escrowContract.filters.DisputeOpened()),
        escrowContract.queryFilter(escrowContract.filters.DisputeResolved()),
      ])
      const escrowEvents = [
        ...createdEvents,
        ...fundedEvents,
        ...deliveredEvents,
        ...releasedEvents,
        ...refundedEvents,
        ...disputeOpenedEvents,
        ...disputeResolvedEvents,
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
      setError(historyError.shortMessage || historyError.message)
    } finally {
      setIsHistoryLoading(false)
    }
  }

  const refreshLiveData = async (refreshEscrowId) => {
    const targetEscrowId = refreshEscrowId || lookupId

    if (targetEscrowId) {
      await refreshEscrow(targetEscrowId)
    }

    if (escrowContract) {
      setContractBalance(await escrowContract.contractUsdcBalance())
    }

    if (activeWalletAddress) {
      await loadMyEscrows()
      await loadTransactionHistory()
    }

    if (canUseCircleWrites) {
      await refreshCircleWalletSession()
    }
  }

  const executeActiveWrite = async ({
    browserWork,
    circleContractAddress = contractAddress,
    circleFunctionSignature,
    circleParameters = [],
    pendingMessage,
    successMessage,
    refreshEscrowId,
  }) => {
    try {
      setIsBusy(true)
      setError('')
      let txHash = ''
      let receipt = null

      if (walletMode === 'circle') {
        const result = await executeCircleContract({
          contractAddress: circleContractAddress,
          abiFunctionSignature: circleFunctionSignature,
          abiParameters: circleParameters,
          pendingMessage,
        })
        txHash = result.txHash || ''
        receipt = result.receipt || null
        setStatus(txHash ? `Transaction confirmed: ${txHash}` : successMessage)
      } else {
        const tx = await browserWork()
        txHash = tx.hash
        setStatus(`Transaction sent: ${tx.hash}`)
        receipt = await tx.wait()
      }

      setStatus(successMessage)
      try {
        await refreshLiveData(refreshEscrowId)
      } catch (refreshError) {
        setStatus(`${successMessage} Live data refresh is delayed.`)
        setError('')
        console.warn('Post-transaction refresh failed:', refreshError)
      }

      return { txHash, receipt }
    } catch (txError) {
      setError(getDisplayError(txError))
      return null
    } finally {
      setIsBusy(false)
    }
  }

  const runEscrowAction = async ({
    escrowId,
    browserWork,
    circleFunctionSignature,
    circleParameters = [],
    pendingMessage,
    successMessage,
  }) => {
    const targetEscrowId = `${escrowId || ''}`.trim()

    if (!hasConnectedWallet) {
      setError('Connect a wallet first.')
      return null
    }

    if (!isCorrectNetwork) {
      setError('Switch your wallet to Arc Testnet before sending transactions.')
      return null
    }

    if (!targetEscrowId) {
      setError('Enter an escrow ID first.')
      return null
    }

    return executeActiveWrite({
      browserWork,
      circleFunctionSignature,
      circleParameters,
      pendingMessage,
      successMessage,
      refreshEscrowId: targetEscrowId,
    })
  }

  const connectWallet = async () => {
    if (!window.ethereum) {
      setError('No injected wallet found. Install MetaMask or another EVM wallet.')
      return
    }

    try {
      setError('')
      const browserProvider = new ethers.BrowserProvider(window.ethereum)
      const accounts = await browserProvider.send('eth_requestAccounts', [])
      const nextSigner = await browserProvider.getSigner()
      const network = await browserProvider.getNetwork()

      setProvider(browserProvider)
      setSigner(nextSigner)
      setWalletAddress(accounts[0] || '')
      setChainId(network.chainId.toString())
      setWalletMode('browser')
      setIsWalletModalOpen(false)
      setStatus(
        network.chainId.toString() === ARC_TESTNET.chainId.toString()
          ? 'Wallet connected to Arc Testnet. You can create or manage escrows now.'
          : 'Wallet connected. Switch to Arc Testnet before sending transactions.',
      )
    } catch (walletError) {
      setError(walletError.shortMessage || walletError.message)
    }
  }

  const disconnectWallet = () => {
    if (walletMode === 'circle') {
      setCircleSession(null)
      setCircleWallets([])
      setCircleWalletBalance(null)
      setCircleOtpRequested(false)
      setCirclePendingChallengeId('')
      setCircleDeviceId('')
      setCircleDeviceToken('')
      setCircleDeviceEncryptionKey('')
      setCircleOtpToken('')
      setCircleFlowStep('idle')
      setCircleMessage('Circle wallet disconnected from ArcEscrow. Sign in again whenever you are ready.')
    } else {
      setSigner(null)
      setWalletAddress('')
      setChainId('')
    }

    setWalletMode(null)
    setWalletBalance(null)
    setAllowance(null)
    setIsWalletMenuOpen(false)
    setError('')
    setStatus('Wallet disconnected from ArcEscrow. Connect again whenever you are ready.')
  }

  const openWalletModal = () => {
    setIsWalletMenuOpen(false)
    setError('')
    if (!circleMessage && isCircleConfigured) {
      setCircleMessage('Use your email to request a Circle OTP, then verify it in the secure Circle window to connect ArcEscrow.')
    }
    setIsWalletModalOpen(true)
  }

  const handleWalletOption = async (action) => {
    if (action === 'browser') {
      await connectWallet()
      return
    }

    setError('')
    setStatus('WalletConnect support is coming soon. For now, use an injected browser wallet or the Circle email flow.')
  }

  const handleCopyWalletAddress = async () => {
    if (!activeWalletAddress) {
      return
    }

    try {
      await navigator.clipboard.writeText(activeWalletAddress)
      setHasCopiedWalletAddress(true)
      setStatus(`${walletMode === 'circle' ? 'Circle' : 'Wallet'} address copied.`)
      setTimeout(() => setHasCopiedWalletAddress(false), 1800)
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Failed to copy wallet address.')
    }
  }

  const switchToArcTestnet = async () => {
    if (!window.ethereum) {
      setError('No injected wallet found. Install MetaMask or another EVM wallet.')
      return
    }

    try {
      setError('')
      setIsBusy(true)

      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: ARC_TESTNET.chainIdHex }],
      })

      setStatus('Wallet switched to Arc Testnet.')
    } catch (switchError) {
      if (switchError.code === 4902) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: ARC_TESTNET.chainIdHex,
                chainName: ARC_TESTNET.chainName,
                rpcUrls: [ARC_TESTNET.rpcUrl],
                nativeCurrency: ARC_TESTNET.nativeCurrency,
                blockExplorerUrls: [ARC_TESTNET.blockExplorerUrl],
              },
            ],
          })

          setStatus('Arc Testnet was added to your wallet and selected.')
        } catch (addError) {
          setError(addError.shortMessage || addError.message)
        }
      } else {
        setError(switchError.shortMessage || switchError.message)
      }
    } finally {
      setIsBusy(false)
    }
  }

  const handleGenerateListing = (event) => {
    event.preventDefault()

    if (!activeWalletAddress) {
      setError('Connect the seller wallet before generating a buyer link.')
      return
    }

    if (!ethers.isAddress(activeWalletAddress)) {
      setError('Connected wallet is not a valid seller address.')
      return
    }

    const amountError = getCreateFormError({
      seller: activeWalletAddress,
      arbiter: listingForm.arbiter,
      amount: listingForm.amount,
      walletAddress: '',
      tokenDecimals,
    })

    if (amountError && amountError !== 'Enter the seller wallet address.') {
      setError(amountError)
      return
    }

    const nextCreateForm = {
      seller: activeWalletAddress,
      arbiter: listingForm.arbiter.trim(),
      amount: listingForm.amount,
      title: listingForm.title.trim(),
      description: listingForm.description.trim(),
    }
    const listingId = crypto.randomUUID()
    const nextListing = {
      id: listingId,
      seller: activeWalletAddress,
      arbiter: listingForm.arbiter.trim(),
      amount: listingForm.amount,
      title: listingForm.title.trim(),
      description: listingForm.description.trim(),
      createdAt: new Date().toISOString(),
    }

    setCreateForm(nextCreateForm)
    setSavedListings((current) => [nextListing, ...current])
    setListingLink(buildPersistentListingLink(listingId, nextListing) || buildListingLink(nextCreateForm))
    setCopied(false)
    setError('')
    setStatus('Seller listing saved and buyer link generated. Share it with the buyer.')
  }

  const handleCopyListing = async () => {
    if (!listingLink) {
      return
    }

    try {
      await navigator.clipboard.writeText(listingLink)
      setCopied(true)
      setStatus('Listing link copied. Send it to the buyer.')
    } catch {
      setError('Could not copy automatically. Copy the link manually.')
    }
  }

  const handleReviewListing = () => {
    if (!listingLink) {
      return
    }

    window.open(listingLink, '_blank', 'noopener,noreferrer')
  }

  const handleLoadSavedListing = (listing) => {
    setListingForm({
      title: listing.title,
      description: listing.description,
      arbiter: listing.arbiter || '',
      amount: listing.amount,
    })
    setCreateForm({
      seller: listing.seller,
      arbiter: listing.arbiter || '',
      amount: listing.amount,
      title: listing.title,
      description: listing.description,
    })
    setListingLink(buildPersistentListingLink(listing.id, listing))
    setCopied(false)
    setStatus(`Saved listing "${listing.title || `#${listing.id.slice(0, 6)}`}" loaded.`)
  }

  const handleDeleteSavedListing = (listingId) => {
    setSavedListings((current) => current.filter((listing) => listing.id !== listingId))
    if (listingLink.includes(`listing=${listingId}`)) {
      setListingLink('')
    }
    setStatus('Saved listing removed.')
  }

  const goToPage = (pageId, event) => {
    if (event?.currentTarget instanceof HTMLElement) {
      event.currentTarget.blur()
    }

    setActivePage(pageId)
  }

  const handleCreateEscrow = async (event) => {
    event.preventDefault()

    if (!hasConnectedWallet) {
      setError('Connect a wallet first.')
      return
    }

    if (!canUseActiveWrites) {
      setError(
        walletMode === 'circle'
          ? 'Circle wallet is still syncing. Wait a moment, then try creating the escrow again.'
          : 'Connect a wallet first.',
      )
      return
    }

    if (!isCorrectNetwork) {
      setError('Switch your wallet to Arc Testnet before creating an escrow.')
      return
    }

    try {
      setIsBusy(true)
      setError('')

      const amount = ethers.parseUnits(createForm.amount, tokenDecimals)
      const result = await executeActiveWrite({
        browserWork: () => signerContract.createEscrow(createForm.seller, createForm.arbiter, amount),
        circleFunctionSignature: 'createEscrow(address,address,uint256)',
        circleParameters: [createForm.seller, createForm.arbiter, amount.toString()],
        pendingMessage: 'Open Circle to approve escrow creation...',
        successMessage: 'Escrow created successfully.',
      })

      if (!result?.receipt) {
        return
      }

      const log = result.receipt.logs
        .map((entry) => {
          try {
            return new ethers.Interface(ESCROW_MANAGER_ABI).parseLog(entry)
          } catch {
            return null
          }
        })
        .find((entry) => entry?.name === 'EscrowCreated')

      const escrowId = log?.args?.escrowId?.toString()

      if (escrowId) {
        syncEscrowWorkspace(escrowId)
        setActivePage('manage')
        setStatus(`Escrow #${escrowId} created successfully.`)
      } else {
        setStatus('Escrow created successfully.')
      }

      setCreateForm(initialCreateForm)
      try {
        await refreshLiveData(escrowId)
      } catch (refreshError) {
        const successLabel = escrowId
          ? `Escrow #${escrowId} created successfully.`
          : 'Escrow created successfully.'
        setStatus(`${successLabel} Live data refresh is delayed.`)
        setError('')
        console.warn('Post-create refresh failed:', refreshError)
      }
    } catch (createError) {
      setError(getDisplayError(createError))
    } finally {
      setIsBusy(false)
    }
  }

  const handleApprove = async (event) => {
    event.preventDefault()

    if (!contractAddress) {
      setError('Connect a wallet and provide your deployed contract address first.')
      return
    }

    if (!isCorrectNetwork) {
      setError('Switch your wallet to Arc Testnet before approving USDC.')
      return
    }

    const targetId = approveForm.escrowId || lookupId

    if (!targetId) {
      setError('Enter an escrow ID so the app can read its amount before approval.')
      return
    }

    try {
      setError('')
      setIsBusy(true)
      const record = await escrowContract.getEscrow(targetId)
      const approveResult = await executeActiveWrite({
        browserWork: () => signerUsdcContract.approve(contractAddress, record.amount),
        circleContractAddress: usdcAddress,
        circleFunctionSignature: 'approve(address,uint256)',
        circleParameters: [contractAddress, record.amount.toString()],
        pendingMessage: 'Open Circle to approve the USDC allowance...',
        successMessage: `Allowance updated for escrow #${targetId}.`,
        refreshEscrowId: targetId,
      })

      if (!approveResult) {
        return
      }

      setStatus(`Allowance updated for escrow #${targetId}.`)
      try {
        await refreshLiveData(targetId)
        setAllowance(await usdcContract.allowance(activeWalletAddress, contractAddress))
      } catch (refreshError) {
        setStatus(`Allowance updated for escrow #${targetId}. Live data refresh is delayed.`)
        setError('')
        console.warn('Post-approval refresh failed:', refreshError)
      }
    } catch (approveError) {
      setError(getDisplayError(approveError))
    } finally {
      setIsBusy(false)
    }
  }

  const buyerStatusMessage = useMemo(() => {
    if (createFormError) {
      return ''
    }

    if (!hasConnectedWallet) {
      return 'Connect a wallet to create the escrow.'
    }

    if (!isCorrectNetwork) {
      return 'Switch to Arc Testnet before creating the escrow.'
    }

    if (!canUseActiveWrites) {
      return walletMode === 'circle'
        ? 'Circle wallet is still syncing. Give it a moment before creating the escrow.'
        : 'Wallet signer is still loading. Give it a moment and try again.'
    }

    return walletMode === 'circle'
      ? 'Circle will open a secure approval window after you tap Create Escrow.'
      : 'Your connected browser wallet will ask you to confirm the escrow transaction.'
  }, [canUseActiveWrites, createFormError, hasConnectedWallet, isCorrectNetwork, walletMode])

  const shouldShowCircleVerification = useMemo(() => {
    if (circleSession || circlePrimaryWallet) {
      return false
    }

    if (circleOtpRequested) {
      return true
    }

    if (circleFlowStep === 'otp-sent' || circleFlowStep === 'verifying') {
      return true
    }

    if (circleOtpToken || circleDeviceToken || circleDeviceEncryptionKey) {
      return true
    }

    const normalizedMessage = circleMessage.toLowerCase()
    return normalizedMessage.includes('otp requested') || normalizedMessage.includes('fresh otp')
  }, [
    circleDeviceEncryptionKey,
    circleDeviceToken,
    circleFlowStep,
    circleMessage,
    circleOtpRequested,
    circleOtpToken,
    circlePrimaryWallet,
    circleSession,
  ])

  const canOpenCircleVerifier = shouldShowCircleVerification && Boolean(
    circleDeviceToken && circleDeviceEncryptionKey,
  )

  const handleLookup = async (event) => {
    event.preventDefault()

    if (!lookupId) {
      setError('Enter an escrow ID to inspect.')
      return
    }

    try {
      setError('')
      await refreshEscrow(lookupId)
      syncEscrowWorkspace(lookupId)
      setStatus(`Loaded escrow #${lookupId}.`)
    } catch (lookupError) {
      setError(lookupError.shortMessage || lookupError.message)
    }
  }

  const handleLoadDashboardEscrow = (escrow) => {
    syncEscrowWorkspace(escrow.id)
    setEscrowRecord(escrow)
    setStatus(`Escrow #${escrow.id} loaded from your dashboard.`)
  }

  return (
    <main className={`app-shell${isWalletModalOpen ? ' app-shell--wallet-modal-open' : ''}`}>
      <header className="app-nav">
        <a
          className="app-nav__brand app-nav__brand-link"
          href="https://arc-escrow-blue.vercel.app/"
          aria-label="Open ArcEscrow website"
        >
          <img className="brand-logo" src="/logo-arc-1.svg" alt="ArcEscrow logo" />
          <div>
            <p className="eyebrow">ArcEscrow</p>
            <strong>Arc Network escrow</strong>
          </div>
        </a>
        <button
          type="button"
          className="hamburger-button"
          aria-label="Toggle navigation menu"
          aria-expanded={isMenuOpen}
          onClick={() => setIsMenuOpen((current) => !current)}
        >
          <span />
          <span />
          <span />
        </button>
        <nav className={`app-nav__links ${isMenuOpen ? 'app-nav__links--open' : ''}`}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-link ${activePage === item.id ? 'nav-link--active' : ''}`}
              onClick={(event) => goToPage(item.id, event)}
              aria-current={activePage === item.id ? 'page' : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {activePage !== 'home' ? (
        <section className="top-band top-band--page">
          <img
            alt="Abstract vault with digital payment light trails"
            src="https://images.unsplash.com/photo-1639322537228-f710d846310a?auto=format&fit=crop&w=1200&q=80"
          />
          <div className="top-band__content">
            <p className="eyebrow">Payments</p>
            <h1>
              {activePage === 'seller' && 'Create and share a polished payment link for every deal.'}
              {activePage === 'buyer' && 'Open a listing link, review the order, and create escrow.'}
              {activePage === 'manage' && 'Approve, fund, release, refund, inspect live escrows, and review wallet activity.'}
              {activePage === 'faq' && 'Everything buyers and sellers need to understand ArcEscrow.'}
            </h1>
            <p className="lede">
              {activePage === 'seller' &&
                'Connect a seller wallet, define the item and price, then generate a shareable link that opens directly in the buyer flow.'}
              {activePage === 'buyer' &&
                'The buyer sees the seller address, arbiter, and amount prefilled, then creates an onchain escrow before approving and locking funds.'}
              {activePage === 'manage' &&
                'Track the contract state, approve USDC, lock funds, mark delivery, complete or dispute escrows, and review history from one workspace.'}
              {activePage === 'faq' &&
                'Learn how seller links, arbiters, buyer funding, escrow IDs, Arc Testnet, and USDC all fit together in the live app.'}
            </p>
          </div>
        </section>
      ) : null}

      <section className={`workspace workspace--${activePage}`}>
        <div className="workspace-topbar">
          <div className="workspace-topbar__spacer" />
          <div className="app-nav__meta workspace-topbar__meta">
            {activePage === 'home' ? (
              <div className="nav-chip">
                <span>Wallet Balance</span>
                <strong>{formatTokenAmount(walletBalance, tokenDecimals)} {tokenSymbol}</strong>
              </div>
            ) : null}
            {hasConnectedWallet && !isCorrectNetwork && chainId ? (
              <button type="button" className="button-secondary nav-switch-button" onClick={switchToArcTestnet} disabled={isBusy}>
                Switch to Arc
              </button>
            ) : null}
            <div className="nav-chip">
              <span>Network</span>
              <strong>{networkLabel}</strong>
              {activePage === 'home' ? <span>Chain ID {activeChainId || ARC_TESTNET.chainId}</span> : null}
            </div>
            <button
              type="button"
              className="button-secondary nav-theme-button"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              aria-label={themeButtonLabel}
              title={themeButtonLabel}
            >
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-theme-button__icon">
                  <path
                    d="M12 3.75a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V4.5a.75.75 0 0 1 .75-.75Zm0 12.75a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 3.75a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V21a.75.75 0 0 1 .75-.75ZM4.5 11.25a.75.75 0 0 1 0 1.5H3a.75.75 0 0 1 0-1.5h1.5Zm16.5 0a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5H21ZM6.47 5.41a.75.75 0 0 1 1.06 0l1.06 1.06a.75.75 0 0 1-1.06 1.06L6.47 6.47a.75.75 0 0 1 0-1.06Zm9.94 9.94a.75.75 0 0 1 1.06 0l1.06 1.06a.75.75 0 0 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06ZM18.59 5.41a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm-11.06 9.94a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Z"
                    fill="currentColor"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-theme-button__icon">
                  <path
                    d="M14.94 3.89a.75.75 0 0 1 .83.96 7.5 7.5 0 1 0 9.38 9.38.75.75 0 0 1 .96.83 9 9 0 1 1-11.17-11.17Z"
                    fill="currentColor"
                    transform="translate(-2 -2)"
                  />
                </svg>
              )}
            </button>
            <div className="wallet-menu">
              <button
                type="button"
                className={`wallet-button ${walletMode === 'circle' ? 'wallet-button--circle' : ''}`}
                onClick={hasConnectedWallet ? () => setIsWalletMenuOpen((current) => !current) : openWalletModal}
                disabled={isBusy}
                aria-expanded={hasConnectedWallet ? isWalletMenuOpen : undefined}
                aria-haspopup={hasConnectedWallet ? 'menu' : undefined}
              >
                {walletButtonLabel}
              </button>
              {hasConnectedWallet && isWalletMenuOpen ? (
                <div className="wallet-menu__panel" role="menu" aria-label="Wallet actions">
                  <div className="wallet-menu__meta">
                    <span>{walletMode === 'circle' ? 'Circle Wallet' : 'Browser Wallet'}</span>
                    <strong>{shortenAddress(activeWalletAddress)}</strong>
                  </div>
                  <button
                    type="button"
                    className="wallet-menu__action"
                    onClick={handleCopyWalletAddress}
                    role="menuitem"
                  >
                    {hasCopiedWalletAddress ? 'Address copied' : 'Copy address'}
                  </button>
                  <button
                    type="button"
                    className="wallet-menu__action"
                    onClick={() => {
                      setIsWalletMenuOpen(false)
                      if (walletMode === 'circle') {
                        void refreshCircleWalletSession()
                        setStatus('Refreshing Circle wallet details...')
                      } else {
                        connectWallet()
                      }
                    }}
                    role="menuitem"
                  >
                    {walletMode === 'circle' ? 'Refresh Circle wallet' : 'Refresh wallet'}
                  </button>
                  <button
                    type="button"
                    className="wallet-menu__action wallet-menu__action--danger"
                    onClick={disconnectWallet}
                    role="menuitem"
                  >
                    Disconnect
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {activePage === 'home' ? (
          <section className="home-overview">
            <section className="top-band top-band--dashboard home-hero">
              <img
                alt="Abstract vault with digital payment light trails"
                src="https://images.unsplash.com/photo-1639322537228-f710d846310a?auto=format&fit=crop&w=1200&q=80"
              />
              <div className="top-band__content">
                <p className="eyebrow">Payments</p>
                <h1>Secure payments. Trusted on Arc.</h1>
                <p className="lede">
                  ArcEscrow uses smart contracts and USDC on Arc Network to secure every deal.
                </p>
                <div className="hero-links">
                  <button type="button" onClick={() => goToPage('buyer')}>Create Escrow</button>
                  <button type="button" className="button-secondary" onClick={() => goToPage('seller')}>Explore Listings</button>
                </div>
              </div>
            </section>
          </section>
        ) : null}

        {activePage === 'home' ? (
          <div className="toolbar">
            <div>
              <p className="section-label">Overview</p>
              <h2>Choose a workflow below or jump into the next step.</h2>
            </div>
          </div>
        ) : null}

        <div className="page-grid">
          <button type="button" className="panel page-card" onClick={() => goToPage('seller')}>
            <p className="section-label">Seller</p>
            <h3>Create and share links</h3>
            <p>Build a buyer-ready payment link with title, description, and price.</p>
          </button>
          <button type="button" className="panel page-card" onClick={() => goToPage('buyer')}>
            <p className="section-label">Buyer</p>
            <h3>Create escrow</h3>
            <p>Open a seller link, review the deal, and create the escrow transaction.</p>
          </button>
          <button type="button" className="panel page-card" onClick={() => goToPage('manage')}>
            <p className="section-label">Manage</p>
            <h3>Run the lifecycle</h3>
            <p>Approve, fund, release, refund, and inspect escrows already created onchain.</p>
          </button>
          <button type="button" className="panel page-card" onClick={() => goToPage('faq')}>
            <p className="section-label">FAQ</p>
            <h3>Understand the flow</h3>
            <p>Read the practical explanation of how ArcEscrow works for both sides.</p>
          </button>
        </div>

        <div className="grid">
          <section className="panel panel--full page-section page-section--manage">
            <div className="panel__header">
              <div>
                <p className="section-label">Dashboard</p>
                <h3>My escrows</h3>
              </div>
              <span className="chip">{myEscrows.length} linked to this wallet</span>
            </div>
            <p className="hint">
              Connected wallet escrows appear here so you can reopen active trades without relying on memory alone.
            </p>
            <div className="dashboard-summary-grid">
              {dashboardSummary.map((card) => (
                <article key={card.id} className="dashboard-summary-card">
                  <span>{card.label}</span>
                  <strong>{card.value}</strong>
                  <p>{card.helper}</p>
                </article>
              ))}
            </div>
            <div className="dashboard-filter-row">
              {DASHBOARD_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={`dashboard-filter ${dashboardFilter === filter.id ? 'dashboard-filter--active' : ''}`}
                  onClick={() => setDashboardFilter(filter.id)}
                >
                  <span>{filter.label}</span>
                  <strong>{dashboardCounts[filter.id]}</strong>
                </button>
              ))}
            </div>
            {!hasConnectedWallet ? (
              <p className="hint">Connect a wallet to load your buyer and seller escrows.</p>
            ) : isDashboardLoading ? (
              <p className="hint">Loading wallet escrows from the contract...</p>
            ) : filteredMyEscrows.length ? (
              <div className="dashboard-list">
                {filteredMyEscrows.map((escrow) => (
                  <article key={escrow.id} className="dashboard-item">
                    <div className="dashboard-item__summary">
                      <div>
                        <p className="section-label">Escrow #{escrow.id}</p>
                        <h4>{formatTokenAmount(escrow.amount, tokenDecimals)} {tokenSymbol}</h4>
                      </div>
                      <span className={`status-pill status-pill--${escrow.state.toLowerCase()}`}>{escrow.state}</span>
                    </div>
                    <div className="dashboard-item__meta">
                      <div>
                        <span>Role</span>
                        <strong>{getEscrowRole(escrow, activeWalletAddress) || 'Viewer'}</strong>
                      </div>
                      <div>
                        <span>Buyer</span>
                        <strong>{shortenAddress(escrow.buyer)}</strong>
                      </div>
                      <div>
                        <span>Seller</span>
                        <strong>{shortenAddress(escrow.seller)}</strong>
                      </div>
                      <div>
                        <span>Arbiter</span>
                        <strong>{shortenAddress(escrow.arbiter)}</strong>
                      </div>
                      <div>
                        <span>Next step</span>
                        <strong>{getNextEscrowStep(escrow.state)}</strong>
                      </div>
                    </div>
                    <div className="dashboard-item__actions">
                      <button type="button" className="button-secondary" onClick={() => handleLoadDashboardEscrow(escrow)}>
                        Load into Manage
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => {
                          handleLoadDashboardEscrow(escrow)
                          setDashboardFilter('all')
                        }}
                      >
                        Prepare next step
                      </button>
                      <a href={getExplorerUrl(`/address/${contractAddress}`)} target="_blank" rel="noreferrer">
                        View contract
                      </a>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="hint">No escrows match this filter yet. Create one as a buyer or receive one as a seller to populate the dashboard.</p>
            )}

          </section>

          <form className="panel panel--wide page-section page-section--seller" onSubmit={handleGenerateListing}>
            <div className="panel__header">
              <div>
                <p className="section-label">Seller</p>
                <h3>Create a payment link</h3>
              </div>
              <span className="chip">Shareable</span>
            </div>
            <p className="hint">Seller connects a wallet, sets a price, and sends the buyer a link with the deal prefilled.</p>
            <label>
              <span>Seller wallet</span>
              <input value={activeWalletAddress} readOnly placeholder="Connect seller wallet" />
            </label>
            <label>
              <span>Title</span>
              <input
                value={listingForm.title}
                onChange={(event) =>
                  setListingForm((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="Gaming laptop"
              />
            </label>
            <label>
              <span>Description</span>
              <input
                value={listingForm.description}
                onChange={(event) =>
                  setListingForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="Lightly used, charger included"
              />
            </label>
            <label>
              <span>Arbiter wallet</span>
              <input
                value={listingForm.arbiter}
                onChange={(event) =>
                  setListingForm((current) => ({ ...current, arbiter: event.target.value.trim() }))
                }
                placeholder="0x..."
              />
            </label>
            <label>
              <span>Price ({tokenSymbol})</span>
              <input
                value={listingForm.amount}
                onChange={(event) =>
                  setListingForm((current) => ({ ...current, amount: event.target.value }))
                }
                inputMode="decimal"
                placeholder="5"
              />
            </label>
            <button type="submit" disabled={isBusy || !isCorrectNetwork}>
              Generate Buyer Link
            </button>
            {listingLink ? (
              <div className="listing-link-box">
                <span>Buyer link</span>
                <a href={listingLink}>{listingLink}</a>
                <div className="listing-link-actions">
                  <button type="button" className="button-secondary" onClick={handleReviewListing}>
                    Review Link
                  </button>
                  <button type="button" className="button-secondary" onClick={handleCopyListing}>
                    {copied ? 'Copied' : 'Copy Link'}
                  </button>
                </div>
              </div>
            ) : null}
            <div className="saved-listings">
              <div className="panel__header">
                <div>
                  <p className="section-label">Saved listings</p>
                  <h3>Persistent seller links</h3>
                </div>
                <span className="chip">{savedListings.length} saved</span>
              </div>
              {savedListings.length ? (
                <div className="saved-listings__list">
                  {savedListings.map((listing) => (
                    <article key={listing.id} className="saved-listing-card">
                      <div>
                        <h4>{listing.title || 'Untitled listing'}</h4>
                        <p>{listing.description || 'No description added yet.'}</p>
                      </div>
                      <div className="saved-listing-card__meta">
                        <span>{listing.amount} {tokenSymbol}</span>
                        <strong>{shortenAddress(listing.seller)}</strong>
                      </div>
                      <div className="saved-listing-card__actions">
                        <button type="button" className="button-secondary" onClick={() => handleLoadSavedListing(listing)}>
                          Load listing
                        </button>
                        <a href={buildPersistentListingLink(listing.id)} target="_blank" rel="noreferrer">
                          Open page
                        </a>
                        <button type="button" className="button-secondary" onClick={() => handleDeleteSavedListing(listing.id)}>
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="hint">Saved listings will stay here on this device, so you can reopen and share them later.</p>
              )}
            </div>
          </form>

          <form className="panel panel--wide page-section page-section--buyer" onSubmit={handleCreateEscrow}>
            <div className="panel__header">
              <div>
                <p className="section-label">Protocol</p>
                <h3>Contract target</h3>
              </div>
              <span className="chip">{tokenSymbol} settled</span>
            </div>
            <label>
              <span>Escrow manager address</span>
              <input
                value={contractAddress}
                onChange={(event) => setContractAddress(event.target.value.trim())}
                placeholder="0x..."
              />
            </label>
            <div className="meta-grid">
              <div>
                <span>Network</span>
                <strong>{ARC_TESTNET.chainName}</strong>
              </div>
              <div>
                <span>USDC token</span>
                <strong>{shortenAddress(usdcAddress)}</strong>
              </div>
              <div>
                <span>Your balance</span>
                <strong>{formatTokenAmount(walletBalance, tokenDecimals)} {tokenSymbol}</strong>
              </div>
              <div>
                <span>Allowance</span>
                <strong>{formatTokenAmount(allowance, tokenDecimals)} {tokenSymbol}</strong>
              </div>
            </div>
            <p className="hint">
              Add `VITE_ESCROW_CONTRACT_ADDRESS` in your environment if you want this prefilled for every run.
            </p>
            <p className="hint">
              <a href={getExplorerUrl(`/address/${contractAddress}`)} target="_blank" rel="noreferrer">
                View contract on ArcScan
              </a>
            </p>
            <p className="hint">
              <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">
                Need test funds? Open the Circle faucet
              </a>
            </p>
          </form>

          <form className="panel page-section page-section--buyer" onSubmit={handleCreateEscrow}>
            <div className="panel__header">
              <div>
                <p className="section-label">Buyer</p>
                <h3>Open link and create escrow</h3>
              </div>
            </div>
            <label>
              <span>Item</span>
              <input
                value={createForm.title}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="Listing title"
              />
            </label>
            <label>
              <span>Description</span>
              <input
                value={createForm.description}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="Listing description"
              />
            </label>
            <label>
              <span>Seller wallet</span>
              <input
                value={createForm.seller}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, seller: event.target.value.trim() }))
                }
                placeholder="0x..."
              />
            </label>
            <label>
              <span>Arbiter wallet</span>
              <input
                value={createForm.arbiter}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, arbiter: event.target.value.trim() }))
                }
                placeholder="0x..."
              />
            </label>
            <label>
              <span>Amount ({tokenSymbol})</span>
              <input
                value={createForm.amount}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, amount: event.target.value }))
                }
                inputMode="decimal"
                placeholder="250.00"
              />
            </label>
            {createFormError ? <p className="inline-error">{createFormError}</p> : null}
            {!createFormError && buyerStatusMessage ? <p className="inline-note">{buyerStatusMessage}</p> : null}
            <button type="submit" disabled={isBusy || !isCorrectNetwork || !canUseActiveWrites || Boolean(createFormError)}>
              {walletMode === 'circle' ? 'Create Escrow with Circle' : 'Create Escrow'}
            </button>
            {status ? <p className="inline-status">{status}</p> : null}
            {error ? <p className="inline-error">{error}</p> : null}
          </form>

          <form className="panel page-section page-section--manage" onSubmit={handleApprove}>
            <div className="panel__header">
              <div>
                <p className="section-label">Flow 2</p>
                <h3>Approve funds</h3>
              </div>
            </div>
            <label>
              <span>Escrow ID</span>
              <input
                value={approveForm.escrowId}
                onChange={(event) => setApproveForm({ escrowId: event.target.value })}
                inputMode="numeric"
                placeholder="0"
              />
            </label>
            <p className="hint">Reads the escrow amount from-chain and approves that exact amount for funding.</p>
            <button type="submit" disabled={isBusy || !isCorrectNetwork || !canUseActiveApprovals}>
              {isCorrectNetwork ? 'Approve USDC' : 'Switch Network First'}
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              void runEscrowAction({
                escrowId: fundForm.escrowId,
                browserWork: () => signerContract.fundEscrow(fundForm.escrowId),
                circleFunctionSignature: 'fundEscrow(uint256)',
                circleParameters: [fundForm.escrowId],
                pendingMessage: 'Open Circle to approve escrow funding...',
                successMessage: `Escrow #${fundForm.escrowId} funded successfully.`,
              })
            }}
          >
            <div className="panel__header">
              <div>
                <p className="section-label">Flow 3</p>
                <h3>Lock funds</h3>
              </div>
            </div>
            <label>
              <span>Escrow ID</span>
              <input
                value={fundForm.escrowId}
                onChange={(event) => setFundForm({ escrowId: event.target.value })}
                inputMode="numeric"
                placeholder="0"
              />
            </label>
            <button type="submit" disabled={isBusy || !canUseActiveWrites || !isCorrectNetwork}>
              Fund Escrow
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              void runEscrowAction({
                escrowId: deliveredForm.escrowId,
                browserWork: () => signerContract.markDelivered(deliveredForm.escrowId),
                circleFunctionSignature: 'markDelivered(uint256)',
                circleParameters: [deliveredForm.escrowId],
                pendingMessage: 'Open Circle to confirm delivery status...',
                successMessage: `Escrow #${deliveredForm.escrowId} marked as delivered.`,
              })
            }}
          >
            <div className="panel__header">
              <div>
                <p className="section-label">Flow 4</p>
                <h3>Mark delivered</h3>
              </div>
            </div>
            <label>
              <span>Escrow ID</span>
              <input
                value={deliveredForm.escrowId}
                onChange={(event) => setDeliveredForm({ escrowId: event.target.value })}
                inputMode="numeric"
                placeholder="0"
              />
            </label>
            <button type="submit" disabled={isBusy || !canUseActiveWrites || !isCorrectNetwork}>
              Mark Delivered
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              void runEscrowAction({
                escrowId: releaseForm.escrowId,
                browserWork: () => signerContract.releaseFunds(releaseForm.escrowId),
                circleFunctionSignature: 'releaseFunds(uint256)',
                circleParameters: [releaseForm.escrowId],
                pendingMessage: 'Open Circle to release funds to the seller...',
                successMessage: `Escrow #${releaseForm.escrowId} released to seller.`,
              })
            }}
          >
            <div className="panel__header">
              <div>
                <p className="section-label">Flow 5</p>
                <h3>Send to seller</h3>
              </div>
            </div>
            <label>
              <span>Escrow ID</span>
              <input
                value={releaseForm.escrowId}
                onChange={(event) => setReleaseForm({ escrowId: event.target.value })}
                inputMode="numeric"
                placeholder="0"
              />
            </label>
            <button type="submit" disabled={isBusy || !canUseActiveWrites || !isCorrectNetwork}>
              Release Funds
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              void runEscrowAction({
                escrowId: refundForm.escrowId,
                browserWork: () => signerContract.refundBuyer(refundForm.escrowId),
                circleFunctionSignature: 'refundBuyer(uint256)',
                circleParameters: [refundForm.escrowId],
                pendingMessage: 'Open Circle to refund the buyer...',
                successMessage: `Escrow #${refundForm.escrowId} refunded to buyer.`,
              })
            }}
          >
            <div className="panel__header">
              <div>
                <p className="section-label">Flow 6</p>
                <h3>Return to buyer</h3>
              </div>
            </div>
            <label>
              <span>Escrow ID</span>
              <input
                value={refundForm.escrowId}
                onChange={(event) => setRefundForm({ escrowId: event.target.value })}
                inputMode="numeric"
                placeholder="0"
              />
            </label>
            <button type="submit" disabled={isBusy || !canUseActiveWrites || !isCorrectNetwork}>
              Refund Buyer
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              void runEscrowAction({
                escrowId: disputeForm.escrowId,
                browserWork: () => signerContract.openDispute(disputeForm.escrowId),
                circleFunctionSignature: 'openDispute(uint256)',
                circleParameters: [disputeForm.escrowId],
                pendingMessage: 'Open Circle to raise the dispute...',
                successMessage: `Dispute opened for escrow #${disputeForm.escrowId}.`,
              })
            }}
          >
            <div className="panel__header">
              <div>
                <p className="section-label">Flow 7</p>
                <h3>Open dispute</h3>
              </div>
            </div>
            <label>
              <span>Escrow ID</span>
              <input
                value={disputeForm.escrowId}
                onChange={(event) => setDisputeForm({ escrowId: event.target.value })}
                inputMode="numeric"
                placeholder="0"
              />
            </label>
            <button type="submit" disabled={isBusy || !canUseActiveWrites || !isCorrectNetwork}>
              Open Dispute
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              void runEscrowAction({
                escrowId: resolveForm.escrowId,
                browserWork: () => signerContract.resolveDispute(resolveForm.escrowId, resolveForm.releaseToSeller === 'seller'),
                circleFunctionSignature: 'resolveDispute(uint256,bool)',
                circleParameters: [resolveForm.escrowId, resolveForm.releaseToSeller === 'seller'],
                pendingMessage: 'Open Circle to resolve the dispute...',
                successMessage: `Dispute resolved for escrow #${resolveForm.escrowId}.`,
              })
            }}
          >
            <div className="panel__header">
              <div>
                <p className="section-label">Arbiter</p>
                <h3>Resolve dispute</h3>
              </div>
            </div>
            <label>
              <span>Escrow ID</span>
              <input
                value={resolveForm.escrowId}
                onChange={(event) => setResolveForm((current) => ({ ...current, escrowId: event.target.value }))}
                inputMode="numeric"
                placeholder="0"
              />
            </label>
            <label>
              <span>Send disputed funds to</span>
              <select
                value={resolveForm.releaseToSeller}
                onChange={(event) => setResolveForm((current) => ({ ...current, releaseToSeller: event.target.value }))}
              >
                <option value="seller">Seller</option>
                <option value="buyer">Buyer</option>
              </select>
            </label>
            <button type="submit" disabled={isBusy || !canUseActiveWrites || !isCorrectNetwork}>
              Resolve Dispute
            </button>
          </form>

          <form className="panel page-section page-section--manage" onSubmit={handleLookup}>
            <div className="panel__header">
              <div>
                <p className="section-label">Inspect</p>
                <h3>Lookup escrow</h3>
              </div>
            </div>
            <label>
              <span>Escrow ID</span>
              <input
                value={lookupId}
                onChange={(event) => setLookupId(event.target.value)}
                inputMode="numeric"
                placeholder="0"
              />
            </label>
            <button type="submit" disabled={isBusy || !escrowContract}>
              Load Escrow
            </button>
          </form>
        </div>

        <div className="bottom-grid page-section page-section--manage">
          <section className="panel panel--status">
            <div className="panel__header">
              <div>
                <p className="section-label">Session</p>
                <h3>Live contract status</h3>
              </div>
            </div>
            <p className="status-line">{status}</p>
            {error ? <p className="error-line">{error}</p> : null}
            <div className="status-summary">
              <div>
                <span>Contract</span>
                <strong>{contractAddress ? shortenAddress(contractAddress) : 'Set contract'}</strong>
              </div>
              <div>
                <span>Explorer</span>
                <strong>
                  <a href={ARC_TESTNET.blockExplorerUrl} target="_blank" rel="noreferrer">
                    ArcScan
                  </a>
                </strong>
              </div>
              <div>
                <span>Busy</span>
                <strong>{isBusy ? 'Pending' : 'Idle'}</strong>
              </div>
            </div>
          </section>

          <section className="panel panel--status">
            <div className="panel__header">
              <div>
                <p className="section-label">Escrow Detail</p>
                <h3>Selected record</h3>
              </div>
            </div>
            {escrowRecord ? (
              <div className="record-grid">
                <div>
                  <span>ID</span>
                  <strong>#{escrowRecord.id}</strong>
                </div>
                <div>
                  <span>State</span>
                  <strong>{escrowRecord.state}</strong>
                </div>
                <div>
                  <span>Buyer</span>
                  <strong>
                    <a href={getExplorerUrl(`/address/${escrowRecord.buyer}`)} target="_blank" rel="noreferrer">
                      {shortenAddress(escrowRecord.buyer)}
                    </a>
                  </strong>
                </div>
                <div>
                  <span>Seller</span>
                  <strong>
                    <a href={getExplorerUrl(`/address/${escrowRecord.seller}`)} target="_blank" rel="noreferrer">
                      {shortenAddress(escrowRecord.seller)}
                    </a>
                  </strong>
                </div>
                <div>
                  <span>Arbiter</span>
                  <strong>
                    <a href={getExplorerUrl(`/address/${escrowRecord.arbiter}`)} target="_blank" rel="noreferrer">
                      {shortenAddress(escrowRecord.arbiter)}
                    </a>
                  </strong>
                </div>
                <div>
                  <span>Amount</span>
                  <strong>{formatTokenAmount(escrowRecord.amount, tokenDecimals)} {tokenSymbol}</strong>
                </div>
              </div>
            ) : (
              <p className="hint">Load an escrow ID to inspect buyer, seller, amount, and state.</p>
            )}
          </section>
        </div>

        <section className="faq-section page-section page-section--faq">
          <div className="faq-section__intro">
            <p className="section-label">FAQ</p>
            <h2>How ArcEscrow works</h2>
          </div>
          <div className="faq-grid">
            <article className="panel faq-item">
              <h3>How does a seller use the app?</h3>
              <p>
                The seller connects a wallet, fills in the item title, description, and price, then
                generates a buyer link. That link carries the seller address and listing details so
                the buyer lands on a ready-to-use order page.
              </p>
            </article>
            <article className="panel faq-item">
              <h3>How does a buyer pay safely?</h3>
              <p>
                The buyer opens the seller link, reviews the order, and creates an escrow on Arc
                Network. After that, the buyer approves USDC and funds the escrow contract instead
                of sending funds directly to the seller.
              </p>
            </article>
            <article className="panel faq-item">
              <h3>What do approve, fund, release, and refund mean?</h3>
              <p>
                Approve gives the escrow contract permission to move the exact USDC amount. Fund
                locks the buyer&apos;s funds in the contract. Release sends the locked funds to the
                seller. Refund returns the locked funds to the buyer.
              </p>
            </article>
            <article className="panel faq-item">
              <h3>Why do I need the escrow ID?</h3>
              <p>
                Every escrow created onchain gets its own ID. The app uses that ID to load the
                escrow record and to run the next steps like approval, funding, release, refund, and
                inspection.
              </p>
            </article>
            <article className="panel faq-item">
              <h3>Who controls the escrow right now?</h3>
              <p>
                In the currently connected contract flow, the buyer creates the escrow, funds it,
                and can release or refund it. The seller prepares the listing link, but the escrow
                lifecycle itself is still buyer-controlled in this live version.
              </p>
            </article>
            <article className="panel faq-item">
              <h3>What network and token does ArcEscrow use?</h3>
              <p>
                This app is configured for Arc Testnet and settles with USDC. Users should connect
                an EVM wallet, switch to Arc Testnet, and make sure they hold enough test USDC to
                create and fund escrows.
              </p>
            </article>
            <article className="panel faq-item">
              <h3>Where do I get test USDC?</h3>
              <p>
                Use the Circle faucet at{' '}
                <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">
                  faucet.circle.com
                </a>{' '}
                to request test funds before creating or funding an escrow on Arc Testnet.
              </p>
            </article>
          </div>
        </section>

        <footer className="app-footer">
          <p>Developed by Vickman</p>
          <a
            className="social-link"
            href="https://x.com/stratton001"
            target="_blank"
            rel="noreferrer"
            aria-label="Vickman on X"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M18.901 2H21.98l-6.726 7.687L23.167 22h-6.194l-4.85-7.491L5.568 22H2.487l7.194-8.223L.833 2h6.351l4.384 6.919L18.901 2Zm-1.082 18.136h1.706L6.257 3.768H4.426L17.819 20.136Z"
                fill="currentColor"
              />
            </svg>
          </a>
        </footer>

        {isWalletModalOpen ? (
          <div className="wallet-modal" role="dialog" aria-modal="true" aria-label="Choose a wallet">
            <button
              type="button"
              className="wallet-modal__backdrop"
              aria-label="Close wallet modal"
              onClick={() => setIsWalletModalOpen(false)}
            />
            <section className="wallet-modal__panel">
              <button
                type="button"
                className="wallet-modal__close"
                aria-label="Close wallet modal"
                title="Close"
                onClick={() => setIsWalletModalOpen(false)}
              >
                <span aria-hidden="true">×</span>
              </button>

              <form className="wallet-modal__circle-card" onSubmit={handleCircleOtpSubmit}>
                <div className="wallet-modal__circle-head">
                  <div className="wallet-modal__circle-brand">
                    <span className="wallet-modal__circle-icon" aria-hidden="true">
                      <img src="/circle-wallet-logo.png" alt="" />
                    </span>
                    <div>
                      <strong>Circle Wallet</strong>
                      <span>Email + OTP · No seed phrase needed</span>
                    </div>
                  </div>
                  <span className="wallet-modal__recommended">Recommended</span>
                </div>

                <div className="wallet-modal__circle-entry">
                  <input
                    type="email"
                    value={circleEmail}
                    onChange={(event) => setCircleEmail(event.target.value)}
                    placeholder="you@email.com"
                    disabled={isBusy || circleFlowStep === 'verifying' || circleFlowStep === 'creating-wallet'}
                  />
                  <button type="submit" disabled={isBusy || !isCircleConfigured || circleFlowStep === 'otp-sent' || circleFlowStep === 'verifying'}>
                    Send Code
                  </button>
                </div>

                <div className="wallet-modal__circle-actions">
                  <button
                    type="button"
                    className="wallet-modal__circle-verify"
                    onClick={handleCircleVerifyOtp}
                    disabled={isBusy || Boolean(circlePrimaryWallet) || !canOpenCircleVerifier}
                    title={canOpenCircleVerifier ? 'Open Circle verification' : 'Request a code first'}
                  >
                    {circleFlowStep === 'verifying' ? 'Waiting for Circle...' : 'Verify Code'}
                  </button>
                  <button
                    type="button"
                    className="button-secondary wallet-modal__circle-resend"
                    onClick={(event) => {
                      void handleCircleOtpSubmit(event, true)
                    }}
                    disabled={isBusy || Boolean(circlePrimaryWallet) || !isCircleConfigured || !circleEmail.trim()}
                  >
                    Resend Code
                  </button>
                </div>

                {circlePendingChallengeId && circleSession && !circlePrimaryWallet ? (
                  <div className="wallet-modal__circle-actions">
                    <button
                      type="button"
                      className="wallet-modal__circle-verify"
                      onClick={handleCircleFinishWalletSetup}
                      disabled={isBusy}
                    >
                      {circleFlowStep === 'creating-wallet' && isBusy ? 'Opening Circle...' : 'Finish Wallet Setup'}
                    </button>
                  </div>
                ) : null}

                {circlePrimaryWallet ? (
                  <div className="wallet-modal__circle-wallet">
                    <div>
                      <span>Arc wallet</span>
                      <strong>{shortenAddress(circlePrimaryWallet.address)}</strong>
                    </div>
                    <div>
                      <span>USDC balance</span>
                      <strong>{circleWalletBalanceLabel || 'Available after Circle sync'}</strong>
                    </div>
                  </div>
                ) : null}

                <p className="wallet-modal__circle-note">
                  {circleMessage || (
                    isCircleConfigured
                      ? 'Request a code, check your email inbox, then tap Verify Code to enter it in Circle’s secure window.'
                      : 'Add VITE_CIRCLE_APP_ID and CIRCLE_API_KEY to activate the real Circle flow.'
                  )}
                </p>
              </form>

              <div className="wallet-modal__divider">
                <span>Or use EVM wallet</span>
              </div>

              <div className="wallet-modal__options">
                {WALLET_CONNECT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="wallet-option"
                    onClick={() => handleWalletOption(option.action)}
                  >
                    <div className="wallet-option__icon" aria-hidden="true">
                      {renderWalletOptionIcon(option.icon)}
                    </div>
                    <div className="wallet-option__copy">
                      <strong>{option.label}</strong>
                      <span>{option.helper}</span>
                    </div>
                    <span className="wallet-option__arrow" aria-hidden="true">&rarr;</span>
                  </button>
                ))}
              </div>

              <p className="wallet-modal__footnote">
                Connects to Arc Testnet · USDC settlement · Circle email login and browser wallets both work in this build
              </p>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  )
}

export default App


