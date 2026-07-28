import { useEffect, useState } from 'react'
import { ethers } from 'ethers'

// Owns the raw injected-wallet (MetaMask/etc.) connection primitives: the ethers provider/signer,
// connected address, and chain id, plus the window.ethereum event listeners that keep them in
// sync. Deliberately does not own walletMode itself (shared with Circle mode) or any of the
// higher-level UI orchestration (status messages, modal visibility) that wraps these calls in
// App.jsx - callers pass setWalletMode in and handle their own UI state around the returned
// connect/reset/refresh functions.
export function useBrowserWallet({ setWalletMode }) {
  const [provider, setProvider] = useState(null)
  const [signer, setSigner] = useState(null)
  const [walletAddress, setWalletAddress] = useState('')
  const [chainId, setChainId] = useState('')

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connectBrowserWallet = async () => {
    if (!window.ethereum) {
      throw new Error('No injected wallet found. Install MetaMask or another EVM wallet.')
    }

    const browserProvider = new ethers.BrowserProvider(window.ethereum)
    const accounts = await browserProvider.send('eth_requestAccounts', [])
    const nextSigner = await browserProvider.getSigner()
    const network = await browserProvider.getNetwork()

    setProvider(browserProvider)
    setSigner(nextSigner)
    setWalletAddress(accounts[0] || '')
    setChainId(network.chainId.toString())
    setWalletMode('browser')

    return { chainId: network.chainId.toString() }
  }

  const refreshBrowserWalletConnection = async () => {
    if (!window.ethereum) {
      throw new Error('No injected wallet found. Install MetaMask or another EVM wallet.')
    }

    const browserProvider = new ethers.BrowserProvider(window.ethereum)
    const accounts = await browserProvider.send('eth_accounts', [])

    if (!accounts[0]) {
      throw new Error('Browser wallet is disconnected. Connect it again to refresh wallet data.')
    }

    const [nextSigner, network] = await Promise.all([
      browserProvider.getSigner(),
      browserProvider.getNetwork(),
    ])

    setProvider(browserProvider)
    setSigner(nextSigner)
    setWalletAddress(accounts[0])
    setChainId(network.chainId.toString())
    setWalletMode('browser')
  }

  const resetBrowserWalletState = () => {
    setSigner(null)
    setWalletAddress('')
    setChainId('')
  }

  return {
    provider,
    signer,
    walletAddress,
    chainId,
    connectBrowserWallet,
    refreshBrowserWalletConnection,
    resetBrowserWalletState,
  }
}
