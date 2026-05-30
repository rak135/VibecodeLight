# VibecodeLight Testing Philosophy

## Purpose

This document defines how we want to build tests for VibecodeLight.

The goal is not to maximize test count. The goal is to protect the product from real regressions while keeping the architecture modular, flexible, and refactorable.

Bad tests make the codebase rigid. Good tests make future changes safer.

VibecodeLight should have enough tests to protect its core behavior, but not so many brittle tests that every normal refactor becomes a fight against the test suite.

---

## Core Principle

Test real product invariants, not incidental implementation details.

A test is worth adding when it protects one of these things:

- a real bug that already happened;
- a failure mode that would corrupt user work;
- a core product invariant;
- a public CLI or desktop behavior users rely on;
- an architecture boundary that prevents the app from turning into a tangled mess;
- a new feature’s expected behavior;
- a critical edge case that is likely to happen in normal use.

A test is usually not worth adding when it only freezes:

- a specific private helper name;
- a specific import path that could reasonably change;
- an exact internal file layout when the behavior is what matters;
- broad snapshots full of unrelated output;
- implementation details that do not affect users, artifacts, or module ownership.

The test suite should be a safety net, not a prison.

---

## What Must Be Protected

### 1. Prompt / run / send flow

This is the main artery of the product.

Protect these invariants:

- every prompt creates a new run package;
- previous runs are preserved;
- `final_prompt.md` is written before send;
- the prompt sent to the terminal is exactly the saved `final_prompt.md`;
- no hidden prompt text is appended after preview;
- send metadata points to the correct run, prompt file, session, cwd, byte/character counts, and hashes where implemented;
- `.vibecode/current` is only a convenience mirror, not the source of truth;
- historical truth stays in `.vibecode/runs/<run_id>/`.

These deserve integration or E2E characterization tests because they define the product.

---

### 2. Terminal lifecycle safety

The terminal is real. That means lifecycle bugs are dangerous.

Protect these behaviors:

- sending without an active terminal fails cleanly;
- sending to a closed origin session fails cleanly;
- send does not silently retarget to another terminal unless current behavior explicitly requires it;
- terminal cleanup does not leave stale sessions that can receive future prompts;
- Windows PTY noise does not corrupt structured output or artifacts.

Do not over-fix harmless environment noise. Characterize it first.

---

### 3. Run store and artifact integrity

Run artifacts are the audit trail.

Protect these invariants:

- run IDs do not collide during repeated or quick back-to-back runs;
- run paths stay inside the workspace `.vibecode` directory;
- generated artifacts are not committed;
- missing or corrupt run files fail with structured diagnostics;
- scanner output, prompt output, terminal metadata, and post-run artifacts do not overwrite unrelated runs.

---

### 4. Scanner boundaries

The scanner gathers facts. It must not become an agent framework.

Protect these boundaries:

- Python scanner writes only inside the authorized scan output directory;
- Python scanner does not call LLM/provider code;
- Python scanner does not manage skills;
- Python scanner does not read provider secrets;
- `.vibecode/` is excluded from scanned source material;
- malformed scanner stdout or non-zero exit codes become structured diagnostics.

---

### 5. Config and secret safety

Config bugs can become silent chaos or secret leaks.

Protect these behaviors:

- mock mode never requires live provider credentials;
- live mode without provider config fails cleanly;
- diagnostics do not leak API keys or sensitive values;
- current config precedence stays stable where it is user-visible;
- scanner config generation does not expose provider secrets.

---

### 6. Architecture boundaries

Architecture tests should prevent slow decay, not freeze every file.

Protect broad ownership rules:

- `core` must not import desktop UI or renderer modules;
- scanner must not import provider/LLM logic;
- prompt rendering remains owned by TypeScript core;
- terminal/PTY process management stays behind terminal/adapter/service boundaries;
- provider adapters stay isolated from run ownership and terminal send behavior;
- app layer delegates core product behavior instead of duplicating it.

Avoid over-specific architecture tests such as:

- “this exact file must import this exact function name”;
- “this gateway must be named exactly X”;
- “this private helper must stay in this file forever.”

Test ownership and direction, not accidental structure.

---

## Types of Tests We Want

### Regression tests

Add these when a real bug was found.

Rule:

1. Reproduce the bug with a failing test.
2. Apply the smallest fix.
3. Keep the test focused on the failure mode.

