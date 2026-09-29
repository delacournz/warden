import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { isFileHref } from "@/lib/shared";

/**
 * File hrefs (`/llms.txt`, `.md` twins) and bare `#fragment`s stay plain anchors;
 * everything else goes through Fumadocs' router-aware link. See {@link isFileHref}.
 */
function Anchor({ href, ...props }: ComponentProps<"a">) {
	if (href !== undefined && (href.startsWith("#") || isFileHref(href))) return <a href={href} {...props} />;
	return <defaultMdxComponents.a href={href} {...props} />;
}

export function getMDXComponents(components?: MDXComponents) {
	return {
		...defaultMdxComponents,
		a: Anchor,
		Accordion,
		Accordions,
		File,
		Files,
		Folder,
		Step,
		Steps,
		Tab,
		Tabs,
		TypeTable,
		...components,
	} satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
	type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
