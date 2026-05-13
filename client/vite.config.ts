import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const clientDir = __dirname;
  const repoRoot = path.resolve(clientDir, "..");
  const fileEnv = loadEnv(mode, repoRoot, "VITE_");
  const apiBase = (process.env.VITE_API_URL || fileEnv.VITE_API_URL || "").trim();

  if (mode === "production" && !apiBase) {
    console.warn(
      "[vite] VITE_API_URL is unset. Production build will use same-origin /api/v1 (set VITE_API_URL in .env or your host, e.g. https://your-api.onrender.com/api/v1)."
    );
  }

  let proxyTarget = "http://127.0.0.1:8000";
  if (apiBase.startsWith("http")) {
    try {
      proxyTarget = new URL(apiBase).origin;
    } catch {
      /* keep localhost */
    }
  }

  return {
    envDir: repoRoot,
    server: {
      host: "::",
      port: 5173,
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
      hmr: {
        overlay: false,
      },
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(clientDir, "./src"),
      },
    },
  };
});
