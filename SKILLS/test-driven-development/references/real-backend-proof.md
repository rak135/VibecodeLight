# Real backend proof after a stubbed greenfield scaffold

Use this when a greenfield repository already has a tested skeleton/stub boundary and the next task is to prove one real backend/adapter without letting implementation-specific types leak into the canonical/core model.

Pattern from a CAD-core backend hardening session:

1. Inspect current package, tests, dependency declarations, and optional backend availability before editing.
2. Write new acceptance tests before implementation. Good tests for a real-backend proof:
   - backend creates a real native object internally;
   - core/canonical model instances do not expose native backend types;
   - real export files exist, are non-empty, and contain format signatures;
   - exports are not placeholder operation-log text;
   - a parameter change changes a stable derived geometry summary or export bytes;
   - source scan fails if core model imports forbidden backend/kernel modules;
   - existing roundtrip/stable-ID tests still pass.
3. If backend dependencies are optional, make test dependency handling explicit:
   - use `pytest.importorskip("backend_package", reason="backend_package is required for real backend tests")` only when the package is genuinely optional/unavailable;
   - do not silently skip tests that the milestone requires in a dev environment;
   - add the backend dependency to a dev extra when real-backend tests are part of normal development.
4. Verify RED. A useful RED can be missing CLI module, placeholder export too small, stub-native object type, or missing derived summary.
5. Implement with a narrow adapter boundary:
   - keep kernel imports inside backend or exporter-adjacent adapter modules;
   - pass resolved canonical operations into the backend;
   - return native objects only in an opaque backend result field;
   - expose backend-neutral summaries (volume/bounds/counts) for deterministic tests/diagnostics when needed.
6. Replace placeholder exporters with backend-native export calls, but keep public exporter functions backend-neutral dispatchers.
7. Add a tiny CLI only after the API behavior is tested; make it call the same public load/regenerate/export functions as tests.
8. Verify more than tests:
   - full test suite;
   - `python -m compileall <package>`;
   - requested CLI command;
   - generated file sizes and magic/header bytes when exports matter;
   - package install/editable-install if pyproject metadata changed.

Packaging pitfall:

- If the project name differs from the import package name and Hatchling cannot infer package files, add explicit wheel package selection, e.g.:

```toml
[tool.hatch.build.targets.wheel]
packages = ["cadcore"]
```

Scope pitfall:

- Do not implement adjacent complex feature classes just because the backend can. If deterministic selectors/semantics are not defined yet (for example, topological fillet/chamfer targets), leave the canonical data intact, skip the backend application, and document the limitation.
