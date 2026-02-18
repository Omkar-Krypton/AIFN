// scripts/randomize-build.cjs (improved)
// Replaces imports including side-effect imports and adds fallback basename lookup
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const TEXT_EXTS = new Set([
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".xml",
  ".txt",
  ".webmanifest",
]);

function toPosix(p) {
  return p.split(path.sep).join("/");
}
function randomBase(ext) {
  return crypto.randomBytes(10).toString("hex") + ext;
}

function collectFiles(dir, base = "") {
  const abs = path.join(dir, base);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) results.push(...collectFiles(dir, rel));
    else if (entry.isFile()) results.push(toPosix(rel));
  }
  return results;
}

function isTextFile(relPosix) {
  return TEXT_EXTS.has(path.extname(relPosix).toLowerCase());
}

function updateManifestContents(manifestObj, renameMap) {
  if (typeof manifestObj === "string") {
    const key = toPosix(manifestObj);
    if (renameMap[key]) return renameMap[key];
    return manifestObj;
  }
  if (Array.isArray(manifestObj)) return manifestObj.map((v) => updateManifestContents(v, renameMap));
  if (typeof manifestObj === "object" && manifestObj !== null) {
    const out = {};
    for (const k of Object.keys(manifestObj)) out[k] = updateManifestContents(manifestObj[k], renameMap);
    return out;
  }
  return manifestObj;
}

function resolveImportPath(fileRelPosix, importPath) {
  if (importPath.startsWith("/")) return importPath.slice(1);
  const fileDir = path.posix.dirname(fileRelPosix);
  return path.posix.normalize(path.posix.join(fileDir, importPath));
}

function toRelativeImport(fromFilePosix, targetPosix) {
  const fromDir = path.posix.dirname(fromFilePosix);
  let rel = path.posix.relative(fromDir, targetPosix);
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = "./" + rel;
  return rel;
}

function findRenameForImport(resolvedPosix, renameMap) {
  // direct match
  if (renameMap[resolvedPosix]) return renameMap[resolvedPosix];

  // variants: with .js, with /index.js
  if (!path.posix.extname(resolvedPosix)) {
    const withJs = resolvedPosix + ".js";
    if (renameMap[withJs]) return renameMap[withJs];
    const withIndex = path.posix.join(resolvedPosix, "index.js");
    if (renameMap[withIndex]) return renameMap[withIndex];
  } else {
    const withIndex = path.posix.join(resolvedPosix, "index.js");
    if (renameMap[withIndex]) return renameMap[withIndex];
  }

  // FALLBACK 1: basename match in same directory
  const targetBase = path.posix.basename(resolvedPosix);
  for (const key of Object.keys(renameMap)) {
    if (path.posix.basename(key) === targetBase) {
      const reqDir = path.posix.dirname(resolvedPosix);
      const keyDir = path.posix.dirname(key);
      if (reqDir === keyDir) return renameMap[key];
    }
  }

  // FALLBACK 2: any key whose basename equals targetBase
  for (const key of Object.keys(renameMap)) {
    if (path.posix.basename(key) === targetBase) return renameMap[key];
  }

  return null;
}

(function main() {
  if (!fs.existsSync(DIST)) {
    console.error("❌ dist not found:", DIST);
    process.exit(1);
  }

  const allFiles = collectFiles(DIST, "");
  const renameMap = {};
  for (const rel of allFiles) {
    const base = path.posix.basename(rel);
    if (base === "manifest.json") continue;
    const ext = path.posix.extname(rel) || "";
    const newBase = randomBase(ext);
    const newRel = path.posix.join(path.posix.dirname(rel), newBase);
    renameMap[rel] = newRel;
  }

  // rename files
  for (const [oldRel, newRel] of Object.entries(renameMap)) {
    const oldAbs = path.join(DIST, ...oldRel.split("/"));
    const newAbs = path.join(DIST, ...newRel.split("/"));
    try {
      fs.renameSync(oldAbs, newAbs);
    } catch (err) {
      console.error("Rename failed:", oldAbs, "->", newAbs, err);
      process.exit(1);
    }
  }

  // update manifest contents
  const manifestPath = path.join(DIST, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const mfRaw = fs.readFileSync(manifestPath, "utf8");
    const mf = JSON.parse(mfRaw);
    const updated = updateManifestContents(mf, renameMap);
    fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2), "utf8");
    console.log("✅ manifest.json updated");
  } else console.warn("⚠ manifest.json missing");

  // Now update imports inside text files
  const after = collectFiles(DIST, "");
  const unresolved = [];

  for (const rel of after) {
    if (!isTextFile(rel)) continue;
    const abs = path.join(DIST, ...rel.split("/"));
    let content = fs.readFileSync(abs, "utf8");
    let changed = false;

    // regexes: includes side-effect import: import 'x';
    const importRegexes = [
      /import\s+[^'"]+from\s+['"]([^'"]+)['"]/g, // import ... from 'path'
      /import\s+['"]([^'"]+)['"]/g, // side-effect import 'path'
      /import\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('path')
      /require\(\s*['"]([^'"]+)['"]\s*\)/g, // require('path')
      /export\s+[^'"]+from\s+['"]([^'"]+)['"]/g, // export ... from 'path'
    ];

    for (const regex of importRegexes) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(content)) !== null) {
        const importPath = m[1];
        if (/^(https?:|data:|chrome-extension:|file:|\/\/)/i.test(importPath)) continue;
        const resolved = resolveImportPath(rel, importPath);
        const newTarget = findRenameForImport(resolved, renameMap);
        if (newTarget) {
          const newRelPath = toRelativeImport(rel, newTarget);
          let replacementPath = newRelPath;
          if (!path.posix.extname(importPath) && path.posix.extname(newRelPath) === ".js") {
            replacementPath = newRelPath.slice(0, -3);
          }
          const matchStr = m[0];
          const idxInMatch = matchStr.indexOf(m[1]);
          if (idxInMatch >= 0) {
            const startIdx = m.index + idxInMatch;
            const endIdx = startIdx + m[1].length;
            content = content.slice(0, startIdx) + replacementPath + content.slice(endIdx);
            changed = true;
            regex.lastIndex = startIdx + replacementPath.length + 1;
          }
        } else {
          unresolved.push({ file: rel, importPath, resolved });
        }
      }
    }

    // replace any literal oldRel occurrences
    for (const [oldPosix, newPosix] of Object.entries(renameMap)) {
      if (content.includes(oldPosix)) {
        content = content.split(oldPosix).join(newPosix);
        changed = true;
      }
      const oldBase = path.posix.basename(oldPosix);
      const newBase = path.posix.basename(newPosix);
      if (oldBase !== newBase && content.includes(oldBase)) {
        content = content.replace(
          new RegExp(`(["'\\(\\/])${oldBase.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&")}`, "g"),
          (m0, p1) => p1 + newBase
        );
        changed = true;
      }
    }

    if (changed) fs.writeFileSync(abs, content, "utf8");
  }

  if (unresolved.length) {
    const reportPath = path.join(DIST, "unresolved-imports.json");
    fs.writeFileSync(reportPath, JSON.stringify(unresolved, null, 2), "utf8");
    console.warn("⚠ Some imports could not be resolved automatically. See dist/unresolved-imports.json");
  }

  console.log("🎉 Randomization + import updates complete.");
})();

