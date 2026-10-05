import type { ReactElement } from "react";
import type { InputSlotProps } from "./input.types";
import { InputGroupDecorator } from "./input-group-decorator";

/**
 * Leading content inside the field's own box — an icon, a text affix, a control.
 *
 * An `Icon` needs nothing said at the call site: it inherits the field's icon
 * step and a muted colour from the decorator's `IconDefaultsProvider`, and turns
 * destructive with the group when the value is invalid. A bare string is wrapped in a
 * `Text` that inherits the same affix treatment.
 */
export function InputGroupPrefix(props: InputSlotProps): ReactElement {
	return <InputGroupDecorator part="Input.Group.Prefix" {...props} />;
}
InputGroupPrefix.displayName = "DelacourUI.Input.Group.Prefix";
