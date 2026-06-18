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

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret'
const ANTHROPIC_KEY = process.env.N8N_AI_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || ''
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'
// Firecrawl self-hosted: búsqueda + scrape de páginas a markdown limpio.
// Si lo movés de server, sólo cambiás esta env y listo.
const FIRECRAWL_URL = (process.env.FIRECRAWL_URL || 'https://firecrawl.lab.whitelabel.lat').replace(
  /\/+$/,
  '',
)
// Instancia n8n (para construir los links de "Importar plantilla").
const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'https://automation.whitelabel.lat').replace(
  /\/+$/,
  '',
)

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })
const suggestionsStore = new Map<
  string,
  { sessionId: string; proposed: string; original?: string }
>()

// ----------------------------------------------------------------------------
// LLM — único punto de contacto. Cambiar de modelo = env ANTHROPIC_MODEL
// (p. ej. claude-sonnet-4-6 para respuestas más finas en algo puntual).
// ----------------------------------------------------------------------------
async function complete(system: string, user: string, maxTokens = 1024): Promise<string> {
  const r = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  })
  return r.content?.map((c: any) => ('text' in c ? c.text : '')).join('\n') || ''
}

// ----------------------------------------------------------------------------
// Firecrawl — robusto, con timeout y fallback (nunca rompe el chat)
// ----------------------------------------------------------------------------
type FcResult = { url: string; title?: string; description?: string; markdown?: string }

function timeoutSignal(ms: number): AbortSignal {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), ms)
  return ac.signal
}

async function fcSearch(
  query: string,
  { limit = 2, scrape = false, timeoutMs = 20000 }: { limit?: number; scrape?: boolean; timeoutMs?: number } = {},
): Promise<FcResult[]> {
  try {
    const r = await fetch(`${FIRECRAWL_URL}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        limit,
        ...(scrape ? { scrapeOptions: { formats: ['markdown'], onlyMainContent: true } } : {}),
      }),
      signal: timeoutSignal(timeoutMs),
    })
    if (!r.ok) return []
    const j: any = await r.json()
    const data: any[] = Array.isArray(j?.data) ? j.data : []
    return data
      .filter((d) => d && typeof d.url === 'string')
      .map((d) => ({ url: d.url, title: d.title, description: d.description, markdown: d.markdown }))
  } catch {
    return []
  }
}

async function fcScrape(url: string, timeoutMs = 20000): Promise<string> {
  try {
    const r = await fetch(`${FIRECRAWL_URL}/v1/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: timeoutSignal(timeoutMs),
    })
    if (!r.ok) return ''
    const j: any = await r.json()
    return typeof j?.data?.markdown === 'string' ? j.data.markdown : ''
  } catch {
    return ''
  }
}

// ----------------------------------------------------------------------------
// Utils
// ----------------------------------------------------------------------------
function truncate(s: string, n: number): string {
  if (!s) return ''
  const t = s.replace(/\n{3,}/g, '\n\n').trim()
  return t.length > n ? `${t.slice(0, n).trimEnd()}\n…` : t
}

function extractUrls(text: string): string[] {
  const re = /\bhttps?:\/\/[^\s)<>"']+/gi
  const found = text.match(re) || []
  return Array.from(new Set(found.map((u) => u.replace(/[.,;:]+$/, ''))))
}

function cleanTitle(t?: string): string {
  return (t || '').replace(/\s*\|\s*n8n.*$/i, '').replace(/\s+/g, ' ').trim()
}

// Tarjeta de fuentes (único modo nativo de mostrar links en el chat de n8n:
// markdown dentro de un mensaje 'summary' -> render como bloque con links).
function sourcesCard(items: Array<{ title?: string; url: string }>): any | null {
  const seen = new Set<string>()
  const lines = items
    .filter((i) => i.url && !seen.has(i.url) && (seen.add(i.url), true))
    .slice(0, 6)
    .map((i) => `- [${cleanTitle(i.title) || i.url}](${i.url})`)
  if (!lines.length) return null
  return { role: 'assistant', type: 'summary', title: '📚 Fuentes', content: lines.join('\n') }
}

