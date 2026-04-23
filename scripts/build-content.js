/**
 * Builds content scripts as self-contained IIFE bundles using Vite.
 * Chrome MV3 content_scripts cannot use ES module import statements —
 * they must be fully inlined single-file classic scripts.
 */
import { build } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const entries = [
  { name: "LBCHunterSession", entry: "src/content/session-capture.js", out: "content/session-capture.js" },
  { name: "LBCHunterBadges", entry: "src/content/inject-badges.js", out: "content/inject-badges.js" },
  { name: "LBCHunterAdpage", entry: "src/content/inject-adpage.js", out: "content/inject-adpage.js" },
  { name: "LBCHunterSidebar", entry: "src/content/inject-sidebar.js", out: "content/inject-sidebar.js" },
  // page-interceptor runs in world:MAIN — pure IIFE, no extension APIs
  { name: "LBCHunterInterceptor", entry: "src/content/page-interceptor.js", out: "content/page-interceptor.js" },
];

for (const { name, entry, out } of entries) {
  const [outDir, fileName] = out.includes("/")
    ? [out.substring(0, out.lastIndexOf("/")), out.substring(out.lastIndexOf("/") + 1)]
    : ["", out];

  console.log(`Building ${out}...`);
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: resolve(root, "dist", outDir),
      emptyOutDir: false,
      lib: {
        entry: resolve(root, entry),
        name,
        formats: ["iife"],
        fileName: () => fileName,
      },
      target: "chrome110",
      minify: false,
    },
    resolve: {
      alias: { "@": resolve(root, "src") },
    },
  });
  console.log(`  → dist/${out}`);
}
