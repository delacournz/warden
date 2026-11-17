/**
 * Pages whose frontmatter sets `simulatorOnly: true` (every device condition: warden never changes a phone's
 * network, clock, sensors or settings) open with a warning that the feature does not run on a physical device:
 * an orange banner on the page, a warning quote in its Markdown for agents.
 */

/** The banner's sentence for a page about `subject` (its title). */
export function simulatorOnlyNotice(subject: string): string {
	return `${subject} can only be used against simulators and emulators, physical devices are not supported.`;
}

/** The notice as the first block of a page's Markdown, or `""` for a page that runs on physical devices too. */
export function simulatorOnlyMarkdown(data: { title: string; simulatorOnly?: boolean }): string {
	return data.simulatorOnly ? `> **Warning:** ${simulatorOnlyNotice(data.title)}\n\n` : "";
}
