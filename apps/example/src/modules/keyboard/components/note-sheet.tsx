import type { ReactElement } from "react";
import { BottomSheet, useBottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";

type NoteSheetProps = {
	draft: string;
	onDraftChange: (text: string) => void;
	onSave: () => void;
};

type SaveButtonProps = {
	onSave: () => void;
};

/** Saves the note, then closes the sheet it is rendered in (reads the sheet from context). */
function SaveButton({ onSave }: SaveButtonProps): ReactElement {
	const sheet = useBottomSheet();

	const press = () => {
		onSave();
		sheet.close();
	};

	return (
		<Button accessible onPress={press} size="lg" testID="keyboard-sheet-save">
			Save
		</Button>
	);
}

/**
 * The note sheet: a title, an input registered with the sheet, and a sticky footer holding Save. With the keyboard up
 * the engine lifts the sheet and pins the footer to the keyboard's top edge, which is what the keyboard specs assert.
 * The panel carries the `keyboard-sheet` testID; `accessible` is deliberately off on the panel (the engine marks it a
 * modal view), so a spec reads the title and the input instead of the container.
 */
export function NoteSheet({ draft, onDraftChange, onSave }: NoteSheetProps): ReactElement {
	return (
		<BottomSheet>
			<BottomSheet.Trigger asChild>
				<Button accessible size="lg" testID="keyboard-sheet-open">
					Add a note
				</Button>
			</BottomSheet.Trigger>
			<BottomSheet.Portal>
				<BottomSheet.Overlay />
				<BottomSheet.Container testID="keyboard-sheet">
					<BottomSheet.Content>
						<BottomSheet.Title accessible testID="keyboard-sheet-title">
							Add a note
						</BottomSheet.Title>
						<BottomSheet.TextInput
							accessible
							accessibilityLabel="Note"
							onChangeText={onDraftChange}
							placeholder="Add a note"
							testID="keyboard-sheet-input"
							value={draft}
						/>
					</BottomSheet.Content>
					<BottomSheet.Footer sticky>
						<SaveButton onSave={onSave} />
					</BottomSheet.Footer>
				</BottomSheet.Container>
			</BottomSheet.Portal>
		</BottomSheet>
	);
}
