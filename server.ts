/* ============================================================
   ASKAI SERVICE – VERSION CORREGIDA
   ============================================================ */

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

/* ============================================================
   CONFIG
   ============================================================ */
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'
const ANTHROPIC_KEY =
  process.env.N8N_AI_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || ''
const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022'

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

const suggestionsStore = new Map<
  string,
  { sessionId: string; proposed: string; original?: string }
>()

/* ============================================================
   UTILIDADES
   ============================================================ */
async function fetchHtml(url: string, timeoutMs = 5000): Promise<string> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9'
      }
    })
    clearTimeout(t)
    if (!r.ok) return ''
    return await r.text()
  } catch {
    clearTimeout(t)
    return ''
  }
}

/* ============================================================
   SEARCH: DOCS
   ============================================================ */
async function searchDocs(query: string) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(
    `site:docs.n8n.io ${query}`
  )}`
  const html = await fetchHtml(url)
  const results: Array<{ title: string; url: string }> = []

  const re =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && results.length < 3) {
    let href = m[1]
    const title = m[2].replace(/<[^>]+>/g, '').trim()
    const u = href.match(/uddg=([^&]+)/)
    if (u) href = decodeURIComponent(u[1])
    results.push({ title, url: href })
  }

  return results
}

/* ============================================================
   SEARCH: FORO
   ============================================================ */
async function searchForum(query: string) {
  const url = `https://community.n8n.io/search?q=${encodeURIComponent(query)}`
  const html = await fetchHtml(url)
  const results: Array<{ title: string; url: string }> = []
  const seen = new Set<string>()

  const re = /<a[^>]+href="(\/t\/[^\"]+)"[^>]*>([^<]+)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && results.length < 3) {
    const href = 'https://community.n8n.io' + m[1]
    const title = m[2].trim()
    if (!seen.has(href)) {
      seen.add(href)
      results.push({ title, url: href })
    }
  }

  return results
}

/* ============================================================
   SEARCH: PLANTILLAS
   ============================================================ */
async function searchTemplates(query: string) {
  const results: Array<{
    id: string
    title: string
    url: string
    importUrl: string
    summary?: string
  }> = []

  // Intento 1 – página de n8n.io
  {
    const html = await fetchHtml(
      `https://n8n.io/workflows/?q=${encodeURIComponent(query)}`
    )
    const re =
      /href="(?:https?:\/\/n8n\.io)?\/workflows\/(\d+)-([^"\/]+)[^\"]*"/gi
    let m: RegExpExecArray | null

    while ((m = re.exec(html)) && results.length < 5) {
      const id = m[1]
      const slug = decodeURIComponent(m[2])
      const title = slug.replace(/-/g, ' ').trim()

      const importUrl = `https://automation.whitelabel.lat/templates/${id}/setup`

      if (!results.find(r => r.id === id)) {
        results.push({
          id,
          title,
          url: '', // ocultamos enlace original
          importUrl
        })
      }
    }
  }

  // Fallbacks omitidos por brevedad (si quieres los añado)
  // [...]

  // Enriquecer con resumen
  for (let i = 0; i < Math.min(results.length, 3); i++) {
    const r = results[i]
    // Si hubiera URL original podríamos extraer summary.
    // Pero como no mostramos la URL original, omitiremos scraping aquí.
    r.summary = undefined
  }

  return results
}

/* ============================================================
   AUTH
   ============================================================ */
function verifyAuth(req: express.Request, res, next) {
  const reqId = (req as any).reqId
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''

  if (!token) {
    console.log(`[askai:${reqId}] auth missing`)
    return res.status(401).json({ code: 401, message: 'Unauthorized' })
  }

  try {
    jwt.verify(token, JWT_SECRET)
    next()
  } catch (e: any) {
    console.log(`[askai:${reqId}] auth error ${e.message}`)
    return res.status(401).json({ code: 401, message: 'Unauthorized' })
  }
}

/* ============================================================
   /auth/token
   ============================================================ */
app.post('/auth/token', async (req, res) => {
  const reqId = (req as any).reqId
  const { licenseCert } = req.body || {}
  if (!licenseCert) {
    console.log(`[askai:${reqId}] missing licenseCert`)
    return res
      .status(400)
      .json({ code: 400, message: 'licenseCert required' })
  }

  const accessToken = jwt.sign(
    {
      sub: 'n8n',
      aud: 'ai-assistant',
      licenseCert
    },
    JWT_SECRET,
    { expiresIn: '10m' }
  )

  console.log(`[askai:${reqId}] issued accessToken`)
  res.json({ accessToken })
})

/* ============================================================
   /v1/ask-ai
   ============================================================ */
