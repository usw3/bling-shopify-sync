import dotenv from "dotenv";
import express from "express";

import { createLogger } from "./src/lib/logger.js";
import { attachRawBody } from "./src/lib/rawBody.js";
import { verifyBlingSignature } from "./src/lib/verifyBlingSignature.js";
import blingProductsRouter from "./src/routes/blingProducts.js";
import blingInvoicesRouter from "./src/routes/blingInvoices.js";
import debugBlingRouter from "./src/routes/debugBling.js";
import shopifyOrdersRouter from "./src/routes/shopifyOrders.js";
import debugProjectRouter from "./src/routes/debugProject.js";
import { exchangeBlingCodeForToken, previewToken } from "./src/services/blingAuth.js";
import { syncProductFromBlingEvent } from "./src/services/syncProduct.js";

dotenv.config();

const app = express();
const logger = createLogger("server");
const port = Number(process.env.PORT) || 3000;
app.disable("x-powered-by");
app.use(express.json({ verify: attachRawBody, limit: "1mb" }));
app.use(express.urlencoded({ extended: true, verify: attachRawBody, limit: "1mb" }));
app.use("/debug/project", debugProjectRouter);

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "bling-shopify-sync",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.post("/", async (req, res) => {
  const blingSignature = req.get("X-Bling-Signature-256");
  const blingEvent = req.get("X-Bling-Event") || req.get("X-Bling-Event-Type");
  const isBling = Boolean(blingSignature || blingEvent);

  if (!isBling) {
    return res.status(404).json({ error: "unknown_webhook" });
  }

  const secret = process.env.BLING_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("Root webhook missing BLING_WEBHOOK_SECRET");
    return res.status(503).json({ error: "missing_bling_webhook_secret" });
  }

  const valid = verifyBlingSignature({
    rawBody: req.rawBody,
    signature: blingSignature,
    secret,
  });

  if (!valid) {
    logger.warn("Root webhook invalid Bling signature");
    return res.status(401).json({ error: "invalid_signature" });
  }

  const eventType = blingEvent || "unknown";
  const syncTraceMeta = {
    eventType,
    path: req.path,
    source: "root_webhook",
    requestId: req.get("X-Request-Id") ?? null,
  };

  logger.info("root_webhook_bling_invocation", {
    ...syncTraceMeta,
    normalizedEvent: eventType,
  });

  try {
    const result = await syncProductFromBlingEvent(req.body, syncTraceMeta);
    logger.info("root_webhook_bling_success", {
      ...syncTraceMeta,
      result_stage: result?.result_stage ?? "sync_complete",
    });

    return res.status(200).json({
      ok: true,
      source: "bling_products_root",
      synced: true,
      result_summary: {
        stage: result?.result_stage ?? null,
        shopify_product_id: result?.product?.id ?? null,
      },
    });
  } catch (error) {
    logger.error("root_webhook_bling_failure", {
      ...syncTraceMeta,
      error: error?.message ?? "unknown_error",
      stage: error?.stage ?? error?.result_stage ?? "unknown",
      sync_trace_id: error?.sync_trace_id ?? null,
      details: error?.details ?? null,
    });

    return res.status(500).json({
      error: error?.code ?? "sync_error",
      message: error?.message ?? "sync failed",
      stage: error?.stage ?? error?.result_stage ?? "unknown",
      sync_trace_id: error?.sync_trace_id ?? null,
    });
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/bling/oauth", (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    return res.status(400).json({ error: "missing_code" });
  }

  const allowOAuthDebug = process.env.BLING_OAUTH_DEBUG === "1";

  logger.info("Bling OAuth callback received", { receivedCode: true });

  return exchangeBlingCodeForToken(code)
    .then((tokenData) => {
      const accessPreview = previewToken(tokenData.access_token);
      const refreshPreview = previewToken(tokenData.refresh_token);

      logger.info("Bling OAuth token exchange succeeded", {
        tokenType: tokenData.token_type,
        expiresIn: tokenData.expires_in,
        accessTokenPreview: accessPreview,
        refreshTokenPreview: refreshPreview,
      });

      if (allowOAuthDebug) {
        logger.warn("Bling OAuth debug is enabled; returning full tokens in response");
      }

      const responsePayload = {
        ok: true,
        provider: "bling",
        received_code: true,
        token_type: tokenData.token_type,
        expires_in: tokenData.expires_in,
        scope: tokenData.scope,
        access_token_preview: accessPreview,
        refresh_token_preview: refreshPreview,
      };

      if (allowOAuthDebug) {
        responsePayload.access_token = tokenData.access_token;
        responsePayload.refresh_token = tokenData.refresh_token;
      }

      return res.status(200).json(responsePayload);
    })
    .catch((error) => {
      logger.warn("Bling OAuth token exchange failed");

      return res.status(502).json({
        error: "bling_token_exchange_failed",
        message: error?.message ?? "Unknown error while exchanging authorization code",
      });
    });
});

app.use("/webhooks/bling/products", blingProductsRouter);
app.use("/webhooks/bling/invoices", blingInvoicesRouter);
app.use("/webhooks/shopify", shopifyOrdersRouter);
app.use("/debug/bling-auth", debugBlingRouter);

app.use((error, _req, res, _next) => {
  logger.error("Unhandled request error", {
    message: error?.message ?? "unknown_error",
    name: error?.name ?? "Error",
  });
  res.status(500).json({ error: "internal_error" });
});

app.listen(port, "0.0.0.0", () => {
  logger.info("Server running", { host: "0.0.0.0", port });
});
