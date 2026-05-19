const DEFAULT_CIRCLE_BASE_URL = 'https://api.circle.com'
const DEFAULT_ACCOUNT_TYPE = 'SCA'
const DEFAULT_BLOCKCHAINS = ['ARC-TESTNET']
const USER_ALREADY_INITIALIZED_CODE = 155106

function json(status, body) {
  return { status, body }
}

function getErrorMessage(payload, fallback) {
  return (
    payload?.error?.message ||
    payload?.message ||
    payload?.errors?.[0]?.message ||
    fallback
  )
}

function getErrorCode(payload) {
  return payload?.error?.code || payload?.code || payload?.errors?.[0]?.code
}

async function callCircle(path, { apiKey, baseUrl, method = 'POST', userToken, body, headers = {} }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      ...(userToken ? { 'X-User-Token': userToken } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

export async function handleCircleApiRequest({ method = 'POST', body = {}, env = process.env }) {
  if ((method || 'POST').toUpperCase() !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  const apiKey = (env.CIRCLE_API_KEY || '').trim()
  const baseUrl = (env.CIRCLE_BASE_URL || DEFAULT_CIRCLE_BASE_URL).trim()

  if (!apiKey) {
    return json(500, {
      error: 'Missing CIRCLE_API_KEY. Add it to your local environment or Vercel project settings.',
    })
  }

  const { action, ...params } = body || {}

  if (!action) {
    return json(400, { error: 'Missing action' })
  }

  try {
    switch (action) {
      case 'requestEmailOtp': {
        const { deviceId, email } = params

        if (!deviceId || !email) {
          return json(400, { error: 'Missing deviceId or email' })
        }

        const { response, payload } = await callCircle('/v1/w3s/users/email/token', {
          apiKey,
          baseUrl,
          body: {
            idempotencyKey: crypto.randomUUID(),
            deviceId,
            email,
          },
        })

        if (!response.ok) {
          return json(response.status, {
            error: getErrorMessage(payload, 'Failed to request Circle email OTP.'),
            code: getErrorCode(payload),
            raw: payload,
          })
        }

        return json(200, payload.data || payload)
      }

      case 'initializeUser': {
        const { userToken } = params

        if (!userToken) {
          return json(400, { error: 'Missing userToken' })
        }

        const { response, payload } = await callCircle('/v1/w3s/user/initialize', {
          apiKey,
          baseUrl,
          userToken,
          body: {
            idempotencyKey: crypto.randomUUID(),
            accountType: DEFAULT_ACCOUNT_TYPE,
            blockchains: DEFAULT_BLOCKCHAINS,
          },
        })

        if (!response.ok) {
          const code = getErrorCode(payload)
          if (code === USER_ALREADY_INITIALIZED_CODE) {
            return json(200, { alreadyInitialized: true, challengeId: null })
          }

          return json(response.status, {
            error: getErrorMessage(payload, 'Failed to initialize Circle user.'),
            code,
            raw: payload,
          })
        }

        return json(200, payload.data || payload)
      }

      case 'listWallets': {
        const { userToken } = params

        if (!userToken) {
          return json(400, { error: 'Missing userToken' })
        }

        const { response, payload } = await callCircle('/v1/w3s/wallets', {
          apiKey,
          baseUrl,
          method: 'GET',
          userToken,
        })

        if (!response.ok) {
          return json(response.status, {
            error: getErrorMessage(payload, 'Failed to load Circle wallets.'),
            code: getErrorCode(payload),
            raw: payload,
          })
        }

        return json(200, payload.data || payload)
      }

      case 'createContractExecutionChallenge': {
        const {
          userToken,
          walletId,
          contractAddress,
          abiFunctionSignature,
          abiParameters = [],
          amount,
          feeLevel = 'MEDIUM',
        } = params

        if (!userToken || !walletId || !contractAddress || !abiFunctionSignature) {
          return json(400, {
            error: 'Missing userToken, walletId, contractAddress, or abiFunctionSignature',
          })
        }

        const { response, payload } = await callCircle('/v1/w3s/user/transactions/contractExecution', {
          apiKey,
          baseUrl,
          userToken,
          body: {
            idempotencyKey: crypto.randomUUID(),
            walletId,
            contractAddress,
            abiFunctionSignature,
            abiParameters,
            feeLevel,
            ...(amount ? { amount } : {}),
          },
        })

        if (!response.ok) {
          return json(response.status, {
            error: getErrorMessage(payload, 'Failed to create Circle contract execution challenge.'),
            code: getErrorCode(payload),
            raw: payload,
          })
        }

        return json(200, payload.data || payload)
      }

      case 'getChallenge': {
        const { userToken, challengeId } = params

        if (!userToken || !challengeId) {
          return json(400, { error: 'Missing userToken or challengeId' })
        }

        const { response, payload } = await callCircle(`/v1/w3s/user/challenges/${challengeId}`, {
          apiKey,
          baseUrl,
          method: 'GET',
          userToken,
        })

        if (!response.ok) {
          return json(response.status, {
            error: getErrorMessage(payload, 'Failed to load Circle challenge status.'),
            code: getErrorCode(payload),
            raw: payload,
          })
        }

        return json(200, payload.data || payload)
      }

      case 'getTransaction': {
        const { userToken, transactionId } = params

        if (!userToken || !transactionId) {
          return json(400, { error: 'Missing userToken or transactionId' })
        }

        const { response, payload } = await callCircle(`/v1/w3s/transactions/${transactionId}`, {
          apiKey,
          baseUrl,
          method: 'GET',
          userToken,
        })

        if (!response.ok) {
          return json(response.status, {
            error: getErrorMessage(payload, 'Failed to load Circle transaction details.'),
            code: getErrorCode(payload),
            raw: payload,
          })
        }

        return json(200, payload.data || payload)
      }

      case 'getTokenBalance': {
        const { userToken, walletId } = params

        if (!userToken || !walletId) {
          return json(400, { error: 'Missing userToken or walletId' })
        }

        const { response, payload } = await callCircle(`/v1/w3s/wallets/${walletId}/balances`, {
          apiKey,
          baseUrl,
          method: 'GET',
          userToken,
        })

        if (!response.ok) {
          return json(response.status, {
            error: getErrorMessage(payload, 'Failed to load Circle wallet balances.'),
            code: getErrorCode(payload),
            raw: payload,
          })
        }

        return json(200, payload.data || payload)
      }

      default:
        return json(400, { error: `Unknown action: ${action}` })
    }
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : 'Internal Circle API error',
    })
  }
}
