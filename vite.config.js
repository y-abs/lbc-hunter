import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "manifest.json", dest: "." },
        { src: "assets", dest: "." },
        { src: "src/offscreen/offscreen.html", dest: "offscreen" },
      ],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/service-worker": resolve(__dirname, "src/background/service-worker.js"),
        // Content scripts are built separately via rollup.content.config.js
        // (MV3 content scripts cannot use ES modules — must be self-contained IIFE)
        "offscreen/offscreen": resolve(__dirname, "src/offscreen/offscreen.js"),
        "popup/popup": resolve(__dirname, "src/popup/popup.html"),
        "options/options": resolve(__dirname, "src/options/options.html"),
        "dashboard/dashboard": resolve(__dirname, "src/dashboard/dashboard.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
    target: "chrome110",
    minify: false,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
