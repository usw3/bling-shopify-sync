import { createLogger } from "../lib/logger.js";
import {
  archiveShopifyProduct,
  createShopifyProduct,
  updateShopifyProduct,
  findVariantBySku,
  findProductByMetafield,
  setProductMetafield,
} from "./shopifyApi.js";

const logger = createLogger("syncProduct");

function parseEventData(data) {
  if (data === null || data === undefined) {
    return null;
  }

  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
      return { id: parsed };
    } catch (_error) {
      // fall through to URLSearchParams
    }

    try {
      const params = new URLSearchParams(trimmed);
      if ([...params.keys()].length === 0) {
        return { id: trimmed };
      }

      const parsedParams = {};
      for (const [key, value] of params.entries()) {
        try {
          parsedParams[key] = JSON.parse(value);
        } catch (_error) {
          parsedParams[key] = value;
        }
      }
      return parsedParams;
    } catch (_error) {
      return { id: trimmed };
    }
  }

  if (typeof data === "object") {
    return data;
  }

  return { id: data };
}

function extractProduct(payload) {
  const resolvedPayload = parseEventData(payload?.data) ?? payload;

  const extracted =
    resolvedPayload?.produto ??
    resolvedPayload?.produtos?.produto ??
    resolvedPayload?.product ??
    resolvedPayload?.products?.product ??
    resolvedPayload;

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

function normalizeBarcode(value) {
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
  const barcode = normalizeBarcode(extractBarcode(product));
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

  if (barcode) {
    payload.product.variants[0].barcode = barcode;
  }

  if (Array.isArray(images) && images.length > 0) {
    payload.product.images = images;
  }

  return payload;
}

function applyFinalPayloadGuard(payload, product) {
  const guarded = payload && typeof payload === "object" ? payload : {};
  const guardedProduct = guarded.product && typeof guarded.product === "object" ? guarded.product : {};

  guardedProduct.title =
    normalizeString(guardedProduct.title) ||
    normalizeSku(product?.id) ||
    normalizeSku(product?.codigo) ||
    "Produto sem título";
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
  firstVariant.barcode = normalizeBarcode(firstVariant.barcode);
  if (!firstVariant.barcode) {
    delete firstVariant.barcode;
  }

  guardedProduct.variants = [firstVariant];
  const safeImages = coerceImages(guardedProduct.images);
  if (safeImages.length > 0) {
    guardedProduct.images = safeImages;
  } else {
    delete guardedProduct.images;
  }

  const hasImages = Array.isArray(guardedProduct.images) && guardedProduct.images.length > 0;
  const hasCategory = Boolean(normalizeString(guardedProduct.product_type));
  if (!hasImages || !hasCategory) {
    guardedProduct.status = "draft";
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

function extractBarcode(product) {
  return (
    product.codigoBarras ??
    product.codigo_barras ??
    product.codigoDeBarras ??
    product.gtin ??
    product.ean ??
    product.barcode ??
    null
  );
}

function buildSyncTraceId(sourceProductId, sku) {
  const cleanId = normalizeSku(sourceProductId) || "no-id";
  const cleanSku = normalizeSku(sku) || "no-sku";
  return `${Date.now()}_${cleanId}_${cleanSku}`;
}

function extractErrorDetails(error) {
  const details = error?.details ?? {};

  return {
    error_code: error?.code ?? null,
    error_message: error?.message ?? "unknown_error",
    error_status: error?.status ?? details?.status ?? null,
    error_status_text: error?.statusText ?? details?.statusText ?? null,
    error_endpoint: error?.endpoint ?? details?.endpoint ?? null,
    error_method: error?.method ?? details?.method ?? null,
    error_response_body:
      error?.responseBody ?? details?.responseBody ?? details?.parsedBody ?? details?.body ?? null,
    error_response_errors: error?.responseErrors ?? details?.responseErrors ?? null,
    error_graphql_errors: error?.graphqlErrors ?? details?.graphqlErrors ?? null,
    error_graphql_user_errors: error?.graphqlUserErrors ?? details?.graphqlUserErrors ?? null,
    error_operation_name: error?.operationName ?? details?.operationName ?? null,
  };
}

function rootCauseSummary(error) {
  if (!error) {
    return "unknown_error";
  }

  if (error?.message) {
    return error.message;
  }

  return "unknown_error";
}

function buildStageError(stage, context, error) {
  const wrapped = new Error(
    `product_sync_failure stage=${stage} trace=${context.sync_trace_id} cause=${rootCauseSummary(error)}`,
  );

  wrapped.code = "product_sync_failure";
  wrapped.stage = stage;
  wrapped.sync_trace_id = context.sync_trace_id;
  wrapped.source_product_id = context.source_product_id;
  wrapped.sku = context.sku;
  wrapped.title = context.normalized_title;
  wrapped.result_stage = stage;
  wrapped.root_cause_summary = rootCauseSummary(error);
  wrapped.cause = error;
  wrapped.details = {
    ...extractErrorDetails(error),
    sync_trace_id: context.sync_trace_id,
    stage,
    source_product_id: context.source_product_id,
    sku: context.sku,
    title: context.normalized_title,
  };

  return wrapped;
}

function buildPayloadSummary(payload, metafieldsToWrite = []) {
  const productPayload = payload?.product ?? {};
  const variants = Array.isArray(productPayload.variants) ? productPayload.variants : [];
  const firstVariant = variants[0] ?? {};

  return {
    title: normalizeString(productPayload.title),
    body_html_length: normalizeString(productPayload.body_html).length,
    vendor: normalizeString(productPayload.vendor),
    product_type: normalizeString(productPayload.product_type),
    tags: normalizeString(productPayload.tags),
    handle: normalizeString(productPayload.handle) || null,
    status: normalizeString(productPayload.status) || null,
    images_count: Array.isArray(productPayload.images) ? productPayload.images.length : 0,
    variant_count: variants.length,
    first_variant_sku: normalizeSku(firstVariant.sku),
    first_variant_price: normalizePrice(firstVariant.price),
    first_variant_barcode: normalizeBarcode(firstVariant.barcode),
    metafields_to_write: metafieldsToWrite,
  };
}

function buildBaseLogContext({
  syncTraceId,
  sourceProductId,
  sku,
  normalizedTitle,
  imagesIncluded,
  shopDomain,
  handle,
  intent,
}) {
  return {
    sync_trace_id: syncTraceId,
    source_product_id: sourceProductId,
    sku: sku || null,
    normalized_title: normalizedTitle || null,
    images_included: Boolean(imagesIncluded),
    shop_domain: shopDomain || null,
    handle: handle || null,
    intent: intent || null,
  };
}

function logProductNormalizationDiagnostics(product, payload) {
  const productPayload = payload?.product ?? {};
  const variants = Array.isArray(productPayload.variants) ? productPayload.variants : [];
  const firstVariant = variants[0] ?? {};
  const shortDescription = normalizeString(extractShortDescription(product));
  const complement = normalizeString(extractComplement(product));

  logger.info("product_sync_normalization_diagnostics", {
    productId: normalizeSku(product?.id ?? product?.codigo ?? product?.sku ?? product?.codigoBling),
    rawFieldTypes: {
      nome: describeType(product?.nome),
      descricao: describeType(product?.descricao ?? product?.description),
      descricao_curta: describeType(extractShortDescription(product)),
      descricao_complementar: describeType(product?.descricaoComplementar ?? product?.descricao_complementar),
      codigo_barras: describeType(extractBarcode(product)),
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
      barcode: normalizeBarcode(firstVariant.barcode),
      descricao_curta_preview: shortDescription.slice(0, 120),
      descricao_complementar_preview: complement.slice(0, 120),
      image_count: Array.isArray(productPayload.images) ? productPayload.images.length : 0,
      variant_count: variants.length,
    },
    arrayPaths: [...new Set(collectArrayFieldPaths(payload))],
  });
}

export async function syncProductFromBlingEvent(payload, meta = {}) {
  const eventType = meta.eventType ?? "product_change";
  const isDeleteEvent = eventType.toLowerCase().includes("excl");
  const product = extractProduct(payload);
  if (!product) {
    if (isDeleteEvent) {
      logger.warn("Product delete request missing payload", { eventType });
      return { stage: "archive", archived: false, reason: "missing_product_payload" };
    }
    throw new Error("missing_product_payload");
  }

  const blingId = normalizeSku(product.id ?? product.codigoBling ?? product.codigo);
  const sourceProductId = blingId || normalizeSku(product.sku) || "no-id";
  const sku = normalizeSku(product.codigo ?? product.sku ?? product.codigoBling ?? product.id);
  const syncTraceId = buildSyncTraceId(sourceProductId, sku);
  const shopDomain = normalizeString(process.env.SHOPIFY_STORE).replace(/^https?:\/\//, "") || null;

  let stage = "start";
  let resultStage = "unknown";
  let intent = null;
  let normalizedTitle = null;
  let imagesIncluded = false;
  let handle = normalizeString(product.handle ?? product.slug) || null;

  const baseContext = () =>
    buildBaseLogContext({
      syncTraceId,
      sourceProductId,
      sku,
      normalizedTitle,
      imagesIncluded,
      shopDomain,
      handle,
      intent,
    });

  if (isDeleteEvent) {
    logger.info("product_sync_archive_start", {
      ...baseContext(),
      event_type: eventType,
    });

    try {
      let existing = sku ? await findVariantBySku(sku) : null;
      if (!existing?.product?.id && blingId) {
        existing = await findProductByMetafield("custom", "bling_id", blingId);
      }

      if (!existing?.product?.id) {
        logger.info("product_sync_archive_not_found", {
          ...baseContext(),
          lookup_key: sku || (blingId ? `bling_id:${blingId}` : "no-sku"),
        });
        return { stage: "archive", archived: false, reason: "not_found" };
      }

      await archiveShopifyProduct(existing.product.id);
      logger.info("product_sync_archive_success", {
        ...baseContext(),
        shopify_product_id: existing.product.id,
        shopify_handle: existing.product.handle ?? null,
      });

      return {
        stage: "archive",
        archived: true,
        shopify_product_id: existing.product.id,
      };
    } catch (error) {
      logger.error("product_sync_archive_error", {
        ...baseContext(),
        ...extractErrorDetails(error),
      });
      throw buildStageError("archive", baseContext(), error);
    }
  }

  logger.info("product_sync_start", {
    ...baseContext(),
    event_type: eventType,
    raw_source_keys: Object.keys(product ?? {}),
  });

  try {
    stage = "source_resolved";
    logger.info("product_sync_source_resolved", {
      ...baseContext(),
      source_fields: {
        id: normalizeSku(product.id),
        codigo: normalizeSku(product.codigo),
        codigoBling: normalizeSku(product.codigoBling),
        sku: normalizeSku(product.sku),
      },
    });

    const extractedImages = extractImages(product);
    const rawPayload = buildShopifyPayload(product, extractedImages.images);
    const shopifyPayload = applyFinalPayloadGuard(rawPayload, product);

    imagesIncluded = Array.isArray(shopifyPayload?.product?.images) && shopifyPayload.product.images.length > 0;
    normalizedTitle = normalizeString(shopifyPayload?.product?.title) || null;
    handle = normalizeString(shopifyPayload?.product?.handle ?? handle) || null;

    const shortDescription = normalizeString(extractShortDescription(product));
    const complement = normalizeString(extractComplement(product));
    const metafieldsToWrite = [];
    if (shortDescription) {
      metafieldsToWrite.push("custom.descricao_curta");
    }
    if (complement) {
      metafieldsToWrite.push("custom.descricao_complementar");
    }
    if (blingId) {
      metafieldsToWrite.push("custom.bling_id");
    }

    const payloadSummary = buildPayloadSummary(shopifyPayload, metafieldsToWrite);

    stage = "payload_built";
    logger.info("product_sync_payload_built", {
      ...baseContext(),
      payload_summary: payloadSummary,
    });

    logger.info("product_sync_image_diagnostics", {
      ...baseContext(),
      ...extractedImages.diagnostics,
      payload_will_include_images: imagesIncluded,
    });

    if (!imagesIncluded && extractedImages.diagnostics.image_candidates_count > 0) {
      logger.info("Product sync will proceed without images after filtering", {
        ...baseContext(),
      });
    }

    logProductNormalizationDiagnostics(product, shopifyPayload);

    stage = "lookup";
    logger.info("product_sync_shopify_lookup_start", {
      ...baseContext(),
      lookup_key: sku || (blingId ? `bling_id:${blingId}` : "no-sku"),
    });

    let existing;
    try {
      existing = sku ? await findVariantBySku(sku) : null;
      if (!existing?.product?.id && blingId) {
        existing = await findProductByMetafield("custom", "bling_id", blingId);
      }
    } catch (error) {
      logger.error("product_sync_failure", {
        ...baseContext(),
        stage: "lookup",
        result_stage: "lookup",
        root_cause_summary: rootCauseSummary(error),
        ...extractErrorDetails(error),
      });
      throw buildStageError("lookup", baseContext(), error);
    }

    intent = existing?.product?.id ? "update" : "create";
    handle = normalizeString(existing?.product?.handle ?? handle) || null;

    logger.info("product_sync_shopify_lookup_result", {
      ...baseContext(),
      lookup_key: sku || (blingId ? `bling_id:${blingId}` : "no-sku"),
      found_existing: Boolean(existing?.product?.id),
      found_product_id: existing?.product?.id ?? null,
      found_product_handle: existing?.product?.handle ?? null,
      chosen_intent: intent,
    });

    let result;
    if (intent === "update") {
      stage = "update";
      logger.info("product_sync_update_start", {
        ...baseContext(),
        target_product_id: existing?.product?.id ?? null,
      });

      try {
        result = await updateShopifyProduct(existing.product.id, shopifyPayload);
        resultStage = "update";
        handle = normalizeString(result?.product?.handle ?? handle) || null;

        logger.info("product_sync_update_success", {
          ...baseContext(),
          shopify_product_id: result?.product?.id ?? existing?.product?.id ?? null,
          shopify_handle: result?.product?.handle ?? null,
        });
      } catch (error) {
        logger.error("product_sync_update_error", {
          ...baseContext(),
          target_product_id: existing?.product?.id ?? null,
          ...extractErrorDetails(error),
        });

        logger.error("product_sync_failure", {
          ...baseContext(),
          stage: "update",
          result_stage: "update",
          root_cause_summary: rootCauseSummary(error),
          ...extractErrorDetails(error),
        });
        throw buildStageError("update", baseContext(), error);
      }
    } else {
      stage = "create";
      logger.info("product_sync_create_start", {
        ...baseContext(),
      });

      try {
        result = await createShopifyProduct(shopifyPayload);
        resultStage = "create";
        handle = normalizeString(result?.product?.handle ?? handle) || null;

        logger.info("product_sync_create_success", {
          ...baseContext(),
          shopify_product_id: result?.product?.id ?? null,
          shopify_handle: result?.product?.handle ?? null,
        });
      } catch (error) {
        logger.error("product_sync_create_error", {
          ...baseContext(),
          ...extractErrorDetails(error),
        });

        logger.error("product_sync_failure", {
          ...baseContext(),
          stage: "create",
          result_stage: "create",
          root_cause_summary: rootCauseSummary(error),
          ...extractErrorDetails(error),
        });
        throw buildStageError("create", baseContext(), error);
      }
    }

    const metafieldUserErrors = [];

    if (result?.product?.id) {
      const ownerId = existing?.product?.gqlId ?? `gid://shopify/Product/${result.product.id}`;

      if (shortDescription) {
        stage = "metafield";
        logger.info("product_sync_metafield_start", {
          ...baseContext(),
          metafield_key: "custom.descricao_curta",
          metafield_type: "single_line_text_field",
          owner_id: ownerId,
        });

        try {
          const response = await setProductMetafield(
            ownerId,
            "descricao_curta",
            shortDescription,
            "single_line_text_field",
          );

          const userErrors = response?.metafieldsSet?.userErrors ?? [];
          if (userErrors.length > 0) {
            resultStage = "metafield";
            metafieldUserErrors.push(...userErrors);
            logger.error("product_sync_metafield_error", {
              ...baseContext(),
              metafield_key: "custom.descricao_curta",
              metafield_type: "single_line_text_field",
              owner_id: ownerId,
              error_graphql_user_errors: userErrors,
              root_cause_summary: "metafield_user_errors",
            });
          } else {
            logger.info("product_sync_metafield_success", {
              ...baseContext(),
              metafield_key: "custom.descricao_curta",
              metafield_type: "single_line_text_field",
              owner_id: ownerId,
            });
          }
        } catch (error) {
          resultStage = "metafield";
          logger.error("product_sync_metafield_error", {
            ...baseContext(),
            metafield_key: "custom.descricao_curta",
            metafield_type: "single_line_text_field",
            owner_id: ownerId,
            ...extractErrorDetails(error),
          });

          logger.error("product_sync_failure", {
            ...baseContext(),
            stage: "metafield",
            result_stage: "metafield",
            root_cause_summary: rootCauseSummary(error),
            ...extractErrorDetails(error),
          });
          throw buildStageError("metafield", baseContext(), error);
        }
      }

      if (complement) {
        stage = "metafield";
        logger.info("product_sync_metafield_start", {
          ...baseContext(),
          metafield_key: "custom.descricao_complementar",
          metafield_type: "multi_line_text_field",
          owner_id: ownerId,
        });

        try {
          const response = await setProductMetafield(
            ownerId,
            "descricao_complementar",
            complement,
            "multi_line_text_field",
          );

          const userErrors = response?.metafieldsSet?.userErrors ?? [];
          if (userErrors.length > 0) {
            resultStage = "metafield";
            metafieldUserErrors.push(...userErrors);
            logger.error("product_sync_metafield_error", {
              ...baseContext(),
              metafield_key: "custom.descricao_complementar",
              metafield_type: "multi_line_text_field",
              owner_id: ownerId,
              error_graphql_user_errors: userErrors,
              root_cause_summary: "metafield_user_errors",
            });
          } else {
            logger.info("product_sync_metafield_success", {
              ...baseContext(),
              metafield_key: "custom.descricao_complementar",
              metafield_type: "multi_line_text_field",
              owner_id: ownerId,
            });
          }
        } catch (error) {
          resultStage = "metafield";
          logger.error("product_sync_metafield_error", {
            ...baseContext(),
            metafield_key: "custom.descricao_complementar",
            metafield_type: "multi_line_text_field",
            owner_id: ownerId,
            ...extractErrorDetails(error),
          });

          logger.error("product_sync_failure", {
            ...baseContext(),
            stage: "metafield",
            result_stage: "metafield",
            root_cause_summary: rootCauseSummary(error),
            ...extractErrorDetails(error),
          });
          throw buildStageError("metafield", baseContext(), error);
        }
      }

      if (blingId) {
        stage = "metafield";
        logger.info("product_sync_metafield_start", {
          ...baseContext(),
          metafield_key: "custom.bling_id",
          metafield_type: "single_line_text_field",
          owner_id: ownerId,
        });

        try {
          const response = await setProductMetafield(ownerId, "bling_id", blingId, "single_line_text_field");
          const userErrors = response?.metafieldsSet?.userErrors ?? [];
          if (userErrors.length > 0) {
            resultStage = "metafield";
            metafieldUserErrors.push(...userErrors);
            logger.error("product_sync_metafield_error", {
              ...baseContext(),
              metafield_key: "custom.bling_id",
              metafield_type: "single_line_text_field",
              owner_id: ownerId,
              error_graphql_user_errors: userErrors,
              root_cause_summary: "metafield_user_errors",
            });
          } else {
            logger.info("product_sync_metafield_success", {
              ...baseContext(),
              metafield_key: "custom.bling_id",
              metafield_type: "single_line_text_field",
              owner_id: ownerId,
            });
          }
        } catch (error) {
          resultStage = "metafield";
          logger.error("product_sync_metafield_error", {
            ...baseContext(),
            metafield_key: "custom.bling_id",
            metafield_type: "single_line_text_field",
            owner_id: ownerId,
            ...extractErrorDetails(error),
          });

          logger.error("product_sync_failure", {
            ...baseContext(),
            stage: "metafield",
            result_stage: "metafield",
            root_cause_summary: rootCauseSummary(error),
            ...extractErrorDetails(error),
          });
          throw buildStageError("metafield", baseContext(), error);
        }
      }
    }

    logger.info("product_sync_finish", {
      ...baseContext(),
      result_stage: resultStage === "unknown" ? intent : resultStage,
      metafield_user_errors_count: metafieldUserErrors.length,
      shopify_product_id: result?.product?.id ?? null,
    });

    return result;
  } catch (error) {
    if (error?.code === "product_sync_failure") {
      throw error;
    }

    logger.error("product_sync_failure", {
      ...baseContext(),
      stage,
      result_stage: resultStage === "unknown" ? stage : resultStage,
      root_cause_summary: rootCauseSummary(error),
      ...extractErrorDetails(error),
    });

    throw buildStageError(stage || "unknown", baseContext(), error);
  }
}
