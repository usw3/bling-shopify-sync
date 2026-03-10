import crypto from "node:crypto";

export function verifyShopifySignature(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }

  const signature = req.headers["x-shopify-hmac-sha256"];
  if (!signature || !req.rawBody) {
    return false;
  }

  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  const expectedBuffer = Buffer.from(digest, "base64");
  const signatureBuffer = Buffer.from(signature.toString(), "base64");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}
