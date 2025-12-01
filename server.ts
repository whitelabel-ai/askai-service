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
const suggestionsStore = new Map<string, { sessionId: string; proposed: string; original?: string }>()

async function fetchHtml(url: string, timeoutMs = 5000): Promise<string> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      },
    })
    clearTimeout(t)
    if (!r.ok) return ''
    return await r.text()
  } catch {
    clearTimeout(t)
    return ''
  }
}

async function searchDocs(query: string) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:docs.n8n.io ${query}`)}`
  const html = await fetchHtml(url)
  const results: Array<{ title: string; url: string }> = []
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
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

async function searchTemplates(query: string) {
  const results: Array<{ id: string; title: string; url: string; importUrl: string }> = []
  // Try site search page first
  {
    const siteUrl = `https://n8n.io/workflows/?q=${encodeURIComponent(query)}`
    const html = await fetchHtml(siteUrl)
    const reAbs = /href="https?:\/\/n8n\.io\/workflows\/(\d+)[^"]*"[^>]*>([^<]+)<\/a>/gi
    const reRel = /href="\/workflows\/(\d+)[^"]*"[^>]*>([^<]+)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = reAbs.exec(html)) && results.length < 3) {
      const id = m[1]
      const title = m[2].trim()
      const url = `https://n8n.io/workflows/${id}`
      const importUrl = `https://automation.whitelabel.lat/templates/${id}/setup`
      results.push({ id, title, url, importUrl })
    }
    while ((m = reRel.exec(html)) && results.length < 3) {
      const id = m[1]
      const title = m[2].trim()
      const url = `https://n8n.io/workflows/${id}`
      const importUrl = `https://automation.whitelabel.lat/templates/${id}/setup`
      // Avoid duplicates
      if (!results.find((r) => r.id === id)) {
        results.push({ id, title, url, importUrl })
      }
    }
  }
  if (results.length === 0) {
    // Fallback to DuckDuckGo
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(`site:n8n.io/workflows ${query}`)}`
    const html = await fetchHtml(url)
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) && results.length < 3) {
      let href = m[1]
      const title = m[2].replace(/<[^>]+>/g, '').trim()
      const u = href.match(/uddg=([^&]+)/)
      if (u) href = decodeURIComponent(u[1])
      const idMatch = href.match(/\/workflows\/(\d+)/)
      if (!idMatch) continue
      const id = idMatch[1]
      const importUrl = `https://automation.whitelabel.lat/templates/${id}/setup`
      results.push({ id, title, url: href, importUrl })
    }
  }
  return results
}

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

