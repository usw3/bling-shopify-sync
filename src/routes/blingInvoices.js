import { Router } from "express";

import { createLogger } from "../lib/logger.js";
import { verifyBlingSignature } from "../lib/verifyBlingSignature.js";

const router = Router();
const logger = createLogger("blingInvoices");

router.post("/", (req, res) => {
  const secret = process.env.BLING_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("Bling invoices webhook secret is missing");
    return res.status(503).json({ error: "missing_bling_webhook_secret" });
  }

  const signature = req.get("X-Bling-Signature-256");
  const valid = verifyBlingSignature({
    rawBody: req.rawBody,
    signature,
    secret,
  });

  if (!valid) {
    logger.warn("Invalid Bling invoices signature");
    return res.status(401).json({ error: "invalid_signature" });
  }

  logger.info("Bling invoices webhook received", {
    eventType: req.get("X-Bling-Event") || req.get("X-Bling-Event-Type") || "unknown",
  });

  return res.status(200).json({
    ok: true,
    source: "bling_invoices",
  });
});

export default router;
