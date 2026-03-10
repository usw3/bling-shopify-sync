import fetch from "node-fetch";

import { createLogger } from "../lib/logger.js";

const logger = createLogger("shopifyApi");
const storeDomain = process.env.SHOPIFY_STORE;
const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;
const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2026-01";

function assertConfig() {
  if (!storeDomain) {
    throw new Error("missing_shopify_store");
  }
  if (!accessToken) {
    throw new Error("missing_shopify_admin_token");
  }
}

function restUrl(path) {
  return `https://${storeDomain}/admin/api/${apiVersion}/${path}`;
}

function graphqlUrl() {
  return `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;
}

function baseHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": accessToken,
  };
}

async function restRequest(path, method, body) {
  assertConfig();
  const url = restUrl(path);
  const response = await fetch(url, {
    method,
    headers: baseHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    logger.error("Shopify REST API error", { path, status: response.status, body: text });
    throw new Error("shopify_api_error");
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    logger.warn("Shopify REST response is not JSON", { body: text });
    return {};
  }
}

export async function createShopifyProduct(payload) {
  return restRequest("products.json", "POST", payload);
}

export async function updateShopifyProduct(productId, payload) {
  return restRequest(`products/${productId}.json`, "PUT", payload);
}

export async function createShopifyOrder(payload) {
  return restRequest("orders.json", "POST", payload);
}

async function graphqlRequest(query, variables) {
  assertConfig();
  const response = await fetch(graphqlUrl(), {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();
  if (!response.ok || json.errors) {
    logger.error("Shopify GraphQL error", { errors: json.errors ?? json });
    throw new Error("shopify_graphql_error");
  }

  return json.data;
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
            }
          }
        }
      }
    }
  `;

  const variables = { query: `sku:${cleanSku}` };
  const data = await graphqlRequest(query, variables);
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
    },
  };
}

export async function setProductMetafield(ownerId, key, value) {
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
        type: "single_line_text_field",
        value,
      },
    ],
  };

  const data = await graphqlRequest(mutation, variables);
  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    logger.warn("Shopify metafield warning", { errors });
  }

  return data;
}
