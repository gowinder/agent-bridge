import { defineConfig } from "vite";

/** Build identity: the browser compares its own value with dist/version.json. */
const buildVersion = Date.now().toString(36);

export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(command === "build" ? buildVersion : "dev"),
  },
  plugins: [
    {
      name: "emit-version",
      apply: "build",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ version: buildVersion }),
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
}));
