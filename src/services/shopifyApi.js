import fetch from "node-fetch";

import { createLogger } from "../lib/logger.js";
import { getShopifyAccessToken } from "../lib/shopifyAuth.js";

const logger = createLogger("shopifyApi");
const DEFAULT_API_VERSION = "2026-01";
let cachedLocationId = null;

function assertConfig() {
  if (!process.env.SHOPIFY_STORE) {
    throw new Error("missing_shopify_store");
  }
}

function resolveStoreDomain() {
  return process.env.SHOPIFY_STORE.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function resolveApiVersion() {
  return process.env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION;
}

function restUrl(path) {
  return `https://${resolveStoreDomain()}/admin/api/${resolveApiVersion()}/${path}`;
}

function graphqlUrl() {
  return `https://${resolveStoreDomain()}/admin/api/${resolveApiVersion()}/graphql.json`;
}

function baseHeaders(accessToken) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Shopify-Access-Token": accessToken,
  };
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function summarizeVariables(variables) {
  if (!variables || typeof variables !== "object") {
    return null;
  }

  const summary = {};
  for (const [key, value] of Object.entries(variables)) {
    if (Array.isArray(value)) {
      summary[key] = { type: "array", length: value.length };
      continue;
    }

    if (value === null) {
      summary[key] = { type: "null" };
      continue;
    }

    if (typeof value === "object") {
      summary[key] = { type: "object", keys: Object.keys(value).length };
      continue;
    }

    if (typeof value === "string") {
      summary[key] = { type: "string", length: value.length };
      continue;
    }

    summary[key] = { type: typeof value };
  }

  return summary;
}

function buildShopifyApiError(message, details) {
  const error = new Error(message);
  error.code = "shopify_api_error";
  error.details = details;
  error.status = details?.status ?? null;
  error.statusText = details?.statusText ?? null;
  error.endpoint = details?.endpoint ?? null;
  error.method = details?.method ?? null;
  error.responseBody = details?.responseBody ?? null;
  error.responseErrors = details?.responseErrors ?? null;
  error.graphqlErrors = details?.graphqlErrors ?? null;
  error.graphqlUserErrors = details?.graphqlUserErrors ?? null;
  error.operationName = details?.operationName ?? null;
  return error;
}

