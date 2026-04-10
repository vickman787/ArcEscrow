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
  'function USDC() view returns (address)',
  'function nextEscrowId() view returns (uint256)',
  'function contractUsdcBalance() view returns (uint256)',
  'function createEscrow(address seller, uint256 amount) returns (uint256)',
  'function fundEscrow(uint256 escrowId)',
  'function releaseFunds(uint256 escrowId)',
  'function refundBuyer(uint256 escrowId)',
  'function getEscrow(uint256 escrowId) view returns (uint256 id, address buyer, address seller, uint256 amount, uint8 state)',
  'event EscrowCreated(uint256 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

const escrowStates = ['Created', 'Funded', 'Released', 'Refunded']

const initialCreateForm = {
  seller: '',
  amount: '',
  title: '',
  description: '',
}

const initialListingForm = {
  title: '',
  description: '',
  amount: '',
}

const initialActionForm = {
  escrowId: '',
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

function getCreateFormError({ seller, amount, walletAddress, tokenDecimals }) {
  if (!seller) {
    return 'Enter the seller wallet address.'
  }

  if (!ethers.isAddress(seller)) {
    return 'Seller wallet must be a full valid EVM address.'
  }

  if (walletAddress && seller.toLowerCase() === walletAddress.toLowerCase()) {
    return 'Buyer and seller cannot be the same wallet.'
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

function buildListingLink({ seller, amount, title, description }) {
  if (typeof window === 'undefined' || !seller || !amount) {
    return ''
  }

  const baseUrl = APP_BASE_URL || `${window.location.origin}${window.location.pathname}`
  const url = new URL(baseUrl)
  url.searchParams.set('seller', seller)
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

function App() {
  const [provider, setProvider] = useState(null)
  const [signer, setSigner] = useState(null)
  const [walletAddress, setWalletAddress] = useState('')
  const [chainId, setChainId] = useState('')
  const [contractAddress, setContractAddress] = useState(DEFAULT_CONTRACT_ADDRESS)
  const [listingForm, setListingForm] = useState(initialListingForm)
  const [createForm, setCreateForm] = useState(initialCreateForm)
  const [listingLink, setListingLink] = useState('')
  const [approveForm, setApproveForm] = useState(initialActionForm)
  const [fundForm, setFundForm] = useState(initialActionForm)
  const [releaseForm, setReleaseForm] = useState(initialActionForm)
  const [refundForm, setRefundForm] = useState(initialActionForm)
  const [lookupId, setLookupId] = useState('')
  const [escrowRecord, setEscrowRecord] = useState(null)
  const [contractBalance, setContractBalance] = useState(null)
  const [usdcAddress, setUsdcAddress] = useState('0x3600000000000000000000000000000000000000')
  const [tokenSymbol, setTokenSymbol] = useState('USDC')
  const [tokenDecimals, setTokenDecimals] = useState(6)
  const [walletBalance, setWalletBalance] = useState(null)
  const [allowance, setAllowance] = useState(null)
  const [status, setStatus] = useState('Connect a wallet on Arc Network to start using your escrow contract.')
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const isCorrectNetwork = chainId === ARC_TESTNET.chainId.toString()
  const walletButtonLabel = walletAddress ? shortenAddress(walletAddress) : 'Connect Wallet'
  const networkLabel = isCorrectNetwork
    ? ARC_TESTNET.chainName
    : chainId
      ? `Wrong network (${chainId})`
      : 'Wallet disconnected'
  const createFormError = getCreateFormError({
    seller: createForm.seller,
    amount: createForm.amount,
    walletAddress,
    tokenDecimals,
  })

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

    const storedAddress = window.localStorage.getItem('arc-escrow-contract-address')

    if (storedAddress && !DEFAULT_CONTRACT_ADDRESS) {
      setContractAddress(storedAddress)
    }

    const params = new URLSearchParams(window.location.search)
    const seller = params.get('seller') || ''
    const amount = params.get('amount') || ''
    const title = params.get('title') || ''
    const description = params.get('description') || ''

    if (seller || amount || title || description) {
      setCreateForm({
        seller,
        amount,
        title,
        description,
      })
      setStatus('Seller listing loaded. Buyer can now create the escrow.')
    }
  }, [])

  useEffect(() => {
    const loadContracts = async () => {
      if (!escrowContract) {
        setContractBalance(null)
        return
      }

      try {
        const [nextUsdcAddress, nextBalance] = await Promise.all([
          escrowContract.USDC(),
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

  const refreshEscrow = async (escrowId) => {
    if (!escrowContract) {
      return
    }

    const record = await escrowContract.getEscrow(escrowId)
    const nextRecord = {
      id: record.id.toString(),
      buyer: record.buyer,
      seller: record.seller,
      amount: record.amount,
      state: escrowStates[Number(record.state)] || 'Unknown',
    }

    setEscrowRecord(nextRecord)
  }

  const withTransaction = async (work, successMessage) => {
    try {
      setIsBusy(true)
      setError('')
      const tx = await work()
      setStatus(`Transaction sent: ${tx.hash}`)
      await tx.wait()
      setStatus(successMessage)

      if (lookupId) {
        await refreshEscrow(lookupId)
      }

      if (escrowContract) {
        setContractBalance(await escrowContract.contractUsdcBalance())
      }
    } catch (txError) {
      setError(txError.shortMessage || txError.message)
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
      amount: listingForm.amount,
      title: listingForm.title.trim(),
      description: listingForm.description.trim(),
    }

    setCreateForm(nextCreateForm)
    setListingLink(buildListingLink(nextCreateForm))
    setCopied(false)
    setError('')
    setStatus('Seller listing link generated. Share it with the buyer.')
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
      const tx = await signerContract.createEscrow(createForm.seller, amount)
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
        setLookupId(escrowId)
        await refreshEscrow(escrowId)
        setApproveForm({ escrowId })
        setFundForm({ escrowId })
        setReleaseForm({ escrowId })
        setRefundForm({ escrowId })
        setStatus(`Escrow #${escrowId} created successfully.`)
      } else {
        setStatus('Escrow created successfully.')
      }

      setCreateForm(initialCreateForm)
      setContractBalance(await escrowContract.contractUsdcBalance())
    } catch (createError) {
      setError(createError.shortMessage || createError.message)
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
      await refreshEscrow(targetId)
      setAllowance(await usdcContract.allowance(walletAddress, contractAddress))
    } catch (approveError) {
      setError(approveError.shortMessage || approveError.message)
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
      setApproveForm({ escrowId: lookupId })
      setFundForm({ escrowId: lookupId })
      setReleaseForm({ escrowId: lookupId })
      setRefundForm({ escrowId: lookupId })
      setStatus(`Loaded escrow #${lookupId}.`)
    } catch (lookupError) {
      setError(lookupError.shortMessage || lookupError.message)
    }
  }

  return (
    <main className="app-shell">
      <header className="app-nav">
        <div className="app-nav__brand">
          <img className="brand-logo" src="/logo-arc-1.svg" alt="ArcEscrow logo" />
          <div>
            <p className="eyebrow">ArcEscrow</p>
            <strong>Arc Network escrow</strong>
          </div>
        </div>
        <div className="app-nav__meta">
          {!isCorrectNetwork && chainId ? (
            <button type="button" className="button-secondary nav-switch-button" onClick={switchToArcTestnet} disabled={isBusy}>
              Switch to Arc
            </button>
          ) : null}
          <div className="nav-chip">
            <span>Network</span>
            <strong>{networkLabel}</strong>
          </div>
          <button type="button" className="wallet-button" onClick={connectWallet} disabled={isBusy}>
            {walletButtonLabel}
          </button>
        </div>
      </header>

      <section className="top-band">
        <img
          alt="Abstract vault with digital payment light trails"
          src="https://images.unsplash.com/photo-1639322537228-f710d846310a?auto=format&fit=crop&w=1200&q=80"
        />
        <div className="top-band__content">
          <p className="eyebrow">Payments</p>
          <h1>Escrow flows that feel familiar to dex users, but settle peer-to-peer deals.</h1>
          <p className="lede">
            Seller creates a polished payment link, buyer lands on a prefilled order, and every step from approval to release stays transparent on Arc Network.
          </p>
          <div className="inline-metrics">
            <div>
              <span>Wallet</span>
              <strong>{walletButtonLabel}</strong>
            </div>
            <div>
              <span>Network</span>
              <strong>{networkLabel}</strong>
            </div>
            <div>
              <span>Contract Pool</span>
              <strong>{formatTokenAmount(contractBalance, tokenDecimals)} {tokenSymbol}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="workspace">
        <div className="toolbar">
          <div>
            <p className="section-label">Overview</p>
            <h2>Run the seller link flow, then complete the escrow lifecycle below.</h2>
          </div>
        </div>

        <div className="grid">
          <form className="panel panel--wide" onSubmit={handleGenerateListing}>
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
          </form>

          <form className="panel panel--wide" onSubmit={handleCreateEscrow}>
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
          </form>

          <form className="panel" onSubmit={handleCreateEscrow}>
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

          <form className="panel" onSubmit={handleApprove}>
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
            className="panel"
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
            className="panel"
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
                <p className="section-label">Flow 4</p>
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
            className="panel"
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
                <p className="section-label">Flow 5</p>
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

          <form className="panel" onSubmit={handleLookup}>
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

        <div className="bottom-grid">
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
                  <span>Amount</span>
                  <strong>{formatTokenAmount(escrowRecord.amount, tokenDecimals)} {tokenSymbol}</strong>
                </div>
              </div>
            ) : (
              <p className="hint">Load an escrow ID to inspect buyer, seller, amount, and state.</p>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}

export default App
