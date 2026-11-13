import { router } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { NoteSheet } from "@/modules/keyboard/components/note-sheet";
import { SavedNote } from "@/modules/keyboard/components/saved-note";
import { useNote } from "@/modules/keyboard/hooks/use-note";

/**
 * Keyboard-in-a-sheet demo, reachable from Settings or `warden-example://keyboard-sheet`: a button opens a bottom
 * sheet with a note input and a sticky Save footer (it lifts above the software keyboard); Save closes the sheet
 * and shows the text here. No sign-in gate.
 */
export default function KeyboardSheet() {
	const { saved, draft, setDraft, save } = useNote();

	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

	return (
		<Screen testID="keyboard-sheet-screen">
			<Screen.Navbar>
				<Screen.Navbar.BackButton onPress={back} testID="keyboard-sheet-back">
					<Screen.Navbar.Title>Keyboard sheet</Screen.Navbar.Title>
				</Screen.Navbar.BackButton>
			</Screen.Navbar>
			<Screen.View className="gap-4 px-5 pt-4">
				<SavedNote note={saved} />
				<NoteSheet draft={draft} onDraftChange={setDraft} onSave={save} />
			</Screen.View>
		</Screen>
	);
}
