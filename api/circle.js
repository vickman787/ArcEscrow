import { handleCircleApiRequest } from '../server/circle-api.js'

export default async function handler(req, res) {
  const result = await handleCircleApiRequest({
    method: req.method,
    body: req.body,
    env: process.env,
  })

  res.status(result.status).json(result.body)
}
