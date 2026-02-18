// scripts/fix-missing-imports.cjs
// Scans dist/*.js for imports that point to missing files and attempts to fix them
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function collectJsFiles(dir, base = "") {
  const abs = path.join(dir, base);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  let results = [];
  for (const e of entries) {
    const rel = path.join(base, e.name);
    if (e.isDirectory()) results = results.concat(collectJsFiles(dir, rel));
    else if (e.isFile() && /\.js$/i.test(e.name)) results.push(toPosix(rel));
  }
  return results;
}

function resolveImport(fileRelPosix, importPath) {
  if (importPath.startsWith("/")) return importPath.slice(1);
  const fileDir = path.posix.dirname(fileRelPosix);
  return path.posix.normalize(path.posix.join(fileDir, importPath));
}

function existsInDist(posixRel) {
  const abs = path.join(DIST, ...posixRel.split("/"));
  return fs.existsSync(abs);
}

function listJsFilesInDir(posixDir) {
  const absDir = path.join(DIST, ...posixDir.split("/"));
  if (!fs.existsSync(absDir)) return [];
  return fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((i) => i.isFile() && /\.js$/i.test(i.name))
    .map((i) => i.name);
}

function toRelativeImport(fromFilePosix, targetPosix) {
  const fromDir = path.posix.dirname(fromFilePosix);
  let rel = path.posix.relative(fromDir, targetPosix);
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = "./" + rel;
  return toPosix(rel);
}

(function main() {
  if (!fs.existsSync(DIST)) {
    console.error("dist not found:", DIST);
    process.exit(1);
  }

  const jsFiles = collectJsFiles(DIST, "");
  const report = { fixed: [], unresolved: [] };

  const importRegexes = [
    /import\s+[^'"]+from\s+['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'"]+from\s+['"]([^'"]+)['"]/g,
  ];

  for (const fileRel of jsFiles) {
    const abs = path.join(DIST, ...fileRel.split("/"));
    let content = fs.readFileSync(abs, "utf8");
    let changed = false;

    for (const regex of importRegexes) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(content)) !== null) {
        const importPath = m[1];
        if (/^(https?:|data:|chrome-extension:|file:|\/\/)/i.test(importPath)) continue;

        const resolved = resolveImport(fileRel, importPath);

        const candidatesToCheck = [resolved, resolved + ".js", path.posix.join(resolved, "index.js")];

        const exists = candidatesToCheck.find((c) => existsInDist(c));
        if (exists) continue;

        const dir = path.posix.dirname(resolved);
        const dirFiles = listJsFilesInDir(dir);
        if (dirFiles.length === 0) {
          report.unresolved.push({ file: fileRel, importPath, resolved, reason: "target-dir-empty" });
          continue;
        }

        const importBase = path.posix.basename(resolved).split(".")[0];
        let pick = dirFiles.find((n) => n.includes(importBase));
        if (!pick) pick = dirFiles[0];

        const newTargetPosix = path.posix.join(dir, pick);
        const newRelImport = toRelativeImport(fileRel, newTargetPosix);

        const matchStr = m[0];
        const idxInMatch = matchStr.indexOf(m[1]);
        if (idxInMatch >= 0) {
          const startIdx = m.index + idxInMatch;
          const endIdx = startIdx + m[1].length;
          content = content.slice(0, startIdx) + newRelImport + content.slice(endIdx);
          changed = true;
          report.fixed.push({
            file: fileRel,
            oldImport: importPath,
            newImport: newRelImport,
            resolved,
            chosenFile: pick,
          });
          regex.lastIndex = startIdx + newRelImport.length + 1;
        } else {
          report.unresolved.push({ file: fileRel, importPath, resolved, reason: "cannot-locate-match-index" });
        }
      }
    }

    if (changed) {
      fs.writeFileSync(abs, content, "utf8");
    }
  }

  fs.writeFileSync(path.join(DIST, "fix-imports-report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log("Fix completed. See dist/fix-imports-report.json for details.");
})();

