import crypto from "node:crypto";

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

function normalizeBase64Signature(signature) {
  if (typeof signature !== "string") {
    return null;
  }

  const cleanSignature = signature.trim();
  return cleanSignature || null;
}

export function verifyShopifyWebhook({ rawBody, signature, secret }) {
  if (!rawBody || !signature || !secret) {
    return false;
  }

  const payloadBuffer = normalizeRawBody(rawBody);
  const normalizedSignature = normalizeBase64Signature(signature);

  if (!payloadBuffer || !normalizedSignature) {
    return false;
  }

  const expectedDigest = crypto.createHmac("sha256", secret).update(payloadBuffer).digest("base64");
  const expectedBuffer = Buffer.from(expectedDigest, "base64");

  let signatureBuffer;
  try {
    signatureBuffer = Buffer.from(normalizedSignature, "base64");
  } catch (_error) {
    return false;
  }

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (_error) {
    return false;
  }
}
