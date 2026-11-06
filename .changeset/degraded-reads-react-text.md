---
"@delacour/warden": minor
---

- On an iOS read that fell back from the bridge to host `ax`, a plain `getByTestId` whose React component has the same rect as a node on that read now resolves to that node: `text()`, `read()`, `allTexts()`, `toHaveText`, `toContainText`, `isVisible()`, `tap({ until })` and every action work as on a whole read, instead of failing `READ_DEGRADED` or `NOT_ACTIONABLE`.
- A component host `ax` does not show at all (a plain View) answers `text()`, `read().text`, `allTexts()`, `toHaveText` and `toContainText` from the text it renders in the React tree.
