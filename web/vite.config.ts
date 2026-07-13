import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const backend = process.env.HCMAP_BACKEND ?? "http://localhost:8787";

/** Bundle the committed snapshot + overlay data into the static build so the
 *  published site works with no backend running. */
function copyStaticData(): Plugin {
  return {
    name: "hcmap-copy-static",
    apply: "build",
    closeBundle() {
      const out = path.resolve(root, "dist");
      for (const dir of ["snapshot", "data"]) {
        const src = path.resolve(root, "..", dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, path.join(out, dir), { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyStaticData()],
  resolve: {
    alias: {
      "@hcmap/shared": path.resolve(root, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    // In dev, the backend serves both the mirror proxy and the static snapshot.
    proxy: {
      "/api": backend,
      "/snapshot": backend,
      "/data": backend,
    },
  },
});
