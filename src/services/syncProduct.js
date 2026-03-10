import { createLogger } from "../lib/logger.js";
import {
  createShopifyProduct,
  updateShopifyProduct,
  findVariantBySku,
  setProductMetafield,
} from "./shopifyApi.js";

const logger = createLogger("syncProduct");

function extractProduct(payload) {
  const extracted =
    payload?.produto ??
    payload?.produtos?.produto ??
    payload?.product ??
    payload?.products?.product ??
    payload;

  if (Array.isArray(extracted)) {
    return extracted[0] ?? null;
  }

  return extracted;
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return typeof value === "string" ? value : String(value);
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeString(item).trim())
      .filter(Boolean)
      .join(", ");
  }

  return normalizeString(value).trim();
}

function normalizeProductType(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeString(item).trim();
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  return normalizeString(value).trim();
}

function ensureNumber(value) {
  const number = Number(value ?? 0);
  return Number.isNaN(number) ? 0 : number;
}

function isValidImageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function unwrapImageField(value) {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "object") {
    const nestedArrayKeys = ["imagens", "images", "fotos", "foto", "imagem", "image", "item"];
    for (const key of nestedArrayKeys) {
      if (Array.isArray(value[key])) {
        return value[key];
      }
    }
  }

  return [value];
}

function extractImageSrc(item) {
  if (typeof item === "string") {
    return item;
  }

  if (!item || typeof item !== "object") {
    return "";
  }

  return normalizeString(item.src ?? item.url ?? item.link ?? item.imagem ?? item.image).trim();
}

function extractImages(product) {
  const sources = [
    product?.imagens,
    product?.images,
    product?.fotos,
    product?.image,
    product?.imagem,
  ];

  const urls = [];

  for (const source of sources) {
    const entries = unwrapImageField(source);
    entries.forEach((entry) => {
      const src = extractImageSrc(entry).trim();
      if (src && isValidImageUrl(src)) {
        urls.push(src);
      }
    });
  }

  const uniqueUrls = [...new Set(urls)];
  return uniqueUrls.map((src) => ({ src }));
}

function collectArrayFieldPaths(value, currentPath = "payload", result = []) {
  if (Array.isArray(value)) {
    result.push(currentPath);
    value.forEach((item, index) => {
      collectArrayFieldPaths(item, `${currentPath}[${index}]`, result);
    });
    return result;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => {
      collectArrayFieldPaths(child, `${currentPath}.${key}`, result);
    });
  }

  return result;
}

function buildShopifyPayload(product) {
  const title = normalizeString(product.nome ?? product.name ?? product.title).trim() || `bling-${Date.now()}`;
  const bodyHtml = normalizeString(product.descricao ?? product.description);
  const vendor = normalizeString(product.marca ?? product.brand).trim() || "Bling";
  const tags = normalizeTags(product.tags ?? product.tag ?? product.etiquetas ?? product.labels) || "bling-sync";
  const productType = normalizeProductType(
    product.product_type ?? product.tipo ?? product.categoria ?? product.categorias,
  );
  const sku = normalizeString(product.codigo ?? product.sku ?? product.codigoBling ?? product.id).trim();
  const images = extractImages(product);

  const payload = {
    product: {
      title,
      body_html: bodyHtml,
      vendor,
      tags,
      product_type: productType,
      variants: [
        {
          sku,
          price: String(product.precoVenda ?? product.price ?? "0.00"),
          inventory_quantity: ensureNumber(product.quantidade ?? product.estoque ?? 0),
        },
      ],
    },
  };

  if (images.length > 0) {
    payload.product.images = images;
  }

  return payload;
}

function logProductPayloadDiagnostics(payload) {
  const productPayload = payload?.product ?? {};
  const topLevelKeys = Object.keys(productPayload);
  const arrayPaths = [...new Set(collectArrayFieldPaths(payload))];

  logger.info("Shopify product payload diagnostics", {
    topLevelKeys,
    arrayPaths,
    title: normalizeString(productPayload.title),
    tags: normalizeString(productPayload.tags),
    product_type: normalizeString(productPayload.product_type),
    image_count: Array.isArray(productPayload.images) ? productPayload.images.length : 0,
    variant_count: Array.isArray(productPayload.variants) ? productPayload.variants.length : 0,
  });
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

  const sku = normalizeString(product.codigo ?? product.sku ?? product.codigoBling).trim();
  const shopifyPayload = buildShopifyPayload(product);

  logProductPayloadDiagnostics(shopifyPayload);

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
    await setProductMetafield(
      ownerId,
      "descricao_complementar",
      String(complement),
      "multi_line_text_field",
    );
    logger.info("Mapped descricaoComplementar to metafield", {
      ownerId,
      key: "custom.descricao_complementar",
      type: "multi_line_text_field",
    });
  }

  return result;
}
