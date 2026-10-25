import { describe, expect, test } from "bun:test";
import { declarationName, findDeclaration } from "./source-grep";

const text = [
	'import { View } from "react-native";',
	"",
	"export function FeedRow({ item }: Props) {",
	"  return null;",
	"}",
	"export const Avatar = memo(function Avatar() { return null; });",
	"const Header: FC<Props> = () => null;",
	"export default class Legacy extends Component {}",
	"const notFeedRowHere = FeedRowFactory();",
].join("\n");

describe("findDeclaration", () => {
	test("function, const, typed const, class; 1-based", () => {
		expect(findDeclaration(text, "FeedRow")).toBe(3);
		expect(findDeclaration(text, "Avatar")).toBe(6);
		expect(findDeclaration(text, "Header")).toBe(7);
		expect(findDeclaration(text, "Legacy")).toBe(8);
	});

	test("not a prefix or a use", () => {
		expect(findDeclaration(text, "Feed")).toBeUndefined();
		expect(findDeclaration(text, "FeedRowFactory")).toBeUndefined();
		expect(findDeclaration(text, "Missing")).toBeUndefined();
	});
});

describe("declarationName", () => {
	test("unwraps Memo(...) and ForwardRef(...); rejects non-identifiers", () => {
		expect(declarationName("Memo(ForwardRef(Row))")).toBe("Row");
		expect(declarationName("Row")).toBe("Row");
		expect(declarationName("Context.Consumer")).toBeUndefined();
		expect(declarationName("Unknown#12")).toBeUndefined();
	});
});
