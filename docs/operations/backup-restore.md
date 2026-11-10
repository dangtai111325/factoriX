# Backup, Verification & Restore Runbook

> Every schema migration, cutover rehearsal, or production `CLEAR_TELEMETRY_ONLY` reset is blocked unless a verified backup AND a demonstrated restore into a clean ephemeral database exist first.

---

## 1. Protected Backup Directory Layout (Outside Git & Containers)

Example operator backup path: `C:\Users\Ave-T14-001\Desktop\FactoriX\backup\`
- `pre-tdengine-config-<ts>.dump` — `pg_dump -Fc` covering schema and all control-plane/config tables.
- `pre-migration-config-inventory-<ts>.json` + `protected-hashes-<ts>.json` — canonical sorted UUID lists and SHA256 hashes of tenants, sites, accounts, resources, connections, signals, Data Models, and secret refs.
- `pre-tdengine-outbox-<ts>.sqlite` — clean online `sqlite3.Connection.backup()` snapshot of `outbox.sqlite`.
- `factorix-precleanup-<ts>.bundle` + `.sha256` — full verified Git bundle of all pre-cleanup refs.
- `golden-api-baseline-<ts>.json` — live REST contract snapshot.

---

## 2. PostgreSQL Pre-Migration Backup & Verified Ephemeral Restore

### Capture (Read-Only on Running Appliance)
```powershell
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
docker exec factorix-appliance su - postgres -c "pg_dump -Fc -d factorix --exclude-table-data='observations*' --exclude-table-data='ingest_dedup' > /tmp/config_$ts.dump"
docker cp "factorix-appliance:/tmp/config_$ts.dump" "C:\Users\Ave-T14-001\Desktop\FactoriX\backup\config_$ts.dump"
docker exec factorix-appliance rm -f "/tmp/config_$ts.dump"
```

### Independent Restore Verification (Mandatory Before Gate Pass)
```powershell
docker run -d --name pg-restore-check -e POSTGRES_PASSWORD=verify_tmp -e POSTGRES_DB=factorix_verify postgres:17-alpine
# Wait until pg_isready succeeds, create role 'factorix', then:
Get-Content "C:\Users\Ave-T14-001\Desktop\FactoriX\backup\config_$ts.dump" -Encoding Byte -ReadCount 0 |
  docker exec -i pg-restore-check pg_restore -U postgres -d factorix_verify --no-owner
# Verify exact table counts and protected SHA256 hashes match manifest before removing pg-restore-check!
docker rm -f -v pg-restore-check
```

---

## 3. TDengine & RabbitMQ Backup Notes (Expanded in S05 / S14)

- **TDengine 3.3.6.13 Community Edition (AGPL-3.0):** Does **not** rely on Enterprise-only backup daemons. Physical subtables are tenant-scoped (`db_t_<short_tenant>` / stable supertables). S05/S14 will implement and verify logical/export chunk snapshots + PG `storage_physical_registry` consistency check + clean restore into an ephemeral `tdengine/tdengine:3.3.6.13` instance.
- **RabbitMQ 4.0:** Quorum definitions (`definitions.json`) exported via Management API (`:15672`) without embedding plaintext broker passwords in version control. Broker messages are **transient in-flight transport**; historical persistence lives in TDengine after ACK.
- **Emergency Rollback Before Cutover Removal:** Until S17 completes, keep PG `observations*` untouched so rollback can re-enable legacy PG readers if staged validation uncovers a discrepancy.
