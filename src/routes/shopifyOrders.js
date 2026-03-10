import { Router } from "express";

import { createLogger } from "../lib/logger.js";
import { verifyShopifySignature } from "../lib/verifyShopifySignature.js";
import { syncOrderFromShopifyEvent } from "../services/syncOrder.js";

const router = Router();
const logger = createLogger("shopifyOrders");

const handlers = [
  { path: "/orders-create", eventType: "orders/create" },
  { path: "/orders-updated", eventType: "orders/updated" },
  { path: "/orders-cancelled", eventType: "orders/cancelled" },
];

handlers.forEach(({ path, eventType }) => {
  router.post(path, (req, res) => {
    if (!verifyShopifySignature(req)) {
      logger.warn("Invalid Shopify signature", { headers: req.headers, eventType });
      return res.status(401).json({ error: "invalid_signature" });
    }

    res.status(200).json({ received: true });

    logger.info("Shopify webhook received", { eventType });
    void syncOrderFromShopifyEvent(req.body, { eventType }).catch((error) => {
      logger.error("Failed to sync Shopify order", { error, eventType, payload: req.body });
    });
  });
});

export default router;
