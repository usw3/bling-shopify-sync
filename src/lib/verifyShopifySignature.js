import { verifyShopifyWebhook } from "./verifyShopifyWebhook.js";

export function verifyShopifySignature(req) {
  return verifyShopifyWebhook({
    rawBody: req.rawBody,
    signature: req.get("X-Shopify-Hmac-Sha256"),
    secret: process.env.SHOPIFY_WEBHOOK_SECRET,
  });
}
