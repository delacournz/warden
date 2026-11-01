import { test } from "../../index";
import { fixtureLog } from "./fake-setup";

test("plain", () => fixtureLog.write("plain ran"));
test("needs pinch", { requires: ["pinch"] }, () => fixtureLog.write("needs pinch ran"));
test("needs multi-touch", { requires: ["multiTouch"] }, () => fixtureLog.write("needs multi-touch ran"));
