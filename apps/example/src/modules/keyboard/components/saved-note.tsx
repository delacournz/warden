import type { ReactElement } from "react";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { formatSavedNote } from "../utils/note";

type SavedNoteProps = {
	note: string;
};

/** The saved note, or `none` before the first save. */
export function SavedNote({ note }: SavedNoteProps): ReactElement {
	return (
		<Card>
			<Card.Header>
				<Card.Title>Saved note</Card.Title>
			</Card.Header>
			<Card.Content>
				<Text.Paragraph accessible testID="keyboard-sheet-saved">
					{formatSavedNote(note)}
				</Text.Paragraph>
			</Card.Content>
		</Card>
	);
}
