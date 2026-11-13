import { describe, test } from "../../index";
import type { BaseFixtures } from "../../runner/fixtures.types";

const withFixtures = (({ app }: BaseFixtures) => {
	void app;
	test("inside", () => undefined);
}) as unknown as () => void;

describe("takes fixtures", withFixtures);
