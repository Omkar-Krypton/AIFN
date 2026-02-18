import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// Keep build output predictable so our post-build obfuscation/minify scripts
// can reliably classify files (mirrors Working_extension).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    historyApiFallback: true,
  },
  build: {
    rollupOptions: {
      input: {
        // React app (popup)
        main: resolve(__dirname, "index.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
    minify: false, // minify via scripts/obfuscate.js for consistent output
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2015",
  },
});
