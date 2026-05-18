# Document Format + Validation CLI Acceptance Tests

Use this reference when a task changes a canonical JSON/YAML/document format, adds validation, or defines CLI contracts for humans and agents.

## RED tests to write first

Cover valid documents:

- each supported document type validates successfully
- example documents are readable and stable for roundtrip/summarize
- legacy examples remain supported or are intentionally migrated with tests updated

Cover format registry boundaries:

- extension-to-type mapping is centralized in one registry/module
- extension is a hint; in-file document type is canonical truth
- extension/document type mismatch returns a clear diagnostic
- no suffix checks are scattered through CLI/export code

Cover validation diagnostics:

- unsupported document type
- missing required fields
- unsupported/missing units and the chosen missing-units policy
- duplicate IDs
- unknown type/kind
- unknown parameter reference
- non-numeric resolved values
- invalid dimensions or counts
- unsupported-but-valid document classes return explicit unsupported diagnostics at export time

Cover CLI contracts:

- `validate --json` emits valid JSON and exits 0/1 correctly
- `summarize --json` emits valid JSON without triggering regeneration/export
- `export --json` validates first, emits valid JSON, and includes export paths/summary on success
- invalid user documents produce structured diagnostics, not raw tracebacks

## Implementation pattern

1. Keep canonical model pure data.
2. Put extension/format decisions in a central registry.
3. Let loaders return raw data plus registry hints; validation decides mismatch diagnostics.
4. Make validation independent from regeneration/export.
5. For agent-facing CLI output, use sorted JSON keys and stable field names.
6. Preserve runtime generated files policy: disposable outputs should be ignored, not committed.

## Pitfall

Do not implement invalid-document handling by relying on model constructors to raise exceptions. Normal bad user input should produce diagnostics that an LLM or human can repair from path/code/message fields.
