import type { TextProps } from "@/components/ui/text";

/**
 * The shape of a field's text parts.
 *
 * Shared by `Field.Label`, `Field.Description`, `Field.Error` and
 * `Field.Legend`, which differ only in the preset they render and the colour
 * they resolve, so it lives in a leaf rather than in one of the four files
 * arbitrarily.
 *
 * `variant` is omitted because each part already is one — naming a second would
 * let a caller turn a description into a heading and lose the type scale the
 * component exists to keep.
 */
export type FieldTextProps = Omit<TextProps, "variant">;
