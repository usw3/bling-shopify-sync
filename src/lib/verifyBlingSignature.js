import crypto from "node:crypto";

function toBuffer(value) {
  if (!value) {
    return null;
  }

  try {
    return Buffer.from(value, "hex");
  } catch (error) {
    return Buffer.from(value, "base64");
  }
}

export function verifyBlingSignature(req) {
  const secret = process.env.BLING_WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }

  const signature = req.headers["x-bling-signature"];
  if (!signature || !req.rawBody) {
    return false;
  }

  const expectedDigest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expectedDigest, "hex");
  const signatureBuffer = toBuffer(signature.toString());

  if (!signatureBuffer || signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}
