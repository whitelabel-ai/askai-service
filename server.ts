import express from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'
const ANTHROPIC_KEY = process.env.N8N_AI_ANTHROPIC_KEY || ''
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

function verifyAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  try {
    jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ message: 'Unauthorized' })
  }
}

app.post('/auth/token', async (req, res) => {
  const { licenseCert } = req.body || {}
  if (!licenseCert) { res.status(400).json({ message: 'licenseCert required' }); return }
  const accessToken = jwt.sign({ sub: 'n8n', aud: 'ai-assistant', licenseCert }, JWT_SECRET, { expiresIn: '10m' })
  res.json({ accessToken })
})

app.post('/ask-ai', verifyAuth, async (req, res) => {
  const { question, context, forNode } = req.body || {}
  if (!question) { res.status(400).json({ message: 'question required' }); return }
  if (!ANTHROPIC_KEY) { res.status(500).json({ message: 'ANTHROPIC key missing' }); return }
  const system = 'Eres un asistente de n8n. Devuelve solo código válido, sin explicaciones.'
  const user = `Nodo: ${JSON.stringify(forNode)}\nContexto: ${JSON.stringify(context)}\nPregunta: ${question}`
  try {
    const r = await anthropic.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, system, messages: [{ role: 'user', content: user }] })
    const content = r.content?.map((c: any) => ('text' in c ? c.text : '')).join('\n') || ''
    res.json({ code: content })
  } catch (e: any) {
    res.status(500).json({ message: e?.message || 'Ask AI failed' })
  }
})

app.post('/chat', verifyAuth, async (req, res) => {
  const body = req.body || {}
  const payload = body.payload || {}
  const sessionId = body.sessionId || uuidv4()
  const text = payload?.text || ''
  if (!text && !('type' in payload)) { res.status(400).json({ message: 'payload required' }); return }
  if (!ANTHROPIC_KEY) { res.status(500).json({ message: 'ANTHROPIC key missing' }); return }
  res.setHeader('Content-Type', 'application/x-ndjson')
  try {
    const r = await anthropic.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages: [{ role: 'user', content: text || JSON.stringify(payload) }] })
    const content = r.content?.map((c: any) => ('text' in c ? c.text : '')).join('\n') || ''
    const line = { sessionId, messages: [{ role: 'assistant', type: 'message', text: content }] }
    res.write(JSON.stringify(line) + '\n')
    res.end()
  } catch (e: any) {
    const line = { sessionId, messages: [{ role: 'assistant', type: 'error', content: e?.message || 'Chat failed' }] }
    res.write(JSON.stringify(line) + '\n')
    res.end()
  }
})

app.post('/chat/apply-suggestion', verifyAuth, async (req, res) => {
  const { sessionId, suggestionId } = req.body || {}
  if (!sessionId || !suggestionId) { res.status(400).json({ message: 'sessionId and suggestionId required' }); return }
  res.json({ sessionId, parameters: {} })
})

const port = process.env.PORT ? Number(process.env.PORT) : 8080
app.listen(port, () => {})
