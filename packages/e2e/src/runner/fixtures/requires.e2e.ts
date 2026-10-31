import { test } from "../../index";
import { fixtureLog as log } from "./fake-setup";

test("plain", () => log("plain ran"));
test("needs pinch", { requires: ["pinch"] }, () => log("needs pinch ran"));
test("needs multi-touch", { requires: ["multiTouch"] }, () => log("needs multi-touch ran"));
