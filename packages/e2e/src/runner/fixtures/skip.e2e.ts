import { test } from "../../index";
import { fixtureLog } from "./fake-setup";

test.skip("skipped", () => fixtureLog.write("skipped ran"));
test.skipIf(true)("skipIf true", () => fixtureLog.write("skipIf true ran"));
test.skipIf(false)("skipIf false", () => fixtureLog.write("skipIf false ran"));
test("option skip", { skip: true }, () => fixtureLog.write("option skip ran"));
test("android only", { platforms: ["android"] }, () => fixtureLog.write("android only ran"));
test("ios only", { platforms: ["ios"] }, () => fixtureLog.write("ios only ran"));
test.todo("later");
