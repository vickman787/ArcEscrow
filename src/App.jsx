import { useEffect, useMemo, useState } from 'react'
import './App.css'

import { ethers } from 'ethers'

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
  const [theme, setTheme] = useState(getInitialTheme)
  const hasConnectedWallet = Boolean(walletAddress)
  const isCorrectNetwork = chainId === ARC_TESTNET.chainId.toString()
  const walletButtonLabel = walletAddress ? shortenAddress(walletAddress) : 'Connect Wallet'
  const themeButtonLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  const networkLabel = hasConnectedWallet
    ? isCorrectNetwork
      ? ARC_TESTNET.chainName
      : chainId
        ? `Wrong network (${chainId})`
        : 'Wallet disconnected'
    : 'Wallet disconnected'
  const createFormError = getCreateFormError({
    seller: createForm.seller,
    arbiter: createForm.arbiter,
    amount: createForm.amount,
    walletAddress,
    tokenDecimals,
  })
  const dashboardCounts = useMemo(() => ({
    all: myEscrows.length,
    buyer: myEscrows.filter((escrow) => getEscrowRole(escrow, walletAddress).includes('Buyer')).length,
    seller: myEscrows.filter((escrow) => getEscrowRole(escrow, walletAddress).includes('Seller')).length,
    active: myEscrows.filter((escrow) => isActiveEscrowState(escrow.state)).length,
    completed: myEscrows.filter((escrow) => !isActiveEscrowState(escrow.state)).length,
  }), [myEscrows, walletAddress])
  const filteredMyEscrows = useMemo(() => {
    switch (dashboardFilter) {
      case 'buyer':
        return myEscrows.filter((escrow) => getEscrowRole(escrow, walletAddress).includes('Buyer'))
      case 'seller':
        return myEscrows.filter((escrow) => getEscrowRole(escrow, walletAddress).includes('Seller'))
      case 'active':
        return myEscrows.filter((escrow) => isActiveEscrowState(escrow.state))
      case 'completed':
        return myEscrows.filter((escrow) => !isActiveEscrowState(escrow.state))
      default:
        return myEscrows
    }
  }, [dashboardFilter, myEscrows, walletAddress])
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
    if (!provider || !contractAddress || !ethers.isAddress(contractAddress)) {
      return null
    }

    return new ethers.Contract(contractAddress, ESCROW_MANAGER_ABI, provider)
  }, [provider, contractAddress])

  const signerContract = useMemo(() => {
    if (!signer || !contractAddress || !ethers.isAddress(contractAddress)) {
      return null
    }

    return new ethers.Contract(contractAddress, ESCROW_MANAGER_ABI, signer)
  }, [signer, contractAddress])

  const usdcContract = useMemo(() => {
    if (!provider || !usdcAddress || !ethers.isAddress(usdcAddress)) {
      return null
    }

    return new ethers.Contract(usdcAddress, ERC20_ABI, provider)
  }, [provider, usdcAddress])

  const signerUsdcContract = useMemo(() => {
    if (!signer || !usdcAddress || !ethers.isAddress(usdcAddress)) {
      return null
    }

    return new ethers.Contract(usdcAddress, ERC20_ABI, signer)
  }, [signer, usdcAddress])

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
        const nextSigner = await browserProvider.getSigner()
        setSigner(nextSigner)
      } else {
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

    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    window.localStorage.setItem('arc-escrow-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!walletAddress) {
      setIsWalletMenuOpen(false)
    }
  }, [walletAddress])

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
      if (!walletAddress || !usdcContract || !contractAddress || !ethers.isAddress(contractAddress)) {
        setWalletBalance(null)
        setAllowance(null)
        return
      }

      try {
        const [nextBalance, nextAllowance] = await Promise.all([
          usdcContract.balanceOf(walletAddress),
          usdcContract.allowance(walletAddress, contractAddress),
        ])

        setWalletBalance(nextBalance)
        setAllowance(nextAllowance)
      } catch (walletError) {
        setError(walletError.shortMessage || walletError.message)
      }
    }

    loadWalletData()
  }, [walletAddress, usdcContract, contractAddress, isBusy])

  useEffect(() => {
    if (!walletAddress || !escrowContract || (activePage !== 'manage' && activePage !== 'home')) {
      if (!walletAddress) {
        setMyEscrows([])
      }

      return
    }

    loadMyEscrows()
  }, [walletAddress, escrowContract, activePage])

  useEffect(() => {
    if (!walletAddress || !escrowContract || !provider || (activePage !== 'transactions' && activePage !== 'manage' && activePage !== 'home')) {
      if (!walletAddress) {
        setTransactionHistory([])
      }

      return
    }

    loadTransactionHistory()
  }, [walletAddress, escrowContract, provider, activePage])

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
    if (!escrowContract || !walletAddress) {
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
      const normalizedWallet = walletAddress.toLowerCase()
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
    if (!escrowContract || !provider || !walletAddress || !usdcContract) {
      setTransactionHistory([])
      return
    }

    try {
      setIsHistoryLoading(true)
      const normalizedWallet = walletAddress.toLowerCase()
      const [approvalEvents, createdEvents, fundedEvents, deliveredEvents, releasedEvents, refundedEvents, disputeOpenedEvents, disputeResolvedEvents] = await Promise.all([
        usdcContract.queryFilter(usdcContract.filters.Approval(walletAddress, contractAddress)),
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
        uniqueBlockNumbers.map(async (blockNumber) => [blockNumber, await provider.getBlock(blockNumber)]),
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

  const withTransaction = async (work, successMessage) => {
    try {
      setIsBusy(true)
      setError('')
      const tx = await work()
      setStatus(`Transaction sent: ${tx.hash}`)
      await tx.wait()
      setStatus(successMessage)
      try {
        if (lookupId) {
          await refreshEscrow(lookupId)
        }

        if (escrowContract) {
          setContractBalance(await escrowContract.contractUsdcBalance())
        }

        if (walletAddress) {
          await loadMyEscrows()
          await loadTransactionHistory()
        }
      } catch (refreshError) {
        setStatus(`${successMessage} Live data refresh is delayed.`)
        setError('')
        console.warn('Post-transaction refresh failed:', refreshError)
      }
    } catch (txError) {
      setError(getDisplayError(txError))
    } finally {
      setIsBusy(false)
    }
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
    setSigner(null)
    setWalletAddress('')
    setChainId('')
    setWalletBalance(null)
    setAllowance(null)
    setIsWalletMenuOpen(false)
    setError('')
    setStatus('Wallet disconnected from ArcEscrow. Connect again whenever you are ready.')
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

    if (!walletAddress) {
      setError('Connect the seller wallet before generating a buyer link.')
      return
    }

    if (!ethers.isAddress(walletAddress)) {
      setError('Connected wallet is not a valid seller address.')
      return
    }

    const amountError = getCreateFormError({
      seller: walletAddress,
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
      seller: walletAddress,
      arbiter: listingForm.arbiter.trim(),
      amount: listingForm.amount,
      title: listingForm.title.trim(),
      description: listingForm.description.trim(),
    }
    const listingId = crypto.randomUUID()
    const nextListing = {
      id: listingId,
      seller: walletAddress,
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

    if (!signerContract) {
      setError('Add your deployed contract address and connect a wallet first.')
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
      const tx = await signerContract.createEscrow(createForm.seller, createForm.arbiter, amount)
      setStatus(`Creating escrow... ${tx.hash}`)
      const receipt = await tx.wait()

      const log = receipt.logs
        .map((entry) => {
          try {
            return signerContract.interface.parseLog(entry)
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
        if (escrowId) {
          await refreshEscrow(escrowId)
        }
        setContractBalance(await escrowContract.contractUsdcBalance())
        await loadMyEscrows()
        await loadTransactionHistory()
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

    if (!signerUsdcContract || !contractAddress) {
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
      const record = await signerContract.getEscrow(targetId)
      const tx = await signerUsdcContract.approve(contractAddress, record.amount)
      setStatus(`Approval sent: ${tx.hash}`)
      await tx.wait()
      setStatus(`Allowance updated for escrow #${targetId}.`)
      try {
        await refreshEscrow(targetId)
        setAllowance(await usdcContract.allowance(walletAddress, contractAddress))
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
    <main className="app-shell">
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
              {activePage === 'home' ? <span>Chain ID {chainId || ARC_TESTNET.chainId}</span> : null}
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
                className="wallet-button"
                onClick={walletAddress ? () => setIsWalletMenuOpen((current) => !current) : connectWallet}
                disabled={isBusy}
                aria-expanded={walletAddress ? isWalletMenuOpen : undefined}
                aria-haspopup={walletAddress ? 'menu' : undefined}
              >
                {walletButtonLabel}
              </button>
              {walletAddress && isWalletMenuOpen ? (
                <div className="wallet-menu__panel" role="menu" aria-label="Wallet actions">
                  <button
                    type="button"
                    className="wallet-menu__action"
                    onClick={() => {
                      setIsWalletMenuOpen(false)
                      connectWallet()
                    }}
                    role="menuitem"
                  >
                    Refresh wallet
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
                        <strong>{getEscrowRole(escrow, walletAddress) || 'Viewer'}</strong>
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

            <div className="panel__header manage-history-header">
              <div>
                <p className="section-label">Transactions</p>
                <h3>Wallet activity</h3>
              </div>
              <span className="chip">{transactionHistory.length} events loaded</span>
            </div>
            <p className="hint">
              This history is built from your escrow contract events, filtered down to escrows connected to the wallet you have open.
            </p>
            {!hasConnectedWallet ? (
              <p className="hint">Connect a wallet to load escrow-related activity.</p>
            ) : isHistoryLoading ? (
              <p className="hint">Loading transaction history from Arc Testnet...</p>
            ) : transactionHistory.length ? (
              <div className="transaction-table-wrap">
                <table className="transaction-table transaction-table--compact">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Escrow</th>
                      <th>Amount</th>
                      <th>State</th>
                      <th>When</th>
                      <th>Tx Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactionHistory.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.action}</td>
                        <td>#{entry.escrowId}</td>
                        <td>{formatTokenAmount(entry.amount, tokenDecimals)} {tokenSymbol}</td>
                        <td>
                          <span className={`status-pill status-pill--${entry.state.toLowerCase()}`}>{entry.state}</span>
                        </td>
                        <td>{formatTimestamp(entry.timestamp)}</td>
                        <td>
                          <a href={getExplorerUrl(`/tx/${entry.txHash}`)} target="_blank" rel="noreferrer">
                            {shortenAddress(entry.txHash)}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="hint">No contract events are tied to this wallet yet. Create or manage an escrow to start building history.</p>
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
              <input value={walletAddress} readOnly placeholder="Connect seller wallet" />
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
            <button type="submit" disabled={isBusy || !isCorrectNetwork || Boolean(createFormError)}>
              Create Escrow
            </button>
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
            <button type="submit" disabled={isBusy || !isCorrectNetwork}>
              {isCorrectNetwork ? 'Approve USDC' : 'Switch Network First'}
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              withTransaction(
                () => signerContract.fundEscrow(fundForm.escrowId),
                `Escrow #${fundForm.escrowId} funded successfully.`,
              )
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
            <button type="submit" disabled={isBusy || !signerContract || !isCorrectNetwork}>
              Fund Escrow
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              withTransaction(
                () => signerContract.markDelivered(deliveredForm.escrowId),
                `Escrow #${deliveredForm.escrowId} marked as delivered.`,
              )
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
            <button type="submit" disabled={isBusy || !signerContract || !isCorrectNetwork}>
              Mark Delivered
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              withTransaction(
                () => signerContract.releaseFunds(releaseForm.escrowId),
                `Escrow #${releaseForm.escrowId} released to seller.`,
              )
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
            <button type="submit" disabled={isBusy || !signerContract || !isCorrectNetwork}>
              Release Funds
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              withTransaction(
                () => signerContract.refundBuyer(refundForm.escrowId),
                `Escrow #${refundForm.escrowId} refunded to buyer.`,
              )
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
            <button type="submit" disabled={isBusy || !signerContract || !isCorrectNetwork}>
              Refund Buyer
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              withTransaction(
                () => signerContract.openDispute(disputeForm.escrowId),
                `Dispute opened for escrow #${disputeForm.escrowId}.`,
              )
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
            <button type="submit" disabled={isBusy || !signerContract || !isCorrectNetwork}>
              Open Dispute
            </button>
          </form>

          <form
            className="panel page-section page-section--manage"
            onSubmit={(event) => {
              event.preventDefault()
              withTransaction(
                () => signerContract.resolveDispute(resolveForm.escrowId, resolveForm.releaseToSeller === 'seller'),
                `Dispute resolved for escrow #${resolveForm.escrowId}.`,
              )
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
            <button type="submit" disabled={isBusy || !signerContract || !isCorrectNetwork}>
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
      </section>
    </main>
  )
}

export default App
