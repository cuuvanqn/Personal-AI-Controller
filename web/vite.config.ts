import * as fs from "node:fs";
import * as path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootPkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __OTTER_VERSION__: JSON.stringify(rootPkg.version || "2.0.0"),
  },
});
