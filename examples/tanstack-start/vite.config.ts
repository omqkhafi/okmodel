import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: { port: 3105 },
  resolve: { tsconfigPaths: true },
  plugins: [nitro(), tanstackStart(), viteReact()],
});
