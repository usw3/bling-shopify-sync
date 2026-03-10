import { Router } from "express";

import { createLogger } from "../lib/logger.js";
import { getValidBlingAccessToken, previewToken } from "../services/blingAuth.js";

const router = Router();
const logger = createLogger("debugBling");

router.get("/", async (_req, res) => {
  try {
    const accessToken = await getValidBlingAccessToken();
    const accessTokenPreview = previewToken(accessToken);

    logger.info("Bling debug access token resolved", { accessTokenPreview });

    return res.status(200).json({
      ok: true,
      provider: "bling",
      access_token_preview: accessTokenPreview,
    });
  } catch (error) {
    logger.warn("Bling debug access token failed", {
      message: error?.message ?? "unknown_error",
    });

    return res.status(500).json({
      ok: false,
      provider: "bling",
      error: error?.message ?? "bling_debug_auth_failed",
    });
  }
});

export default router;
