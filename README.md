# AskAI Service

Servicio Express para integrar el Asistente de n8n con Anthropic, entregando respuestas en streaming y funcionalidades mejoradas como bloques de código copiables, sugerencias de reemplazo (`code-diff`) y señales de progreso.

## Endpoints

- `POST /auth/token`
  - Genera `accessToken` firmado con `JWT_SECRET` usando `{ licenseCert }` en el body.

- `POST /v1/ask-ai`
  - Genera código para el nodo Code.
  - Request: `{ question: string, context: object, forNode: 'code' }`
  - Response: `{ code: string }` (sin fences ni explicación).

- `POST /v1/chat`
  - Chat en streaming (`Content-Type: application/json-lines`).
  - Respuestas con estructura `{ sessionId, messages: ChatMessage[] }` por línea.
  - Soporta:
    - Mensajes de texto: `{ role: 'assistant', type: 'message', text }`
    - Bloques de código: `{ role: 'assistant', type: 'message', codeSnippet: '```lang\n...\n```' }`
    - Sugerencias de reemplazo: `{ role: 'assistant', type: 'code-diff', description, codeDiff, suggestionId }`
    - Señales de progreso: `{ role: 'assistant', type: 'tool', displayTitle, toolName, status }`

- `POST /v1/chat/apply-suggestion`
  - Aplica una sugerencia `code-diff` al nodo Code.
  - Request: `{ sessionId: string, suggestionId: string }`
  - Response: `{ sessionId, parameters: { jsCode: string } }`

También se exponen rutas alternativas por compatibilidad:
- `POST /ai/chat/apply-suggestion`

## Formato de Streaming

- Cada `res.write(JSON.stringify({ sessionId, messages }) + '\n')` agrega una línea del stream.
- El cliente del editor procesa cada línea secuencialmente.
  - Ejemplo:
    1. Progreso: `{ role: 'assistant', type: 'tool', displayTitle: 'Generando propuesta...', status: 'running' }`
    2. Progreso: `{ role: 'assistant', type: 'tool', displayTitle: 'Propuesta generada', status: 'completed' }`
    3. Mensajes finales: `message + codeSnippet + code-diff` según corresponda.

## Preferencia de Lenguaje

- Si el contexto del nodo Code incluye `parameters.language`, se prioriza el bloque de código con ese lenguaje:
  - `python` → orden: `python`, `typescript`, `ts`, `javascript`, `js`, `text`
  - `typescript` → orden: `typescript`, `ts`, `javascript`, `js`, `python`, `text`
  - `javascript` (default) → orden: `javascript`, `js`, `typescript`, `ts`, `python`, `text`

## Variables de Entorno

- `N8N_AI_ANTHROPIC_KEY` o `ANTHROPIC_API_KEY`: clave de Anthropic.
- `ANTHROPIC_MODEL`: modelo del chat/Ask AI (default `claude-haiku-4-5`).
- `BUILDER_MODEL`: fuerza el modelo del AI Builder (default: se respeta el que manda n8n).
- `BUILDER_ENABLED`: `false`/`0`/`no`/`off` apaga el AI Builder ("Build with AI") sin
  afectar el chat ni Ask AI. n8n muestra "0/100 créditos" y deshabilita el envío.
- `CHAT_STREAMING`: `true`/`1`/`yes`/`on` activa el streaming progresivo del chat
  (JSON-lines). Apagado por defecto: respuesta bufferada clásica (más estable).
- `LLM_BASE_URL`: gateway compatible-Anthropic (default `https://api.anthropic.com`).
- `ASKAI_SECRETS`: lista separada por comas de secretos de URL (multi-instancia).
- `FIRECRAWL_URL`: instancia Firecrawl para grounding (default `https://firecrawl.lab.whitelabel.lat`).
- `N8N_BASE_URL`: instancia n8n para los links de "Importar plantilla".
- `JWT_SECRET`: secreto para firmar `accessToken`.
- `PORT`: puerto del servicio (default `8080`).

## Desarrollo

- Compilar: `npm run build`
- Ejecutar: `npm run start`
- Healthcheck: `GET /healthz` → `{ ok: true }`

## Notas

- Los bloques `codeSnippet` usan fences; el botón “Copy” del editor copia solo el contenido interno.
- `code-diff` devuelve un parche unificado, y el editor resuelve Replace/Undo llamando a `apply-suggestion`.
