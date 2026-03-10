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

function collectReadableParts(value, output, seen) {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    const clean = value.trim();
    if (clean) {
      output.push(clean);
    }
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    const clean = String(value).trim();
    if (clean) {
      output.push(clean);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectReadableParts(entry, output, seen));
    return;
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return;
    }

    seen.add(value);
    Object.values(value).forEach((entry) => collectReadableParts(entry, output, seen));
    return;
  }

  const fallback = String(value).trim();
  if (fallback && fallback !== "[object Object]") {
    output.push(fallback);
  }
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }

  if (Array.isArray(value) || typeof value === "object") {
    const parts = [];
    collectReadableParts(value, parts, new WeakSet());
    return parts.join(" ").trim();
  }

  const fallback = String(value).trim();
  return fallback === "[object Object]" ? "" : fallback;
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    const tags = value
      .flat(Infinity)
      .map((entry) => normalizeString(entry))
      .filter(Boolean);

    return tags.join(", ");
  }

  return normalizeString(value);
}

function normalizeProductType(value) {
  if (Array.isArray(value)) {
    for (const entry of value.flat(Infinity)) {
      const normalized = normalizeString(entry);
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const normalized = normalizeString(entry);
      if (normalized) {
        return normalized;
      }
    }

    return "";
  }

  return normalizeString(value);
}

function extractFirstMeaningful(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = extractFirstMeaningful(entry);
      if (candidate !== "") {
        return candidate;
      }
    }

    return "";
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const candidate = extractFirstMeaningful(entry);
      if (candidate !== "") {
        return candidate;
      }
    }

    return "";
  }

  return normalizeString(value);
}

function normalizePrice(value) {
  const candidate = extractFirstMeaningful(value);
  if (!candidate) {
    return "0.00";
  }

  const sanitized = candidate.replace(/\s+/g, "").replace(",", ".").replace(/[^0-9.-]/g, "");
  if (!sanitized) {
    return "0.00";
  }

  const numeric = Number(sanitized);
  if (!Number.isFinite(numeric)) {
    return "0.00";
  }

  return numeric.toFixed(2);
}

function normalizeSku(value) {
  const normalized = normalizeString(value);
  const lowered = normalized.toLowerCase();

  if (!normalized || lowered === "[object object]" || lowered === "array" || lowered === "object") {
    return "";
  }

  return normalized;
}

function ensureNumber(value) {
  const number = Number(value ?? 0);
  return Number.isNaN(number) ? 0 : number;
}

function describeType(value) {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function isValidImageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function getImageUrlRejectionReason(url) {
  const normalizedUrl = normalizeString(url);
  if (!normalizedUrl) {
    return "empty_url";
  }

  if (!isValidImageUrl(normalizedUrl)) {
    return "invalid_url";
  }

  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch (_error) {
    return "invalid_url";
  }

  const lowerFull = normalizedUrl.toLowerCase();
  const queryKeys = [...parsed.searchParams.keys()].map((key) => key.toLowerCase());

  const suspiciousKeySet = new Set([
    "awsaccesskeyid",
    "signature",
    "x-amz-signature",
    "x-amz-credential",
    "expires",
    "x-amz-security-token",
    "x-amz-algorithm",
    "x-amz-date",
    "x-amz-expires",
  ]);

  const hasSuspiciousQueryKey = queryKeys.some((key) => suspiciousKeySet.has(key));
  const hasSuspiciousQueryPattern =
    lowerFull.includes("awsaccesskeyid=") ||
    lowerFull.includes("signature=") ||
    lowerFull.includes("x-amz-signature=") ||
    lowerFull.includes("x-amz-credential=") ||
    lowerFull.includes("expires=");

  if (hasSuspiciousQueryKey || hasSuspiciousQueryPattern) {
    if (parsed.hostname.toLowerCase().includes("orgbling.s3.amazonaws.com")) {
      return "private_presigned_orgbling_s3";
    }

    return "private_presigned_url";
  }

  return null;
}

function isLikelyPublicImageUrl(url) {
  return getImageUrlRejectionReason(url) === null;
}

function unwrapImageField(value, result = [], seenObjects = new WeakSet()) {
  if (value === null || value === undefined) {
    return result;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => unwrapImageField(entry, result, seenObjects));
    return result;
  }

  if (typeof value === "object") {
    if (seenObjects.has(value)) {
      return result;
    }
    seenObjects.add(value);

    if (value.src || value.url || value.link || value.imagem || value.image) {
      result.push(value);
    }

    const nestedArrayKeys = ["imagens", "images", "fotos", "foto", "imagem", "image", "item"];
    for (const key of nestedArrayKeys) {
      if (value[key] !== undefined) {
        unwrapImageField(value[key], result, seenObjects);
      }
    }

    return result;
  }

  result.push(value);
  return result;
}

