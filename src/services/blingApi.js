import fetch from "node-fetch";

import { createLogger } from "../lib/logger.js";

const logger = createLogger("blingApi");
const baseUrl = process.env.BLING_API_URL ?? "https://bling.com.br/Api/v2";
const accessToken = process.env.BLING_ACCESS_TOKEN;

function assertConfig() {
  if (!accessToken) {
    throw new Error("missing_bling_access_token");
  }
}

async function post(path, payload) {
  assertConfig();
  const url = `${baseUrl}/${path}/json/?apikey=${accessToken}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error("Bling API returned an error", { url, status: response.status, body });
    throw new Error("bling_api_error");
  }

  return response.json();
}

export async function createInvoice(payload) {
  return post("notasfiscais", payload);
}
