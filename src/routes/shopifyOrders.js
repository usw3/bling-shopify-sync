import { Router } from "express";

import { createLogger } from "../lib/logger.js";
import { verifyShopifyWebhook } from "../lib/verifyShopifyWebhook.js";

const router = Router();
const logger = createLogger("shopifyOrders");

const handlers = [
  { path: "/orders-create", eventType: "orders/create" },
  { path: "/orders-updated", eventType: "orders/updated" },
  { path: "/orders-cancelled", eventType: "orders/cancelled" },
];

handlers.forEach(({ path, eventType }) => {
  router.post(path, (req, res) => {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret) {
      logger.warn("Shopify webhook secret is missing", { eventType });
      return res.status(503).json({ error: "missing_shopify_webhook_secret" });
    }

    const signature = req.get("X-Shopify-Hmac-Sha256");
    const valid = verifyShopifyWebhook({
      rawBody: req.rawBody,
      signature,
      secret,
    });

    if (!valid) {
      logger.warn("Invalid Shopify webhook signature", { eventType });
      return res.status(401).json({ error: "invalid_signature" });
    }

    logger.info("Shopify webhook received", {
      topic: eventType,
      webhookTopicHeader: req.get("X-Shopify-Topic") || null,
    });

    return res.status(200).json({ ok: true, topic: eventType });
  });
});

export default router;
