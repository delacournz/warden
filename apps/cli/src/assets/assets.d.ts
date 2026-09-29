/** Markdown assets imported as text (`with { type: "text" }`) — embedded by `bun build --compile`. */
declare module "*.md" {
	const content: string;
	export default content;
}
