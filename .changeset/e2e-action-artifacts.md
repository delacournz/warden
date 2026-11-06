---
"@delacour/warden": minor
---

- The e2e GitHub Action collects what a run leaves behind into artifact groups, `report`, `batches`, `logs` (native build logs), `app` (a tarball of the builds the run used) and `golden` (a tarball of the golden simulator archive, for `warden golden import`), and uploads each as `<artifact-name>-<group>`. The report and batches, one `warden-e2e` artifact before, are now `warden-e2e-report` and `warden-e2e-batches`
- New `artifacts` input: `all` (default: every group after a green run, `report,batches,golden` after a failed one), `none`, or a list of groups. The golden is exported only when it was built and is not in `~/warden-goldens` yet, never built to upload it
- New `upload-artifacts` input: `false` collects without uploading. New outputs `artifact-groups` and `artifact-paths` (`{group: [path]}`) for uploading with your own steps
