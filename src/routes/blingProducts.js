import { Router } from "express";

import { createLogger } from "../lib/logger.js";
import { verifyBlingSignature } from "../lib/verifyBlingSignature.js";
import { syncProductFromBlingEvent } from "../services/syncProduct.js";

const router = Router();
const logger = createLogger("blingProducts");

router.post("/", (req, res) => {
  if (!verifyBlingSignature(req)) {
    logger.warn("Invalid Bling product signature", { headers: req.headers });
    return res.status(401).json({ error: "invalid_signature" });
  }

  res.status(200).json({ received: true });

  const eventType = req.headers["x-bling-event"] ?? req.headers["x-bling-event-type"] ?? "product_change";
  void syncProductFromBlingEvent(req.body, { eventType }).catch((error) => {
    logger.error("Failed to sync Bling product", { error, eventType, payload: req.body });
  });
});

export default router;