// Parsea la respuesta del LLM en bloques de mensaje (texto + codeSnippet),
// que es lo que el chat de n8n renderiza (type 'message').
function parseAnswerToBlocks(raw: string): { blocks: any[]; codeMatches: Array<{ lang: string; code: string }> } {
  const blocks: any[] = []
  const codeMatches: Array<{ lang: string; code: string }> = []
  const re = /```([\w+-]*)\n([\s\S]*?)```/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const pre = raw.slice(lastIndex, m.index).trim()
    if (pre) blocks.push({ role: 'assistant', type: 'message', text: pre })
    const lang = m[1] || 'text'
    const code = m[2].trim()
    blocks.push({
      role: 'assistant',
      type: 'message',
      text: '',
      codeSnippet: `\`\`\`${lang}\n${code}\n\`\`\``,
    })
    codeMatches.push({ lang, code })
    lastIndex = re.lastIndex
  }
  const post = raw.slice(lastIndex).trim()
  if (post) blocks.push({ role: 'assistant', type: 'message', text: post })
  if (!blocks.length) blocks.push({ role: 'assistant', type: 'message', text: raw.trim() })
  return { blocks, codeMatches }
}

// ----------------------------------------------------------------------------
// Auth
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// /v1/ask-ai — caja "Ask AI" del NDV: genera código para un nodo Code.
// Respuesta: { code: string }. Fundamentado (best-effort) con la doc del nodo.
// ----------------------------------------------------------------------------
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

  // Grounding ligero: 1 doc relevante, timeout corto (es una caja inline).
  const docs = await fcSearch(`site:docs.n8n.io ${question}`, { limit: 1, scrape: true, timeoutMs: 9000 })
  const ground = docs[0]?.markdown
    ? `\n\nDocumentación n8n relevante:\n${truncate(docs[0].markdown, 2000)}`
    : ''

  const system =
    'Eres un asistente de n8n. Devuelve EXCLUSIVAMENTE código JavaScript válido para un nodo Code de n8n, sin explicaciones, sin comentarios innecesarios y sin bloques Markdown ni ```. Usa la documentación proporcionada como referencia si aplica.'
  const user = `Nodo: ${JSON.stringify(forNode)}\nContexto: ${JSON.stringify(context)}\nPregunta: ${question}${ground}`

  try {
    const raw = await complete(system, user, 1024)
    const fenced = raw.match(/```[a-zA-Z]*\n([\s\S]*?)```/)
    const inlineFenced = raw.match(/```([\s\S]*?)```/)
    const content = fenced ? fenced[1].trim() : inlineFenced ? inlineFenced[1].trim() : raw.trim()
    console.log(`[askai:${reqId}] ask-ai ok len=${content.length} grounded=${!!ground}`)
    res.json({ code: content })
  } catch (e: any) {
    const msg = e?.message || 'Ask AI failed'
    const status = e?.status || e?.statusCode || 500
    console.log(`[askai:${reqId}] ask-ai error status=${status} message=${msg}`)
    if (status === 429) res.status(429).json({ code: 429, message: 'Rate limited' })
    else if (status === 413) res.status(413).json({ code: 413, message: 'Content too large' })
    else if (status === 400) res.status(400).json({ code: 400, message: msg })
    else if (status === 404)
      res.status(400).json({ code: 400, message: 'Anthropic model not found or unsupported' })
    else res.status(500).json({ code: 500, message: msg })
  }
})

