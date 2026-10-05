import type { TextPresetProps } from "@/components/ui/text";

/**
 * The shape of a trigger's text part.
 *
 * Lives in a leaf rather than in `tabs-label.tsx` because `tabs-trigger.tsx`
 * imports it too — the trigger wraps bare string children in a `Tabs.Label`, and
 * reaching for the type through the part file would be reaching past what that
 * file is for. The same two-consumer shape that put `CheckboxLabelProps` here.
 *
 * `variant` is already omitted by `TextPresetProps`: the part *is* one.
 */
export type TabsLabelProps = TextPresetProps;
