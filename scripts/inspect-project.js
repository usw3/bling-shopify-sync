import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const keywords = [
  "shopify",
  "bling",
  "metafield",
  "images",
  "tags",
  "variants",
  "payload",
  "verifyBlingSignature",
  "verifyShopifyWebhook",
];

const targets = [
  { name: "server.js", relPath: "server.js", type: "file" },
  { name: "package.json", relPath: "package.json", type: "file" },
  { name: "src/routes", relPath: "src/routes", type: "dir" },
  { name: "src/services", relPath: "src/services", type: "dir" },
  { name: "src/lib", relPath: "src/lib", type: "dir" },
  { name: "src/utils", relPath: "src/utils", type: "dir" },
];

function toRel(absPath) {
  const relative = path.relative(cwd, absPath);
  return relative || ".";
}

function listFilesRecursively(absDir) {
  if (!fs.existsSync(absDir)) {
    return [];
  }

  const output = [];
  const queue = [absDir];

  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absEntry = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absEntry);
        continue;
      }

      output.push(toRel(absEntry));
    }
  }

  return output.sort();
}

function extractExportedNames(source) {
  const names = new Set();
  const patterns = [
    /export\s+async\s+function\s+([a-zA-Z0-9_$]+)/g,
    /export\s+function\s+([a-zA-Z0-9_$]+)/g,
    /export\s+const\s+([a-zA-Z0-9_$]+)/g,
    /export\s+let\s+([a-zA-Z0-9_$]+)/g,
    /export\s+var\s+([a-zA-Z0-9_$]+)/g,
    /export\s+class\s+([a-zA-Z0-9_$]+)/g,
  ];

  patterns.forEach((pattern) => {
    for (const match of source.matchAll(pattern)) {
      names.add(match[1]);
    }
  });

  for (const match of source.matchAll(/export\s*{\s*([^}]+)\s*}/g)) {
    const group = match[1] || "";
    group
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        const aliasParts = item.split(/\s+as\s+/i);
        const exported = (aliasParts[1] || aliasParts[0] || "").trim();
        if (exported) {
          names.add(exported);
        }
      });
  }

  return [...names].sort();
}

function keywordPresence(source) {
  const lower = source.toLowerCase();
  const result = {};

  keywords.forEach((keyword) => {
    if (keyword === "verifyBlingSignature" || keyword === "verifyShopifyWebhook") {
      result[keyword] = source.includes(keyword);
      return;
    }

    result[keyword] = lower.includes(keyword.toLowerCase());
  });

  return result;
}

function readFileSafe(relPath) {
  const abs = path.join(cwd, relPath);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (_error) {
    return "";
  }
}

console.log("=== Project Inspection ===");
console.log(`cwd: ${cwd}`);
console.log("");

const groups = {};
targets.forEach((target) => {
  const absTarget = path.join(cwd, target.relPath);

  if (target.type === "file") {
    groups[target.name] = fs.existsSync(absTarget) ? [target.relPath] : [];
    return;
  }

  groups[target.name] = listFilesRecursively(absTarget);
});

console.log("=== File Groups ===");
targets.forEach((target) => {
  const files = groups[target.name] || [];
  console.log(`- ${target.name}: ${files.length} file(s)`);
  files.forEach((file) => console.log(`  - ${file}`));
});
console.log("");

const jsFiles = new Set();
Object.values(groups).forEach((files) => {
  files.filter((file) => file.endsWith(".js")).forEach((file) => jsFiles.add(file));
});

console.log("=== JS File Diagnostics ===");
[...jsFiles]
  .sort()
  .forEach((file) => {
    const source = readFileSafe(file);
    const exported = extractExportedNames(source);
    const presence = keywordPresence(source);

    console.log(`\nfile: ${file}`);
    console.log(`exports: ${exported.length ? exported.join(", ") : "(none found)"}`);
    console.log(`keywords: ${JSON.stringify(presence)}`);
  });