Regression tests are high value because they prove the bug stays dead.

---

### Characterization tests

Add these when behavior already exists and must be preserved.

Use them for:

- current CLI behavior;
- current artifact behavior;
- current terminal behavior;
- current architecture ownership;
- current mock/live separation.

Characterization tests should describe what the product currently guarantees, not what old docs hoped the product would become.

---

### E2E invariant tests

Use these sparingly for the main product flow.

Good E2E tests protect:

- prompt generation;
- run artifact creation;
- final prompt source-of-truth;
- terminal send metadata;
- current mirror consistency;
- generated artifact hygiene.

Do not build a giant slow E2E suite for every small branch of behavior. The main flow deserves it. Minor internals usually do not.

---

### Unit tests

Use unit tests for focused logic:

- parsing;
- config resolution;
- path normalization;
- hash calculation;
- structured diagnostics;
- scanner artifact parsing;
- prompt metadata extraction.

A good unit test fails for one clear reason.

---

### Static architecture tests

Use these lightly.

Good static tests check broad boundaries, such as:

- core does not import app;
- scanner does not reference provider secrets;
- default tests do not call live providers;
- generated paths are not used from random modules.

Bad static tests hard-code harmless implementation details and make refactors painful.

---

## What We Should Avoid

Avoid test bloat.

Do not add tests just because something could theoretically break. Everything can theoretically break.

Avoid:

- broad snapshots that fail when unrelated text changes;
- duplicate tests that protect the same invariant at three levels;
- tests that lock private helper names;
- tests that assert exact implementation when behavior is enough;
- tests that encode outdated documentation instead of current code behavior;
- tests that make legitimate refactoring harder without increasing product safety;
- live model calls in default tests;
- tests that require fragile local environment assumptions unless clearly marked as integration/smoke.

Over-tested code is not robust. It is brittle with extra steps.

---

## When to Add a New Test

Add a test when at least one answer is yes:

1. Did this bug already happen?
2. Would this failure corrupt user work or send the wrong prompt?
3. Would this failure break the main prompt/run/send flow?
4. Would this failure hide a crash behind raw exceptions?
5. Would this failure leak secrets?
6. Would this failure let generated artifacts enter commits?
7. Would this failure break a public CLI/desktop behavior?
8. Would this failure violate an important module boundary?
9. Is this new behavior that needs a contract?

If none of these apply, the test is probably noise.

---

## When to Weaken or Remove a Test

A test should be weakened or removed when:

- it fails during a safe refactor even though product behavior is unchanged;
- it duplicates stronger E2E or regression coverage;
- it asserts exact private implementation details;
- it mostly tests file names/import names instead of ownership;
- it makes the suite slower without protecting an important invariant;
- it was based on an assumption that current code does not actually guarantee.

Do not delete meaningful regression tests just because they are inconvenient. But do not worship tests that protect nothing important.

---

## Test Review Standard

For every new or changed test, ask:

- What product risk does this test reduce?
- Would a user, artifact, prompt, terminal session, or module boundary be harmed if this broke?
- Is this covered already by a stronger test?
- Is the test focused enough to diagnose the failure quickly?
- Can the implementation be safely refactored without rewriting this test?
- Does this test preserve current behavior, or does it accidentally invent a new requirement?

If the test cannot answer these cleanly, it is probably trash.

---

## Validation Discipline

Default validation should stay practical:

```powershell
pnpm test
pnpm test:serial
pnpm lint
pnpm typecheck
pnpm build
pnpm desktop:smoke
```

For the Python scanner:

```powershell
cd src/core/scanning/python
uv run pytest
uv run ruff check .
```

Default tests must not call real model providers.

Live/provider tests must be explicit, isolated, and opt-in.

---

## Commit Discipline for Test Work

Test work should be scoped.

Good commit examples:

```text
fix: harden prompt send diagnostics
test: characterize prompt send run invariants
test: characterize architecture boundaries
```

Bad commit examples:

```text
misc tests
improve stuff
big refactor and tests
```

A stabilization commit should say exactly what risk it reduces.

---

## Practical Rule

For VibecodeLight, the best test suite is not the biggest one.

The best test suite is the one that protects:

- the prompt that is generated;
- the prompt that is sent;
- the run artifacts that prove what happened;
- the terminal session that receives it;
- the scanner boundary that gathers facts;
- the modular architecture that keeps the product understandable.

Everything else must earn its place.
