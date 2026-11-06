import { useCallback, useState } from "react";
import { normalizeNote } from "../utils/note";

type UseNote = {
	/** The note last saved; empty until the first save. */
	saved: string;
	/** The text in the sheet's input. */
	draft: string;
	setDraft: (text: string) => void;
	/** Commits the draft as the saved note. */
	save: () => void;
};

/** Draft and saved note for the keyboard sheet demo; in-memory, so every launch starts empty. */
export function useNote(): UseNote {
	const [saved, setSaved] = useState("");
	const [draft, setDraft] = useState("");

	const save = useCallback(() => {
		setSaved(normalizeNote(draft));
	}, [draft]);

	return { saved, draft, setDraft, save };
}
