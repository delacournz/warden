# @delacour/warden-e2e

## 0.13.0

### Patch Changes

- [#198](https://github.com/delacournz/warden/pull/198) [`094a1a9`](https://github.com/delacournz/warden/commit/094a1a9f1fac176aea617473ce0240526b4baa97) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - The iOS driver's first snapshot of a session waits for the in-sim bridge when a device starts cold: it retries bridge-not-ready failures (timeout, unavailable) with backoff (2 s, then 5 s) for up to 60 s, so the first spec on a fresh simulator passes without a suite `retry`. Other errors still fail at once, and after the first successful read the normal budgets apply. The wait shows as `coldBridgeMs` on the span.

- [#203](https://github.com/delacournz/warden/pull/203) [`e011293`](https://github.com/delacournz/warden/commit/e0112939e0be432962c9ff3c91adb3af3258a0d9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `fill` no longer fails on a secure field the iOS accessibility tree reports as a plain text field: a text field whose value is only mask bullets counts as secure, so it is not read back and compared.

## 0.12.1

No changes in this release.

## 0.12.0

No changes in this release.

## 0.11.0

No changes in this release.

## 0.10.0

No changes in this release.

## 0.9.0

No changes in this release.

## 0.8.0

No changes in this release.

## 0.7.0

No changes in this release.

## 0.6.0

No changes in this release.

## 0.5.0

No changes in this release.

## 0.4.0

No changes in this release.

## 0.3.1

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.2

No changes in this release.
