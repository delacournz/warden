import type { TextPresetProps } from "@/components/ui/text";

/**
 * The shape of the checkbox's text part.
 *
 * Lives in a leaf rather than in `checkbox-label.tsx` because the root imports
 * it too — it wraps bare string children in a `Checkbox.Label`, and reaching for
 * the type through the part file would be reaching past what it is for.
 *
 * `variant` is already omitted by `TextPresetProps`: the part *is* one, and
 * naming a second would let a caller turn a checkbox's label into a display
 * heading and lose the scale the component exists to keep.
 */
export type CheckboxLabelProps = TextPresetProps;
