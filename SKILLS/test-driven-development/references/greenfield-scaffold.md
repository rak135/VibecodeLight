# Greenfield repository scaffolding with TDD

Use this when the user asks to create an initial repository/package skeleton plus tests.

Pattern from a successful headless CAD core bootstrap:

1. Inspect the target directory first so you do not overwrite existing work.
2. Write the acceptance tests before creating the package skeleton. For a brand-new repo, an expected RED can be an import/collection failure such as `ModuleNotFoundError` for the not-yet-created package.
3. Run the test suite and verify the failure is caused by missing implementation, not malformed tests.
4. Implement the smallest skeleton that satisfies the acceptance tests:
   - package/module layout
   - data classes or public API requested by tests
   - stubs where the milestone explicitly says not to overbuild
   - examples/docs requested by the user
5. Run the full test suite.
6. Run a cheap syntax/import verification such as `python -m compileall <package>` when applicable.
7. Report created paths and verification commands/results concisely.

Good greenfield acceptance tests cover externally visible invariants, not internal structure only. Examples:

- serialization roundtrip
- deterministic output for the first supported behavior
- stable IDs across parameter changes
- boundary isolation/no forbidden backend imports in the core model
- smoke tests for export commands or files

Pitfalls:

- Do not skip RED just because the repo is empty.
- Do not implement a real backend/kernel integration when the milestone asks for a stub.
- Do not let adapter/native types leak into core model tests or fixtures.
- Keep milestone-zero scaffolds boring: enough to test the boundary, not enough to commit to premature architecture.
