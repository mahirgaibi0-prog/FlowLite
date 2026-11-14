# FlowLite Cloudflare Worker + D1

Cloudflare-native backend replacement for the earlier Express/PostgreSQL starter.

## Included
- Health, signup/login, authenticated user lookup
- Workflow CRUD, manual execution, execution history
- Encrypted per-user credentials (Web Crypto AES-GCM); AI nodes use stored credentials only and are pinned to the OpenAI API endpoint
- PBKDF2-SHA256 password hashes (100,000 iterations) and HMAC-SHA256 JWT
- D1 schema migration; same general /api route family

## Not yet production-ready
- Frontend v2.1 is not in this GitHub repository. Exact client API calls/payloads still need to be inspected and wired.
- Public webhooks and scheduled workflow execution are not implemented.
- Workflow runner supports Trigger, Set, IF, HTTP, AI, Output only. Switch/Merge/Delay/retries are not supported server-side yet.
- HTTP nodes accept HTTPS destinations only, reject IP literals and common local/private hostnames, block sensitive header overrides, reject redirects, and cap response size. This is defense-in-depth, not a complete SSRF guarantee; do not use this as a public multi-tenant automation service yet.
- Free tier limits and Cloudflare availability apply; this is not a 100% uptime guarantee.

## Deploy manually (free plan only)
1. Create Cloudflare account and D1 database named flowlite-db.
2. Replace database_id in wrangler.toml with the ID from Cloudflare.
3. Install Wrangler: npm install -g wrangler; authenticate with npx wrangler login.
4. Apply migration: npx wrangler d1 migrations apply flowlite-db --remote.
5. Set secrets: npx wrangler secret put JWT_SECRET and npx wrangler secret put CREDENTIALS_KEY.
6. Set CORS_ORIGINS to exact frontend origin using Worker settings.
7. Deploy: npx wrangler deploy.

No paid resources are created by this repository. Do not add a payment method or enable paid plans to follow this guide.

## Security changes
- Request JSON is limited to 1 MiB; external HTTP responses are capped (64 KiB, AI response 256 KiB).
- HTTP nodes require HTTPS, reject IP-literal/local-style destinations, reject redirects, and cannot override Authorization/Cookie/Host/connection/content-length headers.
- AI nodes no longer accept a custom endpoint or inline API key. Save an OpenAI key through the encrypted Credentials API first.
- Password hashing uses 100,000 PBKDF2-SHA256 iterations to reduce CPU pressure on Workers Free. Measure actual CPU use after deployment; Cloudflare Free allows 10 ms CPU per request, so authentication may still need further optimization or a different design.
- These controls reduce risk but do not constitute a complete security audit or a guarantee against all SSRF/DNS edge cases.
