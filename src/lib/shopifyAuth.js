import fetch from "node-fetch";

import { createLogger } from "./logger.js";

const logger = createLogger("shopifyAuth");
const DEFAULT_API_VERSION = "2026-01";

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function getEnv(name, required = false) {
  const value = process.env[name];

  if (required && !value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function parseResponseBody(rawBody) {
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (_error) {
    return { message: rawBody };
  }
}

function resolveApiVersion() {
  return getEnv("SHOPIFY_API_VERSION") || DEFAULT_API_VERSION;
}

function resolveStoreHostname() {
  const store = getEnv("SHOPIFY_STORE", true);
  return store.startsWith("https://") ? store.replace("https://", "") : store;
}

function readableTokenError(status, payload) {
  const message = payload?.error_description || payload?.error || payload?.message || "token_request_failed";
  return `Shopify token request failed (${status}): ${message}`;
}

export async function getShopifyAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const store = resolveStoreHostname();
  const clientId = getEnv("SHOPIFY_CLIENT_ID", true);
  const clientSecret = getEnv("SHOPIFY_CLIENT_SECRET", true);

  const response = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  const responseText = await response.text();
  const payload = parseResponseBody(responseText);

  if (!response.ok) {
    throw new Error(readableTokenError(response.status, payload));
  }

  const accessToken = payload?.access_token;
  if (!accessToken) {
    throw new Error("Shopify token response did not include access_token");
  }

  const expiresInSeconds = Number(payload?.expires_in) || 3600;
  const refreshBufferMs = 30 * 1000;

  tokenCache = {
    accessToken,
    expiresAt: Date.now() + Math.max(expiresInSeconds * 1000 - refreshBufferMs, 60 * 1000),
  };

  logger.info("Shopify access token cached", {
    expiresAt: new Date(tokenCache.expiresAt).toISOString(),
  });

  return tokenCache.accessToken;
}

function readableGraphQlError(status, payload) {
  if (payload?.errors && Array.isArray(payload.errors)) {
    const messages = payload.errors
      .map((entry) => entry?.message)
      .filter(Boolean)
      .join("; ");

    if (messages) {
      return `Shopify GraphQL request failed (${status}): ${messages}`;
    }
  }

  const fallbackMessage = payload?.message || "request_failed";
  return `Shopify GraphQL request failed (${status}): ${fallbackMessage}`;
}

export async function shopifyGraphQL(query, variables = {}) {
  if (!query || typeof query !== "string") {
    throw new Error("GraphQL query must be a non-empty string");
  }

  const token = await getShopifyAccessToken();
  const store = resolveStoreHostname();
  const apiVersion = resolveApiVersion();

  const response = await fetch(`https://${store}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const responseText = await response.text();
  const payload = parseResponseBody(responseText);

  if (!response.ok) {
    throw new Error(readableGraphQlError(response.status, payload));
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(readableGraphQlError(response.status, payload));
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "data")) {
    throw new Error("Shopify GraphQL response missing data");
  }

  return payload.data;
}