app.post('/v1/ask-ai', verifyAuth, async (req, res) => {
  const reqId = (req as any).reqId
  const { question, context, forNode } = req.body || {}

  if (!question || typeof question !== 'string') {
    return res
      .status(400)
      .json({ code: 400, message: 'question required' })
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({
      code: 500,
      message: 'Service misconfigured: ANTHROPIC key missing'
    })
  }

  const system =
    'Eres un asistente de n8n. Devuelve solo código JavaScript válido, sin explicaciones y sin ```.'
  const user = `Nodo: ${JSON.stringify(
    forNode
  )}\nContexto: ${JSON.stringify(context)}\nPregunta: ${question}`

  try {
    const r = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }]
    })

    const raw =
      r.content?.map((c: any) => ('text' in c ? c.text : '')).join('\n') ||
      ''
    const inline = raw.replace(/```[\s\S]*?```/g, '').trim()

    return res.json({ code: inline })
  } catch (e: any) {
    return res.status(500).json({
      code: 500,
      message: e?.message || 'Ask AI failed'
    })
  }
})

/* ============================================================
   /v1/chat
   ============================================================ */
app.post('/v1/chat', verifyAuth, async (req, res) => {
  const reqId = (req as any).reqId
  const body = req.body || {}
  const payload = body.payload || {}
  const sessionId = body.sessionId || uuidv4()

  const text =
    typeof payload?.text === 'string'
      ? payload.text
      : typeof body?.question === 'string'
      ? body.question
      : ''

  if (!text && !('type' in payload)) {
    return res
      .status(400)
      .json({ code: 400, message: 'payload required' })
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({
      code: 500,
      message: 'Service misconfigured: ANTHROPIC key missing'
    })
  }

  try {
    const textQuery = text.trim()
    const allMessages: any[] = []

    /* SEARCH */
    const docs = await searchDocs(textQuery)
    const forum = await searchForum(textQuery)
    const templates = await searchTemplates(textQuery)

    /* ============================================================
       DETECCIÓN DE SI EL USUARIO QUIERE PLANTILLAS
       ============================================================ */
    const wantsTemplates =
      /\b(template|plantilla|workflow|plantillas|templates)\b/i.test(
        textQuery
      )

    /* ============================================================
       SI EL USUARIO PIDIO PLANTILLAS → RESPUESTA EXCLUSIVA
       ============================================================ */
    if (wantsTemplates && templates.length > 0) {
      const md = templates
        .slice(0, 3)
        .map(t => {
          const summary = t.summary
            ? `\n_${t.summary.slice(0, 160)}..._`
            : '_Workflow listo para usar._'

          return `### 📄 ${t.title}
${summary}

➡️ **[⬇️ Importar en tu n8n](${t.importUrl})**`
        })
        .join('\n\n---\n\n')

      const blockMsg = {
        role: 'assistant',
        type: 'block',
        title: 'Plantillas encontradas',
        content: md
      }

      const guideMsg = {
        role: 'assistant',
        type: 'message',
        text:
          'Aquí tienes plantillas listas para importar en tu instancia.',
        quickReplies: [
          { type: 'new-suggestion', text: 'Buscar más plantillas' },
          { type: 'resolved', text: 'Listo, gracias', isFeedback: true }
        ]
      }

      return res.json({
        sessionId,
        messages: [...allMessages, blockMsg, guideMsg]
      })
    }

    /* ============================================================
       RESPUESTA NORMAL (NO PLANTILLAS)
       ============================================================ */
    const userText = `${text}`

    const r = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system:
        'Eres un asistente experto en n8n. Usa bloques ``` para código.',
      messages: [{ role: 'user', content: userText }]
    })

    const raw =
      r.content?.map((c: any) => ('text' in c ? c.text : '')).join('\n') ||
      ''

    return res.json({
      sessionId,
      messages: [
        {
          role: 'assistant',
          type: 'message',
          text: raw
        }
      ]
    })
  } catch (e: any) {
    console.log(`[askai:${reqId}] ERROR`, e?.message)

    return res.status(200).json({
      sessionId,
      messages: [
        { role: 'assistant', type: 'error', content: e?.message }
      ]
    })
  }
})

/* ============================================================
   APPLY SUGGESTION
   ============================================================ */
app.post('/v1/chat/apply-suggestion', verifyAuth, (req, res) => {
  const { sessionId, suggestionId } = req.body || {}
  if (!sessionId || !suggestionId)
    return res
      .status(400)
      .json({ code: 400, message: 'sessionId and suggestionId required' })

  const entry = suggestionsStore.get(suggestionId)
  if (!entry)
    return res.status(404).json({ code: 404, message: 'Not found' })

  if (entry.sessionId !== sessionId)
    return res
      .status(400)
      .json({ code: 400, message: 'Session mismatch' })

  return res.json({
    sessionId,
    parameters: { jsCode: entry.proposed }
  })
})

/* ============================================================
   HEALTH
   ============================================================ */
const port = Number(process.env.PORT || 8080)
app.get('/healthz', (_req, res) => res.json({ ok: true }))
app.get('/', (_req, res) =>
  res.json({ ok: true, service: 'askai-service' })
)
app.use((req, res) =>
  res.status(404).json({
    code: 404,
    message: 'Not found',
    path: req.path
  })
)

app.listen(port, () => {
  console.log(`🚀 askai-service running on :${port}`)
})
