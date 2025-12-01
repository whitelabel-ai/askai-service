# AskAI Service

Servicio HTTP en Node.js + TypeScript para asistir a n8n con generación de código y chat usando Anthropic.

## Características

- Autenticación basada en JWT (`/auth/token`).
- Endpoint de ayuda para generar código (`/ask-ai`).
- Chat con respuesta en formato NDJSON (`/chat`).
- Endpoint para aplicar sugerencias (`/chat/apply-suggestion`).
- Dockerfile listo para build y despliegue.
- Workflow de GitHub Actions para build y push de la imagen.

## Requisitos

- Node.js 20+
- Registro de contenedores accesible si se usa CI/CD (`registry.whitelabel.lat`).
- Clave de Anthropic válida.

## Variables de entorno

- `JWT_SECRET`: Secreto para firmar/verificar tokens JWT. Por defecto `dev-secret`.
- `N8N_AI_ANTHROPIC_KEY`: API key de Anthropic.
- `PORT`: Puerto HTTP del servicio. Por defecto `8080`.

## Instalación y scripts

```bash
npm install
npm run dev     # desarrollo con tsx
npm run build   # compilar a dist
npm start       # ejecutar dist/server.js
```

## Endpoints

### POST `/auth/token`

Genera un token de acceso de corta duración.

Body:

```json
{
  "licenseCert": "<string>"
}
```

Respuesta:

```json
{
  "accessToken": "<jwt>"
}
```

Ejemplo:

```bash
curl -X POST http://localhost:8080/auth/token \
  -H "Content-Type: application/json" \
  -d '{"licenseCert":"demo"}'
```

### POST `/ask-ai`

Genera código a partir de una pregunta y contexto.

Headers: `Authorization: Bearer <jwt>`

Body:

```json
{
  "question": "¿Cómo crear un nodo HTTP?",
  "context": {"workflowId": "..."},
  "forNode": {"type": "httpRequest"}
}
```

Respuesta:

```json
{
  "code": "<texto de código>"
}
```

Ejemplo:

```bash
curl -X POST http://localhost:8080/ask-ai \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"question":"...","context":{},"forNode":{}}'
```

### POST `/chat`

Flujo de chat que responde en NDJSON (líneas JSON). Puede enviar `payload.text` o un objeto completo en `payload`.

Headers: `Authorization: Bearer <jwt>`

Body mínimo:

```json
{
  "payload": {"text": "Hola"},
  "sessionId": "<opcional>"
}
```

Respuesta: `application/x-ndjson`, cada línea contiene `sessionId` y `messages`.

Ejemplo:

```bash
curl -N -X POST http://localhost:8080/chat \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"text":"Hola"}}'
```

### POST `/chat/apply-suggestion`

Aplica una sugerencia referenciada por `suggestionId` en una sesión `sessionId`.

Body:

```json
{
  "sessionId": "<string>",
  "suggestionId": "<string>"
}
```

Respuesta:

```json
{
  "sessionId": "<string>",
  "parameters": {}
}
```

## Ejecutar con Docker

Construcción local:

```bash
docker build -f Dockerfile -t askai-service:local .
docker run -p 8080:8080 -e JWT_SECRET=dev -e N8N_AI_ANTHROPIC_KEY=sk-xxx askai-service:local
```

## CI/CD

El workflow `.github/workflows/deploy-askai-service.yml`:

- Se ejecuta en `push` a `main` o manualmente.
- Construye con Buildx (`linux/amd64`).
- Publica etiquetas `latest` y `<sha>` en `registry.whitelabel.lat/whitelabel-ai/askai-service`.

Requiere `REGISTRY_USERNAME` y `REGISTRY_PASSWORD` como secretos de GitHub.

## Seguridad

- Mantén `JWT_SECRET` fuera del repositorio y de logs.
- La clave `N8N_AI_ANTHROPIC_KEY` debe almacenarse como secreto.
- Usa HTTPS en producción y limita CORS si es necesario.

## Licencia

Propietario. Uso interno.