function extractImageSrc(item) {
  if (typeof item === "string") {
    return item;
  }

  if (!item || typeof item !== "object") {
    return "";
  }

  return normalizeString(item.src ?? item.url ?? item.link ?? item.imagem ?? item.image);
}

function extractImages(product) {
  const sources = [
    product?.imagens,
    product?.images,
    product?.fotos,
    product?.image,
    product?.imagem,
  ];

  const candidateUrls = [];
  const validUrls = [];
  const skippedReasonCounts = {};

  for (const source of sources) {
    const entries = unwrapImageField(source);
    entries.forEach((entry) => {
      const src = extractImageSrc(entry);
      candidateUrls.push(src);

      if (!src) {
        skippedReasonCounts.empty_url = (skippedReasonCounts.empty_url ?? 0) + 1;
        return;
      }

      if (!isLikelyPublicImageUrl(src)) {
        const reason = getImageUrlRejectionReason(src) ?? "unavailable_url";
        skippedReasonCounts[reason] = (skippedReasonCounts[reason] ?? 0) + 1;
        return;
      }

      validUrls.push(src);
    });
  }

  const uniqueValidUrls = [...new Set(validUrls)];
  const duplicateSkips = validUrls.length - uniqueValidUrls.length;
  if (duplicateSkips > 0) {
    skippedReasonCounts.duplicate_url = (skippedReasonCounts.duplicate_url ?? 0) + duplicateSkips;
  }

  return {
    images: uniqueValidUrls.map((src) => ({ src })),
    diagnostics: {
      image_candidates_count: candidateUrls.length,
      image_valid_count: uniqueValidUrls.length,
      image_skipped_count: candidateUrls.length - uniqueValidUrls.length,
      skipped_image_reasons: skippedReasonCounts,
    },
  };
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

function coerceImages(images) {
  const raw = Array.isArray(images) ? images : [];
  return raw
    .map((entry) => {
      const src = normalizeString(typeof entry === "object" ? entry?.src ?? entry?.url ?? entry?.link : entry);
      return { src };
    })
    .filter((entry) => entry.src && isLikelyPublicImageUrl(entry.src));
}

function buildShopifyPayload(product, images = []) {
  const rawTitle = product.nome ?? product.name ?? product.title ?? product.descricao ?? product.description;
  const title = normalizeString(rawTitle) || normalizeSku(product.id) || "Produto sem título";
  const bodyHtml = normalizeString(product.descricao ?? product.description ?? product.descricao_curta);
  const vendor = normalizeString(product.marca ?? product.vendor ?? product.fabricante ?? product.brand);
  const tags = normalizeTags(product.tags ?? product.tag ?? product.etiquetas ?? product.labels) || "bling-sync";
  const productType = normalizeProductType(
    product.product_type ?? product.tipo ?? product.categoria ?? product.categorias,
  );
  const sku = normalizeSku(product.codigo ?? product.sku ?? product.codigoBling ?? product.id);
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
          price: normalizePrice(product.precoVenda ?? product.preco ?? product.price),
          inventory_quantity: ensureNumber(product.quantidade ?? product.estoque ?? 0),
        },
      ],
    },
  };

  if (Array.isArray(images) && images.length > 0) {
    payload.product.images = images;
  }

  return payload;
}

function applyFinalPayloadGuard(payload, product) {
  const guarded = payload && typeof payload === "object" ? payload : {};
  const guardedProduct = guarded.product && typeof guarded.product === "object" ? guarded.product : {};

  guardedProduct.title =
    normalizeString(guardedProduct.title) || normalizeSku(product?.id) || normalizeSku(product?.codigo) || "Produto sem título";
  guardedProduct.body_html = normalizeString(guardedProduct.body_html);
  guardedProduct.vendor = normalizeString(guardedProduct.vendor);
  guardedProduct.product_type = normalizeString(guardedProduct.product_type);
  guardedProduct.tags = normalizeString(guardedProduct.tags);

  const firstVariant =
    Array.isArray(guardedProduct.variants) && guardedProduct.variants[0] && typeof guardedProduct.variants[0] === "object"
      ? guardedProduct.variants[0]
      : {};

  firstVariant.sku = normalizeSku(firstVariant.sku);
  firstVariant.price = normalizePrice(firstVariant.price);
  firstVariant.inventory_quantity = ensureNumber(firstVariant.inventory_quantity);

  guardedProduct.variants = [firstVariant];
  const safeImages = coerceImages(guardedProduct.images);
  if (safeImages.length > 0) {
    guardedProduct.images = safeImages;
  } else {
    delete guardedProduct.images;
  }

  guarded.product = guardedProduct;
  return guarded;
}

