import { Router } from "express";

import { createLogger } from "../lib/logger.js";
import { verifyBlingSignature } from "../lib/verifyBlingSignature.js";
import { syncProductFromBlingEvent } from "../services/syncProduct.js";

const router = Router();
const logger = createLogger("blingProducts");

router.post("/", async (req, res) => {
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

  const eventType = req.get("X-Bling-Event") || req.get("X-Bling-Event-Type") || "unknown";
  const syncTraceMeta = {
    eventType,
    path: req.path,
    source: "bling_products_webhook",
    requestId: req.get("X-Request-Id") ?? null,
  };

  logger.info("bling_products_sync_invocation", {
    ...syncTraceMeta,
    normalizedEvent: eventType,
  });

  logger.info("Bling products webhook received", {
    eventType,
  });

  try {
    const result = await syncProductFromBlingEvent(req.body, syncTraceMeta);
    logger.info("bling_products_sync_success", {
      ...syncTraceMeta,
      result_stage: result?.result_stage ?? "sync_complete",
    });

    return res.status(200).json({
      ok: true,
      source: "bling_products",
      synced: true,
      result_summary: {
        stage: result?.result_stage ?? null,
        shopify_product_id: result?.product?.id ?? null,
      },
    });
  } catch (error) {
    logger.error("bling_products_sync_failure", {
      ...syncTraceMeta,
      error: error?.message ?? "unknown_error",
      stage: error?.stage ?? error?.result_stage ?? "unknown",
      sync_trace_id: error?.sync_trace_id ?? null,
      details: error?.details ?? null,
    });

    const errorPayload = {
      error: error?.code ?? "sync_error",
      message: error?.message ?? "sync failed",
      stage: error?.stage ?? error?.result_stage ?? "unknown",
      sync_trace_id: error?.sync_trace_id ?? null,
    };

    return res.status(500).json(errorPayload);
  }
});

export default router;
