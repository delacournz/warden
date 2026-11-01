import { describe, expect, test } from "bun:test";
import { sourceGrep } from "./source-grep";

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
		expect(sourceGrep.findDeclaration(text, "FeedRow")).toBe(3);
		expect(sourceGrep.findDeclaration(text, "Avatar")).toBe(6);
		expect(sourceGrep.findDeclaration(text, "Header")).toBe(7);
		expect(sourceGrep.findDeclaration(text, "Legacy")).toBe(8);
	});

	test("not a prefix or a use", () => {
		expect(sourceGrep.findDeclaration(text, "Feed")).toBeUndefined();
		expect(sourceGrep.findDeclaration(text, "FeedRowFactory")).toBeUndefined();
		expect(sourceGrep.findDeclaration(text, "Missing")).toBeUndefined();
	});
});

describe("declarationName", () => {
	test("unwraps Memo(...) and ForwardRef(...); rejects non-identifiers", () => {
		expect(sourceGrep.declarationName("Memo(ForwardRef(Row))")).toBe("Row");
		expect(sourceGrep.declarationName("Row")).toBe("Row");
		expect(sourceGrep.declarationName("Context.Consumer")).toBeUndefined();
		expect(sourceGrep.declarationName("Unknown#12")).toBeUndefined();
	});
});
