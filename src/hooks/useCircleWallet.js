import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getCircleSdk,
  hasCircleAppId,
  pickArcWallet,
  pickUsdcBalance,
  postCircleAction,
} from '../lib/circle'
import { setDisplayError, shortenAddress } from '../lib/escrow'

const CIRCLE_SESSION_STORAGE_KEY = 'arc-escrow-circle-session'
// Circle's userToken/encryptionKey/refreshToken are stored in localStorage (there's no backend
// session store in this app), so an XSS could read them. There's no shorter-lived alternative
// available without server-side sessions, so we bound the exposure window instead: the stored
// session is treated as stale and discarded after this long, forcing a fresh login.
const CIRCLE_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000
const CIRCLE_WALLETS_STORAGE_KEY = 'arc-escrow-circle-wallets'
const CIRCLE_BALANCE_STORAGE_KEY = 'arc-escrow-circle-balance'

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// Owns the Circle Programmable Wallet login/session lifecycle: email OTP flow, the W3S SDK
// instance, wallet/balance lookups, contract-execution challenges, and localStorage persistence
// of the session. Takes the handful of top-level pieces it needs to touch as parameters
// (walletMode/setWalletMode is shared with the browser-wallet path; setError/setStatus/setIsBusy/
// setIsWalletModalOpen/setIsWalletMenuOpen are generic UI state used across the whole app;
// publicProvider is the Arc RPC, used only to look up a transaction receipt once Circle reports a
// tx hash - deliberately not the injected wallet, which may be on a different chain).
export function useCircleWallet({
  theme,
  walletMode,
  setWalletMode,
  setError,
  setStatus,
  setIsBusy,
  setIsWalletModalOpen,
  setIsWalletMenuOpen,
  publicProvider,
}) {
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
  const circleLoginFlowRef = useRef(false)

  const isCircleConfigured = hasCircleAppId()
  const circlePrimaryWallet = pickArcWallet(circleWallets)
  const isCircleWalletActive = walletMode === 'circle' && Boolean(circlePrimaryWallet?.id && circleSession?.userToken)
  const canUseCircleWrites = Boolean(isCircleWalletActive && circlePrimaryWallet?.id && circleSession?.userToken)
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
        if (circleLoginFlowRef.current) {
          return
        }

        if (loginError || !result) {
          setCircleFlowStep('otp-sent')
          const nextMessage = loginError?.message || 'Circle email verification failed.'
          setError(nextMessage)
          setCircleMessage(nextMessage)
          return
        }

        circleLoginFlowRef.current = true
        const nextSession = {
          userToken: result.userToken,
          encryptionKey: result.encryptionKey,
          refreshToken: result.refreshToken,
          establishedAt: Date.now(),
        }

        setError('')
        setCircleSession(nextSession)
        setCircleOtpRequested(false)
        setCirclePendingChallengeId('')
        setCircleDeviceToken('')
        setCircleDeviceEncryptionKey('')
        setCircleOtpToken('')
        setCircleFlowStep('initializing-wallet')
        setCircleMessage('Email verified. Checking for your existing Circle wallet on Arc Testnet...')

        let setupChallengeId = ''

        try {
          const existingWallet = await activateCircleWalletSession(nextSession, {
            statusPrefix: 'Circle wallet reconnected',
          })

          if (existingWallet?.address) {
            return
          }

          setCircleMessage('No existing Arc wallet was found. Preparing Circle wallet setup...')

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
              session: nextSession,
            })
            return
          }

          const initializedWallet = await activateCircleWalletSession(nextSession)

          if (!initializedWallet?.address) {
            setCircleFlowStep('wallet-ready')
            setCircleMessage('Circle user is initialized, but no Arc Testnet wallet was returned. Try refreshing Circle wallet details before requesting another code.')
            setStatus('Circle session is ready, but no Arc Testnet wallet was found.')
          }
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
        } finally {
          circleLoginFlowRef.current = false
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

  const activateCircleWalletSession = async (
    nextSession = circleSession,
    { statusPrefix = 'Circle wallet connected' } = {},
  ) => {
    const nextPrimaryWallet = await refreshCircleWalletSession(nextSession)

    if (!nextPrimaryWallet?.address) {
      return null
    }

    setCircleFlowStep('wallet-ready')
    setCirclePendingChallengeId('')
    setCircleMessage(`Circle wallet ready at ${shortenAddress(nextPrimaryWallet.address)}.`)
    setWalletMode('circle')
    setIsWalletModalOpen(false)
    setIsWalletMenuOpen(false)
    setStatus(
      `${statusPrefix} at ${shortenAddress(nextPrimaryWallet.address)}. You can now use ArcEscrow with Circle or log out anytime.`,
    )

    return nextPrimaryWallet
  }

  const completeCircleWalletSetup = async ({ challengeId, session = circleSession }) => {
    if (!challengeId) {
      throw new Error('Circle did not return a wallet setup challenge.')
    }

    if (!session?.userToken || !session?.encryptionKey) {
      throw new Error('Verify your email before finishing Circle wallet setup.')
    }

    const existingWallet = await activateCircleWalletSession(session, {
      statusPrefix: 'Circle wallet reconnected',
    })

    if (existingWallet?.address) {
      return existingWallet
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
    const nextPrimaryWallet = await activateCircleWalletSession(session)

    return nextPrimaryWallet
  }

  const resolveCircleTransaction = async ({ challengeId, userToken }) => {
    const maxAttempts = 60
    let lastChallenge = null
    let lastPollError = null

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // By this point Circle has already accepted the transaction and it is on its way to the
      // chain. A dropped request while polling - a flaky network, a cold serverless function - says
      // nothing about whether it succeeded, so retry rather than abort. Aborting here reported
      // failure for escrows that were in fact created, and users retried and created duplicates.
      let challengePayload

      try {
        challengePayload = await postCircleAction('getChallenge', {
          userToken,
          challengeId,
        })
        lastPollError = null
      } catch (pollError) {
        lastPollError = pollError
        await wait(2000)
        continue
      }

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
        let transaction

        try {
          const transactionPayload = await postCircleAction('getTransaction', {
            userToken,
            transactionId,
          })
          transaction =
            transactionPayload.transaction ||
            transactionPayload.userTransaction ||
            transactionPayload
          lastPollError = null
        } catch (pollError) {
          // Same reasoning as above: a failed lookup is not a failed transaction.
          lastPollError = pollError
          await wait(2000)
          continue
        }

        const txHash =
          transaction?.txHash ||
          transaction?.blockchainTxHash ||
          transaction?.transactionHash ||
          transaction?.tx?.txHash ||
          transaction?.tx?.hash ||
          transaction?.tx?.transactionHash ||
          ''

        if (txHash) {
          try {
            // Circle always settles on Arc, so read the receipt from the Arc RPC rather than the
            // injected wallet, which may be pointed at an entirely different chain.
            const receipt = await publicProvider.getTransactionReceipt(txHash)

            if (receipt) {
              return { challenge, transaction, txHash, receipt }
            }
          } catch (receiptError) {
            // The RPC can rate limit or blip; the receipt will still be there on the next pass.
            lastPollError = receiptError
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

    // Running out of attempts means we stopped watching, not that the transaction failed - it has
    // very likely already settled. Say so plainly, because the previous wording read as a failure
    // and users retried, creating duplicate escrows for the same deal.
    throw new Error(
      lastChallenge?.errorReason ||
        (lastPollError
          ? 'Circle approved the transaction and it was most likely created, but we lost contact while waiting for confirmation. Check Manage before trying again, so you do not create the same escrow twice.'
          : 'Circle approved the transaction and it is taking longer than usual to confirm. It has most likely been created - check Manage before trying again, so you do not create the same escrow twice.'),
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
        await refreshCircleWalletSession(circleSession)
      } catch (restoreError) {
        if (isCancelled) {
          return
        }

        console.warn('Failed to restore Circle wallet session:', restoreError)
        setCircleSession(null)
        setCircleWallets([])
        setCircleWalletBalance(null)
        setWalletMode(null)
        setDisplayError(setError, restoreError)
        setCircleMessage('Your Circle session expired. Please sign in again.')
        setStatus('Circle session expired. Sign in again to continue.')
      }
    }

    void restoreCircleWallet()

    return () => {
      isCancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletMode, circleSession?.userToken])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const storedCircleSession = window.localStorage.getItem(CIRCLE_SESSION_STORAGE_KEY)
    const storedCircleWallets = window.localStorage.getItem(CIRCLE_WALLETS_STORAGE_KEY)
    const storedCircleBalance = window.localStorage.getItem(CIRCLE_BALANCE_STORAGE_KEY)

    if (storedCircleSession) {
      try {
        const parsedSession = JSON.parse(storedCircleSession)
        const age = Date.now() - (parsedSession.establishedAt || 0)

        if (age > CIRCLE_SESSION_MAX_AGE_MS) {
          window.localStorage.removeItem(CIRCLE_SESSION_STORAGE_KEY)
        } else {
          setCircleSession(parsedSession)
        }
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

  const resetCircleState = () => {
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
  }

  return {
    circleEmail,
    setCircleEmail,
    circleFlowStep,
    circleMessage,
    setCircleMessage,
    circleOtpRequested,
    circlePendingChallengeId,
    circleDeviceToken,
    circleDeviceEncryptionKey,
    circleOtpToken,
    circleSession,
    circleWallets,
    circleWalletBalance,
    isCircleConfigured,
    circlePrimaryWallet,
    isCircleWalletActive,
    canUseCircleWrites,
    circleWalletBalanceLabel,
    handleCircleOtpSubmit,
    handleCircleVerifyOtp,
    handleCircleFinishWalletSetup,
    activateCircleWalletSession,
    refreshCircleWalletSession,
    executeCircleContract,
    resetCircleState,
  }
}
