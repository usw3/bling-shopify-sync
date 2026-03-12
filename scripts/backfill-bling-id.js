import "dotenv/config";
import fetch from "node-fetch";

import { findProductByMetafield, findVariantBySku, setProductMetafield } from "../src/services/shopifyApi.js";

const BLING_API_BASE = process.env.BLING_API_BASE ?? "https://api.bling.com.br/Api/v3";
let blingAccessToken = process.env.BLING_ACCESS_TOKEN ?? "";
const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID ?? "";
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET ?? "";
const BLING_REFRESH_TOKEN = process.env.BLING_REFRESH_TOKEN ?? "";
const PAGE_LIMIT = Number(process.env.BLING_PAGE_LIMIT ?? process.env.BLING_LIMIT ?? 100);
const MAX_PAGES = Number(process.env.BLING_MAX_PAGES ?? 0);
const MAX_ITEMS = Number(process.env.BLING_MAX_ITEMS ?? 0);
const DELAY_MS = Number(process.env.BLING_BACKFILL_DELAY_MS ?? 0);
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

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

async function refreshBlingAccessToken() {
  if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET || !BLING_REFRESH_TOKEN) {
    throw new Error("missing_bling_refresh_credentials");
  }

  const basic = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${BLING_API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "enable-jwt": "1",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: BLING_REFRESH_TOKEN,
    }).toString(),
  });

  const text = await response.text();
  const parsed = parseJsonSafe(text);
  if (!response.ok) {
    const errorType = parsed?.error?.type ?? null;
    throw new Error(`bling_refresh_failed status ${response.status} type ${errorType ?? "unknown"}`);
  }

  const accessToken = parsed?.access_token ?? "";
  if (!accessToken) {
    throw new Error("bling_refresh_missing_access_token");
  }

  blingAccessToken = accessToken;
  log("Bling access token refreshed", { hasToken: true });
  return accessToken;
}

async function fetchBlingPage(page) {
  if (!blingAccessToken && BLING_REFRESH_TOKEN) {
    await refreshBlingAccessToken();
  }

  const url = new URL(`${BLING_API_BASE}/produtos`);
  if (PAGE_LIMIT > 0) {
    url.searchParams.set("limite", String(PAGE_LIMIT));
  }
  url.searchParams.set("pagina", String(page));

  const doRequest = async () => {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${blingAccessToken}`,
        Accept: "application/json",
      },
    });

    const text = await response.text();
    const parsed = parseJsonSafe(text);
    return { response, parsed };
  };

  let { response, parsed } = await doRequest();

  if (!response.ok) {
    const errorType = parsed?.error?.type ?? null;
    if (response.status === 401 && errorType === "invalid_token" && BLING_REFRESH_TOKEN) {
      log("Bling access token invalid, attempting refresh", { status: response.status });
      await refreshBlingAccessToken();
      ({ response, parsed } = await doRequest());
    }
  }

  if (!response.ok) {
    const errorType = parsed?.error?.type ?? null;
    throw new Error(`Bling API error ${response.status} type ${errorType ?? "unknown"}`);
  }

  const data = parsed?.data ?? parsed?.produtos ?? [];
  return Array.isArray(data) ? data : [];
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
  if (!blingAccessToken && !BLING_REFRESH_TOKEN) {
    throw new Error("missing_bling_access_or_refresh_token");
  }

  if (!blingAccessToken && BLING_REFRESH_TOKEN) {
    await refreshBlingAccessToken();
  }

  log("Backfill started", {
    apiBase: BLING_API_BASE,
    pageLimit: PAGE_LIMIT,
    maxPages: MAX_PAGES || null,
    maxItems: MAX_ITEMS || null,
    dryRun: DRY_RUN,
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
      const blingId = normalizeSku(product?.id ?? product?.codigoBling ?? product?.codigo);
      const sku = normalizeSku(product?.codigo ?? product?.sku ?? product?.codigoBling ?? product?.id);
      processed += 1;

      if (!blingId) {
        skipped += 1;
        log("skip: missing bling_id", { sku });
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
          log("dry-run: would set bling_id", { blingId, sku, ownerId });
          continue;
        }

        const response = await setProductMetafield(ownerId, "bling_id", blingId, "single_line_text_field");
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