function extractShortDescription(product) {
  return (
    product.descricaoCurta ??
    product.descricao_curta ??
    product.resumo ??
    product.short_description ??
    product.shortDescription ??
    null
  );
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

function logProductNormalizationDiagnostics(product, payload) {
  const productPayload = payload?.product ?? {};
  const variants = Array.isArray(productPayload.variants) ? productPayload.variants : [];
  const firstVariant = variants[0] ?? {};

  logger.info("product_sync_normalization_diagnostics", {
    productId: normalizeSku(product?.id ?? product?.codigo ?? product?.sku ?? product?.codigoBling),
    rawFieldTypes: {
      nome: describeType(product?.nome),
      descricao: describeType(product?.descricao ?? product?.description),
      descricao_curta: describeType(extractShortDescription(product)),
      descricao_complementar: describeType(product?.descricaoComplementar ?? product?.descricao_complementar),
      marca_vendor: describeType(product?.marca ?? product?.vendor ?? product?.fabricante ?? product?.brand),
      tags: describeType(product?.tags ?? product?.tag ?? product?.etiquetas ?? product?.labels),
      product_type: describeType(product?.product_type ?? product?.tipo ?? product?.categoria ?? product?.categorias),
      imagens_images_fotos_image_imagem: describeType(
        product?.imagens ?? product?.images ?? product?.fotos ?? product?.image ?? product?.imagem,
      ),
      preco_price: describeType(product?.precoVenda ?? product?.preco ?? product?.price),
      sku_codigo: describeType(product?.codigo ?? product?.sku ?? product?.codigoBling ?? product?.id),
    },
    normalized: {
      title: normalizeString(productPayload.title),
      body_html_preview: normalizeString(productPayload.body_html).slice(0, 120),
      vendor: normalizeString(productPayload.vendor),
      product_type: normalizeString(productPayload.product_type),
      tags: normalizeString(productPayload.tags),
      sku: normalizeSku(firstVariant.sku),
      price: normalizePrice(firstVariant.price),
      image_count: Array.isArray(productPayload.images) ? productPayload.images.length : 0,
      variant_count: variants.length,
    },
    arrayPaths: [...new Set(collectArrayFieldPaths(payload))],
  });
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

  const sku = normalizeSku(product.codigo ?? product.sku ?? product.codigoBling ?? product.id);
  const extractedImages = extractImages(product);
  const rawPayload = buildShopifyPayload(product, extractedImages.images);
  const shopifyPayload = applyFinalPayloadGuard(rawPayload, product);
  const payloadWillIncludeImages = Array.isArray(shopifyPayload?.product?.images) && shopifyPayload.product.images.length > 0;

  logger.info("product_sync_image_diagnostics", {
    ...extractedImages.diagnostics,
    payload_will_include_images: payloadWillIncludeImages,
  });

  if (!payloadWillIncludeImages && extractedImages.diagnostics.image_candidates_count > 0) {
    logger.info("Product sync will proceed without images after filtering");
  }

  logProductNormalizationDiagnostics(product, shopifyPayload);

  const existing = sku ? await findVariantBySku(sku) : null;
  let result;

  if (existing?.product?.id) {
    result = await updateShopifyProduct(existing.product.id, shopifyPayload);
    logger.info("Shopify product updated", { sku, eventType, productId: existing.product.id });
  } else {
    result = await createShopifyProduct(shopifyPayload);
    logger.info("Shopify product created", { sku, eventType, productId: result?.product?.id });
  }

  if (result?.product?.id) {
    const ownerId = existing?.product?.gqlId ?? `gid://shopify/Product/${result.product.id}`;

    const shortDescription = normalizeString(extractShortDescription(product));
    if (shortDescription) {
      await setProductMetafield(ownerId, "descricao_curta", shortDescription, "single_line_text_field");
      logger.info("Mapped descricao_curta to metafield", {
        ownerId,
        key: "custom.descricao_curta",
        type: "single_line_text_field",
      });
    }

    const complement = normalizeString(extractComplement(product));
    if (complement) {
      await setProductMetafield(ownerId, "descricao_complementar", complement, "multi_line_text_field");
      logger.info("Mapped descricaoComplementar to metafield", {
        ownerId,
        key: "custom.descricao_complementar",
        type: "multi_line_text_field",
      });
    }
  }

  return result;
}
