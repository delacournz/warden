import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		tailwindcss(),
		tanstackRouter({
			routesDirectory: "src/_routes",
			routeFileIgnorePattern: "\\.test\\.(tsx?|jsx?)$",
		}),
		react(),
	],
	clearScreen: false,
	server: {
		port: 3231,
		strictPort: true,
		watch: { ignored: ["**/src-tauri/**"] },
	},
});
