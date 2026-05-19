const CIRCLE_APP_ID = import.meta.env.VITE_CIRCLE_APP_ID?.trim() || ''

let sdkInstance
let circleSdkPromise

async function loadCircleSdkClass() {
  if (!circleSdkPromise) {
    circleSdkPromise = import('@circle-fin/w3s-pw-web-sdk')
      .then((module) => module.W3SSdk)
      .catch((error) => {
        circleSdkPromise = null
        throw new Error(
          error instanceof Error
            ? `Failed to load Circle Web SDK: ${error.message}`
            : 'Failed to load Circle Web SDK.',
        )
      })
  }

  return circleSdkPromise
}

function getCircleTheme(theme) {
  const dark = theme === 'dark'

  return {
    backdrop: dark ? '#081014' : '#0f1c1b',
    backdropOpacity: dark ? 0.82 : 0.7,
    bg: dark ? '#162126' : '#f6fbf8',
    textMain: dark ? '#f5f7f8' : '#16332b',
    textMain2: dark ? '#d8e5df' : '#30554a',
    textAuxiliary: dark ? '#9fb5ac' : '#527669',
    textAuxiliary2: dark ? '#7f978d' : '#6e8e82',
    textPlaceholder: dark ? '#7d9188' : '#7e968b',
    divider: dark ? '#23353a' : '#d7e6df',
    interactiveBg: dark ? '#203139' : '#ffffff',
    inputBg: dark ? '#1b2a30' : '#ffffff',
    inputText: dark ? '#f5f7f8' : '#16332b',
    inputBorderFocused: '#279764',
    mainBtnBg: '#279764',
    mainBtnBgOnHover: '#1f8f5f',
    mainBtnText: '#f5f7f8',
    secondBtnBorder: dark ? '#31454d' : '#c6d7d0',
    secondBtnBgOnHover: dark ? '#203139' : '#eef7f2',
    secondBtnText: dark ? '#f5f7f8' : '#16332b',
    titleGradients: ['#74f2c1', '#4f8cff'],
  }
}

export function hasCircleAppId() {
  return Boolean(CIRCLE_APP_ID)
}

export function getCircleAppId() {
  return CIRCLE_APP_ID
}

export async function getCircleSdk({ theme, onLoginComplete, onResendOtpEmail }) {
  const W3SSdk = await loadCircleSdkClass()
  const configs = CIRCLE_APP_ID
    ? { appSettings: { appId: CIRCLE_APP_ID } }
    : undefined

  if (!sdkInstance) {
    sdkInstance = new W3SSdk(configs, onLoginComplete)
  } else {
    sdkInstance.updateConfigs(configs, onLoginComplete)
  }

  sdkInstance.setThemeColor(getCircleTheme(theme))

  if (onResendOtpEmail) {
    sdkInstance.setOnResendOtpEmail(onResendOtpEmail)
  }

  return sdkInstance
}

export async function postCircleAction(action, payload = {}) {
  const response = await fetch('/api/circle', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action,
      ...payload,
    }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.error || 'Circle request failed')
  }

  return data
}

export function pickArcWallet(wallets = []) {
  return wallets.find((wallet) => wallet.blockchain === 'ARC-TESTNET') || wallets[0] || null
}

export function pickUsdcBalance(balancePayload) {
  const tokenBalances = balancePayload?.tokenBalances || balancePayload?.balances || []
  return tokenBalances.find((item) => item.token?.symbol === 'USDC' || item.symbol === 'USDC') || null
}
