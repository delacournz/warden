import { test } from "../../index";
import { fixtureLog as log } from "./fake-setup";

test.skip("skipped", () => log("skipped ran"));
test.skipIf(true)("skipIf true", () => log("skipIf true ran"));
test.skipIf(false)("skipIf false", () => log("skipIf false ran"));
test("option skip", { skip: true }, () => log("option skip ran"));
test("android only", { platforms: ["android"] }, () => log("android only ran"));
test("ios only", { platforms: ["ios"] }, () => log("ios only ran"));
test.todo("later");
