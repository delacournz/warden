import type { ReactElement } from "react";
import type { InputSlotProps } from "./input.types";
import { InputGroupDecorator } from "./input-group-decorator";

/**
 * Trailing content inside the field's own box — an icon, a text affix, a control.
 *
 * Draws nothing of its own, unlike `ListGroup.ItemSuffix`: a row in a list has a
 * default chevron because it always navigates, whereas a field's trailing slot
 * has no one thing it usually holds.
 */
export function InputGroupSuffix(props: InputSlotProps): ReactElement {
	return <InputGroupDecorator part="Input.Group.Suffix" {...props} />;
}
InputGroupSuffix.displayName = "DelacourUI.Input.Group.Suffix";
