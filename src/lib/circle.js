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
    backdrop: dark ? '#0a0e1a' : '#0d1220',
    backdropOpacity: dark ? 0.82 : 0.7,
    bg: dark ? '#191713' : '#ffffff',
    textMain: dark ? '#f0ede6' : '#181614',
    textMain2: dark ? '#d9d4c8' : '#3a352f',
    textAuxiliary: dark ? '#b3ac9f' : '#565049',
    textAuxiliary2: dark ? '#8f8878' : '#6e675c',
    textPlaceholder: dark ? '#8f8878' : '#948e83',
    divider: dark ? 'rgba(240, 237, 230, 0.13)' : 'rgba(24, 22, 20, 0.14)',
    interactiveBg: dark ? '#1e1b16' : '#ffffff',
    inputBg: dark ? '#17140f' : '#fbfcfb',
    inputText: dark ? '#f0ede6' : '#181614',
    inputBorderFocused: dark ? '#6d94e6' : '#2451c4',
    mainBtnBg: dark ? '#6d94e6' : '#2451c4',
    mainBtnBgOnHover: dark ? '#8fabf0' : '#1c3fa0',
    mainBtnText: '#f5f7f8',
    secondBtnBorder: dark ? 'rgba(240, 237, 230, 0.28)' : 'rgba(24, 22, 20, 0.3)',
    secondBtnBgOnHover: dark ? '#1e1b16' : '#f8f7f2',
    secondBtnText: dark ? '#f0ede6' : '#181614',
    titleGradients: ['#f8cf72', '#2451c4'],
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
