import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { routeRules } from "./src/lib/http-cache.ts";

/**
 * `PORT` lets `warden port claim` hand out the port; 3210 otherwise. `strictPort`
 * fails rather than wandering onto a port another agent's server already holds.
 */
export default defineConfig({
	server: {
		port: Number(process.env.PORT ?? 3210),
		strictPort: true,
	},
	plugins: [fumadocsMdx(), tailwindcss(), tanstackStart(), react(), nitro({
			preset: "bun",
			compressPublicAssets: true,
			routeRules,
			handlers: [{ route: "/**", middleware: true, handler: "./src/server/compress.ts" }],
		})],
	resolve: {
		tsconfigPaths: true,
	},
});
