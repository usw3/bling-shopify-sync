import fs from "node:fs";
import path from "node:path";

import { Router } from "express";

const router = Router();

function listFilesRecursively(relPath) {
  const cwd = process.cwd();
  const absPath = path.join(cwd, relPath);

  if (!fs.existsSync(absPath)) {
    return [];
  }

  const output = [];
  const queue = [absPath];

  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absEntry = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absEntry);
        continue;
      }

      output.push(path.relative(cwd, absEntry));
    }
  }

  return output.sort();
}

function listDebugFiles() {
  const cwd = process.cwd();
  const hasServer = fs.existsSync(path.join(cwd, "server.js"));

  return {
    server: hasServer ? ["server.js"] : [],
    routes: listFilesRecursively("src/routes"),
    services: listFilesRecursively("src/services"),
    lib: listFilesRecursively("src/lib"),
    utils: listFilesRecursively("src/utils"),
  };
}

function inspectNode(value, currentPath, arrayFields, fieldTypes) {
  const isArray = Array.isArray(value);
  const type = value === null ? "null" : isArray ? "array" : typeof value;
  fieldTypes.push({ path: currentPath, type });

  if (isArray) {
    arrayFields.push(currentPath);
    value.forEach((item, index) => {
      inspectNode(item, `${currentPath}[${index}]`, arrayFields, fieldTypes);
    });
    return;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => {
      inspectNode(child, `${currentPath}.${key}`, arrayFields, fieldTypes);
    });
  }
}

router.get("/files", (_req, res) => {
  return res.status(200).json({
    ok: true,
    files: listDebugFiles(),
  });
});

router.get("/env-check", (_req, res) => {
  return res.status(200).json({
    hasBLING_CLIENT_ID: Boolean(process.env.BLING_CLIENT_ID),
    hasBLING_CLIENT_SECRET: Boolean(process.env.BLING_CLIENT_SECRET),
    hasBLING_ACCESS_TOKEN: Boolean(process.env.BLING_ACCESS_TOKEN),
    hasBLING_REFRESH_TOKEN: Boolean(process.env.BLING_REFRESH_TOKEN),
    hasBLING_WEBHOOK_SECRET: Boolean(process.env.BLING_WEBHOOK_SECRET),
    hasSHOPIFY_STORE: Boolean(process.env.SHOPIFY_STORE),
    hasSHOPIFY_CLIENT_ID: Boolean(process.env.SHOPIFY_CLIENT_ID),
    hasSHOPIFY_CLIENT_SECRET: Boolean(process.env.SHOPIFY_CLIENT_SECRET),
    hasSHOPIFY_WEBHOOK_SECRET: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET),
    hasSHOPIFY_API_VERSION: Boolean(process.env.SHOPIFY_API_VERSION),
  });
});

router.post("/inspect-payload", (req, res) => {
  const arrayFields = [];
  const fieldTypes = [];
  const body = req.body ?? {};

  inspectNode(body, "body", arrayFields, fieldTypes);

  return res.status(200).json({
    ok: true,
    arrayFields: [...new Set(arrayFields)],
    fieldTypes,
  });
});

export default router;
