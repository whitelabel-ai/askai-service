import express from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  const reqId = uuidv4().slice(0, 8)
  ;(req as any).reqId = reqId
  const start = Date.now()
  const hasAuth = req.headers.authorization ? 'present' : 'absent'
  console.log(`[askai:${reqId}] ${req.method} ${req.path} auth=${hasAuth}`)
  res.on('finish', () => {
    console.log(`[askai:${reqId}] -> ${res.statusCode} ${Date.now() - start}ms`)
  })
  next()
})

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'
const ANTHROPIC_KEY = process.env.N8N_AI_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || ''
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022'
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

function verifyAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const reqId = (req as any).reqId || '-'
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!token) {
    console.log(`[askai:${reqId}] auth missing`)
    res.status(401).json({ code: 401, message: 'Unauthorized' })
    return
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any
    console.log(`[askai:${reqId}] auth ok sub=${decoded?.sub} aud=${decoded?.aud}`)
    next()
  } catch (e: any) {
    console.log(`[askai:${reqId}] auth error ${e?.message}`)
    res.status(401).json({ code: 401, message: 'Unauthorized' })
  }
}

app.post('/auth/token', async (req, res) => {
  const reqId = (req as any).reqId || '-'
  const { licenseCert } = req.body || {}
  if (!licenseCert) {
    console.log(`[askai:${reqId}] missing licenseCert`)
    res.status(400).json({ code: 400, message: 'licenseCert required' })
    return
  }
  const accessToken = jwt.sign({ sub: 'n8n', aud: 'ai-assistant', licenseCert }, JWT_SECRET, {
    expiresIn: '10m',
  })
  console.log(`[askai:${reqId}] issued accessToken`)
  res.json({ accessToken })
})

app.post('/v1/ask-ai', verifyAuth, async (req, res) => {
  const reqId = (req as any).reqId || '-'
  const { question, context, forNode } = req.body || {}
  if (!question || typeof question !== 'string') {
    console.log(`[askai:${reqId}] invalid question`)
    res.status(400).json({ code: 400, message: 'question required' })
    return
  }
  if (!ANTHROPIC_KEY) {
    console.log(`[askai:${reqId}] anthropic key missing`)
    res.status(500).json({ code: 500, message: 'Service misconfigured: ANTHROPIC key missing' })
    return
  }
  const system = 'Eres un asistente de n8n. Devuelve exclusivamente código JavaScript válido, sin explicaciones ni bloques Markdown. No incluyas ```.'
  const user = `Nodo: ${JSON.stringify(forNode)}\nContexto: ${JSON.stringify(context)}\nPregunta: ${question}`
  try {
    const r = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    })
    const raw = r.content?.map((c: any) => ('text' in c ? c.text : '')).join('\n') || ''
    const fenced = raw.match(/```[a-zA-Z]*\n([\s\S]*?)```/)
    const inlineFenced = raw.match(/```([\s\S]*?)```/)
    const content = fenced ? fenced[1].trim() : inlineFenced ? inlineFenced[1].trim() : raw.trim()
    console.log(`[askai:${reqId}] anthropic ok len=${content.length}`)
    res.json({ code: content })
  } catch (e: any) {
    const msg = e?.message || 'Ask AI failed'
    const status = e?.status || e?.statusCode || 500
    console.log(`[askai:${reqId}] anthropic error status=${status} message=${msg}`)
    if (status === 429) {
      res.status(429).json({ code: 429, message: 'Rate limited' })
    } else if (status === 413) {
      res.status(413).json({ code: 413, message: 'Content too large' })
    } else if (status === 400) {
      res.status(400).json({ code: 400, message: msg })
    } else if (status === 404) {
      res.status(400).json({ code: 400, message: 'Anthropic model not found or unsupported' })
    } else {
      res.status(500).json({ code: 500, message: msg })
    }
  }
})

const port = process.env.PORT ? Number(process.env.PORT) : 8080
app.get('/healthz', (_req, res) => {
  res.json({ ok: true })
})
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'askai-service' })
})
app.use((req, res) => {
  res.status(404).json({ code: 404, message: 'Not found', path: req.path })
})
app.listen(port, () => {})
