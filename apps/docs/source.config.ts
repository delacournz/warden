import { defineConfig } from "fumadocs-mdx/config";
import { rehypeRowAnchors } from "./src/lib/row-anchors";

export default defineConfig({
	mdxOptions: {
		rehypePlugins: (plugins) => [...plugins, rehypeRowAnchors],
	},
});
