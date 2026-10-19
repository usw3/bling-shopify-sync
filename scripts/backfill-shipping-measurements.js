import "dotenv/config";
import fetch from "node-fetch";

import { findVariantBySku, getShopifyProduct, setInventoryItemMeasurements } from "../src/services/shopifyApi.js";
import { getValidBlingAccessToken } from "../src/services/blingAuth.js";

const BLING_API_BASE = process.env.BLING_API_BASE ?? "https://api.bling.com.br/Api/v3";
let accessToken = "";
const pageLimit = Number(process.env.BLING_PAGE_LIMIT ?? 100);
const maxItems = Number(process.env.BLING_MAX_ITEMS ?? 0);
const delayMs = Number(process.env.BLING_BACKFILL_DELAY_MS ?? 150);
const dryRun = process.env.DRY_RUN === "1";

function log(message, meta = {}) {
  console.log(`${new Date().toISOString()} [shipping-backfill] ${message} ${JSON.stringify(meta)}`);
}

function normalizeNumber(value) {
  const number = Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function measurementFrom(product) {
  const dimensions = product?.dimensoes ?? {};
  const values = (entries) => {
    let zero = null;
    for (const entry of entries) {
      const number = normalizeNumber(entry);
      if (number === null) continue;
      if (number > 0) return number;
      zero = number;
    }
    return zero;
  };
  const unit = { 0: "METERS", 1: "CENTIMETERS", 2: "MILLIMETERS" }[dimensions?.unidadeMedida] ?? "CENTIMETERS";
  return {
    weight: values([product?.pesoBruto, product?.pesoLiquido]),
    height: values([dimensions?.altura]),
    width: values([dimensions?.largura]),
    length: values([dimensions?.profundidade, dimensions?.comprimento]),
    unit,
  };
}

async function blingRequest(path) {
  const response = await fetch(`${BLING_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Bling request failed (${response.status}): ${body?.error?.type ?? "unknown"}`);
  }
  return body?.data ?? body;
}

async function sleep() {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function run() {
  accessToken = await getValidBlingAccessToken();
  log("started", { dryRun, maxItems: maxItems || null, pageLimit });
  let page = 1;
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  while (!maxItems || processed < maxItems) {
    const pageData = await blingRequest(`/produtos?pagina=${page}&limite=${pageLimit}`);
    const products = Array.isArray(pageData) ? pageData : [];
    if (!products.length) break;

    for (const summary of products) {
      if (maxItems && processed >= maxItems) break;
      processed += 1;
      const id = summary?.id;
      const sku = String(summary?.codigo ?? "").trim();
      try {
        const product = await blingRequest(`/produtos/${id}`);
        const measurements = measurementFrom(product);
        const hasDimensions = [measurements.height, measurements.width, measurements.length].every((value) => value !== null);
        if (!sku || !hasDimensions) {
          skipped += 1;
          log("skipped", { id, sku: sku || null, reason: !sku ? "missing_sku" : "missing_dimensions" });
          continue;
        }
        const match = await findVariantBySku(sku);
        if (!match?.product?.id) {
          skipped += 1;
          log("skipped", { id, sku, reason: "shopify_variant_not_found" });
          continue;
        }
        const shopifyProduct = await getShopifyProduct(match.product.id);
        const variant = (shopifyProduct?.product?.variants ?? []).find((item) => item.sku === sku);
        if (!variant?.inventory_item_id) {
          skipped += 1;
          log("skipped", { id, sku, reason: "missing_inventory_item" });
          continue;
        }
        if (!dryRun) {
          await setInventoryItemMeasurements(variant.inventory_item_id, measurements.weight ?? 0, {
            height: measurements.height,
            width: measurements.width,
            length: measurements.length,
            unit: measurements.unit,
          });
        }
        updated += 1;
        log(dryRun ? "would_update" : "updated", { id, sku, measurements });
      } catch (error) {
        errors += 1;
        log("error", { id, sku: sku || null, message: error?.message ?? String(error) });
      }
      await sleep();
    }
    page += 1;
  }
  log("finished", { processed, updated, skipped, errors });
}

run().catch((error) => {
  log("failed", { message: error?.message ?? String(error) });
  process.exitCode = 1;
});
