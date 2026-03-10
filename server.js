import express from "express";
import dotenv from "dotenv";

import { attachRawBody } from "./src/lib/rawBody.js";
import { createLogger } from "./src/lib/logger.js";
import blingProductsRouter from "./src/routes/blingProducts.js";
import blingInvoicesRouter from "./src/routes/blingInvoices.js";
import shopifyOrdersRouter from "./src/routes/shopifyOrders.js";

dotenv.config();

const logger = createLogger("server");
const app = express();

app.use(express.json({ verify: attachRawBody }));
app.use(express.urlencoded({ extended: true, verify: attachRawBody }));

/*
Health check
*/
app.get("/", (req, res) => {
  res.json({
    service: "bling-shopify-sync",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

/*
OAuth callback do Bling
*/
app.get("/bling/oauth", async (req, res) => {
  try {
    const { code } = req.query;

    logger.info("Bling OAuth callback recebido", { code });

    if (!code) {
      return res.status(400).json({
        error: "missing_oauth_code",
      });
    }

    res.send(`
      <h2>Bling autorizado com sucesso</h2>
      <p>Authorization code recebido:</p>
      <pre>${code}</pre>
    `);
  } catch (error) {
    logger.error("Erro no callback OAuth do Bling", { error });
    res.status(500).json({
      error: "bling_oauth_error",
    });
  }
});

/*
Webhooks Bling
*/
app.use("/webhooks/bling/products", blingProductsRouter);
app.use("/webhooks/bling/invoices", blingInvoicesRouter);

/*
Webhooks Shopify
*/
app.use("/webhooks/shopify", shopifyOrdersRouter);

/*
Error handler global
*/
app.use((err, req, res, next) => {
  logger.error("Unhandled request error", { error: err });
  res.status(500).json({ error: "internal_server_error" });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});