import dotenv from "dotenv";
import express from "express";

import { createLogger } from "./src/lib/logger.js";
import { attachRawBody } from "./src/lib/rawBody.js";
import blingProductsRouter from "./src/routes/blingProducts.js";
import blingInvoicesRouter from "./src/routes/blingInvoices.js";
import debugBlingRouter from "./src/routes/debugBling.js";
import shopifyOrdersRouter from "./src/routes/shopifyOrders.js";
import debugProjectRouter from "./src/routes/debugProject.js";
import { exchangeBlingCodeForToken, previewToken } from "./src/services/blingAuth.js";

dotenv.config();

const app = express();
const logger = createLogger("server");
const port = Number(process.env.PORT) || 3000;

app.use("/debug/project", debugProjectRouter);
app.disable("x-powered-by");
app.use(express.json({ verify: attachRawBody, limit: "1mb" }));
app.use(express.urlencoded({ extended: true, verify: attachRawBody, limit: "1mb" }));

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "bling-shopify-sync",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/bling/oauth", (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    return res.status(400).json({ error: "missing_code" });
  }

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

      return res.status(200).json({
        ok: true,
        provider: "bling",
        received_code: true,
        token_type: tokenData.token_type,
        expires_in: tokenData.expires_in,
        scope: tokenData.scope,
        access_token_preview: accessPreview,
        refresh_token_preview: refreshPreview,
      });
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
