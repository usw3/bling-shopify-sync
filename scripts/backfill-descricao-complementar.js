import "dotenv/config";
import fetch from "node-fetch";

import { findProductByMetafield, findVariantBySku, setProductMetafield } from "../src/services/shopifyApi.js";

const BLING_API_BASE = process.env.BLING_API_BASE ?? "https://api.bling.com.br/Api/v3";
const BLING_ACCESS_TOKEN = process.env.BLING_ACCESS_TOKEN ?? "";
const PAGE_LIMIT = Number(process.env.BLING_PAGE_LIMIT ?? process.env.BLING_LIMIT ?? 100);
const MAX_PAGES = Number(process.env.BLING_MAX_PAGES ?? 0);
const MAX_ITEMS = Number(process.env.BLING_MAX_ITEMS ?? 0);
const DELAY_MS = Number(process.env.BLING_BACKFILL_DELAY_MS ?? 0);
const COMPLEMENT_TYPE = process.env.SHOPIFY_COMPLEMENT_TYPE ?? "multi_line_text_field";
const DRY_RUN = process.env.DRY_RUN === "1";

function log(message, meta) {
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  console.log(`${new Date().toISOString()} [backfill] ${line}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value).trim();
  }
}

function normalizeSku(value) {
  const normalized = normalizeString(value);
  const lowered = normalized.toLowerCase();
  if (!normalized || lowered === "[object object]" || lowered === "array" || lowered === "object") {
    return "";
  }
  return normalized;
}

function extractComplement(product) {
  return (
    product?.descricaoComplementar ??
    product?.descricao_complementar ??
    product?.descricaoExtra ??
    product?.complemento ??
    product?.complemento_descricao ??
    ""
  );
}

function extractProductId(product) {
  return normalizeSku(product?.id ?? product?.codigoBling ?? product?.codigo);
}

function extractSku(product) {
  return normalizeSku(product?.codigo ?? product?.sku ?? product?.codigoBling ?? product?.id);
}

async function fetchBlingPage(page) {
  const url = new URL(`${BLING_API_BASE}/produtos`);
  if (PAGE_LIMIT > 0) {
    url.searchParams.set("limite", String(PAGE_LIMIT));
  }
  url.searchParams.set("pagina", String(page));

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${BLING_ACCESS_TOKEN}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    parsed = null;
  }

  if (!response.ok) {
    throw new Error(`Bling API error ${response.status}: ${text}`);
  }

  const data = parsed?.data ?? parsed?.produtos ?? [];
  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

async function resolveShopifyProduct({ blingId, sku }) {
  if (blingId) {
    const byBlingId = await findProductByMetafield("custom", "bling_id", blingId);
    if (byBlingId?.product?.id) {
      return byBlingId;
    }
  }

  if (sku) {
    const bySku = await findVariantBySku(sku);
    if (bySku?.product?.id) {
      return bySku;
    }
  }

  return null;
}

async function backfill() {
  if (!BLING_ACCESS_TOKEN) {
    throw new Error("missing BLING_ACCESS_TOKEN");
  }

  log("Backfill started", {
    apiBase: BLING_API_BASE,
    pageLimit: PAGE_LIMIT,
    maxPages: MAX_PAGES || null,
    maxItems: MAX_ITEMS || null,
    dryRun: DRY_RUN,
    complementType: COMPLEMENT_TYPE,
  });

  let page = 1;
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  let errors = 0;

  while (true) {
    if (MAX_PAGES && page > MAX_PAGES) {
      break;
    }

    const items = await fetchBlingPage(page);
    if (!items.length) {
      break;
    }

    for (const item of items) {
      if (MAX_ITEMS && processed >= MAX_ITEMS) {
        break;
      }

      const product = item?.produto ?? item?.product ?? item;
      const blingId = extractProductId(product);
      const sku = extractSku(product);
      const complementRaw = extractComplement(product);
      const complement = normalizeString(complementRaw);

      processed += 1;

      if (!complement) {
        skipped += 1;
        log("skip: empty complement", { blingId, sku });
        continue;
      }

      try {
        const existing = await resolveShopifyProduct({ blingId, sku });
        if (!existing?.product?.id) {
          notFound += 1;
          log("skip: shopify product not found", { blingId, sku });
          continue;
        }

        const ownerId = existing.product.gqlId ?? `gid://shopify/Product/${existing.product.id}`;

        if (DRY_RUN) {
          updated += 1;
          log("dry-run: would update metafield", { blingId, sku, ownerId });
          continue;
        }

        const response = await setProductMetafield(
          ownerId,
          "descricao_complementar",
          complement,
          COMPLEMENT_TYPE,
        );

        const userErrors = response?.metafieldsSet?.userErrors ?? [];
        if (userErrors.length > 0) {
          errors += 1;
          log("metafield userErrors", { blingId, sku, ownerId, userErrors });
          continue;
        }

        updated += 1;
        log("updated", { blingId, sku, ownerId });
      } catch (error) {
        errors += 1;
        log("error", { blingId, sku, message: error?.message ?? String(error) });
      }
    }

    if (MAX_ITEMS && processed >= MAX_ITEMS) {
      break;
    }

    page += 1;
    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  log("Backfill finished", {
    processed,
    updated,
    skipped,
    notFound,
    errors,
  });
}

backfill().catch((error) => {
  log("Backfill failed", { message: error?.message ?? String(error) });
  process.exitCode = 1;
});
