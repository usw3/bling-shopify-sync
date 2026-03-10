import { createLogger } from "../lib/logger.js";
import {
  createShopifyProduct,
  updateShopifyProduct,
  findVariantBySku,
  setProductMetafield,
} from "./shopifyApi.js";

const logger = createLogger("syncProduct");

function extractProduct(payload) {
  return (
    payload?.produto ??
    payload?.produtos?.produto ??
    payload?.product ??
    payload?.products?.product ??
    payload
  );
}

function ensureNumber(value) {
  const number = Number(value ?? 0);
  return Number.isNaN(number) ? 0 : number;
}

function buildShopifyPayload(product) {
  const sku = product.codigo ?? product.sku ?? product.codigoBling ?? product.id;
  return {
    product: {
      title: product.nome ?? product.name ?? product.title ?? `bling-${Date.now()}`,
      body_html: product.descricao ?? product.description ?? "",
      vendor: product.marca ?? product.brand ?? "Bling",
      tags: Array.isArray(product.tags) ? product.tags.join(",") : product.tags ?? "bling-sync",
      variants: [
        {
          sku,
          price: String(product.precoVenda ?? product.price ?? "0.00"),
          inventory_quantity: ensureNumber(product.quantidade ?? product.estoque ?? 0),
        },
      ],
    },
  };
}

function extractComplement(product) {
  return (
    product.descricaoComplementar ??
    product.descricao_complementar ??
    product.descricaoExtra ??
    product.complemento ??
    product.complemento_descricao ??
    null
  );
}

export async function syncProductFromBlingEvent(payload, meta = {}) {
  const eventType = meta.eventType ?? "product_change";
  if (eventType.toLowerCase().includes("excl")) {
    logger.info("Product delete request received", { eventType, payload });
    // TODO: remove Shopify product when Bling reports deletion
    return;
  }

  const product = extractProduct(payload);
  if (!product) {
    throw new Error("missing_product_payload");
  }

  const sku = product.codigo ?? product.sku ?? product.codigoBling;
  const shopifyPayload = buildShopifyPayload(product);

  const existing = sku ? await findVariantBySku(sku) : null;
  let result;

  if (existing?.product?.id) {
    result = await updateShopifyProduct(existing.product.id, shopifyPayload);
    logger.info("Shopify product updated", { sku, eventType, productId: existing.product.id });
  } else {
    result = await createShopifyProduct(shopifyPayload);
    logger.info("Shopify product created", { sku, eventType, productId: result?.product?.id });
  }

  const complement = extractComplement(product);
  if (complement && result?.product?.id) {
    const ownerId = existing?.product?.gqlId ?? `gid://shopify/Product/${result.product.id}`;
    await setProductMetafield(ownerId, "descricao_complementar", String(complement));
    logger.info("Mapped descricaoComplementar to metafield", { ownerId, key: "custom.descricao_complementar" });
  }

  return result;
}