// ----------------------------------------------------------------------------
// /v1/chat — chat del asistente. RAG con Firecrawl + fuentes visibles.
// Respuesta: { sessionId, messages: [...] } con tipos que n8n SÍ renderiza:
//   message (text), summary (block), code-diff. (Los 'tool' se descartan, no se usan.)
// ----------------------------------------------------------------------------
app.post('/v1/chat', verifyAuth, async (req, res) => {
  const reqId = (req as any).reqId || '-'
  const body = req.body || {}
  const payload = body.payload || {}
  const sessionId = body.sessionId || uuidv4()

  // El primer mensaje (init) trae 'question'; los follow-ups traen 'text'.
  const text: string =
    (typeof payload?.text === 'string' && payload.text) ||
    (typeof payload?.question === 'string' && payload.question) ||
    (typeof body?.question === 'string' && body.question) ||
    (typeof body?.text === 'string' && body.text) ||
    ''

  if (!text) {
    res.status(400).json({ code: 400, message: 'payload required' })
    return
  }
  if (!ANTHROPIC_KEY) {
    res.status(500).json({ code: 500, message: 'Service misconfigured: ANTHROPIC key missing' })
    return
  }

  const quickReplies = [
    { type: 'new-suggestion', text: 'Dame otra solución' },
    { type: 'resolved', text: 'Sí, gracias', isFeedback: true },
  ]

  try {
    const ctx = payload?.context || payload?.workflowContext || {}

    // ------------------------------------------------------------------
    // Intención: plantillas (discovery vía Firecrawl)
    // ------------------------------------------------------------------
    if (/\b(template|templates|plantilla|plantillas)\b/i.test(text)) {
      const found = await fcSearch(`site:n8n.io/workflows ${text}`, { limit: 6 })
      const templates = found
        .map((r) => {
          const mm = r.url.match(/\/workflows\/(\d+)(?:-([a-z0-9-]+))?/i)
          if (!mm) return null
          const id = mm[1]
          const slug = mm[2] || ''
          const title = cleanTitle(r.title) || slug.replace(/-/g, ' ').trim() || `Workflow ${id}`
          return {
            id,
            title,
            url: r.url,
            importUrl: `${N8N_BASE_URL}/templates/${id}/setup`,
            summary: r.description || '',
          }
        })
        .filter((t): t is NonNullable<typeof t> => !!t)
        .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)

      if (templates.length) {
        const cards = templates.slice(0, 5).map((t) => {
          const desc = truncate(t.summary, 220) || 'Workflow listo para usar en tu instancia de n8n.'
          const content = [`_${desc}_`, '', `➡️ **[⬇️ Importar en tu n8n](${t.importUrl})**`].join('\n')
          return { role: 'assistant', type: 'summary', title: `📄 ${t.title}`, content }
        })
        const guide = {
          role: 'assistant',
          type: 'message',
          text:
            'Encontré estas plantillas de n8n. Hacé clic en **⬇️ Importar en tu n8n** en la que más se acerque a lo que necesitás y se abrirá en tu instancia para terminar de configurarla.',
          quickReplies: [
            { type: 'new-suggestion', text: 'Buscar más plantillas' },
            { type: 'resolved', text: 'Listo, gracias', isFeedback: true },
          ],
        }
        console.log(`[askai:${reqId}] templates cards=${cards.length}`)
        res.json({ sessionId, messages: [...cards, guide] })
        return
      }
      // Sin plantillas -> sigue como pregunta general.
    }

    // ------------------------------------------------------------------
    // Grounding (RAG) — en paralelo para minimizar latencia
    //  (a) URL explícita en el mensaje -> scrape
    //  (b) docs.n8n.io -> search + contenido (fuente de verdad)
    //  (c) community.n8n.io -> sólo links como fuente
    // ------------------------------------------------------------------
    const urls = extractUrls(text).filter((u) => !/n8n\.io\/workflows/i.test(u))
    const [urlMd, docs, forum] = await Promise.all([
      urls.length ? fcScrape(urls[0]) : Promise.resolve(''),
      fcSearch(`site:docs.n8n.io ${text}`, { limit: 2, scrape: true }),
      fcSearch(`site:community.n8n.io ${text}`, { limit: 2 }),
    ])

    const sources: Array<{ title?: string; url: string }> = []
    const groundingParts: string[] = []

    if (urlMd) {
      groundingParts.push(`Contenido de ${urls[0]}:\n${truncate(urlMd, 4000)}`)
      sources.push({ title: urls[0], url: urls[0] })
    }
    for (const d of docs) {
      if (d.markdown) groundingParts.push(`Doc: ${cleanTitle(d.title) || d.url}\n${truncate(d.markdown, 2500)}`)
      sources.push({ title: d.title, url: d.url })
    }
    for (const f of forum) sources.push({ title: f.title, url: f.url })

    const grounding = groundingParts.join('\n\n---\n\n')
    console.log(
      `[askai:${reqId}] grounding url=${urlMd ? 1 : 0} docs=${docs.length} forum=${forum.length}`,
    )

    const system =
      'Eres un asistente experto de n8n. Usa la DOCUMENTACIÓN proporcionada como fuente de verdad: si responde la pregunta, básate en ella; si no la cubre, dilo claramente y responde con tu mejor criterio. Cuando incluyas código, usa bloques con triple acento grave indicando el lenguaje (```javascript, ```sql, etc.). Responde en el idioma del usuario, de forma clara y concisa.'
    const userMsg = grounding
      ? `${text}\n\n--- DOCUMENTACIÓN n8n (fuente de verdad) ---\n${grounding}`
      : text

    const raw = await complete(system, userMsg, 2048)
    const { blocks, codeMatches } = parseAnswerToBlocks(raw)

    const messages: any[] = [...blocks]

    // ------------------------------------------------------------------
    // code-diff: si el nodo activo es un Code con jsCode, proponer reemplazo
    // ------------------------------------------------------------------
    const nodeParams = (ctx?.activeNodeInfo?.node?.parameters ||
      payload?.context?.activeNodeInfo?.node?.parameters ||
      payload?.workflowContext?.activeNodeInfo?.node?.parameters) as any
    const oldCode = typeof nodeParams?.jsCode === 'string' ? nodeParams.jsCode : undefined

    let preferredNewCode = ''
    if (codeMatches.length > 0) {
      const nodeLangRaw = String(nodeParams?.language ?? '').toLowerCase()
      const prefersPython = nodeLangRaw.includes('python')
      const prefersTs = nodeLangRaw.includes('typescript') || nodeLangRaw.includes('ts')
      const order: string[] = prefersPython
        ? ['python', 'typescript', 'ts', 'javascript', 'js', 'text']
        : prefersTs
        ? ['typescript', 'ts', 'javascript', 'js', 'python', 'text']
        : ['javascript', 'js', 'typescript', 'ts', 'python', 'text']
      const preferred = codeMatches.find((c) => order.includes(c.lang.toLowerCase())) || codeMatches[0]
      preferredNewCode = preferred.code
    }

    if (oldCode && preferredNewCode) {
      const oldLines = oldCode.split('\n')
      const newLines = preferredNewCode.split('\n')
      let diff = `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
      for (const l of oldLines) diff += `-${l}\n`
      for (const l of newLines) diff += `+${l}\n`
      const suggestionId = uuidv4()
      suggestionsStore.set(suggestionId, { sessionId, original: oldCode, proposed: preferredNewCode })
      messages.push({
        role: 'assistant',
        type: 'code-diff',
        description: 'Sugerencia de reemplazo del nodo Code',
        codeDiff: diff,
        suggestionId,
        quickReplies,
      })
    }

    // ------------------------------------------------------------------
    // Fuentes visibles (links clickeables)
    // ------------------------------------------------------------------
    const src = sourcesCard(sources)
    if (src) messages.push(src)

    // quickReplies en el último mensaje (si todavía no tiene)
    const last = messages[messages.length - 1]
    if (last && !last.quickReplies) last.quickReplies = quickReplies

    console.log(`[askai:${reqId}] respond messages=${messages.length} sources=${sources.length}`)
    res.json({ sessionId, messages })
  } catch (e: any) {
    const msg = e?.message || 'Chat failed'
    const status = e?.status || e?.statusCode || 500
    res.status(status === 401 ? 401 : 200).json({
      sessionId,
      messages: [{ role: 'assistant', type: 'error', content: msg }],
    })
    console.log(`[askai:${reqId}] chat error status=${status} message=${msg}`)
  }
})

// ----------------------------------------------------------------------------
// Aplicar sugerencia de código (botón "Apply" del code-diff)
// ----------------------------------------------------------------------------
function applySuggestion(req: express.Request, res: express.Response) {
  const reqId = (req as any).reqId || '-'
  const { sessionId, suggestionId } = req.body || {}
  if (!sessionId || !suggestionId) {
    res.status(400).json({ code: 400, message: 'sessionId and suggestionId required' })
    return
  }
  const entry = suggestionsStore.get(suggestionId)
  if (!entry) {
    console.log(`[askai:${reqId}] apply-suggestion not found id=${suggestionId}`)
    res.status(404).json({ code: 404, message: 'Suggestion not found' })
    return
  }
  if (entry.sessionId !== sessionId) {
    console.log(`[askai:${reqId}] apply-suggestion session mismatch id=${suggestionId}`)
    res.status(400).json({ code: 400, message: 'Session mismatch' })
    return
  }
  res.json({ sessionId, parameters: { jsCode: entry.proposed } })
}

app.post('/v1/chat/apply-suggestion', verifyAuth, applySuggestion)
app.post('/ai/chat/apply-suggestion', verifyAuth, applySuggestion)

// ----------------------------------------------------------------------------
// Salud / fallback
// ----------------------------------------------------------------------------
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
