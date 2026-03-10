export function attachRawBody(req, _res, buf) {
  if (!buf || buf.length === 0) {
    return;
  }

  req.rawBody = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from(String(buf));
}
