import { Router } from "express";

import { createLogger } from "../lib/logger.js";
import { verifyBlingSignature } from "../lib/verifyBlingSignature.js";

const router = Router();
const logger = createLogger("blingProducts");

router.post("/", (req, res) => {
  const secret = process.env.BLING_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("Bling products webhook secret is missing");
    return res.status(503).json({ error: "missing_bling_webhook_secret" });
  }

  const signature = req.get("X-Bling-Signature-256");
  logger.info("Bling products signature diagnostics", {
    hasRawBody: Boolean(req.rawBody),
    rawBodyLength: Buffer.isBuffer(req.rawBody)
      ? req.rawBody.length
      : typeof req.rawBody === "string"
        ? req.rawBody.length
        : 0,
    xBlingSignature256: signature ?? null,
  });

  const valid = verifyBlingSignature({
    rawBody: req.rawBody,
    signature,
    secret,
  });

  if (!valid) {
    logger.warn("Invalid Bling products signature");
    return res.status(401).json({ error: "invalid_signature" });
  }

  logger.info("Bling products webhook received", {
    eventType: req.get("X-Bling-Event") || req.get("X-Bling-Event-Type") || "unknown",
  });

  return res.status(200).json({
    ok: true,
    source: "bling_products",
  });
});

export default router;
