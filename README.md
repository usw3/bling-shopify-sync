# Bling Shopify Sync

Middleware that bridges Bling webhooks with Shopify webhooks so products, invoices, and orders stay aligned without persisting state locally.

## Local development
1. `npm install`
2. Copy `.env.example` to `.env` and fill in the credentials for Bling and Shopify attacks.
3. `npm start` to listen for requests on `PORT` (default 3000).
4. Expose the server via tools like `ngrok` when testing Bling or Shopify webhooks locally.

## Webhook surface
- `GET /` — health/status check returning a timestamp.
- `POST /webhooks/bling/products` — handles product create/update/delete events from Bling.
- `POST /webhooks/bling/invoices` — handles emitted notas fiscais.
- `POST /webhooks/shopify/orders-create` — catches `orders/create` events.
- `POST /webhooks/shopify/orders-updated` — catches `orders/updated` events.
- `POST /webhooks/shopify/orders-cancelled` — catches `orders/cancelled` events.

Every webhook validates the secret against `x-bling-event`/`x-shopify-hmac-sha256` headers, logs the event, and responds with `200` before delegating to the async sync handlers.

## Sync responsibilities
- `syncProductFromBlingEvent` turns a Bling product payload into a Shopify product (or updates the existing one when a SKU matches). It also maps `descricaoComplementar`/`complemento` into the `custom.descricao_complementar` metafield so the extra descriptive text survives the move to Shopify.
- `syncOrderFromShopifyEvent` converts Shopify `orders/*` payloads into Bling invoice creation requests and skips invoices when cancellations arrive. This is where you would eventually update or cancel the Bling nota fiscal to mirror Shopify.
- `syncInvoiceFromBlingEvent` creates or updates Shopify orders from Bling nota fiscal data and is ready to be extended with fulfillment reconciliation.

## Shopify helpers
- `findVariantBySku` performs a GraphQL `productVariants` search on the Shopify store to locate an existing variant/product before deciding to create or update anything.
- `setProductMetafield` issues a GraphQL `metafieldsSet` mutation to persist `descricaoComplementar` in `custom.descricao_complementar` for the Shopify product.

Example GraphQL mutation for the metafield:

```graphql
mutation setDescriptionMetafield {
  metafieldsSet(
    metafields: [
      {
        ownerId: "gid://shopify/Product/1234567890"
        namespace: "custom"
        key: "descricao_complementar"
        type: "single_line_text_field"
        value: "Texto complementar vindo do Bling"
      }
    ]
  ) {
    metafields {
      id
      namespace
      key
    }
    userErrors {
      field
      message
    }
  }
}
```

## Railway deployment
Railway can run this project with a simple `npm start`. Set the following environment variables in Railway (matching `.env.example`) before deploying:
- `PORT`
- `BLING_ACCESS_TOKEN`
- `BLING_WEBHOOK_SECRET`
- `BLING_API_URL` (optional override)
- `SHOPIFY_STORE`
- `SHOPIFY_ADMIN_TOKEN`
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_API_VERSION` (defaults to `2026-01`)

Steps to deploy with Railway:
1. `railway login`
2. `railway init` (choose a project or create a new one).
3. Push the repository and set the required environment variables via the Railway dashboard or `railway env` commands.
4. `railway up` to start the service.

## Next steps
- Implement retries and queueing for the outbound API calls in case the downstream services are unavailable.
- Add automated tests for the signature validators and sync helpers.
- Extend the reconciliation strategy so Bling invoices can update Shopify fulfillment/order status and vice versa.
