import fetch from "node-fetch";

import { createLogger } from "../lib/logger.js";

const logger = createLogger("blingAuth");
const BLING_TOKEN_ENDPOINT = "https://www.bling.com.br/Api/v3/oauth/token";
const TOKEN_REFRESH_SAFETY_WINDOW_MS = 60 * 1000;

const tokenCache = {
  currentAccessToken: null,
  currentRefreshToken: null,
  expiresAt: 0,
};

function parseJsonSafe(rawBody) {
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (_error) {
    return { raw: rawBody };
  }
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function normalizeTokenPayload(payload) {
  return {
    access_token: payload?.access_token ?? null,
    refresh_token: payload?.refresh_token ?? null,
    expires_in: payload?.expires_in ?? null,
    scope: payload?.scope ?? null,
    token_type: payload?.token_type ?? null,
  };
}

function updateTokenCache(tokenData) {
  tokenCache.currentAccessToken = tokenData.access_token;
  tokenCache.currentRefreshToken = tokenData.refresh_token;

  const expiresInSeconds = Number(tokenData.expires_in) || 0;
  tokenCache.expiresAt = Date.now() + Math.max(0, expiresInSeconds) * 1000;
}

export function previewToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  return `${token.slice(0, 12)}...`;
}

export function buildBlingBasicAuth() {
  const clientId = getRequiredEnv("BLING_CLIENT_ID");
  const clientSecret = getRequiredEnv("BLING_CLIENT_SECRET");
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${basicAuth}`;
}

async function requestToken(params) {
  const response = await fetch(BLING_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: buildBlingBasicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "enable-jwt": "1",
    },
    body: new URLSearchParams(params).toString(),
  });

  const responseText = await response.text();
  const responseBody = parseJsonSafe(responseText);

  if (!response.ok) {
    logger.warn("Bling token endpoint returned non-success status", {
      status: response.status,
      grantType: params.grant_type,
    });

    throw new Error(
      `Bling token exchange failed (status ${response.status}): ${JSON.stringify(responseBody)}`,
    );
  }

  const normalized = normalizeTokenPayload(responseBody);
  if (!normalized.access_token || !normalized.refresh_token) {
    throw new Error(`Bling token exchange returned incomplete payload: ${JSON.stringify(responseBody)}`);
  }

  updateTokenCache(normalized);

  return normalized;
}

export async function exchangeBlingCodeForToken(code) {
  if (!code) {
    throw new Error("Missing authorization code");
  }

  logger.info("Starting Bling authorization_code exchange");

  const tokenData = await requestToken({
    grant_type: "authorization_code",
    code,
  });

  logger.info("Bling authorization_code exchange completed", {
    tokenType: tokenData.token_type,
    expiresIn: tokenData.expires_in,
    hasScope: Boolean(tokenData.scope),
  });

  return tokenData;
}

export async function refreshBlingToken(refreshToken) {
  if (!refreshToken) {
    throw new Error("Missing refresh token");
  }

  logger.info("Starting Bling refresh_token exchange");

  const tokenData = await requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  logger.info("Bling refresh_token exchange completed", {
    tokenType: tokenData.token_type,
    expiresIn: tokenData.expires_in,
    hasScope: Boolean(tokenData.scope),
  });

  return tokenData;
}

export async function getValidBlingAccessToken() {
  const now = Date.now();
  const hasValidCachedToken =
    Boolean(tokenCache.currentAccessToken) && tokenCache.expiresAt - now >= TOKEN_REFRESH_SAFETY_WINDOW_MS;

  if (hasValidCachedToken) {
    return tokenCache.currentAccessToken;
  }

  if (tokenCache.currentRefreshToken) {
    const refreshed = await refreshBlingToken(tokenCache.currentRefreshToken);
    return refreshed.access_token;
  }

  const envAccessToken = process.env.BLING_ACCESS_TOKEN;
  const envRefreshToken = process.env.BLING_REFRESH_TOKEN;
  if (envAccessToken && envRefreshToken) {
    tokenCache.currentAccessToken = envAccessToken;
    tokenCache.currentRefreshToken = envRefreshToken;
    tokenCache.expiresAt = 0;

    logger.info("Seeded Bling token cache from environment");

    const refreshed = await refreshBlingToken(tokenCache.currentRefreshToken);
    return refreshed.access_token;
  }

  throw new Error("missing_bling_tokens");
}
