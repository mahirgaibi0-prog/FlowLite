# FlowLite Backend Starter

Node.js 20+ API starter for the FlowLite workflow builder.

## Included
- Email/password signup and login (bcrypt password hashes, 7-day JWT)
- PostgreSQL workflow and execution storage
- Manual workflow execution: Trigger, Set, IF, HTTP Request, AI Agent, Output
- Per-user encrypted AI credentials (AES-256-GCM)
- Basic rate limiting, Helmet, CORS allow-list, request size limit
- Basic outbound URL checks intended to reduce SSRF risk

## Not included yet
- Public webhooks
- Background/24-7 execution or durable scheduling
- Email verification and password reset
- Production-grade SSRF/network isolation
- Full backend parity for Switch, Merge, Delay, retries, and every frontend node

This is starter code, not a deployed service. It has not yet been tested against a live database or hosting provider.

## Local setup
1. Install Node.js 20+ and PostgreSQL.
2. Create a database and run `psql "$DATABASE_URL" -f schema.sql`.
3. Copy `.env.example` to `.env` and fill every secret.
4. Generate a 32-byte credentials key (example: `openssl rand -base64 32`).
5. Run `npm install`, then `npm start`.

## API
- `GET /health`
- `POST /api/auth/signup` { email, password }
- `POST /api/auth/login` { email, password }
- `GET /api/me` (Bearer token)
- `GET /api/workflows`
- `POST /api/workflows` { name, definition }
- `PUT /api/workflows/:id` { name, definition }
- `DELETE /api/workflows/:id`
- `POST /api/workflows/:id/run` { input }
- `GET /api/executions`
- `PUT /api/credentials/:name` { secret }
- `DELETE /api/credentials/:name`

## Important security notes
- Use HTTPS in deployment and keep `.env` private. Never commit API keys or database passwords.
- Restrict CORS to the exact frontend origin.
- The URL validation is only a basic guard. DNS rebinding and other network edge cases require network-level egress controls; do not expose this as a hardened public service.
- Webhook and scheduling features are deliberately absent until authentication, abuse controls, and durable workers are designed.
- Never use real customer data until the service has been independently security-reviewed.