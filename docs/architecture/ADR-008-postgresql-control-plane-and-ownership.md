# ADR-008: PostgreSQL Control Plane Ownership & Declarative Storage AST

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decision Drivers:** Single source of truth for Visual Designer and Code DSL, safe schema compilation, zero arbitrary DDL execution from browser.

## Context

Supporting both a drag-and-drop Visual Storage Designer and a YAML/JSON Code editor requires zero divergence between visual diagrams and declarative text, while protecting TDengine from arbitrary SQL injection or unreviewed destructive DDL.

## Decision

1. **PostgreSQL 17 Owns All Metadata & ASTs:** Control-plane tables (`storage_designs`, `storage_design_versions`, `storage_datasets`, `storage_field_bindings`, `storage_recording_policies`, `storage_physical_registry`, `storage_dependencies`, `storage_operations`, `storage_exports`, `telemetry_generations`, `historian_saved_views`, `collector_runtime_status`) live in PostgreSQL via forward-only Alembic migrations (`0008_storage_and_historian`).
2. **One Canonical AST (`factorix.io/storage/v1`):** Both Visual and Code modes edit/validate the exact same deterministic AST model. Layout positions (`ui_meta`) never force physical TDengine schema version bumps.
3. **Declarative Compilation Only:** The `SchemaCompiler` resolves `$type[name].signal` references into immutable UUIDs at Validate/Publish and emits deterministic read-only TDengine DDL (`CREATE DATABASE`, `CREATE STABLE`, `CREATE TABLE`) verified against actual TDengine state. Raw SQL/Python execution in DSL or Query inputs is strictly forbidden.

## Consequences

- **Positive:** 100% lossless round-trip between Visual and Code; optimistic concurrency (`409` on stale `version`); zero reliance on TDengine to infer application ownership.