async function restRequest(path, method, body) {
  assertConfig();

  const accessToken = await getShopifyAccessToken();
  const url = restUrl(path);
  const response = await fetch(url, {
    method,
    headers: baseHeaders(accessToken),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const parsedBody = parseJsonSafe(text);
  const responseErrors = parsedBody?.errors ?? parsedBody?.error ?? null;

  if (!response.ok) {
    logger.error("Shopify REST API error", {
      endpoint: path,
      method,
      status: response.status,
      statusText: response.statusText,
      body: text,
      responseErrors,
    });

    throw buildShopifyApiError(
      `Shopify REST request failed (${method} ${path}) status ${response.status} ${response.statusText}`,
      {
        endpoint: path,
        method,
        status: response.status,
        statusText: response.statusText,
        responseBody: text,
        parsedBody,
        responseErrors,
      },
    );
  }

  if (!parsedBody) {
    logger.warn("Shopify REST response is not JSON", { endpoint: path, method, body: text });
    return {};
  }

  return parsedBody;
}

export async function createShopifyProduct(payload) {
  return restRequest("products.json", "POST", payload);
}

export async function updateShopifyProduct(productId, payload) {
  return restRequest(`products/${productId}.json`, "PUT", payload);
}

export async function getShopifyProduct(productId) {
  return restRequest(`products/${productId}.json`, "GET");
}

export async function archiveShopifyProduct(productId) {
  const numericId = Number(productId);
  const resolvedId = Number.isFinite(numericId) ? numericId : productId;

  return restRequest(`products/${resolvedId}.json`, "PUT", {
    product: {
      id: resolvedId,
      status: "archived",
    },
  });
}

export async function createShopifyOrder(payload) {
  return restRequest("orders.json", "POST", payload);
}

export async function getShopifyLocationId() {
  const envLocationId = process.env.SHOPIFY_LOCATION_ID;
  if (envLocationId) {
    return Number.isNaN(Number(envLocationId)) ? envLocationId : Number(envLocationId);
  }

  if (cachedLocationId) {
    return cachedLocationId;
  }

  const response = await restRequest("locations.json", "GET");
  const locations = response?.locations ?? [];
  const activeLocation = locations.find((location) => location?.active) ?? locations[0];
  if (!activeLocation?.id) {
    throw new Error("missing_shopify_location");
  }

  cachedLocationId = activeLocation.id;
  return cachedLocationId;
}

export async function setInventoryLevel(inventoryItemId, available, locationId) {
  if (!inventoryItemId) {
    throw new Error("missing_inventory_item_id");
  }

  const resolvedLocationId = locationId ?? (await getShopifyLocationId());
  return restRequest("inventory_levels/set.json", "POST", {
    location_id: resolvedLocationId,
    inventory_item_id: inventoryItemId,
    available,
  });
}

async function graphqlRequest(query, variables, context = {}) {
  assertConfig();

  const accessToken = await getShopifyAccessToken();
  const response = await fetch(graphqlUrl(), {
    method: "POST",
    headers: baseHeaders(accessToken),
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  const parsedBody = parseJsonSafe(text) || {};
  const graphqlErrors = Array.isArray(parsedBody?.errors) ? parsedBody.errors : [];

  const mutationUserErrors =
    parsedBody?.data?.metafieldsSet?.userErrors ?? parsedBody?.data?.productCreate?.userErrors ?? null;

  if (!response.ok || graphqlErrors.length > 0) {
    logger.error("Shopify GraphQL error", {
      endpoint: "graphql.json",
      method: "POST",
      status: response.status,
      statusText: response.statusText,
      operationName: context.operationName ?? null,
      variablesSummary: summarizeVariables(variables),
      graphqlErrors,
      graphqlUserErrors: mutationUserErrors,
      body: text,
    });

    throw buildShopifyApiError(
      `Shopify GraphQL request failed (${context.operationName ?? "unknown_operation"}) status ${response.status}`,
      {
        endpoint: "graphql.json",
        method: "POST",
        status: response.status,
        statusText: response.statusText,
        responseBody: text,
        parsedBody,
        graphqlErrors,
        graphqlUserErrors: mutationUserErrors,
        operationName: context.operationName ?? null,
        variablesSummary: summarizeVariables(variables),
      },
    );
  }

  return parsedBody.data ?? {};
}

function parseNumericIdFromGid(gid) {
  if (!gid) {
    return null;
  }

  const parts = gid.split("/");
  const rawId = parts.at(-1);
  const id = Number(rawId);
  return Number.isNaN(id) ? null : id;
}

function ensureGraphqlProductId(ownerId) {
  if (!ownerId) {
    return null;
  }

  if (typeof ownerId === "number" || /^[0-9]+$/.test(ownerId.toString())) {
    return `gid://shopify/Product/${ownerId}`;
  }

  if (ownerId.startsWith("gid://")) {
    return ownerId;
  }

  return ownerId;
}

export async function findVariantBySku(sku) {
  if (!sku) {
    return null;
  }

  const cleanSku = sku.toString().trim();
  if (!cleanSku) {
    return null;
  }

  const query = `
    query variantBySku($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            id
            sku
            product {
              id
              title
              handle
            }
          }
        }
      }
    }
  `;

  const variables = { query: `sku:${cleanSku}` };
  const data = await graphqlRequest(query, variables, { operationName: "variantBySku" });
  const node = data?.productVariants?.edges?.[0]?.node;
  if (!node) {
    return null;
  }

  return {
    variant: {
      id: parseNumericIdFromGid(node.id),
      gqlId: node.id,
      sku: node.sku,
    },
    product: {
      id: parseNumericIdFromGid(node.product?.id),
      gqlId: node.product?.id,
      title: node.product?.title,
      handle: node.product?.handle,
    },
  };
}

export async function findProductByMetafield(namespace, key, value) {
  if (!namespace || !key || !value) {
    return null;
  }

  const cleanValue = value.toString().trim();
  if (!cleanValue) {
    return null;
  }

  const query = `
    query productByMetafield($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            id
            title
            handle
          }
        }
      }
    }
  `;

  const variables = { query: `metafield:${namespace}.${key}:${cleanValue}` };
  const data = await graphqlRequest(query, variables, { operationName: "productByMetafield" });
  const node = data?.products?.edges?.[0]?.node;
  if (!node) {
    return null;
  }

  return {
    product: {
      id: parseNumericIdFromGid(node.id),
      gqlId: node.id,
      title: node.title,
      handle: node.handle,
    },
  };
}

export async function setProductMetafield(ownerId, key, value, type = "single_line_text_field") {
  const ownerGraphqlId = ensureGraphqlProductId(ownerId);
  if (!ownerGraphqlId) {
    throw new Error("missing_product_owner_id");
  }

  const mutation = `
    mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: ownerGraphqlId,
        namespace: "custom",
        key,
        type,
        value,
      },
    ],
  };

  const data = await graphqlRequest(mutation, variables, { operationName: "metafieldsSet" });
  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    logger.warn("Shopify metafield warning", {
      operationName: "metafieldsSet",
      userErrors,
      key,
      type,
      ownerId: ownerGraphqlId,
      variablesSummary: summarizeVariables(variables),
    });
  }

  return data;
}
