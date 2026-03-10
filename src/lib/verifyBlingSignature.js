import crypto from "node:crypto";

import { createLogger } from "./logger.js";

const logger = createLogger("verifyBlingSignature");

function normalizeRawBody(rawBody) {
  if (!rawBody) {
    return null;
  }

  if (Buffer.isBuffer(rawBody)) {
    return rawBody;
  }

  if (typeof rawBody === "string") {
    return Buffer.from(rawBody, "utf8");
  }

  try {
    return Buffer.from(JSON.stringify(rawBody), "utf8");
  } catch (_error) {
    return null;
  }
}

function normalizeHexSignature(signature) {
  if (typeof signature !== "string") {
    return null;
  }

  const cleanSignature = signature.startsWith("sha256=") ? signature.slice(7) : signature;

  if (!cleanSignature || !/^[a-fA-F0-9]+$/.test(cleanSignature)) {
    return false;
  }

  return cleanSignature.toLowerCase();
}

export function verifyBlingSignature({ rawBody, signature, secret }) {
  const payloadBuffer = normalizeRawBody(rawBody);
  const hasRawBody = Boolean(payloadBuffer);
  const rawBodyLength = payloadBuffer ? payloadBuffer.length : 0;
  const hasSecret = Boolean(secret);
  const receivedSignature = typeof signature === "string" ? signature : null;

  let expectedHex = null;
  let expectedBase64 = null;

  if (hasRawBody && hasSecret) {
    const expectedDigestBuffer = crypto.createHmac("sha256", secret).update(payloadBuffer).digest();
    expectedHex = expectedDigestBuffer.toString("hex");
    expectedBase64 = expectedDigestBuffer.toString("base64");
  }

  if (!hasRawBody || !receivedSignature || !hasSecret) {
    logger.info("Bling signature validation debug", {
      hasRawBody,
      rawBodyLength,
      hasWebhookSecret: hasSecret,
      xBlingSignature256: receivedSignature,
      expectedSignatureHex: expectedHex,
      expectedSignatureBase64: expectedBase64,
      finalValidationResult: false,
    });
    return false;
  }

  const normalizedSignature = normalizeHexSignature(receivedSignature);

  if (!payloadBuffer || !normalizedSignature) {
    logger.info("Bling signature validation debug", {
      hasRawBody,
      rawBodyLength,
      hasWebhookSecret: hasSecret,
      xBlingSignature256: receivedSignature,
      expectedSignatureHex: expectedHex,
      expectedSignatureBase64: expectedBase64,
      finalValidationResult: false,
    });
    return false;
  }

  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const signatureBuffer = Buffer.from(normalizedSignature, "hex");

  if (signatureBuffer.length !== expectedBuffer.length) {
    logger.info("Bling signature validation debug", {
      hasRawBody,
      rawBodyLength,
      hasWebhookSecret: hasSecret,
      xBlingSignature256: receivedSignature,
      expectedSignatureHex: expectedHex,
      expectedSignatureBase64: expectedBase64,
      finalValidationResult: false,
    });
    return false;
  }

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (_error) {
    isValid = false;
  }

  logger.info("Bling signature validation debug", {
    hasRawBody,
    rawBodyLength,
    hasWebhookSecret: hasSecret,
    xBlingSignature256: receivedSignature,
    expectedSignatureHex: expectedHex,
    expectedSignatureBase64: expectedBase64,
    finalValidationResult: isValid,
  });

  return isValid;
}
