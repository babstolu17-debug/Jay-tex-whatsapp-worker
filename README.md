# Jay Tex WhatsApp Worker

Render settings:
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

Set `WORKER_SECRET` in Render Environment. For persistent WhatsApp sessions, attach a persistent disk mounted at `/data` and set `AUTH_ROOT=/data/sessions`.

Endpoints:
- `GET /health`
- `POST /pair` with header `x-worker-secret` and JSON `{"phone":"2348012345678"}`
- `GET /status/2348012345678` with header `x-worker-secret`
- `POST /send` with header `x-worker-secret` and JSON `{"phone":"2348012345678","jid":"...","text":"..."}`

Starter worker; test carefully and configure persistent session storage before production use.