app.post('/v1/chat', verifyAuth, async (req, res) => {
  const reqId = (req as any).reqId || '-'
  const body = req.body || {}
  const payload = body.payload || {}
  const sessionId = body.sessionId || uuidv4()
  const text = typeof payload?.text === 'string' ? payload.text : typeof body?.question === 'string' ? body.question : ''
  if (!text && !('type' in payload)) {
    res.status(400).json({ code: 400, message: 'payload required' })
    return
  }
  if (!ANTHROPIC_KEY) {
    res.status(500).json({ code: 500, message: 'Service misconfigured: ANTHROPIC key missing' })
    return
  }
  res.setHeader('Content-Type', 'application/json')
  try {
    const userTextBase = text || JSON.stringify(payload)
    const allMessages: any[] = []
    if (payload?.context) {
      const toolStart = {
        role: 'assistant',
        type: 'tool',
        toolName: 'read_workflow_context',
        displayTitle: 'Leyendo contexto del workflow',
        status: 'running',
        updates: [
          { type: 'input', data: { hasActiveNodeInfo: !!payload?.context?.activeNodeInfo } },
        ],
      }
      allMessages.push(toolStart)
      const toolDone = {
        role: 'assistant',
        type: 'tool',
        toolName: 'read_workflow_context',
        displayTitle: 'Contexto del workflow leído',
        status: 'completed',
        updates: [{ type: 'output', data: { nodeType: payload?.context?.activeNodeInfo?.node?.type } }],
      }
      allMessages.push(toolDone)
    }
    const searchDocsStart = {
      role: 'assistant',
      type: 'tool',
      toolName: 'search_docs',
      displayTitle: 'Buscando en documentación de n8n',
      status: 'running',
      updates: [{ type: 'input', data: { query: userTextBase } }],
    }
    allMessages.push(searchDocsStart)
    const docs = await searchDocs(userTextBase)
    const searchDocsDone = {
      role: 'assistant',
      type: 'tool',
      toolName: 'search_docs',
      displayTitle: 'Documentación consultada',
      status: 'completed',
      updates: [{ type: 'output', data: { results: docs } }],
    }
    allMessages.push(searchDocsDone)

    const searchForumStart = {
      role: 'assistant',
      type: 'tool',
      toolName: 'search_forum',
      displayTitle: 'Buscando en foro de la comunidad',
      status: 'running',
      updates: [{ type: 'input', data: { query: userTextBase } }],
    }
    allMessages.push(searchForumStart)
    const forum = await searchForum(userTextBase)
    const searchForumDone = {
      role: 'assistant',
      type: 'tool',
      toolName: 'search_forum',
      displayTitle: 'Foro consultado',
      status: 'completed',
      updates: [{ type: 'output', data: { results: forum } }],
    }
    allMessages.push(searchForumDone)

    const searchTemplatesStart = {
      role: 'assistant',
      type: 'tool',
      toolName: 'search_templates',
      displayTitle: 'Buscando plantillas de workflows',
      status: 'running',
      updates: [{ type: 'input', data: { query: userTextBase } }],
    }
    allMessages.push(searchTemplatesStart)
    const templates = await searchTemplates(userTextBase)
    const searchTemplatesDone = {
      role: 'assistant',
      type: 'tool',
      toolName: 'search_templates',
      displayTitle: 'Plantillas consultadas',
      status: 'completed',
      updates: [{ type: 'output', data: { results: templates } }],
    }
    allMessages.push(searchTemplatesDone)

    const sourcesText = [
      docs.length ? `Docs:\n${docs.map((d) => `- ${d.title} (${d.url})`).join('\n')}` : '',
      forum.length ? `Forum:\n${forum.map((d) => `- ${d.title} (${d.url})`).join('\n')}` : '',
      templates.length
        ? `Templates:\n${templates
            .map((t) => `- ${t.title} (${t.url})\n  Importar: ${t.importUrl}`)
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const userText = sourcesText ? `${userTextBase}\n\nFuentes:\n${sourcesText}` : userTextBase
    const wantsTemplates = /\b(template|plantilla|workflow|plantillas|templates)\b/i.test(text || '')
    if (templates.length && wantsTemplates) {
      const pretty = templates
        .map(
          (t) => `• ${t.title}\n  Ver: ${t.url}\n  Importar: ${t.importUrl}`,
        )
        .join('\n\n')
      const tplMsg = {
        role: 'assistant',
        type: 'message',
        text: `Plantillas encontradas:\n\n${pretty}`,
        quickReplies: [
          { type: 'new-suggestion', text: 'Buscar más plantillas' },
          { type: 'resolved', text: 'Listo, gracias', isFeedback: true },
        ],
      }
      const line = { sessionId, messages: [...allMessages, tplMsg] }
      res.json(line)
      return
    }
    const r = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: 'Eres un asistente de n8n. Cuando incluyas código, usa bloques con triple acento grave separados por sección y especifica el lenguaje, por ejemplo ```javascript ... ``` o ```sql ... ```, etc...',
      messages: [{ role: 'user', content: userText }],
    })
    const raw = r.content?.map((c: any) => ('text' in c ? c.text : '')).join('\n') || ''
    if (templates.length) {
      const md = templates
        .map(
          (t) => `- [${t.title}](${t.url})  \\
  Importar en tu instancia: [Abrir](${t.importUrl})`,
        )
        .join('\n')
      const blockMsg = {
        role: 'assistant',
        type: 'block',
        title: 'Plantillas encontradas',
        content: md,
      }
      allMessages.push(blockMsg)
      const guideMsg = {
        role: 'assistant',
        type: 'message',
        text:
          'Para importar una plantilla, haz clic en "Abrir" junto a la plantilla deseada. Se abrirá en tu instancia para configurar: parámetros, credenciales y ajustes. Si quieres otra búsqueda, dime la app o el caso de uso.',
        quickReplies: [
          { type: 'new-suggestion', text: 'Buscar más plantillas' },
          { type: 'resolved', text: 'Listo, gracias', isFeedback: true },
        ],
      }
      allMessages.push(guideMsg)
    }
    const blocks: any[] = []
    const re = /```([\w+-]*)\n([\s\S]*?)```/g
    let lastIndex = 0
    let m: RegExpExecArray | null
    const codeMatches: Array<{ lang: string; code: string }> = []
    while ((m = re.exec(raw)) !== null) {
      const pre = raw.slice(lastIndex, m.index).trim()
      if (pre) blocks.push({ role: 'assistant', type: 'message', text: pre })
      const lang = m[1] || 'text'
      const code = m[2].trim()
      const snippet = `\`\`\`${lang}\n${code}\n\`\`\``
      blocks.push({ role: 'assistant', type: 'message', text: '', codeSnippet: snippet })
      codeMatches.push({ lang, code })
      lastIndex = re.lastIndex
    }
    const post = raw.slice(lastIndex).trim()
    if (post) blocks.push({ role: 'assistant', type: 'message', text: post })
    if (blocks.length === 0) {
      blocks.push({ role: 'assistant', type: 'message', text: raw.trim() })
    }
    const quickReplies = [
      { type: 'new-suggestion', text: 'Dame otra solución' },
      { type: 'resolved', text: 'Sí, gracias', isFeedback: true },
    ]

    const nodeParams = (payload?.context?.activeNodeInfo?.node?.parameters || payload?.workflowContext?.activeNodeInfo?.node?.parameters || undefined) as any
    const oldCode = typeof nodeParams?.jsCode === 'string' ? nodeParams.jsCode : undefined
    let preferredNewCode = ''
    if (codeMatches.length > 0) {
      const nodeLangRaw = String((nodeParams?.language ?? '')).toLowerCase()
      const prefersPython = nodeLangRaw.includes('python')
      const prefersTs = nodeLangRaw.includes('typescript') || nodeLangRaw.includes('ts')
      const prefersJs = nodeLangRaw.includes('javascript') || nodeLangRaw.includes('js')
      const order: string[] = prefersPython
        ? ['python', 'typescript', 'ts', 'javascript', 'js', 'text']
        : prefersTs
        ? ['typescript', 'ts', 'javascript', 'js', 'python', 'text']
        : prefersJs
        ? ['javascript', 'js', 'typescript', 'ts', 'python', 'text']
        : ['javascript', 'js', 'typescript', 'ts', 'python', 'text']
      const preferred = codeMatches.find((c) => order.includes(c.lang.toLowerCase())) || codeMatches[0]
      preferredNewCode = preferred.code
    }

    if (oldCode && preferredNewCode) {
      const progressStart = {
        role: 'assistant',
        type: 'tool',
        displayTitle: 'Generando propuesta de reemplazo',
        toolName: 'apply_suggestion',
        status: 'running',
      }
      allMessages.push(progressStart)
      const oldLines = oldCode.split('\n')
      const newLines = preferredNewCode.split('\n')
      let diff = `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
      for (const l of oldLines) diff += `-${l}\n`
      for (const l of newLines) diff += `+${l}\n`
      const suggestionId = uuidv4()
      suggestionsStore.set(suggestionId, { sessionId, original: oldCode, proposed: preferredNewCode })
      const codeDiffMsg: any = {
        role: 'assistant',
        type: 'code-diff',
        description: 'Sugerencia de reemplazo del nodo Code',
        codeDiff: diff,
        suggestionId,
        quickReplies,
      }
      blocks.push(codeDiffMsg)
      const progressDone = {
        role: 'assistant',
        type: 'tool',
        displayTitle: 'Propuesta generada',
        toolName: 'apply_suggestion',
        status: 'completed',
      }
      allMessages.push(progressDone)
    } else {
      const last = blocks[blocks.length - 1]
      if (last) last.quickReplies = quickReplies
    }
    const line = { sessionId, messages: [...allMessages, ...blocks] }
    res.json(line)
  } catch (e: any) {
    const msg = e?.message || 'Chat failed'
    const status = e?.status || e?.statusCode || 500
    const line = { sessionId, messages: [{ role: 'assistant', type: 'error', content: msg }] }
    res.status(status === 401 ? 401 : 200).json(line)
    console.log(`[askai:${reqId}] chat error status=${status} message=${msg}`)
  }
})

app.post('/v1/chat/apply-suggestion', verifyAuth, async (req, res) => {
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
})

app.post('/ai/chat/apply-suggestion', verifyAuth, async (req, res) => {
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
