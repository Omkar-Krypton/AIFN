import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const BUILD_STEPS = {
  CLEAN: "🧹 Clean dist folder",
  BUILD: "🏗️ Build with Vite",
  COPY_MANIFEST: "📋 Copy manifest and assets",
  OBFUSCATE: "🔒 Obfuscate and minify JavaScript files",
  VALIDATE: "✅ Validate build output",
};

function logStep(step, message) {
  console.log(`\n${step} ${message}`);
  console.log("─".repeat(50));
}

function executeCommand(command, description) {
  try {
    console.log(`\n🔄 ${description}...`);
    execSync(command, { stdio: "inherit" });
    console.log(`✅ ${description} completed successfully`);
    return true;
  } catch (error) {
    console.error(`❌ ${description} failed:`, error.message);
    return false;
  }
}

function cleanDist() {
  const distPath = path.join(process.cwd(), "dist");
  if (fs.existsSync(distPath)) {
    fs.rmSync(distPath, { recursive: true, force: true });
    console.log("🗑️ Dist folder cleaned");
  }
}

function copyDirectoryRecursive(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  entries.forEach((entry) => {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

function copyManifestAndAssets() {
  const publicDir = path.join(process.cwd(), "public");
  const distDir = path.join(process.cwd(), "dist");

  // Track which files were actually copied (used by validate)
  const copiedFiles = new Set();

  // Copy manifest.json explicitly (make sure it's always present)
  const manifestPath = path.join(publicDir, "manifest.json");
  const distManifestPath = path.join(distDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    fs.copyFileSync(manifestPath, distManifestPath);
    copiedFiles.add("manifest.json");
    console.log("📋 manifest.json copied");
  }

  // Copy root-level public files (js/html/svg/png/ico/json)
  if (fs.existsSync(publicDir)) {
    const rootFiles = fs.readdirSync(publicDir, { withFileTypes: true }).filter((e) => e.isFile());
    for (const entry of rootFiles) {
      const name = entry.name;
      if (name === "manifest.json") continue;
      const ext = path.extname(name).toLowerCase();
      if (![".js", ".html", ".svg", ".png", ".ico", ".json", ".webp"].includes(ext)) continue;
      fs.copyFileSync(path.join(publicDir, name), path.join(distDir, name));
      copiedFiles.add(name);
    }
  }

  // Copy extension folders that must be present for MV3
  const foldersToCopy = ["core", "js", "background", "content", "config"];
  for (const folder of foldersToCopy) {
    const src = path.join(publicDir, folder);
    const dest = path.join(distDir, folder);
    if (fs.existsSync(src)) {
      copyDirectoryRecursive(src, dest);
      console.log(`📁 ${folder}/ folder copied`);
      copiedFiles.add(`${folder}/`);
    }
  }

  copyManifestAndAssets.copiedFiles = copiedFiles;
}

function validateBuild() {
  const distDir = path.join(process.cwd(), "dist");

  // Required files (must exist BEFORE randomization)
  // Keep naming aligned with Working_extension:
  // - MV3 service worker entry: matrixDaemon.js
  // - page-context injector: nexusPage.js
  // background.js is still required because matrixDaemon.js imports it.
  const requiredFiles = ["manifest.json", "matrixDaemon.js", "background.js", "contentScript.js", "nexusPage.js"];

  console.log("\n🔍 Validating build output...");
  let allValid = true;

  for (const file of requiredFiles) {
    const filePath = path.join(distDir, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      console.log(`✅ ${file} (${(stats.size / 1024).toFixed(2)} KB)`);
    } else {
      console.error(`❌ ${file} missing`);
      allValid = false;
    }
  }

  // Validate presence of at least one app JS bundle (Vite emits hashed files under assets/)
  let hasJsBundle = false;
  const rootJs = fs.readdirSync(distDir).some((f) => f.endsWith(".js"));
  if (rootJs) {
    hasJsBundle = true;
  } else {
    const assetsDir = path.join(distDir, "assets");
    if (fs.existsSync(assetsDir)) {
      hasJsBundle = fs.readdirSync(assetsDir).some((f) => f.endsWith(".js"));
      if (hasJsBundle) {
        const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
        jsFiles.slice(0, 3).forEach((f) => {
          const stats = fs.statSync(path.join(assetsDir, f));
          console.log(`✅ assets/${f} (${(stats.size / 1024).toFixed(2)} KB)`);
        });
      }
    }
  }

  if (!hasJsBundle) {
    console.error("❌ No JavaScript bundle found in dist/ or dist/assets/");
    allValid = false;
  }

  if (allValid) {
    console.log("\n🎉 Build validation passed!");
  } else {
    console.error("\n💥 Build validation failed!");
    process.exit(1);
  }
}

async function buildExtension() {
  console.log("🚀 Starting Extension Build Process");
  console.log("=".repeat(60));

  try {
    logStep(BUILD_STEPS.CLEAN, "Removing previous build files");
    cleanDist();

    logStep(BUILD_STEPS.BUILD, "Building extension with Vite");
    if (!executeCommand("npm run build", "Vite build")) {
      throw new Error("Build failed");
    }

    logStep(BUILD_STEPS.COPY_MANIFEST, "Copying manifest and assets");
    copyManifestAndAssets();

    const shouldSkipObfuscate =
      process.argv.includes("--no-obfuscate") || process.argv.includes("--skip-obfuscate");
    if (!shouldSkipObfuscate) {
      logStep(BUILD_STEPS.OBFUSCATE, "Obfuscating and minifying JavaScript files");
      if (!executeCommand("npm run obfuscate", "Obfuscation and minification")) {
        console.warn("⚠️ Obfuscation/minification failed, continuing with build...");
      }
    } else {
      console.log("\n⏭️  Skipping obfuscation (--no-obfuscate flag detected)");
    }

    logStep(BUILD_STEPS.VALIDATE, "Checking build output");
    validateBuild();

    console.log("\n🎊 Extension build completed successfully!");
    console.log("\n📁 Build output location: ./dist/");
    console.log("\n🚀 Available commands:");
    console.log("   npm run build:extension                  - Build + Obfuscate + Randomize + Fix imports");
    console.log("   npm run build:extension -- --no-obfuscate - Build without obfuscation");
    console.log("   npm run build                            - Vite build only (no obfuscation)");
    console.log("   npm run build:obfuscate                  - Vite build + Obfuscate");
  } catch (error) {
    console.error("\n💥 Build process failed:", error.message);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
🚀 Extension Build Script

Usage: node scripts/build.js [options]

Options:
  --no-obfuscate, --skip-obfuscate  Skip obfuscation step (obfuscation runs by default)
  --help, -h                        Show this help message

Examples:
  node scripts/build.js                    # Build + Obfuscate (default)
  node scripts/build.js --no-obfuscate    # Build without obfuscation
  `);
  process.exit(0);
}

buildExtension();

