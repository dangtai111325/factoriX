# FactoriX Storage DSL (`factorix.io/storage/v1`) & SchemaCompiler

**Module:** `apps/center/src/factorix/modules/storage_dsl.py`  
**Control-Plane Compiler:** `apps/center/src/factorix/modules/storage_compiler.py`  
**Compiler Version:** `1.0.0`

---

## 1. Design Principles

1. **One Canonical AST:** Both the Visual Storage Designer (`@xyflow/react`) and YAML/JSON Code Editor mutate, validate, and serialize the exact same immutable AST (`StorageDesignAst`).
2. **Lossless Round-Trip:** `parse_storage_dsl(serialize_storage_dsl(ast)) == ast` holds for both YAML and JSON representations.
3. **Layout vs Schema Separation (`uiMeta`):** Visual coordinates (`uiMeta`) live inside the document for UX fidelity, while `semantic_hash()` intentionally excludes `uiMeta` so dragging nodes never triggers physical schema churn.
4. **Purely Declarative & Non-Executable:** Parsed strictly via `yaml.safe_load` / `json.loads` with size (`<= 512 KB`), depth (`<= 24`), and expression complexity budgets. Rejects Python constructors (`!!python`), dunder attributes, comprehensions, SQL DDL/DML (`DROP TABLE`, `DELETE FROM`), and arbitrary code execution.
5. **Transport Is Never Storage:** `spec.destination.engine` only permits `'tdengine'`. RabbitMQ / AMQP brokers are explicitly rejected as historical storage destinations.
6. **Stable Identity Resolution:** Symbolic source references (`$machine[...].signal`, `$model[...].field`) resolve against tenant catalog snapshots (`StorageCatalogSnapshot`) to immutable UUIDs (`signal_id`, `model_id`, `resource_id`, `model_field_path`), preventing silent corruption on resource or signal renames.

---

## 2. Canonical Document Structure

```yaml
apiVersion: factorix.io/storage/v1
kind: StorageDesign
metadata:
  name: Line 1 Process History
  description: Optional operator description
spec:
  scope:
    mode: subtree # all_sites | site | subtree | resources
    resource: $machine[RESOURCE_KEY]
  destination:
    engine: tdengine # strictly tdengine
    dbStrategy: tenant_isolated
  datasets:
    - key: process_values
      displayName: Process Values
      semantics: state_series # state_series | event_stream | structured_record
      sourceKind: signals     # signals | model_fields | mixed
      timeAxis: acquired_at   # acquired_at | source_time
      tags:
        - key: plant
          value: Factory-1
      fields:
        - key: field_a
          from: $machine[RESOURCE_KEY].signal_key
          type: float64       # bool | int64 | float64 | string | enum | json | timestamp
          unit: "°C"
          transform: clamp(value * 1.0, -50, 500) # safe scalar math AST only
      recording:
        mode: ON_CHANGE       # ON_CHANGE | EVERY_ACQUISITION | INTERVAL
        qualityTransitions: true # Mandatory: disabling rejected cleanly
        deadband:             # Optional, valid ONLY when numeric fields exist
          kind: absolute      # absolute | percent
          value: 0.25
        maxCheckpointInterval: 60s
        lateTolerance: 5m
        missingPolicy: GAP_MARKER # GAP_MARKER | NULL | HOLD_LAST_WITH_QUALITY
      retention:
        days: 90              # 1 .. 3650
        legalHold: false
```

---

## 3. Recording Modes & Semantic Guarantees

| Mode | Stored Rows | Quality Transitions | Typical Use | Exact `avg`/`count` Behavior |
|---|---|---|---|---|
| `ON_CHANGE` *(Default)* | Baseline + value changes (outside optional deadband) + quality transitions + periodic keepalive checkpoints | Mandatory | Steady/slow signals (`pressure`, `setpoints`, discrete `state`) | Sample-weighted exactness uses Operational History tier within retention window; long-range queries label `managed_recorded` / `reconstructed`. |
| `EVERY_ACQUISITION` | Every distinct verified acquisition (`event_uid` deduped on broker retry) | Mandatory | Event streams, alarms, forensic cycles, high-rate exact analytics | Native full-fidelity samples. |
| `INTERVAL` | Fixed wall-clock UTC boundary snapshot (`>= 100ms`, `<= 24h`) | Mandatory | Synchronized downsampled trending / reports | Emits explicit gap markers on missing windows — never fabricates `0` or fake `GOOD`. |

---

## 4. TDengine Type Mapping & Compiler Rules

| Logical DSL Type | TDengine Column Type | Notes / Constraints |
|---|---|---|
| `bool` | `BOOL` | Strict boolean literal; never coerced from arbitrary text without explicit transform. |
| `int64` | `BIGINT` | Signed 64-bit integer `[-(2^63), 2^63 - 1]`. |
| `float64` | `DOUBLE` | Finite IEEE-754 double (`NaN` / `±Infinity` rejected before write; `-0.0` preserved). |
| `timestamp` | `TIMESTAMP` | UTC microsecond precision (`PRECISION 'us'`). |
| `string` / `enum` | `NCHAR(n)` | Default `n = 1024`, max `15000` Unicode characters. |
| `json` | `VARCHAR(n)` | Default `n = 16384`, max `60000` bytes; escaped cleanly against SQL `\uXXXX` / `{}` quirks, with compiler row-width guard (`<= 64,500` B against TDengine `65,531` B max row limit). |

### Breaking vs Non-Breaking Schema Evolution
- **Non-breaking:** Layout `uiMeta` updates, new datasets, new fields (`ALTER STABLE ... ADD COLUMN`), retention extension, recording mode or deadband adjustments.
- **Breaking:** Removing datasets/fields, changing a field's physical TDengine type (`DOUBLE -> NCHAR`), mutating `semantics` (`state_series <-> event_stream`), or reducing `retention.days` below current retention. Breaking changes are highlighted cleanly in Physical Preview & Review before Publish.
