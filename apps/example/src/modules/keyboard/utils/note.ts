/** What the saved readout shows before anything is saved. */
export const NO_NOTE = "none";

/** Trims a draft; an empty or whitespace-only draft saves nothing. */
export function normalizeNote(draft: string): string {
	return draft.trim();
}

/** The saved readout text: the note, or `none` while there is no note. */
export function formatSavedNote(note: string): string {
	return note === "" ? NO_NOTE : note;
}
