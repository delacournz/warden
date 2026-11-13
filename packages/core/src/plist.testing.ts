/**
 * `plutil -convert binary1` of a dict holding: AutomationEnabled 1, KeyboardAutocorrection false, KeyboardPrediction
 * true, KeyboardCheckSpelling 0, Big 70000, Name "sim", When (a date), Nested {Inner true}, "CaféÜnïcode" true.
 */
const FLAGS =
	"YnBsaXN0MDDZAQIDBAUGBwgJCgsMDQsREhMUXxAWS2V5Ym9hcmRBdXRvY29ycmVjdGlvbl8QEktleWJvYXJkUHJlZGljdGlvbl8QFUtleWJvYXJkQ2hlY2tTcGVsbGluZ1ZOZXN0ZWRrAEMAYQBmAOkA3ABuAO8AYwBvAGQAZVNCaWdUV2hlblROYW1lXxARQXV0b21hdGlvbkVuYWJsZWQICRAA0Q4LVUlubmVyCQkSAAERcDNByFNFQAAAAFNzaW0QAQgbNElhaH+DiI2hoqOlqK6vsLW+wgAAAAAAAAEBAAAAAAAAABUAAAAAAAAAAAAAAAAAAADE";

/** `plutil -convert binary1` of `{ Name: "sim" }`: a binary plist with no flags at all. */
const NO_FLAGS = "YnBsaXN0MDDRAQJUTmFtZVNzaW0ICxAAAAAAAAABAQAAAAAAAAADAAAAAAAAAAAAAAAAAAAAFA==";

/** A fresh copy of the binary plist holding every flag kind (see `FLAGS`). */
export const flagsPlist = (): Uint8Array => Uint8Array.from(Buffer.from(FLAGS, "base64"));

/** A fresh copy of a binary plist that holds none of the keys warden reads. */
export const noFlagsPlist = (): Uint8Array => Uint8Array.from(Buffer.from(NO_FLAGS, "base64"));
