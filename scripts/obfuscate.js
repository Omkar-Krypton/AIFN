import fs from "fs";
import path from "path";
import JavaScriptObfuscator from "javascript-obfuscator";
import { minify } from "terser";

/**
 * We separate all JS files into:
 * 1) service worker (skip)
 * 2) content scripts (safe obfuscation)
 * 3) background/config/utils (strong obfuscation)
 * 4) Vite app bundles (minify only; obfuscation can break runtime)
 *
 * This mirrors the Working_extension approach but adapts to AINJ file layout.
 */
function collectJsBundles() {
  const distDir = path.join(process.cwd(), "dist");

  const contentScripts = [];
  const backgroundFiles = [];
  const skipFiles = [];
  const appBundles = [];

  const isServiceWorker = (filePath) => {
    const relative = path.relative(distDir, filePath).split(path.sep).join("/");
    // Keep naming aligned with Working_extension (MV3 service worker entry is matrixDaemon.js).
    return relative === "matrixDaemon.js";
  };

  const isViteBundle = (relativePosix) => {
    // Default Vite outputs into assets/, but with our config we also emit root-level bundles.
    if (relativePosix.startsWith("assets/")) return true;

    // Any root-level JS that isn't one of our extension entrypoints is the popup/app bundle.
    if (!relativePosix.includes("/")) {
      const allowRoot = new Set([
        "matrixDaemon.js",
        "background.js",
        "contentScript.js",
        "nexusPage.js",
        // legacy name still present in repo (not referenced by manifest)
        "inject.js",
      ]);
      return !allowRoot.has(relativePosix);
    }

    return false;
  };

  const isContentScript = (relativePosix) => {
    if (relativePosix === "contentScript.js") return true;
    if (relativePosix === "nexusPage.js") return true;
    if (relativePosix === "inject.js") return true;
    if (relativePosix.startsWith("content/")) return true;
    if (relativePosix.startsWith("js/")) return true;
    return false;
  };

  function scan(dir) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
        continue;
      }

      if (!fullPath.endsWith(".js")) continue;

      const relativePosix = path.relative(distDir, fullPath).split(path.sep).join("/");

      if (isServiceWorker(fullPath)) {
        skipFiles.push(fullPath);
        console.log("⏭️ Skipping service worker:", relativePosix);
        continue;
      }

      // Don't obfuscate Vite bundles (React popup/app). Minify-only to keep size down.
      // Strong obfuscation here frequently breaks runtime in MV3.
      if (isViteBundle(relativePosix)) {
        appBundles.push(fullPath);
        console.log("⏭️ Skipping obfuscation (app bundle):", relativePosix);
        continue;
      }

      if (isContentScript(relativePosix)) {
        contentScripts.push(fullPath);
        continue;
      }

      backgroundFiles.push(fullPath);
    }
  }

  scan(distDir);
  return { contentScripts, backgroundFiles, appBundles, skipFiles };
}

const { contentScripts, backgroundFiles, appBundles } = collectJsBundles();

// STRONG obfuscation (ONLY FOR BACKGROUND CODE)
const strongObfuscationOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.9,

  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,

  splitStrings: true,
  splitStringsChunkLength: 5,

  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,

  renameGlobals: false,
  numbersToExpressions: true,
  simplify: true,
  shuffleStringArray: true,
  rotateStringArray: true,

  selfDefending: false,
  disableConsoleOutput: false,
  target: "browser",
};

// SAFE obfuscation (FOR CONTENT SCRIPTS ONLY)
const safeObfuscationOptions = {
  compact: true,
  controlFlowFlattening: false,

  stringArray: true,
  stringArrayEncoding: [],
  stringArrayThreshold: 0.5,

  deadCodeInjection: false,
  renameGlobals: false,
  simplify: false,
  numbersToExpressions: false,
  shuffleStringArray: true,

  selfDefending: false,
  target: "browser",
};

async function minifyFile(filePath) {
  try {
    const src = fs.readFileSync(filePath, "utf-8");
    if (src.length < 50) return true;

    const result = await minify(src, {
      compress: { dead_code: true },
      mangle: { reserved: ["chrome"] },
    });

    if (result.code) fs.writeFileSync(filePath, result.code);
    return true;
  } catch {
    return false;
  }
}

async function obfuscateFile(filePath, options) {
  const src = fs.readFileSync(filePath, "utf-8");
  const out = JavaScriptObfuscator.obfuscate(src, options).getObfuscatedCode();
  fs.writeFileSync(filePath, out);
}

async function run() {
  console.log("🔧 Minifying first...");
  for (const file of [...backgroundFiles, ...contentScripts, ...appBundles]) {
    // eslint-disable-next-line no-await-in-loop
    await minifyFile(file);
  }

  console.log("\n🔒 Strong obfuscation (background code)...");
  for (const file of backgroundFiles) {
    // eslint-disable-next-line no-await-in-loop
    await obfuscateFile(file, strongObfuscationOptions);
  }

  console.log("\n🛡️ Safe obfuscation (content scripts)...");
  for (const file of contentScripts) {
    // eslint-disable-next-line no-await-in-loop
    await obfuscateFile(file, safeObfuscationOptions);
  }

  console.log("\n✨ Minify/obfuscation complete (app bundles were minified only).");
}

run();

