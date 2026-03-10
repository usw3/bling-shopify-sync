# Bling Shopify Sync

Safe middleware skeleton for Bling <-> Shopify integrations, ready to run on Railway.

This patch is intentionally minimal and production-safe:
- stable Express boot
- quick health endpoints
- webhook routes with signature validation stubs
- Shopify token utility via client credentials grant
- no database, no queues, no background jobs, and no sync side effects yet

## Local run
1. Install dependencies:
   - `npm install`
2. Create local env file:
   - `cp .env.example .env`
3. Start server:
   - `npm start`
4. Test health routes:
   - `GET /`
   - `GET /health`

## Railway deployment
Railway compatibility is preserved:
- app binds to host `0.0.0.0`
- app reads port from `process.env.PORT` (with local fallback to `3000`)
- startup does not depend on external API calls

Required on Railway:
- Public networking enabled
- Healthcheck path set to `/health` (or `/`)
- Environment variables configured (see `.env.example`)

## Environment variables
From `.env.example`:
- `PORT` (default local: `3000`)
- `BLING_CLIENT_ID`
- `BLING_CLIENT_SECRET`
- `BLING_ACCESS_TOKEN`
- `BLING_REFRESH_TOKEN`
- `BLING_WEBHOOK_SECRET`
- `SHOPIFY_STORE`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_API_VERSION` (default: `2026-01`)

## Public routes
- `GET /`
  - returns `{ service, status, timestamp }`
- `GET /health`
  - returns `{ status: "ok" }`
- `GET /bling/oauth`
  - exchanges Bling `?code=` for OAuth tokens and returns masked token previews
- `GET /debug/bling-auth`
  - resolves a valid Bling access token using in-memory cache + automatic refresh (debug only)
- `POST /webhooks/bling/products`
- `POST /webhooks/bling/invoices`
- `POST /webhooks/shopify/orders-create`
- `POST /webhooks/shopify/orders-updated`
- `POST /webhooks/shopify/orders-cancelled`

## Webhook signature headers
- Bling routes validate `X-Bling-Signature-256`
- Shopify routes validate `X-Shopify-Hmac-Sha256`

If required webhook secrets are missing, routes fail gracefully with readable `503` errors. Invalid signatures return `401`.

## Shopify auth utility
`src/lib/shopifyAuth.js` provides:
- `getShopifyAccessToken()`
  - obtains token via client credentials grant
  - caches token in memory with expiration
  - refreshes automatically when expired
- `shopifyGraphQL(query, variables)`
  - fetches token automatically
  - calls Shopify GraphQL Admin API
  - throws readable errors without exposing secrets

## Current scope
This repository is now a safe middleware base.

It does **not** perform full Bling/Shopify synchronization yet.

## Bling OAuth helper
1. Open your Bling app authorization/invite link.
2. After approving, Bling redirects to `GET /bling/oauth?code=...`.
3. The middleware exchanges the code for tokens automatically, seeds in-memory cache, and keeps refresh token available.
4. Automatic refresh happens when token expiry is near (`getValidBlingAccessToken` refreshes if needed).
5. Test refresh/cached access token resolution at `GET /debug/bling-auth`.
6. Token values returned by endpoints are masked previews only; full tokens are never returned.
7. For now, token cache is in memory only (no database persistence yet).
