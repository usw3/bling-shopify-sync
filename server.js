import dotenv from "dotenv";
import express from "express";

import { createLogger } from "./src/lib/logger.js";
import { attachRawBody } from "./src/lib/rawBody.js";
import blingProductsRouter from "./src/routes/blingProducts.js";
import blingInvoicesRouter from "./src/routes/blingInvoices.js";
import shopifyOrdersRouter from "./src/routes/shopifyOrders.js";

dotenv.config();

const app = express();
const logger = createLogger("server");
const port = Number(process.env.PORT) || 3000;

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
  const code = typeof req.query.code === "string" ? req.query.code : null;
  res.status(200).json({
    ok: true,
    message: code ? "Bling OAuth callback received." : "Bling OAuth callback reached without code.",
    code,
  });
});

app.use("/webhooks/bling/products", blingProductsRouter);
app.use("/webhooks/bling/invoices", blingInvoicesRouter);
app.use("/webhooks/shopify", shopifyOrdersRouter);

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
