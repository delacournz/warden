import { Button } from "@delacournz/apogee/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@delacournz/apogee/dialog";
import { Input } from "@delacournz/apogee/input";
import { Switch } from "@delacournz/apogee/switch";
import { type FormEvent, useId, useState } from "react";
import { type Coordinates, LOCATION_PRESETS, parseLocation } from "./location.ts";

type DialogProps<T> = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (value: T) => void;
};

/**
 * Text to type on the device, with a "clear first" switch. The dialog (base-ui) traps focus,
 * restores it on close and closes on Escape; the field is focused on open and Enter submits.
 */
export function TextDialog({ open, onOpenChange, onSubmit }: DialogProps<{ text: string; clearFirst: boolean }>) {
	const [text, setText] = useState("");
	const [clearFirst, setClearFirst] = useState(false);
	const fieldId = useId();
	const switchId = useId();

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (text === "") return;
		onSubmit({ text, clearFirst });
		setText("");
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="max-w-sm">
				<form onSubmit={submit} className="contents">
					<DialogHeader>
						<DialogTitle>Enter text</DialogTitle>
					</DialogHeader>
					<DialogPanel className="flex flex-col gap-3">
						<label htmlFor={fieldId} className="sr-only">
							Text to type on the device
						</label>
						<Input
							id={fieldId}
							placeholder="Text to type"
							value={text}
							onChange={(e) => setText(e.target.value)}
							autoComplete="off"
							autoCorrect="off"
							spellCheck={false}
							autoFocus
						/>
						<div className="flex items-center gap-2 text-xs">
							<Switch id={switchId} checked={clearFirst} onCheckedChange={setClearFirst} />
							<label htmlFor={switchId}>Clear the field first</label>
						</div>
					</DialogPanel>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={text === ""}>
							Type
						</Button>
					</DialogFooter>
				</form>
			</DialogPopup>
		</Dialog>
	);
}

/** Latitude and longitude fields plus one-click city presets that fill them. */
export function LocationDialog({ open, onOpenChange, onSubmit }: DialogProps<Coordinates>) {
	const [latitude, setLatitude] = useState("");
	const [longitude, setLongitude] = useState("");
	const latId = useId();
	const lngId = useId();
	const parsed = parseLocation(latitude, longitude);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!parsed) return;
		onSubmit(parsed);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="max-w-sm">
				<form onSubmit={submit} className="contents">
					<DialogHeader>
						<DialogTitle>Set location</DialogTitle>
					</DialogHeader>
					<DialogPanel className="flex flex-col gap-3">
						<div className="flex gap-2">
							<div className="flex flex-1 flex-col gap-1">
								<label htmlFor={latId} className="text-xs font-medium">
									Latitude
								</label>
								<Input
									id={latId}
									inputMode="decimal"
									placeholder="37.7749"
									value={latitude}
									onChange={(e) => setLatitude(e.target.value)}
									autoComplete="off"
									spellCheck={false}
									autoFocus
								/>
							</div>
							<div className="flex flex-1 flex-col gap-1">
								<label htmlFor={lngId} className="text-xs font-medium">
									Longitude
								</label>
								<Input
									id={lngId}
									inputMode="decimal"
									placeholder="-122.4194"
									value={longitude}
									onChange={(e) => setLongitude(e.target.value)}
									autoComplete="off"
									spellCheck={false}
								/>
							</div>
						</div>
						<fieldset className="flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
							<legend className="sr-only">Presets</legend>
							{LOCATION_PRESETS.map((preset) => (
								<Button
									key={preset.name}
									type="button"
									size="xs"
									variant="outline"
									onClick={() => {
										setLatitude(String(preset.latitude));
										setLongitude(String(preset.longitude));
									}}
								>
									{preset.name}
								</Button>
							))}
						</fieldset>
					</DialogPanel>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!parsed}>
							Set location
						</Button>
					</DialogFooter>
				</form>
			</DialogPopup>
		</Dialog>
	);
}
