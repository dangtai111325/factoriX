# Superseded Artifacts Archive

> [!WARNING]
> **UNVERIFIED / HISTORICAL / SUPERSEDED ARTIFACTS**
> The files in this directory are archived from earlier iterations (prior to 2026-11-13) for historical reference and traceability only.
> **DO NOT USE THESE FILES AS AUTHORITATIVE RELEASE EVIDENCE OR BENCHMARKS.**

## Contents Inventory

1. `test-results-stale-264pass.json`:
   - Archived from `reports/test-results.json` (baseline commit `400dba192eb13be30806dbacb1568ffff23ae26b`).
   - Reason for supersession: Identified in `review.md` §12 (FX-P0-15) and §20 as containing generic duplicate claims ("Verified passing with 100% regression parity and zero TypeScript / pytest errors.") without independent machine-generated execution traces.
   - Authoritative replacement: Machine-generated test evidence under `docs/release/evidence/<tested-commit-sha>/`.

2. `cpu-before-after-unattributed.csv`:
   - Archived from `reports/cpu-before-after.csv`.
   - Reason for supersession: Pre-calculated percentage claims without raw run attribution or hardware/workload hashes at current HEAD.
   - Authoritative replacement: Benchmark aggregates in `docs/release/evidence/<tested-commit-sha>/performance-summary.json`.

3. `storage-rework-acceptance-2026-11-12.md`:
   - Archived copy of legacy acceptance report.
   - Reason for supersession: Premature `ACCEPTED FOR RELEASE` status before resolution of P0/P1 audit findings in `review.md`.
   - Authoritative replacement: `RELEASE_READINESS.md` gated by G0–G8.
