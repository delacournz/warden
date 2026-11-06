---
"@delacour/warden": patch
---

- iOS reads that fell back to the host `ax` reader after an `axbridge` stall are read again on `axbridge`, so `getByTestId` on static text (which `ax` drops) still matches on slow CI runners; a guest that stays silent is retried at most every 5 s
