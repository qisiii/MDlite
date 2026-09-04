import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const { version, displayName } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version), __APP_NAME__: JSON.stringify(displayName) },
  plugins: [{
    name: "inject-app-name",
    transformIndexHtml(html) { return html.replaceAll("%APP_NAME%", displayName); }
  }],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } }
});
