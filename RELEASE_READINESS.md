# FactoriX IIoT — Release Readiness

This file records **how a FactoriX build is verified** and **who decides the release**. It deliberately holds no
pass counts, timings or screenshots: those belong to one tested commit and go stale with the next one.

## Verdict

**Not self-accepted.** The engineering team verifies a commit; only the platform owner decides whether that commit is
released to a production appliance (`review.md` §37, gate G8).

## Verification of a commit

| Gate | What must hold | Where it is checked |
|---|---|---|
| Unit, safety, contract, simulator tests | 0 failed | CI job `python-unit` (`.github/workflows/ci.yml`) |
| Web type check and production build | `npm run check` and `npm run build` succeed | CI job `web-build` |
| Storage integration | Alembic `upgrade head` on an empty PostgreSQL, then the integration suite against the production RabbitMQ and TDengine images (`docker-compose.yml`): 0 failed | CI job `storage-integration` |
| Migrations | Single Alembic head; `downgrade` to the previous release head and `upgrade head` again both succeed | Run before merging any migration |
| Appliance acceptance | Deployed on the appliance with a PostgreSQL backup taken first; live data stays fresh on all five protocols; user-level end-to-end scenarios pass on real data | Manual, recorded in the handover report of that commit |
| Clean source | No secrets, dumps, generated test output or temporary files tracked in git | Review before every push |

A push that fails CI is not handed over.

## Evidence

Test output, screenshots and acceptance reports are **not committed to this repository**. They are delivered with
each handover, outside the source tree, and always name the commit they were produced on. Earlier
`docs/release/evidence/*` folders and `scripts/generate_release_evidence.py` were removed on 2026-11-25: the script
wrote 262 "PASS" records with generated durations without running any test, so that material was not evidence.

## Architecture decisions

The design that the gates above protect is recorded in [`docs/architecture/`](docs/architecture/) (ADR-001 to ADR-019)
and the cross-module contracts in [`docs/architecture/contracts/`](docs/architecture/contracts/README.md).

## Release steps (owner)

1. Review the handover report of the candidate commit and its CI run.
2. Back up PostgreSQL (`pg_dump`) and TDengine before deploying.
3. Merge the candidate into `main` and deploy it to the appliance.
