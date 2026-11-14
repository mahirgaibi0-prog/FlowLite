# FlowLite Cloudflare Worker + D1

Cloudflare-native backend replacement for the earlier Express/PostgreSQL starter.

## Included
- Health, signup/login, authenticated user lookup
- Workflow CRUD, manual execution, execution history
- Encrypted per-user credentials (Web Crypto AES-GCM)
- PBKDF2-SHA256 password hashes and HMAC-SHA256 JWT
- D1 schema migration; same general /api route family

## Not yet production-ready
- Frontend v2.1 is not in this GitHub repository. Exact client API calls/payloads still need to be inspected and wired.
- Public webhooks and scheduled workflow execution are not implemented.
- Workflow runner supports Trigger, Set, IF, HTTP, AI, Output only. Switch/Merge/Delay/retries are not supported server-side yet.
- HTTP URL checks are basic and are not a complete SSRF defense.
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
