# MCP/CLI Multi-Agent Efficiency Plan

This document is the implementation guide for the next VibecodeLight MCP/CLI
agent-efficiency phases. It is intentionally concrete. It describes what exists
now, what is missing, what to build first, and which tests prove that coding
agents actually use Vibecode instead of falling back to raw `rg`, `find`, and
`git`.

File: `docs/MCP_CLI_MULTI_AGENT_EFFICIENCY_PLAN.md`.

Source-of-truth posture:

- Code and tests are stronger evidence than documentation.
- Existing architecture docs remain useful for ownership boundaries, but some
  MCP and coordination sections are stale.
- The two latest MCP/CLI efficiency review files were not found in the repo by
  filename/content search. This plan is derived from current code, tests, and
  docs.

## 1. Executive Summary

Current state:

- VibecodeLight has a real MCP server, a broad CLI, CodeGraph adapters, run
  artifact readers, project-instruction access, Agent Guidance, and a tested
  advisory multi-agent coordination core.
- MCP currently exposes 32 tools. That is too many for a fresh coding agent to
  choose from without guidance.
- CLI has stronger coordination coverage than MCP in one important area:
  `vibecode commit guard` is CLI-only and is the only implemented scoped git
  commit guard.
- Claims, conflicts, evidence, finalize checks, and commit guard are useful, but
  the safe workflow is too many calls and too easy to skip.

Main problem:

- Vibecode does not yet make the safe coordinated path shorter than raw shell
  work. A practical agent still reaches for `rg`, `git status`, and direct file
  reads because bootstrap, git changes, scan intelligence, and artifact reads
  are not combined into a compact workflow.

Core direction:

- Add one-call session bootstrap.
- Add claim-aware git/change awareness.
- Expose deterministic scan intelligence through bounded agent-facing tools.
- Add artifact continuation.
- Reduce default MCP tool surface through profiles.
- Make the agent operating protocol visible in MCP, CLI, and terminal startup.

First priority:

- Build `session_bootstrap` plus `git_changes` as one small, tested batch.
  Without these, every other coordination improvement still depends on agents
  remembering a long manual checklist.

What must not be built yet:

- More desktop UI as a substitute for missing core workflow.
- Hard source-file locks.
- MCP commit mutation by default.
- More CodeGraph surface before fuzzy resolve and stale-index warnings.
- Subagent orchestration before parent/child identity and basic claims are
  reliable.

## 2. Product Goal

VibecodeLight should make the safe coordinated path shorter and easier than raw
shell work.

Practical target:

- A fresh agent calls one bootstrap tool/command and knows the repo root, branch,
  dirty files, active agents, current claims, unresolved conflicts, current run,
  available artifacts, scan/CodeGraph status, project instructions, warnings,
  blockers, and next best tools.
- An agent claims files before editing because the claim workflow is obvious,
  short, and returned directly from bootstrap/change responses.
- An agent validates and commits only its own claimed files because finalize and
  commit guard are the easy path.
- A CLI-only agent can follow the same protocol without MCP.

Goals by workflow:

| Workflow | Goal |
| --- | --- |
| Single-agent implementation | Orient in one call, find relevant files, claim/edit/validate/finalize with minimal raw shell fallback. |
| Single-agent review/debugging | See dirty files, run artifacts, recent evidence, CodeGraph/scan context, and affected tests without reading generated files by hand. |
| Two-agent parallel work | Agents can see each other, claim disjoint files, avoid overlapping claims, finalize independently, and commit only owned files. |
| Subagent work | Parent and child agents have explicit identity, scope, claims, and handoff metadata. Not built before basic workflow is short. |
| CLI-only fallback agents | Every safe MCP workflow has an equivalent stable `--json` CLI path. |
| MCP-capable agents | MCP exposes fewer higher-value tools and returns recommended next actions. |

## 3. Current Verified State

### Verified In Code

MCP:

- `src/app/mcp/tool_registry.ts` registers 32 tools.
- Tools are repo-bound through server context. Tool schemas do not accept `repo`.
- MCP handlers call core/adapters directly. They do not shell out through CLI.
- MCP output uses a bounded text block plus `structuredContent`.
- MCP text output is capped at `MCP_TEXT_OUTPUT_LIMIT` of 16000 bytes.
- `vibecode_artifact_read` accepts `run_id`, `artifact`, `byte_offset`, and
  `max_bytes` and supports byte-offset continuation (Phase 1B-1 — see §14B).
  (Pre-Phase-1B-1 it accepted only `run_id`/`artifact`/`max_bytes` with no
  continuation.)

CLI:

- `src/app/cli/index.ts` registers prompt, scan, runs, context, flash, desktop,
  terminal, CodeGraph, MCP, Agent Guidance, and coordination commands.
- Coordination CLI commands exist for `coordination status`, `agents`,
  `claims`, `conflicts`, `finalize check`, `evidence`, and `commit guard`.
- `vibecode commit guard` is intentionally CLI-only and git-mutating.

Coordination:

- Coordination state is generated state under `.vibecode/coordination/state.json`.
- Agents register and heartbeat. Stale status is computed from heartbeat age.
- Claims are advisory. No source files are locked.
- Exclusive claims conflict with any overlapping active claim. Shared claims
  can overlap other shared claims.
- Claim denial records a generated conflict record on a best-effort basis.
- Evidence scan observes changed git files and writes generated evidence events.
- Finalize check is read-only and classifies dirty files relative to the
  current agent's active claims.
- Commit guard runs finalize first, stages explicit pathspecs only, blocks
  unrelated staged files, and commits only files classified `claimed_by_agent`.

Run/artifact access:

- Artifact reads use `RUN_SHOW_ARTIFACTS` allowlist and realpath containment.
- Current allowlist covers prompt/context/flash/run/terminal and CodeGraph
  artifacts.
- Most deterministic scan artifacts are not directly exposed through
  `vibecode_artifact_read`.

CodeGraph:

- Read-only query commands exist: status, search, context, files, callers,
  callees, impact.
- CLI maintenance commands exist for status/init/sync/reindex/binary/transport
  and upstream CodeGraph MCP self-test/config.
- Query commands do not auto-init, auto-sync, or mutate `.codegraph/`.

### Verified In Tests

MCP:

- Registry count/name parity and guidance-description behavior are tested.
- Tool schemas reject unknown `repo` arguments.
- Security tests assert no MCP source write/shell/git/terminal mutation tool is
  registered.
- Artifact read tests cover allowlist, aliases, max byte truncation, traversal
  rejection, missing artifact, and source-file rejection.
- MCP/CLI parity tests cover existing artifact reads.
- Workspace status tests prove it summarizes changed files without raw diffs.

Coordination:

- Agent register/list/heartbeat/status behavior is tested in CLI and MCP.
- Claims add/list/status/release behavior is tested in core, CLI, and MCP.
- Claim denial and conflict recording are tested.
- Stale/terminated claim cleanup is tested.
- Finalize tests cover missing/stale agents, run binding, unclaimed blocks,
  other-agent warnings, generated paths, and non-overlapping parallel work.
- Commit guard tests prove dry-run, scoped staging, exact claimed-file commits,
  unrelated staged-file blocking, path safety, metadata footers, and no broad git
  commands.
- Evidence tests prove manual scans write generated evidence only and do not
  mutate git/source.

### Documented But Not Fully Proven

- Agent Guidance is intended to steer agents toward MCP first and CLI fallback.
  Default guidance exists, but only a small subset of tools has useful default
  per-tool notes.
- CodeGraph docs say real dogfood found `context` more useful than other
  commands, but there is no benchmark proving CodeGraph beats `rg` for fresh
  agents.
- Multi-agent UI and handoff design docs describe future targets, not current
  implementation.

### Known Docs Drift Or Uncertainty

- `docs/MULTI_AGENT_COORDINATION.md` states finalize guard, commit guard,
  conflict persistence, and watcher are not yet implemented. Current code/tests
  show finalize check, commit guard, conflicts, evidence, and live watcher
  pieces now exist.
- Some CodeGraph docs still describe Vibecode as not implementing its own MCP
  server in older phase wording. Current code has a native repo-bound Vibecode
  MCP server that wraps CodeGraph and more.
- The public/stable CLI lists in some docs do not fully reflect the current
  coordination command surface.
- `tool_registry.ts` comments still summarize the registry as older MCP phases,
  while the actual registry includes coordination tools.

### Current MCP Tools

| Group | Tools |
| --- | --- |
| Bootstrap/orientation | `vibecode_workspace_info`, `vibecode_workspace_status`, `vibecode_mcp_guidance`, `vibecode_project_instructions` |
| Workspace/git status | `vibecode_workspace_status` |
| CodeGraph/navigation | `vibecode_codegraph_status`, `vibecode_codegraph_search`, `vibecode_codegraph_context`, `vibecode_codegraph_files`, `vibecode_codegraph_callers`, `vibecode_codegraph_callees`, `vibecode_codegraph_impact` |
| Run/artifact access | `vibecode_runs_list`, `vibecode_current_run`, `vibecode_run_get`, `vibecode_artifacts_list`, `vibecode_artifact_read`, `vibecode_codegraph_usage` |
| Coordination/agents | `vibecode_coordination_status`, `vibecode_agent_register`, `vibecode_agent_heartbeat`, `vibecode_agents_list`, `vibecode_agent_status` |
| Claims/conflicts | `vibecode_claim_add`, `vibecode_claims_list`, `vibecode_claim_status`, `vibecode_claim_release`, `vibecode_claims_reap`, `vibecode_conflicts_list`, `vibecode_conflict_resolve` |
| Finalize/evidence | `vibecode_finalize_check`, `vibecode_evidence_list`, `vibecode_evidence_scan` |

### Current CLI Commands Relevant To Agents

| Area | Commands |
| --- | --- |
| Workspace/config | `vibecode init`, `vibecode doctor`, `vibecode config paths/show/providers/models/init-local/sync` |
| Runs/artifacts | `vibecode scan`, `vibecode context-build`, `vibecode prompt`, `vibecode runs list`, `vibecode runs show`, `vibecode flash run/validate`, `vibecode context finalize` |
| CodeGraph | `vibecode codegraph status/search/context/files/callers/callees/impact/init/sync/reindex/transport/binary/mcp` |
| MCP setup | `vibecode mcp serve/tools/config/install/doctor` |
| Agent Guidance | `vibecode agent-guidance status/apply/preflight` |
| Coordination | `vibecode coordination status`, `vibecode agents register/list/heartbeat/status/terminate`, `vibecode claims add/list/status/release/reap`, `vibecode conflicts list/resolve`, `vibecode finalize check`, `vibecode evidence list/scan/watch`, `vibecode commit guard` |

## 4. Core Problems To Solve

### 1. No One-Call Session Bootstrap / Orientation

Current behavior:

- MCP agents are told to call `workspace_info` and `workspace_status`.
- Multi-agent safety also requires separate calls to register/list agents,
  list claims, list conflicts, list artifacts, read instructions, and inspect
  dirty files.

Why agents bypass it:

- Raw `git status` plus `rg` is faster than assembling 6 to 9 Vibecode calls.

Single-agent impact:

- Agent loses time at startup and does not see current run/artifact context.

Multi-agent impact:

- Agent may start editing before noticing active claims or unresolved conflicts.

Recommended fix:

- Add `vibecode_session_bootstrap` and `vibecode session bootstrap --json`.

### 2. Weak Or Incomplete Git/Change Awareness

Current behavior:

- `workspace_status` returns branch/head/dirty counts and a few first paths.
- `getGitChangedFiles` has rich data, but it is only directly consumed by
  finalize/evidence/commit guard.

Why agents bypass it:

- Agents need full changed file lists, staged state, renamed/deleted files, and
  claim classifications. They run `git status`, `git diff --stat`, and
  `git diff --name-only`.

Single-agent impact:

- Agent can miss unrelated dirty files before editing or finalizing.

Multi-agent impact:

- Agents cannot quickly see unclaimed dirty files, other-agent claimed dirty
  files, or what commit guard will skip.

Recommended fix:

- Add `vibecode_git_changes` and `vibecode git changes --json`.

### 3. Scan Artifact Intelligence Not Convenient Enough

Current behavior:

- Deterministic scan creates useful artifacts.
- MCP/CLI artifact allowlist does not expose most scanner artifacts directly.

Why agents bypass it:

- Scanner intelligence is less convenient than `rg --files`, direct reads, and
  source grep.

Single-agent impact:

- File inventory, commands, tests, imports, entrypoints, and symbols do not
  reliably help the agent orient.

Multi-agent impact:

- Agents cannot use scan-derived test and command suggestions as shared
  coordination evidence.

Recommended fix:

- Add `vibecode_scan_summary` and direct bounded scan artifact reads.

### 4. Artifact Truncation / Continuation Risk

> RESOLVED in Phase 1B-1 (see §14B). The text below is the original
> pre-Phase-1B-1 problem statement, kept for history.

Current behavior (pre-Phase-1B-1):

- `artifact_read` truncates by max bytes and reports `truncated`.
- There is no `byte_offset`, `next_offset`, or reliable continuation.

Why agents bypass it:

- If an artifact is large, direct file reads feel safer.

Single-agent impact:

- Agent may act on partial `final_prompt`, `context_pack`, or `flash_output`.

Multi-agent impact:

- Agents may miss coordination instructions or warnings in truncated artifacts.

Recommended fix:

- Add byte-offset continuation and UTF-8 safe slicing.

### 5. Too Many MCP Tools By Default

Current behavior:

- All 32 tools are exposed by default.

Why agents bypass it:

- Tool choice is noisy. The safe path is not visually obvious.

Single-agent impact:

- Agents overuse CodeGraph or skip artifacts because the first tool to call is
  unclear.

Multi-agent impact:

- Claim/finalize tools are buried among many optional tools.

Recommended fix:

- Add MCP tool profiles and default to `standard`, not all tools.

### 6. Coordination Is Too Easy To Skip

Current behavior:

- Claims are advisory and manually invoked.
- Finalize/commit guard work only when called.

Why agents bypass it:

- The normal coding-agent loop is read/edit/test/report. Claiming is an extra
  mental step.

Single-agent impact:

- Agent can leave unclaimed dirty files and discover this only at finalize.

Multi-agent impact:

- Agents can edit the same file if they skip claims.

Recommended fix:

- Put claim status and next claim commands in bootstrap/git changes.
- Add bulk claims with intent.
- Add terminal protocol banner/preflight.

### 7. Commit Safety Gap Between CLI And MCP

Current behavior:

- CLI has `commit guard`.
- MCP has no commit mutation tool by design.

Why agents bypass it:

- MCP-capable agents that stay inside MCP must switch to CLI for safe commits.

Single-agent impact:

- Agent may run raw `git add`/`git commit`.

Multi-agent impact:

- Raw commits can include another agent's dirty files.

Recommended fix:

- Keep commit mutation CLI-only for now, but make MCP finalize return the exact
  `vibecode commit guard` command to run. Revisit MCP commit only after profiles
  and explicit opt-in permissions exist.

### 8. Weak Agent Operating Protocol

Current behavior:

- Guidance tells agents to use MCP first and CLI fallback.
- It does not give a short, complete, enforced operating protocol.

Why agents bypass it:

- Agents follow easy instructions. Long scattered docs lose to familiar shell
  habits.

Single-agent impact:

- Agents do not consistently bootstrap, claim, finalize, and report.

Multi-agent impact:

- Agents do not coordinate unless prompted manually.

Recommended fix:

- Add `vibecode agent protocol --json|--markdown` and expose the same protocol
  through MCP server instructions, bootstrap output, terminal preflight, and
  optional generated instructions.

### 9. CodeGraph Not Yet Proven Better Than `rg`

Current behavior:

- CodeGraph search/context/files/callers/callees/impact exist.
- Docs admit `rg` remains better for literals.
- Callers/callees need exact indexed symbols.

Why agents bypass it:

- If a CodeGraph query misses or returns low-signal results once, agents revert
  to `rg`.

Single-agent impact:

- Agent spends time on graph tools without confidence.

Multi-agent impact:

- Shared navigation advice may be stale or misleading.

Recommended fix:

- Add fuzzy resolve and stale-index warnings before adding more CodeGraph tools.

### 10. Missing Subagent Identity / Handoff / Notice Board

Current behavior:

- Agent type exists, but there is no parent/child relationship, task scope,
  notice board, or handoff protocol.

Why agents bypass it:

- Subagents have no first-class place to say what they own or report results.

Single-agent impact:

- Not relevant until subagents are used.

Multi-agent impact:

- Parent agents cannot safely delegate tests/docs/refactors without manual
  coordination.

Recommended fix:

- Defer until Phase 4. First make bootstrap, git changes, claims, and finalize
  short and reliable.

## 5. Desired Agent Operating Protocol

Every agent should follow this protocol.

| Step | MCP support now | CLI support now | Current gap | Target behavior | Test evidence needed |
| --- | --- | --- | --- | --- | --- |
| 1. Bootstrap / identify session | Partial: `workspace_info`, `workspace_status` | Partial: several commands | Too many calls | One `session_bootstrap` call/command | Bootstrap aggregation tests |
| 2. Register or confirm agent identity | `agent_register`, `agent_heartbeat` | `agents register`, `agents heartbeat` | Not part of bootstrap | Bootstrap can register or instruct exact register command | Register-in-bootstrap tests |
| 3. Inspect active agents | `agents_list`, `coordination_status` | `agents list`, `coordination status` | Separate calls | Included in bootstrap | Active/stale agent fixture |
| 4. Inspect current claims/conflicts | Claims/conflict tools | Claims/conflict commands | Separate calls | Included in bootstrap and git changes | Claim/conflict summary tests |
| 5. Inspect git changes | Shallow `workspace_status`; finalize requires agent | Raw helper hidden behind commands | No full standalone command/tool | `git_changes` with claim classification | Git category/classification tests |
| 6. Read project instructions | `project_instructions` | No exact direct equivalent except docs/raw files and scan | CLI fallback weak | `agent bootstrap` includes bounded instruction metadata and next read | CLI parity tests |
| 7. Read relevant run/context/scan artifacts | Artifacts list/read; no scan summary | Runs show artifact raw; no continuation | Scan intelligence hidden | Artifact continuation and scan summary | Allowlist/bounds tests |
| 8. Claim files before editing | Claim tools | Claim commands | Single path only; no intent | Bulk claim with intent and next action | Bulk denial/partial tests |
| 9. Edit only claimed files | Not enforceable | Not enforceable | Advisory only | Bootstrap/finalize/evidence make violations obvious | Dogfood tests |
| 10. Run relevant checks | Agent shell only | Agent shell only | No validation evidence model | Bootstrap/scan suggests checks; final report records checks | Later validation evidence tests |
| 11. Finalize before commit | `finalize_check` | `finalize check` | Not enough next-action guidance | Finalize returns exact next command | Finalize next-action tests |
| 12. Commit only own claimed files through guard | No MCP commit | `commit guard` | MCP agents must switch to CLI | MCP finalize points to CLI guard; CLI remains source of truth | Commit guard workflow tests |
| 13. Release claims or mark done | Claim release; no MCP terminate | Claim release; agents terminate | No done workflow | `agent done` or protocol output with release/terminate | Agent done tests later |
| 14. Produce final report | Manual | Manual | No generated summary | Bootstrap/finalize/commit outputs enough data to report | Dogfood report assertions |

Skipping behavior:

- If an agent skips bootstrap, it may miss active claims/conflicts.
- If an agent skips claims, finalize blocks its unclaimed dirty files.
- If an agent skips finalize/commit guard and uses raw git, Vibecode cannot
  prevent cross-agent commits today.

## 6. MCP vs CLI Responsibility Split

Direction:

- CLI remains the source-of-truth and fallback interface.
- MCP is the efficient agent-facing adapter.
- MCP exposes fewer higher-value tools by default.
- Mutating operations are explicit and minimal.
- Raw git is discouraged where a Vibecode guard exists.

Belongs in MCP:

- Session bootstrap.
- Workspace/git summaries without full diffs.
- Project instructions and guidance.
- Bounded run/artifact reads with continuation.
- Bounded scan summaries and allowlisted scan artifact reads.
- CodeGraph read-only navigation.
- Coordination register/heartbeat/list.
- Advisory claims.
- Conflict list/resolve where generated-state mutation is acceptable.
- Finalize check.
- Evidence list/manual scan if clearly labeled generated-state only.

Belongs in CLI only:

- `commit guard` for now.
- CodeGraph maintenance: init, sync, reindex, binary config, transport config.
- MCP config/install/doctor.
- Agent Guidance apply/preflight that writes external agent config.
- Long-running evidence watch.
- Desktop smoke/terminal demo.

Must have MCP/CLI parity:

- Bootstrap.
- Git changes.
- Scan summary/read.
- Artifact read continuation.
- Coordination status, agents, claims, conflicts.
- Finalize check.
- Read-only CodeGraph queries.

Should never be exposed through default MCP:

- Arbitrary file read.
- Shell exec.
- Raw `git add`, `git commit`, `git reset`, `git checkout`, `git clean`,
  `git stash`.
- Source-file write.
- Terminal stdin write.
- Full raw diffs by default.
- Agent approval/permission mutation.

Write tools acceptable in MCP:

- Generated coordination state writes: register, heartbeat, claim add/release,
  claims reap, conflict resolve, evidence scan.
- These must remain clearly labeled as generated-state only.

CLI-only agent behavior:

- Run `vibecode session bootstrap --repo <path> --json`.
- Register/heartbeat if not already registered.
- Claim before editing.
- Use `vibecode git changes --agent <id> --json`.
- Use `vibecode finalize check --agent <id> --json`.
- Use `vibecode commit guard --agent <id> --message "<subject>" --json`.
- Use raw `rg` only when Vibecode scan/CodeGraph cannot answer the query.

## 7. Proposed Tool Profiles

Do not default to all tools. The default must make the safe path obvious.

### minimal

Intended user/agent:

- Fresh MCP-capable agent that only needs startup, instructions, and artifacts.

Included:

- `vibecode_session_bootstrap`
- `vibecode_project_instructions`
- `vibecode_artifacts_list`
- `vibecode_artifact_read`
- `vibecode_git_changes`

Excluded:

- CodeGraph symbol relationship tools.
- Conflict resolution/reap/admin tools.
- Evidence scan.

Why it exists:

- Lowest cognitive load for simple single-agent tasks.

### standard

Recommended default profile.

Intended user/agent:

- Normal coding agent in a Vibecode terminal.

Included:

- Everything in `minimal`
- `vibecode_scan_summary`
- `vibecode_scan_artifact_read`
- `vibecode_codegraph_search`
- `vibecode_codegraph_context`
- `vibecode_codegraph_files`
- `vibecode_agent_register`
- `vibecode_agent_heartbeat`
- `vibecode_claim_add`
- `vibecode_claims_list`
- `vibecode_claim_release`
- `vibecode_finalize_check`

Excluded:

- `vibecode_codegraph_callers`
- `vibecode_codegraph_callees`
- `vibecode_codegraph_impact`
- `vibecode_claim_status`
- `vibecode_claims_reap`
- `vibecode_conflict_resolve`
- `vibecode_evidence_scan`
- run-list/admin overlap tools unless surfaced through bootstrap.

Why it exists:

- It gives the common safe path without presenting every optional tool.

### multi-agent

Intended user/agent:

- Agents explicitly working in parallel.

Included:

- Everything in `standard`
- `vibecode_coordination_status`
- `vibecode_agents_list`
- `vibecode_agent_status`
- `vibecode_claim_status`
- `vibecode_claims_reap`
- `vibecode_conflicts_list`
- `vibecode_conflict_resolve`
- `vibecode_evidence_list`
- `vibecode_evidence_scan`

Excluded:

- CodeGraph maintenance.
- Commit mutation.

Why it exists:

- Makes team-state tools available without making them default noise for every
  single-agent task.

### review-admin

Intended user/agent:

- Reviewer/debugger/admin session.

Included:

- `vibecode_session_bootstrap`
- `vibecode_git_changes`
- `vibecode_artifacts_list`
- `vibecode_artifact_read`
- `vibecode_runs_list`
- `vibecode_run_get`
- `vibecode_codegraph_status`
- `vibecode_codegraph_search`
- `vibecode_codegraph_context`
- `vibecode_codegraph_files`
- `vibecode_codegraph_callers`
- `vibecode_codegraph_callees`
- `vibecode_codegraph_impact`
- `vibecode_coordination_status`
- `vibecode_agents_list`
- `vibecode_claims_list`
- `vibecode_conflicts_list`
- `vibecode_evidence_list`
- `vibecode_finalize_check`

Excluded:

- Generated-state mutators unless explicitly requested.

Why it exists:

- Read-only by default for review/debugging.

Profile configuration:

- `vibecode mcp serve --profile standard`
- `vibecode mcp tools --profile standard --json`
- Terminal sessions should default to `standard`.
- Desktop/admin settings may expose `minimal`, `standard`, `multi-agent`, and
  `review-admin`.

## 8. Phase Plan

### Phase 1  Make The Safe Path Obvious And Short

Goal:

- A fresh agent can begin safely with one call and can inspect changed files
  without raw `git status`.

Scope:

- `session_bootstrap` MCP tool.
- `vibecode session bootstrap --json` CLI command.
- `git_changes` MCP tool/CLI command.
- Artifact continuation.
- Scan summary/read exposure.
- `recommended_next_tools` in new responses.
- `vibecode agent protocol --json|--markdown`.

Explicit non-goals:

- No MCP commit tool.
- No hard locks.
- No subagent model.
- No desktop coordination UI changes.
- No CodeGraph feature expansion beyond status/stale data needed by bootstrap.

Proposed files/modules:

- `src/core/agent_session/bootstrap.ts`
- `src/core/workspace/git_changes_summary.ts`
- `src/core/runs/artifact_pagination.ts`
- `src/core/runs/scan_artifacts.ts`
- `src/app/mcp/tools/session_bootstrap.ts`
- `src/app/mcp/tools/git_changes.ts`
- `src/app/mcp/tools/scan_summary.ts`
- `src/app/cli/commands/agent.ts`
- `src/app/cli/commands/git_changes.ts`
- `tests/core/agent_session/bootstrap.test.ts`
- `tests/app/mcp/session_bootstrap.test.ts`
- `tests/app/cli/agent_bootstrap_commands.test.ts`

MCP contract changes:

- Add `vibecode_session_bootstrap`.
- Add `vibecode_git_changes`.
- Add `vibecode_scan_summary`.
- Add `vibecode_scan_artifact_read` or extend `vibecode_artifact_read` with
  explicit scan artifact names.
- Add continuation fields to artifact read.

CLI contract changes:

- Add `vibecode session bootstrap --repo <path> --json`.
- Add `vibecode agent protocol --json|--markdown`.
- Add `vibecode git changes --repo <path> [--agent <id>] --json`.
- Add `vibecode scan summary --run <id|current|latest> --json`.
- Add JSON artifact read with offset/limit if keeping raw `runs show --artifact`
  as an exception.

Tests to add:

- Bootstrap aggregation and MCP/CLI parity.
- Git changes categories and claim classifications.
- Artifact continuation with UTF-8 boundaries.
- Scan artifact allowlist and bounded summaries.
- Recommended next tools present on success and common blocked states.

Acceptance criteria:

- A new agent can call one bootstrap command/tool and receive enough state to
  decide whether it can edit.
- A CLI-only agent can follow the same protocol without raw `git status`.
- Large artifacts can be read in chunks without partial-context traps.
- Scan intelligence is available without manual `.vibecode` browsing.

Why this phase comes before the next:

- Coordination cannot become reliable while agents need many calls just to know
  what is safe.

### Phase 2  Make Multi-Agent Coordination Harder To Skip

Goal:

- Claim/finalize/commit guard become the obvious shortest workflow for active
  coding agents.

Scope:

- Bulk claims with intent.
- Claim-aware `git_changes` classifications.
- Finalize output with exact next action.
- Commit guard workflow improvements.
- Tool profiles.
- Terminal preflight/protocol banner.
- Stronger CLI-only guidance.

Explicit non-goals:

- No source-file locks.
- No automatic edits or commits.
- No subagent handoff model.
- No raw diff exposure by default.

Proposed files/modules:

- `src/core/coordination/claim_batch.ts`
- `src/core/coordination/protocol.ts`
- `src/app/mcp/tool_profiles.ts`
- `src/app/mcp/tools/protocol.ts`
- `src/app/cli/commands/agent.ts`
- Existing `claims`, `finalize`, `commit`, and Agent Guidance modules.

MCP contract changes:

- Add optional `paths` array and `intent` metadata to `vibecode_claim_add`, or
  add `vibecode_claims_add`.
- Add `recommended_next_tools` and `recommended_cli_commands` to finalize and
  claim-denial outputs.
- Add profile selection to MCP server/tools list.

CLI contract changes:

- Add `vibecode claims add --paths <path...> --intent <text> --json`.
- Add `vibecode agent done --agent <id> --release-claims --json` if needed.
- `finalize check --json` returns exact `commit guard` command when unblocked.

Tests to add:

- Bulk claim all-or-none and partial-denial behavior.
- Claim intent persists and appears in bootstrap/claims list.
- Tool profiles expose expected names and exclude rare/admin tools.
- Finalize recommends commit guard command.
- CLI-only protocol output matches MCP bootstrap protocol.

Acceptance criteria:

- A normal agent does not need to remember command syntax after bootstrap.
- Claim denial gives a direct next step.
- Finalize gives a direct commit-guard command when safe.

Why this phase comes before the next:

- Navigation improvements do not matter if agents can still edit and commit
  unsafely.

### Phase 3  Improve Repo Navigation Intelligence

Goal:

- Vibecode scan/CodeGraph tools should beat raw `rg` for orientation and test
  selection on unfamiliar work.

Scope:

- Task-aware scan summary.
- CodeGraph fuzzy resolve.
- Stale CodeGraph index warnings.
- Affected tests.
- File/symbol/test mapping.

Explicit non-goals:

- No full AST parser unless regex/import/test maps prove insufficient.
- No fake precision scores.
- No new CodeGraph tools that just wrap low-value upstream commands.

Proposed files/modules:

- `src/core/scanning/scan_summary.ts`
- `src/core/navigation/affected_tests.ts`
- `src/adapters/codegraph/codegraph_resolve.ts`
- `src/app/mcp/tools/codegraph_resolve.ts`
- Python scanner modules remain deterministic and read-only.

MCP contract changes:

- Add `vibecode_codegraph_resolve`.
- Extend `vibecode_scan_summary` with `task` and `sections`.
- Add `vibecode_affected_tests` if the output is useful enough.

CLI contract changes:

- Add `vibecode codegraph resolve <query> --json`.
- Add `vibecode scan summary --task <task> --json`.
- Add `vibecode tests affected --paths <path...> --json` if implemented.

Tests to add:

- Fuzzy resolve returns suggestions for known local symbols.
- Stale warning appears when index state is not trustworthy.
- Affected tests map changed source files to tests from scan/import data.
- Dogfood scenario compares Vibecode navigation against raw `rg`.

Acceptance criteria:

- For unfamiliar feature work, the agent reaches a correct file faster with
  Vibecode tools than with raw `rg`.

Why this phase comes before subagents/UI:

- Multi-agent task splitting depends on knowing file/test ownership accurately.

### Phase 4  Subagents, Handoff, And Team Workflow

Goal:

- Parent agents can delegate scoped work to subagents without confusing claims,
  ownership, or reports.

Scope:

- Parent/child agent identity.
- Subagent claim ownership and inherited context.
- Notice board / agent messages.
- Handoff protocol.
- Per-agent work summaries.

Explicit non-goals:

- No autonomous orchestration framework.
- No hidden prompt injection.
- No automatic conflict resolution.

Proposed files/modules:

- `src/core/coordination/subagents.ts`
- `src/core/coordination/notices.ts`
- `src/core/coordination/handoffs.ts`
- `src/app/mcp/tools/agent_messages.ts`
- `src/app/cli/commands/handoffs.ts`

MCP contract changes:

- Add parent/child fields to register/bootstrap outputs.
- Add notice-board read/write generated-state tools.
- Add handoff request/accept/decline when data model is pinned.

CLI contract changes:

- `vibecode agents register --parent <agent_id> --role <role> --task <text>`
- `vibecode notices list/post --json`
- `vibecode handoffs request/accept/decline --json`

Tests to add:

- Parent/child registration.
- Subagent claims are visible under parent summary.
- Handoff cannot silently transfer ownership without explicit accept.
- Notice board writes generated state only.

Acceptance criteria:

- Parent and child agents can report scope, claims, validation, and handoff
  status without manual side channels.

Why this phase comes before UI:

- UI should observe a stable team model, not define it.

### Phase 5  UI / Observability After Core Works

Goal:

- Show coordination state and Vibecode usage clearly after the core protocol is
  proven.

Scope:

- Read-only coordination panel.
- MCP usage visibility.
- Run/claim/conflict overview.
- Dogfood dashboard.

Explicit non-goals:

- No UI-only workflow that bypasses CLI/MCP contracts.
- No desktop mutation controls until CLI/MCP behavior is stable.

Proposed files/modules:

- Existing desktop coordination bridge/panel modules.
- `src/core/coordination/overview.ts`
- MCP usage log reader if exposed safely.

MCP contract changes:

- None required unless usage logs become agent-facing.

CLI contract changes:

- Optional `vibecode coordination overview --json`.

Tests to add:

- Desktop uses read-only core overview.
- UI does not mutate coordination state.
- Overview caps output and avoids raw diffs/secrets.

Acceptance criteria:

- Humans can see active agents, claims, conflicts, evidence, and recent guarded
  commits without opening `.vibecode` files.

Why this phase comes last:

- Observability is valuable only after the underlying protocol is short and
  used.

## 9. Detailed Feature Specifications

### session_bootstrap

MCP name:

- `vibecode_session_bootstrap`

CLI command:

- `vibecode session bootstrap --repo <path> --json`

Request shape:

```json
{
  "agent_id": "agent-123",
  "register": false,
  "agent_name": "Codex terminal 1",
  "agent_type": "codex",
  "terminal_session_id": "term-1",
  "include_instructions": true,
  "include_scan_summary": true,
  "max_items": 25
}
```

Rules:

- If `register` is true and no `agent_id` is supplied, create an agent session.
- If `agent_id` is supplied, heartbeat or report exact next heartbeat command.
- Read/write only generated coordination state when registering/heartbeating.
- Never read arbitrary source files.
- Bound all lists.

Response shape:

```json
{
  "repo_root": "C:/repo",
  "git": {
    "branch": "master",
    "head": "abc123",
    "dirty": true,
    "changed_counts": {
      "staged": 0,
      "unstaged": 2,
      "untracked": 1,
      "deleted": 0,
      "renamed": 0
    },
    "changed_files": []
  },
  "current_run": {
    "run_id": "current",
    "has_final_prompt": true,
    "has_context_pack": true,
    "available_artifacts": []
  },
  "agents": {
    "current": null,
    "active": [],
    "stale": []
  },
  "claims": {
    "own": [],
    "other_active": [],
    "stale": []
  },
  "conflicts": {
    "unresolved": []
  },
  "evidence": {
    "recent_count": 0,
    "warning_count": 0,
    "high_count": 0
  },
  "scan": {
    "current_run_scan_available": true,
    "recommended_sections": ["commands", "tests", "symbols", "imports"]
  },
  "codegraph": {
    "available": true,
    "initialized": true,
    "stale": false
  },
  "project_instructions": {
    "available": true,
    "sources": ["AGENTS.md"]
  },
  "warnings": [],
  "blockers": [],
  "recommended_next_tools": [
    "vibecode_git_changes",
    "vibecode_claim_add",
    "vibecode_scan_summary"
  ],
  "recommended_cli_commands": [
    "vibecode git changes --repo <path> --agent <agent_id> --json"
  ],
  "agent_protocol": [
    "claim before editing",
    "edit only claimed files",
    "run checks",
    "finalize before commit",
    "commit through vibecode commit guard"
  ]
}
```

Warnings/blockers:

- Warn when repo is dirty and no agent is registered.
- Warn when active other-agent claims overlap dirty files.
- Block only invocation errors, not normal dirty state.

Tests:

- Bootstrap clean repo.
- Bootstrap dirty repo.
- Bootstrap with existing agents/claims/conflicts.
- Bootstrap register mode writes only generated coordination state.
- Bootstrap has MCP/CLI parity.
- Bootstrap does not read arbitrary source files.
- Bootstrap output is bounded and includes recommended next tools.

### git_changes

MCP name:

- `vibecode_git_changes`

CLI command:

- `vibecode git changes --repo <path> [--agent <agent_id>] --json`

Changed file categories:

- `staged`
- `unstaged`
- `untracked`
- `deleted`
- `renamed`
- `copied`
- `type_changed`
- `generated_or_ignored`

Claim-aware classification:

- `claimed_by_agent`
- `claimed_by_other_active_agent`
- `unclaimed`
- `generated_or_ignored`
- `stale_claim_overlap`
- `unknown`

Diff stat behavior:

- Include compact `diff_stat` by default if available.
- Do not include full diffs by default.
- A future explicit `--include-diff --path <path>` may be added only with
  bounded output and clear secret-risk warnings.

Response shape:

```json
{
  "repo_root": "C:/repo",
  "head": "abc123",
  "dirty": true,
  "summary": {
    "changed_count": 3,
    "claimed_by_agent": 1,
    "claimed_by_other_active_agent": 1,
    "unclaimed": 1
  },
  "files": [
    {
      "path": "src/a.ts",
      "status": "modified",
      "staged": false,
      "unstaged": true,
      "untracked": false,
      "classification": "claimed_by_agent",
      "owning_claim_id": "claim-1",
      "owning_agent_id": "agent-a"
    }
  ],
  "diff_stat": "bounded text or null",
  "warnings": [],
  "recommended_next_tools": ["vibecode_claim_add", "vibecode_finalize_check"]
}
```

Tests:

- Covers every porcelain status category.
- Classifies paths against active/stale/released claims.
- Does not mutate git state.
- Does not include full diff by default.
- Handles non-git directory with structured failure/warning.
- MCP/CLI parity.

### scan_summary / scan artifact exposure

MCP names:

- `vibecode_scan_summary`
- `vibecode_scan_artifact_read`

CLI commands:

- `vibecode scan summary --run <current|latest|run_id> --json`
- `vibecode scan artifact-read --run <current|latest|run_id> --artifact <name> --json`

Artifacts to summarize:

- `file_inventory.json`
- `commands.json`
- `repo_instructions.json`
- `symbols.json`
- `imports.json`
- `entrypoints.json`
- `tests.json`
- `tooling.json`
- `schemas.json`
- `keyword_hits.json`
- `git_status.json`
- `git_diff_stat.txt`

Artifacts directly readable:

- The same artifacts above, through a strict scan artifact allowlist.
- No arbitrary `scan/<path>` reads.
- No source-file reads.

Size limits:

- Summary default text max: 16000 bytes.
- Structured lists default item cap: 50 per section.
- Direct reads use artifact continuation.

Response shape:

```json
{
  "run_id": "20260608-000000-ABCD",
  "scan_dir": ".vibecode/runs/<run>/scan",
  "sections": {
    "commands": [],
    "tests": [],
    "entrypoints": [],
    "symbols": {
      "total": 1200,
      "items": []
    }
  },
  "available_artifacts": [],
  "missing_artifacts": [],
  "warnings": [],
  "recommended_next_tools": ["vibecode_artifact_read", "vibecode_codegraph_context"]
}
```

Tests:

- Summary reads only allowlisted scan artifacts.
- Summary handles missing scan artifacts.
- Summary caps large lists.
- Direct read rejects traversal and non-allowlisted files.
- MCP/CLI parity.

### artifact continuation

> IMPLEMENTED in Phase 1B-1 (see §14B for the as-built contract). This
> sub-section is the original spec; the implementation wins where it differs.

Current behavior (pre-Phase-1B-1):

- `artifact_read` supports `max_bytes` only.

Target fields:

- `byte_offset`
- `max_bytes`
- `next_offset`
- `total_bytes`
- `bytes_read`
- `content_sha256`
- `truncated`

UTF-8 safety:

- Slicing must not split a UTF-8 code point.
- `next_offset` must be a byte offset into the original file.
- Reading chunks from `0 -> next_offset -> ...` must reconstruct the exact file.

Structured metadata under truncation:

- `structuredContent.data` must always include run id, relative path,
  total bytes, byte offset, bytes read, next offset, and hash even when text
  content is truncated.

Tests:

- Large ASCII artifact continuation.
- Large multi-byte UTF-8 artifact continuation.
- Reconstructed content equals original.
- `next_offset` becomes null at EOF.
- Offset beyond EOF returns structured validation error.
- MCP/CLI parity.

### tool profiles

Profile names:

- `minimal`
- `standard`
- `multi-agent`
- `review-admin`
- `all`

Default profile:

- `standard`

CLI/MCP serve config:

```powershell
vibecode mcp serve --repo <path> --profile standard
vibecode mcp tools --profile standard --json
```

Rules:

- `all` exists for compatibility/admin, but is not default.
- Profile selection must be visible in `workspace_info` and bootstrap.
- Unknown profile is a structured error.

Tests:

- Each profile exposes exact expected tool names.
- Default profile is `standard`.
- `all` matches current full registry.
- No profile exposes commit mutation.
- Settings inventory handles profiles.

### agent protocol / guidance

How MCP agents see the protocol:

- MCP server instructions include the short protocol.
- `vibecode_session_bootstrap` returns `agent_protocol`.
- Tool descriptions include short "when to use this" notes for bootstrap,
  git changes, claims, finalize, artifacts, and scan summary.

How CLI-only agents see the protocol:

```powershell
vibecode agent protocol --repo <path> --markdown
vibecode agent protocol --repo <path> --json
```

Shell banner/preflight:

- Terminal Agent Preflight should print a short banner or make one available
  before starting agents.
- It must not type hidden prompt text into PTY.
- It may verify MCP config and point CLI-only agents to `agent bootstrap`.

Generated instructions:

- Do not silently rewrite `AGENTS.md`.
- If generated repo-local instructions are added later, use an explicit command
  such as `vibecode agent protocol install --target AGENTS.md --dry-run`.

Tests:

- Protocol output includes exact workflow.
- MCP and CLI protocol text stay in parity.
- Terminal preflight does not inject text into terminal stdin.
- Guidance descriptions include useful notes for key tools.

### commit/finalize workflow

Current CLI commit guard behavior:

- Runs finalize check first.
- Blocks when finalize is blocked.
- Commits only files classified `claimed_by_agent`.
- Uses explicit pathspec staging.
- Blocks pre-existing unrelated staged files.
- Writes `commit_guard.json` under run coordination state when run id is
  provided.

Should MCP commit tool exist now?

- No. Keep commit mutation CLI-only until profiles, protocol, and dogfood prove
  agents consistently use finalize/commit guard.

Safe default behavior:

- MCP `finalize_check` returns exact `vibecode commit guard` command when safe.
- CLI `finalize check` returns the same recommendation in JSON.
- `commit guard --dry-run` remains the recommended first commit command.

Dry-run behavior:

- No staging.
- No commit.
- No `commit_guard.json` artifact write.
- Shows would-stage, skipped files, blocks, and warnings.

Tests:

- Finalize includes recommended commit guard command when status is `ok` or
  `warning` and committable files exist.
- Finalize does not recommend commit when blocked.
- Commit guard still never stages broad paths.
- Commit guard leaves other-agent dirty files untouched.

## 10. Dogfood / Benchmark Plan

### Scenario A  Single Agent Unfamiliar Feature

Goal:

- Prove Vibecode helps find relevant files faster than raw `rg`.

Setup:

- Use a fixture or real VibecodeLight task with no known file path, for example
  "change artifact read pagination behavior".
- Start from clean repo.
- Agent must call bootstrap first.

Expected commands/tools:

- `vibecode_session_bootstrap`
- `vibecode_scan_summary`
- `vibecode_codegraph_context`
- `vibecode_codegraph_search`
- Raw `rg` only after Vibecode tools fail to identify candidates.

Measure:

- Number of Vibecode tool/CLI calls.
- Number of raw `rg`/`find`/`git` commands.
- Time to first correct file.
- Wrong files opened.
- Tests selected.

Pass criteria:

- Agent reaches a correct source file and relevant test using Vibecode before
  raw `rg`, or records why Vibecode failed.
- Raw shell fallback count decreases over repeated runs.

Failure signals:

- Agent ignores bootstrap.
- Agent uses raw `rg` first.
- CodeGraph gives low-signal results and scan summary is not enough.

### Scenario B  Two Agents Non-Overlapping Work

Goal:

- Prove two agents can claim different files, work, finalize, and commit without
  conflict.

Setup:

- Agent A changes one source file and its test.
- Agent B changes separate docs or a separate source/test pair.
- Both start in the same working tree.

Expected commands/tools:

- Both call bootstrap first.
- Both register or heartbeat.
- Both claim before edit.
- Both call git changes.
- Both call finalize.
- Both use `vibecode commit guard --dry-run`, then `commit guard`.
- Both release claims or mark done.

Pass criteria:

- No overlapping active claims.
- No unclaimed dirty files at finalize.
- Commit guard for Agent A commits only Agent A files.
- Commit guard for Agent B commits only Agent B files.
- Final reports list claims, changed files, tests, commit hash, and known issues.

Failure signals:

- Raw `git add` or raw `git commit`.
- Unclaimed dirty files at finalize.
- One agent commits another agent's file.

### Scenario C  Two Agents Competing For Same File

Goal:

- Prove overlapping work is denied, recorded, and recoverable.

Setup:

- Agent A claims `src/app/mcp/tool_registry.ts`.
- Agent B tries to claim the same file exclusively.

Expected commands/tools:

- `vibecode_claim_add`
- `vibecode_conflicts_list`
- Bootstrap or claim response recommends wait, shared retry if compatible, or
  request human/agent handoff.

Pass criteria:

- Claim denial is structured.
- Conflict record exists.
- Agent B does not edit the file.
- No accidental commit of the other agent's work.

Failure signals:

- Agent B edits despite claim denial.
- Conflict is not visible in bootstrap/conflict list.
- Recommended next action is missing.

### Scenario D  CLI-Only Agent

Goal:

- Prove a non-MCP agent can work safely without raw coordination.

Setup:

- Disable MCP for one terminal agent.

Expected commands:

```powershell
vibecode session bootstrap --repo . --register --json
vibecode git changes --repo . --agent <id> --json
vibecode claims add --repo . --agent <id> --paths <paths> --intent "<task>" --json
vibecode finalize check --repo . --agent <id> --json
vibecode commit guard --repo . --agent <id> --dry-run --json
vibecode commit guard --repo . --agent <id> --message "<subject>" --json
```

Pass criteria:

- CLI-only agent does not need MCP or direct `.vibecode` reads.
- Raw `git status` is not needed for coordination.

### Scenario E  Subagent Scenario Later

Goal:

- Prove parent/child identity and handoff once Phase 4 exists.

Setup:

- Parent agent delegates tests to child agent.

Pass criteria:

- Child has parent id, role, claims, validation result, and done/handoff record.

## 11. Tests Required Before Implementation

Add tests before production code.

Required categories:

- MCP/CLI parity for bootstrap, git changes, scan summary, and artifact
  continuation.
- Bootstrap aggregation: repo/git/current run/agents/claims/conflicts/evidence
  artifacts/codegraph/instructions/recommended next tools.
- Bootstrap generated-state mutation only when register/heartbeat requested.
- `git_changes` classification for staged, unstaged, untracked, deleted,
  renamed, copied, generated, claimed, other-claimed, stale-overlap, and
  unclaimed files.
- Artifact continuation with ASCII and multi-byte UTF-8.
- Scan summary allowlist, bounds, missing artifacts, and no arbitrary file
  access.
- Tool profiles: expected inclusion/exclusion, default `standard`, no commit
  mutation in any default profile.
- Claim conflict behavior with bulk paths and intent metadata.
- Finalize blocking behavior and exact next action recommendation.
- Commit guard scope and no broad staging.
- Stale claims and reap behavior remains generated-state only.
- Dogfood-style multi-agent fixture.
- No `.vibecode` commit leakage.
- No arbitrary repo/source file access through MCP.
- `recommended_next_tools` presence on bootstrap, claim denial, git changes,
  and finalize outputs.

Example test names:

- `tests/app/mcp/session_bootstrap.test.ts`
- `tests/app/cli/agent_bootstrap_commands.test.ts`
- `tests/core/workspace/git_changes_summary.test.ts`
- `tests/app/mcp/git_changes_tool.test.ts`
- `tests/core/runs/artifact_continuation.test.ts`
- `tests/app/mcp/scan_summary_tool.test.ts`
- `tests/app/mcp/tool_profiles.test.ts`
- `tests/integration/multi_agent_dogfood.test.ts`

## 12. What Not To Build Yet

More UI before core workflow is usable:

- Premature because agents still need one-call bootstrap and git changes. UI
  should observe stable core state, not invent workflow.

HTTP MCP before stdio workflow is proven:

- Premature because the current issue is workflow efficiency, not transport.

Live file watcher as enforcement:

- Current evidence/watchers are advisory. Do not pretend watcher events can
  safely enforce ownership.

Complex handoff before basic claims/commit guard are reliable:

- Handoff will add state transitions. Build it only after claim/finalize/commit
  workflows are short.

More CodeGraph tools before fuzzy resolve/stale index:

- More wrappers will not help if agents cannot resolve exact symbols or trust
  index freshness.

Raw diff exposure by default:

- Full diffs may contain secrets or large content. Keep summaries default.

Hard filesystem locks:

- Locks add cross-platform failure modes and may fight editors/tools. Advisory
  coordination plus guarded commit is the current pragmatic path.

Magical automatic agent detection:

- Agents should identify/register explicitly. Hidden detection will be brittle
  across Codex, Claude, Hermes, OpenCode, shells, and terminals.

MCP commit tool by default:

- Commit mutation belongs in CLI until opt-in permissions, profiles, and
  dogfood show safe behavior.

## 13. Recommended Immediate Next Batch

Chosen batch:

- Implement `session_bootstrap` and `git_changes` only.

Exact scope:

- Add core bootstrap aggregation service.
- Add core claim-aware git changes summary service.
- Add MCP tools:
  - `vibecode_session_bootstrap`
  - `vibecode_git_changes`
- Add CLI commands:
  - `vibecode session bootstrap --repo <path> --json`
  - `vibecode git changes --repo <path> [--agent <id>] --json`
- Add `recommended_next_tools` and `recommended_cli_commands` to both new
  responses.
- Do not implement scan summary, artifact continuation, profiles, or bulk
  claims in this first batch.

Exact files likely touched:

- `src/core/agent_session/bootstrap.ts`
- `src/core/workspace/git_changes_summary.ts`
- `src/app/mcp/tools/session_bootstrap.ts`
- `src/app/mcp/tools/git_changes.ts`
- `src/app/mcp/tool_registry.ts`
- `src/app/mcp/schemas.ts`
- `src/app/cli/commands/agent.ts`
- `src/app/cli/commands/git_changes.ts`
- `src/app/cli/index.ts`
- `tests/core/agent_session/bootstrap.test.ts`
- `tests/core/workspace/git_changes_summary.test.ts`
- `tests/app/mcp/session_bootstrap.test.ts`
- `tests/app/mcp/git_changes_tool.test.ts`
- `tests/app/cli/agent_bootstrap_commands.test.ts`
- `tests/app/cli/git_changes_commands.test.ts`

Tests first:

1. Write failing core tests for bootstrap and git changes.
2. Write failing MCP schema/handler tests.
3. Write failing CLI command tests.
4. Implement smallest code to pass.
5. Run targeted tests, then relevant MCP/CLI/coordination suites.

Acceptance criteria:

- One MCP call gives enough orientation for a fresh coding agent.
- One CLI command gives the same orientation for CLI-only agents.
- Git changes output lists all changed files and classifies them relative to
  active claims when `agent_id` is supplied.
- No full diffs are exposed by default.
- New tools/commands do not mutate source files or git.
- Existing coordination and MCP security tests remain green.

What must not be changed:

- Do not add MCP commit mutation.
- Do not change claim semantics from advisory to locking.
- Do not rewrite existing architecture docs in the same batch.
- Do not expose arbitrary artifact/source reads.
- Do not alter Python scanner ownership.

## 14A. Phase 1A — session_bootstrap + git_changes (Implemented)

This section records what was actually built in the first batch. Where the
implementation differs from the earlier proposal above, the implementation wins
and the difference is called out.

### Implemented MCP tools

- `vibecode_session_bootstrap` — one-call orientation for the bound repo.
- `vibecode_git_changes` — claim-aware changed-files summary.

Both are registered in `src/app/mcp/tool_registry.ts` (the canonical
`VIBECODE_MCP_TOOL_NAMES` list), grouped under `workspace_orientation` in
`src/core/config/agent_guidance_mcp_tools.ts` and `tools/workspace_info.ts`, and
covered by the MCP security/registry/parity suites. They never accept a `repo`
argument (the repo is bound at server start), never expose a full diff or
arbitrary file read, and never mutate git or source files.

### Implemented CLI commands

- `vibecode session bootstrap --json`
- `vibecode git changes --json`

**Naming difference from the proposal:** earlier sections of this plan sketched
the CLI as `vibecode session bootstrap`. The shipped commands are
`vibecode session bootstrap` and `vibecode git changes` (the agent-facing MCP
tool names `vibecode_session_bootstrap` / `vibecode_git_changes` are unchanged).
`vibecode agent protocol` was **not** shipped in this batch.

Both CLI commands and both MCP tools call the same shared core services, so
MCP/CLI parity holds:

- `src/core/agent_session/bootstrap.ts` (`getSessionBootstrap`)
- `src/core/workspace/git_changes_summary.ts` (`getGitChangesSummary`)

`getGitChangesSummary` is the single source of truth for changed files and is
also consumed by `session_bootstrap`'s git section (reusable by a future
workspace/finalize/commit-alignment phase).

### session_bootstrap behavior

Read-only by default. The only generated state it ever writes is
`.vibecode/coordination/state.json`, and only when:

- an `agent_id` is supplied (heartbeat/refresh; revives a stale/idle session); or
- `register: true` with a valid `agent_mode` and a `task`.

Agent operating mode is a Phase 1A concept distinct from the existing
`agent_binding` tooling mode (`mcp`/`cli`/`unknown`). Valid operating modes are
`read_only` and `build`; the value (plus the `task`/intent) is stored in the
agent session `metadata` (`operating_mode`, `task`) — the `AgentSession` shape is
unchanged. Mode is chosen at session start and is not changed mid-session.
`read_only` agents must not modify source and do not claim files; `build` agents
must claim each file before editing.

Identity resolution:

| Input | Result |
| --- | --- |
| `agent_id` active/idle/stale | heartbeat (revives), `ok:true`, `generated_state_written:true` |
| `agent_id` terminated | `ok:false`, blocker `AGENT_TERMINATED` (MCP error `AGENT_TERMINATED`) |
| `agent_id` not found | `ok:false`, blocker `AGENT_NOT_FOUND` |
| no `agent_id`, `register:true`, valid mode + task | new agent created, `agent_id` returned, state written |
| no `agent_id`, `register:true`, bad mode | `ok:false`, blocker `INVALID_AGENT_MODE` (MCP error `INVALID_ARGUMENT`) |
| no `agent_id`, `register:true`, no task | `ok:false`, blocker `AGENT_TASK_REQUIRED` (MCP error `INVALID_ARGUMENT`) |
| no `agent_id`, `register:false` | `ok:true` orientation + `NOT_REGISTERED` warning |

Run selection (`run_ref`): `current`, `latest`, or a concrete run id. **Actual
behavior:** in Phase 1A `current` and `latest` BOTH resolve to the
`.vibecode/current` pointer — chronological-latest is intentionally not
distinguished yet (consistent with the existing `resolveRunDir` semantics). A
concrete run id resolves through the path-safe `resolveExplicitRunDir`.

Bounded response sections (all lists capped by `max_items`, default 25):

- `repo_root`, `generated_state_written`
- `git`: `available`, `branch`, `head`, `dirty`, `changed_counts`
  (`staged`/`unstaged`/`untracked`/`deleted`/`renamed`/`total`),
  `sample_changed_files` (capped), `sample_truncated`
- `current_run`: `run_ref`, `run_id`, `available`, `has_final_prompt`,
  `has_context_pack`, `has_flash_output`, `available_artifacts`
- `agents`: `total`/`active`/`stale`/`terminated` + capped `active_items` /
  `stale_items`
- `current_agent`: identity incl. `operating_mode` + `task` (or null)
- `claims`: `counts` (`own`/`other_active`/`stale`) + capped `own` /
  `other_active` / `stale` lists
- `conflicts`: `unresolved_count` + capped `items`
- `evidence`: `recent_count` / `warning_count` / `high_count` / `last_event_at`
- `scan`: `current_run_scan_available` only (no `scan_summary` in Phase 1A)
- `codegraph`: `available` / `initialized` / `stale` (`stale` is always `false`
  in Phase 1A — stale-index detection is a later phase)
- `project_instructions`: `available`, `sources`, bounded `excerpt`,
  `excerpt_truncated` (from the same strict allowlist as
  `vibecode_project_instructions`; no arbitrary source reads)
- `agent_protocol` (see below), `warnings`, `blockers`,
  `recommended_next_tools`, `recommended_cli_commands`

### git_changes behavior

Read-only. Works without `agent_id` (partial classification + warning); with
`agent_id` the agent's mode/claims are read from registered coordination state,
not from a per-call override.

Changed-file categories: `staged`, `unstaged`, `untracked`, `deleted`,
`renamed`, `copied`, `type_changed`, `generated_or_ignored` (a file may belong
to several).

Claim-aware classifications: `claimed_by_agent`,
`claimed_by_other_active_agent`, `unclaimed`, `generated_or_ignored`,
`stale_claim_overlap`, `unknown_without_agent_id` (the no-agent case).

Other guarantees: counts are computed over ALL changed files while the `files`
list is capped (`truncated` / `total_changed` / `returned_changed`); a bounded
`git diff --stat` is included by default (never a full diff — no hunk bodies);
unclaimed dirty source files raise a HIGH `UNCLAIMED_DIRTY_FILES` warning when an
agent is supplied; a non-git directory returns `ok:false` (MCP/CLI error
`GIT_CHANGES_FAILED`). It is NOT finalize — it warns and classifies; finalize /
commit guard remain the hard decision points.

### Current agent operating protocol

Returned verbatim by every `session_bootstrap` call
(`AGENT_OPERATING_PROTOCOL`):

1. Register or confirm your agent identity (`read_only` or `build`) with a
   task/intent before working.
2. `read_only` agents must NOT modify source files and do not claim files.
3. `build` agents must claim each file (`vibecode_claim_add`) before editing it.
4. Inspect the working tree with `vibecode_git_changes` before editing or
   finalizing.
5. Edit only files your agent has claimed.
6. Run the project checks/tests after editing.
7. Run `vibecode_finalize_check` before committing.
8. Commit only your claimed files through the CLI `vibecode commit guard`
   (no raw `git add`/`commit`).
9. Heartbeat to stay active; release claims or terminate when done.

`recommended_next_tools` / `recommended_cli_commands` are returned by both
`session_bootstrap` and `git_changes` only (no other MCP response was
standardized in this batch).

### Tests proving behavior

- `tests/core/workspace/git_changes_summary.test.ts` — categories, counts +
  truncation, bounded diff stat vs. no full diff, classification with/without
  agent_id, stale-overlap, generated/ignored separation, HIGH unclaimed
  warning, non-git failure, no git/source mutation.
- `tests/core/agent_session/bootstrap.test.ts` — clean/dirty, register
  (mode+task), heartbeat, stale revive, terminated/not-found blockers,
  register=false warning, bounded sections, scan-availability-only, instruction
  excerpt, protocol + recommendations, claim split + caps.
- `tests/app/mcp/session_bootstrap_tool.test.ts`,
  `tests/app/mcp/git_changes_tool.test.ts` — schema rejects unknown fields,
  expected `structuredContent`, registry membership, error mapping.
- `tests/app/cli/session_git_changes_commands.test.ts` — stable success/error
  envelopes and CLI/MCP parity for core fields.
- Existing `tests/app/mcp/security.test.ts` / `registry_parity.test.ts` /
  `tool_registry.test.ts` / `docs.test.ts` stay green (lockstep lists updated).

### Known limitations

- `current`/`latest` both mean the current pointer (no chronological-latest).
- `codegraph.stale` is always `false` (stale-index detection is later).
- `scan` reports availability only — no `scan_summary`.
- No tool profiles, no bulk claims, no `vibecode agent protocol` command, no
  MCP commit tool. (Artifact-read continuation was a Phase 1A limitation too,
  but has since been added in Phase 1B-1 — see §14B.)
- Coordination remains advisory: no source-file locks; claims are enforced
  at the agent-mode level (read_only cannot claim), but file-level locking
  is not implemented.

### Phase 1A review fixes (enforced)

The Phase 1A review returned NEEDS FIXES. The following blockers were fixed:

**1. Shared agent operating-mode/task validation.**
New module `src/core/coordination/agent_operating_mode.ts` is the single source
of truth for operating-mode extraction, validation, and enforcement. Bootstrap,
claims, finalize_check, and commit_guard all use this module instead of
duplicating mode/task logic.

**2. read_only enforcement.**
- `addFileClaim` rejects agents whose `operating_mode` is not `build`.
- `finalize_check` blocks non-build agents as `READ_ONLY_AGENT` or
  `INVALID_AGENT_SESSION`.
- `commit_guard` blocks non-build or invalid-mode agents before staging/committing.
- Bootstrap recommendations are mode-aware: read_only agents get
  `vibecode_project_instructions` / `vibecode_workspace_info` instead of
  `vibecode_claim_add`.

**3. Legacy/no-mode agent handling.**
- Bootstrap with an active/stale `agent_id` that has missing `operating_mode` or
  `task` metadata returns a structured `INVALID_AGENT_SESSION` blocker.
- Terminated agents remain terminated.
- The old `vibecode_agent_register` MCP tool remains for compatibility but creates
  agents without mode/task; bootstrap blocks these until re-registered through
  `session_bootstrap --register`.

**4. Hard caps and strict input validation.**
- MCP schemas include `maximum` for `max_items` (100) and `max_files` (200).
- MCP manual validation rejects wrong types, invalid booleans, invalid enums,
  empty required strings, negative/zero/huge caps with `INVALID_ARGUMENT`.
- CLI rejects invalid numeric flags (`--max-items nope`, `--max-files 0`,
  `--max-items 999`) with structured error envelopes.
- New `validateBoundedInteger` helper in `src/app/mcp/schemas.ts`.

**5. Mode immutability.**
- Existing agent registered as `read_only` cannot be changed to `build` through
  bootstrap heartbeat/update (and vice versa). Returns `MODE_IMMUTABLE` blocker.

**Tests added:**
- `tests/core/coordination/agent_operating_mode_enforcement.test.ts` — 28 tests
  covering read_only claim/finalize/commit_guard restriction, build agent
  workflows, legacy agent handling, missing task/mode, mode immutability,
  shared helper correctness.
- `tests/app/mcp/phase1a_enforcement.test.ts` — 22 tests covering MCP input
  validation (register type, max_items caps, operating_mode, task), mode-aware
  recommendations, legacy agent bootstrap via MCP, read_only claim/finalize via
  MCP.

**Existing tests updated:** 151 `registerAgent` calls across 21 test files
updated to include `metadata: { operating_mode: 'build', task: 'test' }` so
agents pass the new validation. One CLI test helper updated to use
`session bootstrap --register` instead of the old `agents register` path.

### Phase 1A follow-up cleanups

**1. Core services now defensively enforce cap limits.**
`SESSION_BOOTSTRAP_MAX_ITEMS` (100) and `GIT_CHANGES_MAX_FILES` (200) are
defined in their respective core modules (`bootstrap.ts`, `git_changes_summary.ts`)
and enforced defensively by `getSessionBootstrap()` / `getGitChangesSummary()`.
MCP schemas and CLI commands import from core to avoid drift. MCP/CLI adapters
still reject invalid user input explicitly at the validation layer.

**2. commit_guard / finalize mode-check duplication clarified.**
Both `commit_guard` and `finalize_check` validate agent operating mode using
the same shared helpers (`getAgentOperatingMode` / `getAgentTask` from
`agent_operating_mode.ts`). The early check in `commit_guard` is intentional
defense-in-depth — it ensures commit_guard never even invokes finalize for
read_only/invalid agents, keeping the "block before staging" invariant
independent of finalize's internal logic. A comment in `commit_guard.ts`
documents this.

**3. `generated_or_ignored` surfaced in `changed_counts`.**
`session_bootstrap`'s `git.changed_counts` now includes `generated_or_ignored`
as a first-class count, sourced from `getGitChangesSummary`'s classification
counts. Generated `.vibecode/` paths remain excluded from unclaimed-source
warnings.

### Phase 1A dogfood follow-up — implemented

Dogfood found three bounded usability gaps. All three are fixed:

**1. Bootstrap warning for active claims on clean files.**
`session_bootstrap` now detects when other-agent active claims cover files
that are NOT dirty in the working tree. These are flagged with a
`POSSIBLY_STALE_ACTIVE_CLAIMS` warning including claim ids, agent ids, and
sample paths (bounded by `max_items`). The warning does NOT auto-release
claims; it recommends `vibecode claims list` and `vibecode claims reap` as
next actions. Active claims on dirty files are NOT flagged.

**2. Finalize OK now recommends commit guard.**
`getFinalizeCheck` returns a new `recommended_cli_commands` field. When
status is `ok` or `warning` with committable claimed files, it includes:
- `vibecode commit guard --repo <repo> --agent <id> --dry-run --json`
- `vibecode commit guard --repo <repo> --agent <id> --message "<msg>" --json`

When finalize is blocked, no commit guard command is recommended. MCP and CLI
expose equivalent recommendation data.

**3. Standalone agents register now requires mode/task.**
Both CLI `vibecode agents register` and MCP `vibecode_agent_register` now
require `--agent-mode` / `agent_mode` (read_only | build) and `--task` /
`task` (non-empty string). Missing or invalid values return structured
`MISSING_REQUIRED_OPTION` or `INVALID_ARGUMENT` errors. Legacy agents without
mode/task can no longer be created through the normal agent-facing register
commands. The session bootstrap `register=true` flow continues to work.

**Tests added:**
- `tests/core/agent_session/bootstrap.test.ts` — 6 tests covering stale
  active claim warnings, clean vs dirty file distinction, bounded details,
  recommended next commands.
- `tests/core/coordination/finalize_check.test.ts` — 6 tests covering commit
  guard recommendations for ok/blocked/warning states.
- `tests/app/cli/finalize_commands.test.ts` — 2 tests covering CLI
  recommended_cli_commands output.
- `tests/app/mcp/finalize_tool.test.ts` — 2 tests covering MCP
  recommended_cli_commands output.
- `tests/app/cli/agents_commands.test.ts` — 5 tests covering CLI register
  with/without mode/task, invalid mode, empty task.
- `tests/app/mcp/phase1a_enforcement.test.ts` — 5 tests covering MCP
  agent_register with/without mode/task, invalid mode, empty task.

**Existing tests updated:** 3 test files updated to pass `--agent-mode` and
`--task` to `agents register` CLI calls; 2 MCP test files updated to pass
`agent_mode` and `task` to `vibecode_agent_register` calls.

### Next batch

Phase 2 (make coordination harder to skip): bulk claims with intent, finalize
"next action" command output, tool profiles (default `standard`), terminal
protocol banner. Scan summary can follow per §13.

## 14B. Phase 1B-1 — artifact_read continuation (Implemented)

This section records what was actually built for artifact continuation (Problem
§4.4, spec §9 "artifact continuation"). It is the second slice of Phase 1 work,
shipped after Phase 1A. Where the implementation differs from the earlier
proposal, the implementation wins.

### Scope (and explicit non-scope)

In scope: byte-offset continuation for the existing run-artifact allowlist, on
both MCP and CLI, with UTF-8-safe chunking and a stable full-file hash.

**NOT in this batch** (deferred, unchanged from §13/§7): `scan_summary`,
`scan_artifact_read`, any scan-artifact exposure, tool profiles, bulk claims, an
MCP commit tool, subagents/handoff/notice board, UI changes, hard file locks, and
full-diff exposure. No new artifact categories were added — continuation reads
the *same* `RUN_SHOW_ARTIFACTS` allowlist as before.

### Shared core service

`src/core/runs/artifact_pagination.ts` (`readRunArtifactChunk`) is the single
source of truth. Both adapters are thin wrappers over it; neither re-implements
slicing, validation, UTF-8 boundary handling, hashing, or bounds. It reuses
`resolveRunArtifactPath` from `run_artifacts.ts`, so the allowlist + realpath
containment (no traversal, no symlink escape, no source/scan exposure) are
inherited unchanged.

Bounds are defined in core, not only in the adapters:

- `DEFAULT_ARTIFACT_CHUNK_BYTES = 16000` (matches `MCP_TEXT_OUTPUT_LIMIT`).
- `HARD_MAX_ARTIFACT_CHUNK_BYTES = 65536` (64 KiB). No MCP/CLI path can request
  an unbounded read.

### MCP tool input/output

Tool name is unchanged: `vibecode_artifact_read`. New optional inputs:

- `byte_offset?` — non-negative integer byte offset into the original file
  (default 0). For continuation, pass the previous response's `next_byte_offset`.
- `max_bytes?` — positive integer, now hard-capped at 65536.

`structuredContent.data` always includes the full continuation metadata even when
the bounded 16000-byte text block truncates the inline content:

```json
{
  "run_id": "r1",
  "artifact": "final_prompt",
  "relative_path": "output/final_prompt.md",
  "byte_offset": 16000,
  "requested_max_bytes": 16000,
  "bytes_read": 16000,
  "total_bytes": 48000,
  "has_more": true,
  "next_byte_offset": 32000,
  "content_sha256": "<sha256 of the full artifact file>",
  "truncated": true,
  "content": "..."
}
```

The text block restates `byte_offset` / `bytes_read` / `total_bytes` /
`has_more` / `next_byte_offset` / `content_sha256`, and when `has_more` is true it
explicitly says: *continue: call vibecode_artifact_read again with
byte_offset: <next_byte_offset>*.

**Hash naming:** `content_sha256` is the SHA-256 of the **full artifact file**,
stable across chunks (so a caller can verify a reconstructed file). It is not a
per-chunk hash; the name is unambiguous.

**Backward compatibility:** a call without `byte_offset` behaves like before
(reads from 0). The legacy `truncated` field is retained and now equals
`has_more`. The one intentional contract refinement: `bytes_read` is now the
bytes *actually returned in this chunk* and `total_bytes` is the full file size —
previously `bytes_read` reported the whole file size on a truncated read. The MCP
test for this was updated.

### CLI command chosen

`vibecode runs artifact-read --run <current|latest|run_id> --artifact <name>
[--byte-offset <n>] [--max-bytes <n>] [--repo <path>] --json`

A **dedicated** command was added rather than extending `runs show --artifact`,
because `runs show --artifact` intentionally streams **raw** artifact bytes to
stdout (even with `--json`) for humans, and that behavior is pinned by a
characterization test. `runs artifact-read --json` emits the canonical envelope
`{ ok, data, artifacts, warnings }` with the same `data` fields as the MCP tool;
without `--json` it prints a short human summary plus the chunk content. CLI-only
agents therefore never need to read `.vibecode/runs/...` files directly.

**Run selection (`--run`):** `current`, `latest`, or an explicit run id. Both
`current` and `latest` resolve to the `.vibecode/current` pointer — the same
convention the MCP tool uses for `run_id` (Phase 1A: there is no
chronological-latest distinction yet). This mapping is centralized in
`normalizeRunSelector` (`src/core/runs/run_resolver.ts`) and shared by the CLI
command and the MCP `_run_select.ts` helper so the two cannot drift on what
`current` means. (A Phase 1B-1 review fix: the CLI previously treated `--run
current` as a literal run id, which did not match the advertised contract or the
MCP behavior.)

### Continuation workflow

```text
1. call with byte_offset 0 (or omit it)
2. if has_more=true, call again with byte_offset = next_byte_offset
3. repeat until has_more=false (next_byte_offset becomes null)
4. concatenate the content chunks to reconstruct the full artifact
```

### byte_offset / max_bytes behavior

- `byte_offset` defaults to 0; rejects negative / non-integer values
  (`INVALID_BYTE_OFFSET` in core → `INVALID_ARGUMENT` on MCP/CLI).
- `byte_offset == total_bytes` is a valid terminal read: empty content,
  `has_more=false`, `next_byte_offset=null`.
- `byte_offset > total_bytes` → `BYTE_OFFSET_OUT_OF_RANGE` (→ `INVALID_ARGUMENT`).
- `max_bytes` defaults to 16000; rejects zero / negative / non-integer / values
  above 65536 (`INVALID_MAX_BYTES` → `INVALID_ARGUMENT`).

### UTF-8 safety

The chunk window end is trimmed backward to the nearest UTF-8 code-point boundary
so returned content never contains a spurious U+FFFD. `next_byte_offset` is the
real byte length consumed (computed from the byte buffer, never from JS string
length), so chained reads from 0 → EOF reconstruct the exact original file,
including multi-byte content. If `max_bytes` is smaller than the next code point,
exactly one whole code point is returned to guarantee forward progress (no
zero-length stall).

### Hard caps

Default 16000 bytes/chunk; hard maximum 65536 bytes/chunk, enforced in core and
mirrored in the MCP schema `maximum` and CLI validation. The MCP text block stays
bounded at `MCP_TEXT_OUTPUT_LIMIT`; structured metadata is always complete.

### Examples

```powershell
# MCP (conceptually): vibecode_artifact_read { run_id:"latest", artifact:"final_prompt", byte_offset:0, max_bytes:16000 }
vibecode runs artifact-read --run latest --artifact final_prompt --max-bytes 16000 --json
vibecode runs artifact-read --run latest --artifact final_prompt --byte-offset 16000 --max-bytes 16000 --json
```

### Tests proving behavior

- `tests/core/runs/artifact_continuation.test.ts` — single-chunk, large ASCII
  reconstruction, multi-byte UTF-8 reconstruction with no replacement chars,
  tiny-max progress guarantee, offset at/beyond EOF, negative/non-integer offset,
  max_bytes 0/negative/over-cap/at-cap, alias resolution, traversal +
  non-allowlisted scan artifact rejection, full-file hash stability.
- `tests/app/mcp/artifact_read_continuation.test.ts` — new fields, has_more +
  continuation hint, chained reconstruction, complete metadata under text-block
  truncation, EOF, invalid offset/max_bytes, unknown-key rejection, scan rejection.
- `tests/app/mcp/runs_tools.test.ts` — existing read tests still pass (the
  truncation test updated to the refined `bytes_read`/`total_bytes` contract).
- `tests/app/cli/runs_artifact_read_commands.test.ts` — JSON envelope, chunked
  paging, large UTF-8 reconstruction, invalid offset/max_bytes envelopes, scan
  rejection, CLI/MCP field parity, and preservation of raw `runs show --artifact`.
- `tests/app/mcp/limits.test.ts` — default still equals `MCP_TEXT_OUTPUT_LIMIT`.

### Known limitations

- Continuation only covers the existing `RUN_SHOW_ARTIFACTS` allowlist. Scan
  artifacts (`symbols.json`, `tests.json`, etc.) remain unreadable — `scan_summary`
  / scan-artifact exposure is explicitly **not** part of this batch (see §13/§9).
- Pure agent-arbitrary `byte_offset` values that fall mid-code-point at the chunk
  *start* are not re-aligned; agents are expected to chain from `next_byte_offset`
  (always a valid boundary). Reconstruction guarantees hold for chained reads.
- No tool profiles, bulk claims, MCP commit tool, or full-diff exposure (deferred).

## 14C. Phase 1B-2 — scan_summary + scan_artifact_read (Implemented)

This section records what was actually built to make deterministic scan
intelligence available to agents through safe MCP/CLI surfaces (Problem §4.3,
spec §9 "scan_summary / scan artifact exposure"). It is the third slice of
Phase 1 work, shipped after Phase 1B-1. Where the implementation differs from the
earlier proposal, the implementation wins.

### Scope (and explicit non-scope)

In scope: a bounded scan summary and bounded, allowlisted, continuation-friendly
reads of individual scan artifacts, on both MCP and CLI, reading **existing**
scan artifacts produced by an earlier run.

**These tools read existing scan artifacts and do NOT run the scanner.**

**NOT in this batch** (deferred, unchanged from §13/§7): tool profiles, bulk
claims, an MCP commit tool, subagents/handoff/notice board, UI changes, hard file
locks, full-diff exposure, CodeGraph fuzzy resolve, affected-tests, and
task-aware relevance scoring. No automatic scanner runs, no arbitrary scan
directory browsing, and no arbitrary file reads.

### Shared core services

`src/core/runs/scan_artifacts.ts` and `src/core/runs/scan_summary.ts` are the
single source of truth. Both adapters (MCP and CLI) are thin wrappers; neither
re-implements allowlist resolution, slicing, validation, UTF-8 handling, hashing,
or bounds.

- `scan_artifacts.ts` owns the strict scan-artifact allowlist (agent-facing KEY →
  run-relative path) and `readScanArtifactChunk`, which delegates to the Phase
  1B-1 `readRunArtifactChunk` with a **scan-only** allowlist set. It therefore
  inherits the same `resolveRunArtifactPath` allowlist + realpath containment
  (no traversal, no symlink escape, no source/non-allowlisted exposure) and the
  same continuation contract (byte offsets, UTF-8-safe slicing, full-file hash,
  64 KiB hard cap). Unknown keys (including raw paths and traversal strings) are
  rejected with `ARTIFACT_NOT_ALLOWED` before any filesystem access.
- `scan_summary.ts` owns `getScanSummary`, which projects allowlisted scan
  artifacts into compact, counted, bounded sections. It never reads source files
  and never includes instruction/file *contents* (only paths/counts/metadata).

### Scan artifact allowlist (KEY → real scanner path)

These are the real filenames the Python scanner writes under
`.vibecode/runs/<run_id>/scan/` (`base_scan.py`):

```text
file_inventory    -> scan/file_inventory.json
commands          -> scan/commands.json
repo_instructions -> scan/repo_instructions.json
symbols           -> scan/symbols.json
imports           -> scan/imports.json
entrypoints       -> scan/entrypoints.json
tests             -> scan/tests.json
tooling           -> scan/tooling.json
schemas           -> scan/schemas.json
keyword_hits      -> scan/keyword_hits.json
git_status        -> scan/git_status.json
git_diff_stat     -> scan/git_diff_stat.txt
```

A run that did not produce a given artifact reports it as **missing**, never
invented.

### MCP tools

- `vibecode_scan_summary` — input `{ run_id?, sections?, max_items? }`. `run_id`
  accepts `latest`/`current` (default current). `sections` is an optional subset
  of `files, commands, tests, symbols, imports, entrypoints, instructions,
  tooling, git` (omit for all). Returns `run_id`, `run_ref`, `scan_available`,
  `scan_dir_available`, `sections_requested`, `sections` (each with
  `available`/`total`/`returned`/`truncated`/`items`, plus a compact `summary`
  for `tooling`/`git`), `available_artifacts`, `missing_artifacts`, `max_items`,
  `warnings`, and `recommended_next_tools` / `recommended_cli_commands`.
- `vibecode_scan_artifact_read` — input `{ run_id?, artifact, byte_offset?,
  max_bytes? }`. `artifact` is an allowlist KEY (enum). Returns the same
  continuation fields as `vibecode_artifact_read` (`relative_path`,
  `byte_offset`, `requested_max_bytes`, `bytes_read`, `total_bytes`, `has_more`,
  `next_byte_offset`, `content_sha256`, `content`) plus the `artifact` key.

Tool count: 34 → **36**.

### CLI commands (chosen shape)

```powershell
vibecode scan summary --run current --sections "files,commands,tests,symbols" --max-items 50 --json
vibecode scan artifact-read --run current --artifact commands --byte-offset 0 --max-bytes 16000 --json
```

These attach as subcommands on the **existing** `vibecode scan` command. The
legacy `vibecode scan "<task>"` form (which runs the scanner) is preserved:
`createCli()` calls `program.enablePositionalOptions()` so the `summary` /
`artifact-read` subcommand names are routed ahead of the positional `<task>`
argument while their `--repo`/`--json` options are scoped to the subcommand
(without the parent greedily consuming them). Any other first token is still
treated as the task to scan. JSON output uses the canonical
`{ ok, data, artifacts, warnings }` envelope; structured errors use
`{ ok: false, error: { code, message, path, details } }`.

### Run selection + continuation

`--run` / `run_id` accept `current`, `latest`, or an explicit run id, with
`current`/`latest` both resolving to the `.vibecode/current` pointer — the same
`normalizeRunSelector` convention shared with Phase 1B-1. Continuation is
identical to `vibecode_artifact_read`: chain `byte_offset = next_byte_offset`
until `has_more=false`; chained chunks reconstruct the exact UTF-8 file, and
`content_sha256` is the full-file hash (stable across chunks).

### Validation and hard caps

- `scan_summary` `max_items`: positive integer, default 50, hard max
  `SCAN_SUMMARY_MAX_ITEMS = 100`. Unknown sections → `INVALID_SECTION` (core) →
  `INVALID_ARGUMENT` (MCP/CLI). Out-of-range `max_items` → `INVALID_MAX_ITEMS` →
  `INVALID_ARGUMENT`.
- `scan_artifact_read` reuses the Phase 1B-1 byte-offset/max-bytes validation:
  default 16000 bytes/chunk, hard max 65536; negative/non-integer offsets and
  zero/negative/over-cap `max_bytes` are rejected; offset beyond EOF →
  `BYTE_OFFSET_OUT_OF_RANGE`; offset exactly at EOF is a valid empty terminal
  read.
- MCP schemas use `additionalProperties: false`; unknown argument keys are
  rejected with `INVALID_ARGUMENT`.

### Missing-scan behavior

A missing `scan/` directory or a missing individual artifact is **not** an error:
`scan_summary` returns ok with `scan_available=false` (or per-section
`available=false`) plus an actionable warning and a recommendation to run a
scan. `scan_artifact_read` of an allowlisted-but-absent artifact returns
`ARTIFACT_NOT_FOUND`. Only an invalid/missing run itself fails the call.

### Security boundaries

No arbitrary file read, no source-file read, no directory listing, no
non-allowlisted scan-file read, no shell exec, no source writes, no git mutation,
and no scanner execution flow through either tool. The scan tool names also pass
the MCP security suite (no `write/shell/git/terminal/commit` patterns).

### Example agent workflow

```text
1. call session_bootstrap (note scan_available)
2. if scan_available=true, call vibecode_scan_summary
3. inspect commands/tests/files/symbols section counts + samples
4. for detail, call vibecode_scan_artifact_read for one allowlisted artifact
5. follow next_byte_offset until has_more=false if the full artifact is needed
```

### Tests proving behavior

- `tests/core/runs/scan_artifacts.test.ts` — allowlist names, available/missing
  listing, JSON/text reads, malformed-JSON tolerance, chunk continuation +
  UTF-8 reconstruction, unknown key / traversal / raw-path / source rejection,
  not-found, offset-beyond-EOF.
- `tests/core/runs/scan_summary.test.ts` — populated sections (files/commands/
  tests/symbols/imports/entrypoints/instructions/tooling/git), no content leak,
  caps/truncation, missing scan dir, missing/malformed artifact degradation,
  unknown section + max_items validation, section de-duplication.
- `tests/app/mcp/scan_tools.test.ts` — structured summary, sections filter,
  missing-scan ok, validation, continuation reconstruction, unknown
  section/artifact/key + bad offset + unknown-field rejection.
- `tests/app/cli/scan_read_commands.test.ts` — JSON envelopes, sections/max-items,
  chunked paging, UTF-8 reconstruction, structured errors, run selectors, CLI/MCP
  field parity, and the legacy `scan <task>` form is not shadowed.
- Lockstep updates: `tool_registry`, `security`, `registry_parity`,
  `workspace_info` group total, `agent_guidance_mcp_tools`, Codex/Claude
  `enabled_tools`, README tool-name contract.

### Known limitations

- Section projections are deterministic field picks from current scanner shapes;
  if the Python scanner renames an artifact or restructures its JSON, the
  allowlist/summarizers must be revisited (a core test pins the real names).
- These tools never run or refresh the scanner; a stale scan stays stale until a
  new `vibecode scan` run.
- No tool profiles, CodeGraph fuzzy resolve, affected-tests, or task-aware
  relevance scoring (deferred).

## 14D. Phase 1B-3 — tool profiles / recommended tool sets (Implemented)

This section records what was actually built to make tool choice easier and
safer by exposing small, deterministic, context-aware recommended tool sets
("tool profiles"). It is the fourth slice of Phase 1 work, shipped after Phase
1B-2, and it also folds in the Phase 1B-2 review follow-ups (below). Where the
implementation differs from the earlier proposal, the implementation wins.

### Purpose

Agents now have 30+ MCP tools and a matching CLI surface. Choosing the right
tool for a situation is itself friction, and friction is what pushes agents back
to raw `rg` / `git`. Tool profiles are **named, deterministic bundles** of the
recommended VibecodeMCP tools and CLI commands for a common agent situation. The
purpose is **not** new power — it is to reduce confusion and raw-shell fallback,
so an agent can ask "what should I use for X?" instead of reasoning over the
whole tool list every time.

### Scope (and explicit non-scope)

In scope: a shared core service for tool profiles, one MCP tool and one CLI
command (MCP/CLI parity), and compact profile recommendations integrated into
`session_bootstrap` and `workspace_info`.

**Profiles are static/deterministic.** NOT in this batch (and deliberately
excluded): LLM-based relevance ranking, automatic task-aware relevance scoring,
bulk claims, an MCP commit tool, subagents/handoff/notice board, UI changes,
hard file locks, full-diff exposure, CodeGraph fuzzy resolve, affected-tests,
automatic scanner runs, and arbitrary scan/file reads. Profiles do not execute
any tool, run the scanner, or mutate anything.

### Shared core service

`src/core/agent_guidance/tool_profiles.ts` is the single source of truth. It
declares the profiles as static data and exposes pure functions:
`listToolProfiles()`, `listToolProfileSummaries()`, `getToolProfile(id)`,
`isToolProfileId(v)`, `toolProfileMcpToolNames()`, and
`recommendBootstrapToolProfiles(ctx)`. It imports nothing from the app layer;
the test suite (not the module) cross-checks every referenced MCP tool name
against the canonical registry so a renamed/removed tool fails CI (no stale tool
names).

Profile DTO (bounded and simple):

```json
{
  "profile_id": "build_pre_edit",
  "title": "Build agent before editing",
  "purpose": "Orient and claim files before modifying anything.",
  "when_to_use": ["..."],
  "mcp_tools": [{ "name": "vibecode_git_changes", "reason": "Check claim-aware dirty state before editing." }],
  "cli_commands": [{ "command": "vibecode git changes --agent <agent_id> --json", "reason": "CLI fallback for claim-aware dirty state." }],
  "next_steps": ["..."],
  "warnings": ["..."]
}
```

### Available profile ids

- `read_only_orientation` — inspect the repo without editing.
- `build_pre_edit` — orient and claim files before editing.
- `build_post_edit` — validate changes and head toward a scoped commit.
- `scan_inspection` — use deterministic scanner intelligence.
- `artifact_continuation` — read large run/scan artifacts fully via continuation.
- `safe_commit` — commit only your claimed files through the CLI guard.
- `conflict_resolution` — inspect/resolve overlapping claims or recorded conflicts.

`conflict_resolution` references the real `vibecode_conflict_resolve` /
`vibecode_conflicts_list` tools (there is no `vibecode_conflict_record` tool, so
the proposal's name was corrected to the existing one). No profile references an
MCP commit tool — commit mutation is CLI-only.

### MCP tool

`vibecode_tool_profile` — input `{ profile? }` (`additionalProperties: false`).

- Omit `profile` → returns `{ mode: "list", profiles: [summary…], count }`
  (compact id/title/purpose summaries).
- Pass a profile id → returns `{ mode: "profile", profile: {…full DTO…} }`.
- Unknown profile id → `INVALID_ARGUMENT`; unknown fields → `INVALID_ARGUMENT`;
  an unexpected internal failure maps to `TOOL_PROFILE_FAILED`.
- Read-only and static: no filesystem reads, no shell, no scanner, no git.

Tool count: 36 → **37**.

### CLI command

```powershell
vibecode tools profile --json                          # list all profiles
vibecode tools profile --profile build_pre_edit --json # one profile
```

`--profile` is optional; omitted returns the profile list. JSON output uses the
canonical envelope `{ ok, data, artifacts, warnings }` with the same `data`
shape as the MCP tool (`mode` + `profiles`/`profile`); an unknown profile returns
the structured error envelope `{ ok:false, error:{ code, message, path, details } }`.
Non-JSON output is a short, readable summary. The new `vibecode tools` namespace
is independent of `vibecode mcp tools` (which lists live MCP tool names); the two
do not collide.

### Integration into existing outputs

- `session_bootstrap` (MCP + CLI) returns a new compact
  `recommended_tool_profiles: [{ profile_id, reason }]` — ids + short reasons,
  NOT full profiles. The mapping is deterministic:
  - not registered / unknown mode → `read_only_orientation`;
  - `read_only` agent → `read_only_orientation`;
  - `build` agent with no claimed dirty files → `build_pre_edit`;
  - `build` agent with claimed dirty files → `build_post_edit` + `safe_commit`;
  - scan available for the current run → add `scan_inspection`;
  - run artifacts available → add `artifact_continuation`;
  - unresolved conflicts / possibly-stale claims → add `conflict_resolution`.
  The list is deduped and bounded; the existing `recommended_next_tools` /
  `recommended_cli_commands` are unchanged.
- `workspace_info` (MCP) adds a compact `tool_profiles` list (summaries only —
  no full tool lists) so an agent can see which profiles exist at orientation
  time.

### CLI-only agents

CLI-only agents call `vibecode tools profile --json` (and
`--profile <id> --json`) to get the same profiles, and read
`recommended_tool_profiles` from `vibecode session bootstrap --json`. Both call
the same shared core service as the MCP surface, so MCP and CLI return identical
profile data.

### Example agent workflow

```text
1. call session_bootstrap → read recommended_tool_profiles (e.g. build_pre_edit)
2. call vibecode_tool_profile { profile: "build_pre_edit" } for the full set
3. use the listed MCP tools (or CLI fallbacks) for that situation
4. after editing, bootstrap now recommends build_post_edit / safe_commit
```

### Relationship to Phase 1A / 1B-1 / 1B-2

Profiles only *reference* the tools those phases shipped: Phase 1A
(`session_bootstrap`, `git_changes`, claims/finalize), Phase 1B-1
(`artifact_read` continuation → `artifact_continuation`), and Phase 1B-2
(`scan_summary` / `scan_artifact_read` → `scan_inspection`). They add no new
capability of their own.

### Phase 1B-2 review follow-ups included in this batch

1. Docs: comma-valued `--sections` examples are quoted
   (`--sections "files,commands,tests,symbols"`) for PowerShell/pnpm reliability.
2. CLI hardening tests: invalid numeric `--max-items` / `--byte-offset` /
   `--max-bytes` are structured `INVALID_ARGUMENT` errors; `--sections` trims
   whitespace and dedupes repeated sections while preserving order; unknown
   sections are rejected.
3. Scan artifact chunk edge tests: empty artifact (content "", total_bytes 0,
   has_more false), artifact exactly equal to chunk size (has_more false), and
   one byte over (has_more true, next read finishes).
4. Symlink availability: `listAllowedScanArtifacts` now uses `lstatSync`, so a
   symlink planted at an allowlisted path is NOT advertised as a normal available
   artifact; the read-time realpath-containment guard remains the authoritative
   security boundary.
5. `SCAN_ARTIFACT_READ_FAILED` is now used as the catch-all error code in the
   `vibecode_scan_artifact_read` handler (no dead error code).

### Known limitations

- Profiles are deterministic/static — no LLM ranking and no automatic
  task-aware relevance scoring.
- No orchestration, no tool execution, no scanner execution — profiles only
  describe which tools to use.
- The recommendation logic is rule-based over coarse context (mode / edit state
  / scan / artifacts / conflicts), not a learned or task-specific ranking.

## 14E. Phase 1B-4 — terminal protocol banner / preflight (Implemented)

This section records what was actually built to make a freshly opened Vibecode
terminal self-guiding. Agents now have good tools and profiles (Phase 1A–1B-3),
but a newly opened terminal still gave a fresh agent no starting protocol. Phase
1B-4 adds a short, static **agent protocol banner** (plus a cheap, read-only
preflight preface) shown once when a new desktop terminal session starts. It is
the fifth slice of Phase 1 work and also folds in the Phase 1B dogfood polish
follow-ups (below). It is **guidance and preflight only — not orchestration.**

### What appears in a new terminal

When the desktop opens a new terminal in a Vibecode repo, the terminal **display**
shows a one-time banner like:

```text
Repo: C:/path/to/repo | current run: yes | coordination: no
Vibecode agent protocol — do this first in a new terminal:
1. Orient: prefer MCP vibecode_session_bootstrap / vibecode_tool_profile; CLI fallback:
   vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json
2. Mode: read_only for research/review, build to edit files.
3. Pick tools by profile (do not guess): vibecode tools profile --json (e.g. --profile build_pre_edit --json).
4. build agents: claim files before editing; run vibecode git changes --agent <agent_id> --json before/after edits.
5. Orient with scan/artifact tools, not raw rg/find or direct .vibecode reads:
   vibecode scan summary --run current --json
   vibecode runs artifact-read --run current --artifact <artifact> --json
6. Before commit: vibecode finalize check --agent <agent_id> --json, then vibecode commit guard.
Do not push unless explicitly asked. (Set VIBECODE_AGENT_BANNER=0 to silence this banner.)
```

The first line is the optional preflight preface; the rest is the static protocol.

### Why it exists

A long, scattered guidance doc loses to familiar shell habits. The banner is the
short, complete, actionable starting protocol the efficiency plan called for
(Problem §8, spec §9 "agent protocol / guidance", Phase 2 "terminal protocol
banner"): it tells a fresh agent the exact first command, distinguishes the MCP
preferred path from the CLI fallback, and points at the safe coordinated path so
the agent does not reach for raw `rg` / `git` / direct `.vibecode` reads.

### MCP preferred path / CLI fallback / first command

- MCP preferred: `vibecode_session_bootstrap`, `vibecode_tool_profile`.
- CLI fallback (every step has one): `vibecode session bootstrap`,
  `vibecode tools profile`, `vibecode git changes`, `vibecode scan summary`,
  `vibecode runs artifact-read`, `vibecode finalize check`, `vibecode commit guard`.
- Exact first command:
  `vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json`.

### read_only vs build / claim-before-edit / finalize+guard / scan-artifact / no-push

- read_only for research/review; build to edit files.
- build agents must claim each file before editing and check
  `vibecode git changes` before/after edits.
- before committing: `vibecode finalize check`, then `vibecode commit guard`
  (commit mutation is CLI-only — there is no MCP commit tool).
- use scan/artifact tools (`scan summary`, `runs artifact-read`) instead of raw
  `rg`/`find` or direct `.vibecode` reads.
- do not push unless explicitly asked.

### Shared core service

`src/core/agent_guidance/terminal_protocol.ts` is the single source of truth:

- `getTerminalAgentProtocolBanner({ preflight? })` — the static, bounded banner
  string (line endings `\n`; the renderer normalizes to `\r\n` for xterm). Every
  `vibecode_*` tool it names is a real registered MCP tool (a test cross-checks
  the canonical registry, so a renamed/removed tool fails CI).
- `getTerminalPreflightSummary(repoRoot)` — cheap, read-only facts gathered with
  `fs.existsSync` only (no git, no scanner, no arbitrary file reads): repo root,
  whether `.vibecode/` is initialized, whether `.vibecode/current/run_manifest.json`
  exists, whether `.vibecode/coordination/state.json` exists, and the recommended
  next command. Never throws.
- `isTerminalAgentBannerEnabled(env)` / `TERMINAL_AGENT_BANNER_ENV` — the opt-out.

### Terminal integration point

The banner is the least-invasive **session-level** banner, not shell echo
injection: `DesktopTerminalService.startSession` attaches the banner string to
the returned session **metadata** (`DesktopTerminalMetadata.banner`). Because the
banner rides with the start metadata, the renderer prints it to the xterm
**display** exactly once when the tile is created — sidestepping any IPC ordering
race and never touching shell stdin. A new `agentBanner` provider option (default
= static banner + cheap preflight, opt-out aware; `null` disables it) mirrors the
existing `terminalPreflight` injection seam.

### Opt-out / noise control

- The banner prints once per new terminal session (it is not part of the
  `terminal:data` stream and never repeats on output refresh).
- `VIBECODE_AGENT_BANNER=0` (also `false`/`off`/`no`, case-insensitive) silences
  it. No persistent user config / settings UI was added in this batch.

### What it is NOT (guarantees)

- It is **guidance only**: it does not register an agent, infer mode, claim
  files, run the scanner, execute any workflow command, or mutate repo/git state.
- It is **not an MCP tool** and adds no MCP tool (tool count unchanged). It only
  points at existing MCP/CLI tools.
- It is **never written into the PTY** (no `pty.write`); the renderer writes it to
  the xterm display only. Tests assert `pty.writes` stays empty.
- It **never pollutes JSON CLI output** — only the interactive desktop terminal
  emits it; no CLI command prints it, and MCP responses are untouched.

### Phase 1B dogfood polish follow-ups (included)

1. **A1 — cross-shell `--sections` quoting.** Comma-valued `--sections` is shown
   as ONE quoted argument (e.g. `--sections "files,commands,tests,symbols"`) in
   the `scan summary` CLI help and the `scan_inspection` tool profile; never quote
   each section separately.
2. **A2 — npm/lockfile speedbump.** `build_pre_edit` and `safe_commit` profiles
   warn that an npm/pnpm/yarn install can modify a lockfile (e.g.
   `package-lock.json`) which then blocks finalize: claim a deliberate lockfile
   change before finalize, or revert an accidental one. (Finalize logic is
   unchanged — no lockfile special-casing, no auto-claim, no ignore.)
3. **A3 — `vibecode tools profile` non-JSON clarity.** The non-JSON list output
   and command help now state that `--json` is the agent-readable form;
   `vibecode tools profile --json` remains canonical and is shown in the banner.

### Tests proving behavior

- `tests/core/agent_guidance/terminal_protocol.test.ts` — banner content (first
  command, MCP-preferred + CLI-fallback names, mode choice, claim-before-edit,
  git changes, finalize/commit guard, scan/artifact, no-push, opt-out env),
  bounded size, no stale/nonexistent tool names, no Phase 2+ features; preflight
  summary (uninitialized vs seeded, never throws); opt-out helper.
- `tests/app/desktop/terminal_banner.test.ts` — banner present once in session
  metadata, never written to the PTY, ordinary output never contains it, opt-out
  via constructor and via `VIBECODE_AGENT_BANNER=0`, custom provider used with
  the cwd, shim/env preparation untouched.
- `tests/core/agent_guidance/tool_profiles.test.ts` /
  `tests/app/cli/tools_commands.test.ts` — A1 quoted `--sections`, A2 lockfile
  warnings, A3 non-JSON `--json` steering.

### Known limitations

- The banner does not register agents automatically, does not infer mode, does
  not run the scanner, does not orchestrate work, and does not execute tools —
  it is guidance only.
- The preflight preface uses only cheap `fs.existsSync` checks; it does not read
  git branch/head, run the scanner, or read artifacts.
- The banner integration is desktop-terminal-only; the standalone `vibecode
  terminal demo` and non-desktop CLI flows do not print it.

## 14F. Phase 2A — agent-declared work scope / explicit bulk claims (Implemented)

This section records what was built so a build agent can declare an initial work
scope and claim multiple explicit paths safely as one intentional unit, instead
of claiming files one-by-one.

### Key principle

**Vibecode does NOT decide which files an agent needs.** The agent researches the
task, understands the likely implementation scope, and explicitly declares the
exact paths it wants to claim. Vibecode's role is only to: validate the declared
paths, detect conflicts, apply the claims safely (atomically), make the declared
work scope visible to other agents, allow the agent to extend that scope later
with more explicit paths, and preserve finalize/commit safety. This is **not**
automatic claiming, task-to-files inference, LLM relevance scoring, glob/wildcard
expansion, directory claims, or scanner-based auto-claim.

### MCP tools

- `vibecode_claims_plan` — read-only. Input `{ agent_id, paths[], intent? }`
  (`additionalProperties: false`). Classifies each explicit path and reports
  whether the whole set can be claimed atomically. Never mutates state, never
  suggests paths the agent did not supply.
- `vibecode_claims_add_bulk` — mutating. Input
  `{ agent_id, paths[], intent?, intent_id? }`. Claims the explicit paths as one
  atomic work intent. A conflict is returned as `ok=true` with
  `status: "blocked"` (no claims created), mirroring `finalize_check`; only
  invocation/validation problems are MCP errors.

Tool count: 37 → **39** (the canonical `VIBECODE_MCP_TOOL_NAMES` registry length
after these two additions). Both write only generated
`.vibecode/coordination/state.json` (plan writes nothing); neither touches source
files, the shell, git, or the terminal, and neither infers or expands paths. The
two tools were added to the canonical registry, schemas, MCP error codes,
`workspace_info` coordination group, the Agent Guidance Settings group, and the
Codex/Claude `enabled_tools` lists in lockstep.

### CLI commands

```powershell
vibecode claims plan --agent <agent_id> --path src/a.ts --path tests/a.test.ts --json
vibecode claims add-bulk --agent <agent_id> --intent "add alpha feature" --path src/a.ts --path tests/a.test.ts --json
vibecode claims add-bulk --agent <agent_id> --intent-id <intent_id> --path package-lock.json --json
```

`--path` is repeatable; both surfaces call the same shared core services
(`core/coordination/claim_planning` / `bulk_claims`) so MCP and CLI return
equivalent data. A blocked bulk claim is reported as a valid `ok:true` envelope
with `data.status="blocked"` (exit 0), mirroring finalize.

### Per-path classification

The shared evaluator (`evaluateClaimPaths`) dedupes normalized paths (first wins)
and classifies each: `claimable`, `missing` (claimable; file does not exist yet),
`already_claimed_by_agent` (idempotent — no new claim), `stale_claim_overlap`
(claimable; only a stale claim overlaps), `claimed_by_other_active_agent`
(blocking), `generated_or_ignored` (blocking; `node_modules`/`.codegraph`),
`directory_not_supported` (blocking; the path is an existing directory), and
`invalid` (blocking; traversal, absolute, `.vibecode`/`.git`, empty). The same
evaluator powers both `plan` (preview) and `add_bulk` (apply) so they can never
disagree.

### Atomicity

Bulk claim evaluates the whole set first. If ANY requested path is blocking, NO
new claims are created. A coordination conflict is recorded ONLY when the block
is another agent's active claim; local validation blocks (directories,
generated/ignored, invalid paths) record no conflict and create no intent. On
success, all new claims, the agent's claim list, and the intent are written in a
SINGLE `writeCoordinationState` call.

### Exact file paths only — directories rejected (blocker fix)

A claim authorizes a path and, via prefix overlap, every descendant under it.
Claiming a directory like `src` would silently authorize `src/a.ts`, `src/b.ts`,
and every other descendant the agent never declared — exactly what the exact-path
principle forbids. So an existing directory is rejected everywhere: the evaluator
classifies it `directory_not_supported` (blocking) for plan/add-bulk, and the
single-file `addFileClaim` (MCP `vibecode_claim_add` / CLI `vibecode claims add`)
throws `DIRECTORY_CLAIM_NOT_ALLOWED` (mapped to `INVALID_ARGUMENT` over MCP).
Directory rejection happens before any state mutation, so a directory never
creates a claim, an intent, or a conflict. (Non-existent paths that later become
directories are out of scope; the check targets EXISTING directories at claim
time, matching the prefix-overlap risk.)

### Valid build session required (blocker fix)

Planning or claiming requires a VALID build session, not merely
`operating_mode=build`: the agent must also have a non-empty `task` (the same
contract Phase 1A bootstrap / finalize / commit guard enforce). The single source
of truth is `requireBuildAgent`, now strengthened to throw `INVALID_AGENT_SESSION`
when a build agent has no task (and still `INVALID_AGENT_MODE` for legacy/no-mode,
`READ_ONLY_AGENT` for read_only). `resolveBuildClaimAgent` (plan/bulk) and
`addFileClaim` (single claim) both gate through it, so a build/no-task agent
cannot plan, bulk-claim, or single-claim.

### Claim intent metadata

A new `ClaimIntent` (`intent_id`, `agent_id`, `intent`, `status`, `created_at`,
`updated_at`, `claim_ids[]`, `paths[]`) is stored in a new additive `intents[]`
array on the coordination state (older state files normalize to `[]`). Each
bulk-created claim also carries `{ intent_id, intent }` in its metadata, so the
existing finalize/commit guard (which only read `claim.path`) work unchanged and
bulk claims appear in the normal claims list. Intents belong to exactly one
agent; intent text is required and trimmed when creating a new intent.

### Extending an existing intent (Part D behavior)

Pass `intent_id` to extend an intent you own with new explicit paths (validated
to exist, belong to you, and that you are still a valid build session — mode=build
and a non-empty task; new paths are atomic and de-duplicated). If both `intent`
and `intent_id` are supplied, `intent_id` wins (the existing intent's text is
kept; the passed `intent` text is ignored). If only `intent` text is supplied (no
`intent_id`), a **new** intent is always created — extension requires the explicit
`intent_id` (deterministic and documented).

### Integration

- `session_bootstrap` (MCP + CLI) adds a compact `active_work_intents` summary
  (`intent_id`, `intent`, `claim_count`, `sample_paths`, bounded by `max_items`)
  for build agents with active intents; build recommendations now point at
  `claims plan` / `claims add-bulk` (with `claim_add` as the single-file fallback).
- The `build_pre_edit` tool profile now prefers inspect → plan explicit claims →
  add-bulk explicit claims → edit only claimed files; `build_post_edit` notes
  that a finalize block on an unclaimed file should be claimed explicitly (or
  reverted if accidental).

### Known limitations

- No automatic file selection, task-to-files inference, or LLM relevance scoring.
- No glob/wildcard expansion, no directory claims, no scanner-based suggestions.
- No automatic lockfile/test-file claims (the agent declares them explicitly).
- No release-by-intent / auto-release / auto-merge / auto-resolve, no MCP commit,
  no handoff, no orchestration, no full-diff exposure, no affected-tests inference.

### Phase 2B — claim intent lifecycle and release-by-intent

Status: **implemented, hardened, and dogfooded (MCP-first, 2026-06-10); closed.**

Goal: once an agent can create and extend a work intent, it must be able to see
its active intents, inspect which claims belong to each, and safely release all
claims for a completed or abandoned intent. Release is blocked when any claimed
path is still dirty in the working tree.

#### What was built

Core:

- `src/core/coordination/intent_lifecycle.ts` — `listClaimIntentsDetail`
  (read-only intent listing with claim detail) and `releaseClaimIntent`
  (dry-run + mutation, dirty-file safety).

MCP tools:

- `vibecode_claim_intents_list` — read-only; lists the agent's work intents
  with active/released claim counts, paths, timestamps. Filter by `agent_id`,
  `status` (`active` / `released` / `all`), or `intent_id`.
- `vibecode_claim_intent_release` — releases all active claims belonging to a
  work intent. Same-agent only. Blocked when claimed files are dirty. Supports
  `dry_run: true`.

CLI commands:

- `vibecode claims intents list --agent <id> [--status active|released|all] [--intent-id <id>] --json`
- `vibecode claims intent-release --agent <id> --intent-id <id> [--dry-run] --json`

#### Release semantics

- Same-agent only: only the owning agent may release an intent. A defensive
  ownership filter additionally guarantees that a (hand-edited/inconsistent)
  intent referencing another agent's claim never releases that claim — it is
  skipped and surfaced as a warning.
- Dirty-file safety: if any currently-claimed path in the intent is dirty in the
  working tree, release is blocked (`release_allowed: false`,
  `blocked_reason: dirty_claimed_files`). Zero claims are released. The agent
  should commit through `vibecode commit guard` or revert changes, then retry.
- Fail-closed without git: if git changed-file detection is unavailable (not a
  git repository, git missing/failing), the dirty state of the claimed paths is
  unknown and release is blocked (`release_allowed: false`,
  `blocked_reason: git_unavailable`). Unknown dirty state never authorizes a
  release.
- Atomic: either all active claims in the intent are released, or none are. A
  clean release updates the claims, the agent's claim list, and the intent
  status in ONE coordination state write (no transient partial state).
- Idempotent: releasing an already-released intent returns `already_released`.
- The intent record is never deleted; it is marked `released` with
  `released_at` and `released_by_agent_id`.
- No auto-release, no force release, no source mutation, no git mutation.

#### Intent status model

- `active` — intent has active claims.
- `released` — intent's claims have been released by the owning agent.

#### Integration points

- Bootstrap: recommends intent release only when a build agent has active
  intents AND the tree is clean for that agent — zero dirty claimed files and
  zero unclaimed dirty files (i.e. only when release can actually succeed).
- Tool profiles: `build_post_edit` and `safe_commit` include intent release
  guidance.
- Existing single-claim release and reap behavior still works alongside intent
  release.

#### MCP tool count

After Phase 2B: **41 tools** (was 39 after Phase 2A).

#### Known limitations

- No auto-release after commit.
- No force release of dirty files.
- No handoff between agents.
- No orchestration or subagents.

## 14G. Phase 2C — agent lifecycle heartbeat and stale coordination housekeeping (Implemented)

This section records what was built to improve the lifecycle around active
agents, stale agents, stale claims, and active work intents. It is **still
coordination and guidance — not orchestration**: Vibecode surfaces stale
coordination state and provides explicit safe commands; it never cleans up
another agent's work, never auto-releases, never auto-reaps, and never
transfers ownership.

### Motivation (from the Phase 2A/2B dogfoods)

- Long sessions suffered heartbeat staleness: an agent had no small explicit
  way to stay fresh without re-bootstrapping.
- Old stale claims from dead agents were visible in bootstrap but only as
  noise — bootstrap did not explain them or recommend the right cleanup
  commands.
- Active intents could be owned by stale/terminated/missing agents (or have
  zero active claims left) with no visibility into that state.

### Part A — explicit agent heartbeat (existing tool reused + hardened)

**No new MCP tool was added.** The existing `vibecode_agent_heartbeat` MCP tool
and `vibecode agents heartbeat --agent <agent_id> --json` CLI command (Phase
Coordination-2) are the explicit heartbeat path; Phase 2C hardened them:

- Core `heartbeatAgentDetailed` (new, in `core/coordination/agents.ts`) is the
  single source of truth; `heartbeatAgent` is a thin wrapper over it. Both the
  MCP tool and the CLI command call it, so MCP/CLI stay in parity.
- A **terminated agent is blocked** with `AGENT_TERMINATED` (new core
  `CoordinationError` code, mapped to the existing MCP `AGENT_TERMINATED`
  error and the CLI structured-error envelope). The message instructs
  registering a new agent. Previously a terminated session would have been
  silently revived.
- A missing agent stays a structured `AGENT_NOT_FOUND` error (never an
  implicit registration).
- Heartbeat changes ONLY `last_heartbeat_at` and `status` — mode/task
  metadata, claims, intents, conflicts, and identity fields are untouched
  (tested). The MCP schema accepts only `agent_id`; mode/task fields are
  rejected as unknown keys.
- `read_only` and `build` agents can both heartbeat; legacy/no-mode sessions
  follow the existing lifecycle semantics (heartbeat does not validate mode).
- Output now includes `was_stale`, `previous_status`, and `heartbeat_at`; a
  revived (`was_stale: true`) agent is recommended `vibecode_session_bootstrap`
  to re-orient.
- No background heartbeat daemon or worker was introduced — heartbeat remains
  an explicit agent action.

### Part B — bootstrap `stale_coordination` summary

`session_bootstrap` (MCP + CLI) returns a new bounded, read-only
`stale_coordination` section built by the new core module
`core/coordination/stale_coordination.ts` (`summarizeStaleCoordination`):

```json
{
  "has_stale_state": true,
  "stale_agents_count": 1,
  "stale_active_claims_count": 3,
  "active_intents_owned_by_stale_agents_count": 1,
  "active_intents_owned_by_terminated_agents_count": 0,
  "active_intents_owned_by_missing_agents_count": 0,
  "active_intents_with_no_active_claims_count": 0,
  "samples": {
    "stale_agents": [],
    "stale_claims": [],
    "stale_intents": [],
    "intents_with_no_active_claims": []
  },
  "samples_truncated": false,
  "recommended_cli_commands": [
    "vibecode claims list --json",
    "vibecode claims reap --dry-run --json",
    "vibecode agents heartbeat --agent <agent_id> --json",
    "vibecode claims intents list --agent <agent_id> --status active --json"
  ]
}
```

Guarantees:

- Counts are computed over ALL agents/claims/intents; only the `samples` lists
  are capped (by `max_items`), with `samples_truncated` set when capped. No
  count is ever derived from a capped sample.
- "Stale active claim" = claim with computed status `stale` (persisted active,
  owner stale/terminated). Intent owner statuses distinguish
  `active` / `stale` / `terminated` / `missing` (missing = inconsistent state;
  `unknown` heartbeats are treated as stale).
- When nothing is stale, the section is compact (zeros, empty samples, no
  recommended commands) and bootstrap stays quiet.
- When stale state exists, bootstrap adds ONE bounded
  `STALE_COORDINATION_STATE` warning, appends the explicit housekeeping
  commands to `recommended_cli_commands`, appends
  `vibecode_claims_list` / `vibecode_claims_reap` (and
  `vibecode_agent_heartbeat` for a registered agent) to
  `recommended_next_tools`, and recommends the `coordination_housekeeping`
  tool profile.
- The summary is read-only: no reap, no release, no force release, no
  ownership transfer, no git/scanner/source access. It never recommends an
  `intent-release` for stale state (release is same-agent only) and never
  implies one agent may release another agent's active intent.

### Part C — intent list owner/claim lifecycle visibility

`listClaimIntentsDetail` (→ MCP `vibecode_claim_intents_list`, CLI
`vibecode claims intents list`) gained per-intent lifecycle fields:

- `owning_agent_status`: `active` | `stale` | `terminated` | `missing`
  (computed stale-aware; shared mapping with the bootstrap summary).
- `missing_claim_count`: referenced claim ids that do not exist in state.
- `warning_codes` (advisory only — nothing triggers automatic cleanup):
  `INTENT_OWNER_STALE`, `INTENT_OWNER_TERMINATED`, `INTENT_OWNER_MISSING`,
  `INTENT_HAS_NO_ACTIVE_CLAIMS` (active intents only — released intents
  naturally have no active claims), `INTENT_REFERENCES_MISSING_CLAIMS`.
- The existing `active_claim_count` / `released_claim_count`, bounded
  `sample_paths`, default released-intent exclusion, and Phase 2B list
  semantics are unchanged. **No `--owner-status` filter was added** —
  per the plan, visibility beats over-filtering and the extra filter would
  only add validation noise.

### Part D — `coordination_housekeeping` tool profile

A new static deterministic profile (Phase 1B-3 framework; profile count 7 → 8)
guiding agents when bootstrap reports stale coordination state:

- heartbeat your OWN agent during long work
  (`vibecode agents heartbeat --agent <agent_id> --json`);
- inspect intents/claims (`claims intents list`, `claims list`);
- dry-run then explicitly apply stale-claim reap
  (`vibecode claims reap --dry-run --json`, then `--json`);
- release by intent ONLY for your own clean intents (dry-run first).

Profile warnings: never release another agent's intent; no force/automatic
cleanup exists; do not edit unclaimed files; never hand-edit
`.vibecode/coordination/state.json`; use the CLI fallback when MCP is
unavailable. The profile-vs-registry test cross-checks every referenced MCP
tool name, and `workspace_info` / `vibecode tools profile` pick the new
profile up automatically. `recommendBootstrapToolProfiles` gained a
`hasStaleCoordination` context flag.

### MCP tool count

**Unchanged: 41.** Phase 2C reused the existing heartbeat tool, so no
registry/schema/config/docs lockstep lists changed.

### Example workflow

```powershell
# during a long agent session
vibecode agents heartbeat --agent <agent_id> --json

# when bootstrap reports stale coordination noise
vibecode tools profile --profile coordination_housekeeping --json
vibecode claims intents list --agent <agent_id> --status active --json
vibecode claims list --json
vibecode claims reap --dry-run --json
```

### Tests proving behavior

- `tests/core/coordination/agents.test.ts` — terminated heartbeat blocked +
  zero mutation, heartbeat-only field changes (metadata/claims untouched),
  state arrays untouched, read_only + build both heartbeat,
  `heartbeatAgentDetailed` was_stale/previous_status, missing agent.
- `tests/app/mcp/agent_tools.test.ts` / `tests/app/cli/agents_commands.test.ts`
  — was_stale/heartbeat_at in output, AGENT_TERMINATED mapping, missing agent,
  unknown-field rejection (no mode/task change through heartbeat), no metadata
  drift.
- `tests/core/coordination/stale_coordination.test.ts` — owner-status mapping,
  full-count vs capped-sample boundedness, terminated/missing separation,
  claimless active intents, released intents ignored, no cross-agent release
  recommendation, no heartbeat recommendation without a current agent.
- `tests/core/agent_session/bootstrap_stale_coordination.test.ts` — compact
  clean bootstrap, stale agent/claim/intent summary + STALE_COORDINATION_STATE
  warning + housekeeping profile recommendation, terminated vs stale owners,
  own claimless intent surfaced, bootstrap never releases another agent's
  intent (and same-agent release stays enforced), long-session heartbeat
  revival leaves claims/intents unchanged.
- `tests/core/coordination/intent_lifecycle.test.ts` — owner status
  active/stale/terminated/missing, claimless-active warning, released intents
  not warned, missing claim refs counted + warned.
- `tests/app/mcp/claim_intent_lifecycle_tools.test.ts` /
  `tests/app/cli/claim_intent_lifecycle_commands.test.ts` — owner lifecycle
  fields over MCP/CLI, terminated owner surfaced.
- `tests/core/agent_guidance/tool_profiles.test.ts` — coordination_housekeeping
  exists, references real tools/commands, warns against cross-agent release /
  force cleanup / raw state edits, recommendation flag.
- `tests/app/mcp/session_bootstrap_tool.test.ts` — stale_coordination over MCP.

### Known limitations

- No background heartbeat daemon or worker — heartbeat is an explicit call.
- No orchestration, no handoff, no ownership transfer, no notice board.
- No auto-release, no auto-reap, no force release — claim reap remains an
  explicit, dry-run-first command.
- Cross-process coordination state write races are unchanged (last write
  wins on `state.json`).
- Stale detection still derives purely from the 5-minute heartbeat TTL.

## 14H. Phase 2D — intent-aware conflict triage: dogfood follow-ups (Implemented)

Phase 2D shipped intent-aware conflict triage (`core/coordination/conflict_triage.ts`,
MCP `vibecode_conflict_detail` + CLI `vibecode conflicts detail`, bootstrap triage
counts; tool count 41 → **42**). The Phase 2D dogfood passed and surfaced three
small polish items, implemented as this follow-up batch. **No new tools — the
count stays 42**, and no orchestration / handoff / ownership transfer / auto
cleanup / auto release was added.

1. **MCP server identity for stale-session detection.** During the dogfood a
   live MCP server session was stale: it exposed 41 tools and lacked
   `vibecode_conflict_detail` while the current build had 42.
   `vibecode_workspace_info` and `vibecode_session_bootstrap` now return a
   compact, bounded `server_identity` block (`src/app/mcp/server_identity.ts`):
   `server_name`, `server_version`, `tool_count` (derived from the canonical
   `VIBECODE_MCP_TOOL_NAMES` registry of the RUNNING build), `started_at`
   (captured at server start), and `repo_root`. An agent compares the reported
   `tool_count` against the current build (`vibecode mcp tools`, docs) and
   restarts/reconnects the MCP server when tools are missing. Constants only —
   no git, scanner, or filesystem work in the hot path; no mismatch warning is
   emitted because the server alone cannot reliably know the expected build.
   The MCP-layer wrapper adds the block; the shared core bootstrap result and
   the CLI `vibecode session bootstrap` output are unchanged.
2. **CLI conflict detail requester context.**
   `vibecode conflicts detail --conflict-id <id> [--agent <agent_id>] --json`
   accepts the optional requesting agent id and passes it as `currentAgentId`
   to the same core triage service MCP uses. A cleared / no-longer-blocking
   conflict then recommends requester-specific `claims plan` /
   `claims add-bulk` follow-ups with the real agent id (and the agent's own
   intent list for its own cleared conflicts). Without `--agent` behavior is
   unchanged; the option is advisory and read-only — no permission widening, no
   mutation, no conflict resolution, no claim create/release. MCP
   `vibecode_conflict_detail` is unchanged.
3. **Min-age grace for `POSSIBLY_STALE_ACTIVE_CLAIMS`.** A seconds-old active
   claim by another agent on a clean file is normal "claimed, not yet edited"
   state, not staleness. Bootstrap now flags clean-file other-agent claims only
   when older than `POSSIBLY_STALE_ACTIVE_CLAIM_MIN_AGE_MS` (2 minutes, named
   constant in `core/agent_session/bootstrap.ts`; unparseable `created_at`
   fails toward warning). The grace applies ONLY to this advisory warning:
   conflict triage still reports `still_blocking` immediately, dirty/unclaimed
   safety warnings are untouched, claim authorization is unchanged, and
   stale-agent TTL semantics are unchanged.

Tests: `tests/app/mcp/workspace_tools.test.ts` /
`tests/app/mcp/session_bootstrap_tool.test.ts` (server_identity shape, canonical
tool count, stability), `tests/app/cli/conflicts_commands.test.ts` (`--agent`
requester recommendations, no-agent parity, unknown agent stays advisory),
`tests/core/agent_session/bootstrap.test.ts` /
`bootstrap_tool_profiles.test.ts` (grace period quiet/fires, dirty-file and
conflict paths unaffected).

## 14I. Phase 3A — shared-tree commit isolation (Implemented)

Trigger (dogfood finding): during the Phase 2D follow-up commit another agent
had unrelated WIP in the same working tree. `vibecode commit guard` hard-blocked
with `FINALIZE_CHECK_BLOCKED` because unclaimed dirty files existed — even
though the agent had claimed every file it intended to commit and the guard
would have staged only those claimed files. The agent had to bypass the guard
with explicit-path `git add`, which is exactly what the guard exists to prevent.

Phase 3A makes the commit guard support **safe isolated commits in a dirty
shared tree**. Core principle: the guard only ever stages and commits files
claimed by the current agent; it never stages, commits, cleans, reverts,
claims, releases, reaps, or modifies unrelated dirty files. It may proceed when
unrelated unclaimed dirty files exist only if they are safely skipped and
clearly reported. This is commit isolation — not cleanup, not orchestration.

Isolated-commit policy (implemented in
`src/core/coordination/commit_guard.ts`; **no new files, no new MCP tool, tool
count stays 42**):

- `vibecode finalize check` is **unchanged and stays conservative**: every
  unclaimed dirty file is still reported as an `UNCLAIMED_CHANGED_FILE` blocker
  for general readiness, and `vibecode git changes` still classifies them as
  `unclaimed`.
- The guard proceeds past a blocked finalize ONLY when ALL of the following
  hold:
  1. every finalize blocker is a per-path `UNCLAIMED_CHANGED_FILE` (any other
     blocker — agent/run resolution, `GIT_CHANGED_FILES_FAILED`, read-only or
     invalid session — keeps the hard `FINALIZE_CHECK_BLOCKED` behavior;
     uncertainty never authorizes a commit);
  2. the agent has at least one committable `claimed_by_agent` changed file
     (otherwise `FINALIZE_CHECK_BLOCKED` as before);
  3. no unclaimed dirty file is already staged — otherwise the guard blocks
     with the new `STAGED_UNCLAIMED_FILES_BLOCKED` code and never unstages or
     touches the file.
- When it proceeds, the result carries `isolated_commit: true`, the unclaimed
  files appear in `skipped_files` (reason `unclaimed`), and a high-visibility
  `UNCLAIMED_DIRTY_FILES_SKIPPED` warning lists the skipped paths. Dry-run and
  real commit behave identically except for mutation.
- Staged-file safety is unchanged underneath: the guard still verifies the
  index at entry (`GIT_INDEX_NOT_CLEAN` for any staged file outside the
  committable set, including other-agent claimed and generated paths), verifies
  the staged set after staging, and stages only an explicit
  `:(literal)` pathspec allowlist of the agent's claimed files. A pre-staged
  current-agent claimed file in the commit set remains allowed.
- The commit leaves skipped files dirty and byte-identical; the tree may remain
  dirty after a successful guarded commit, but only due to skipped files.
- Unclaimed files cannot overlap the agent's claim scope by construction: the
  shared `classifyChangedPath` primitive classifies any path overlapping the
  agent's active claims as `claimed_by_agent`, so `unclaimed` is always outside
  the agent's claimed paths.

Out of scope, confirmed not added: auto-claim, auto-reap, auto-release,
auto-resolve, force cleanup, ownership transfer, handoff, branch management,
background workers, UI, directory/glob claims, MCP commit mutation, and any
git mutation beyond the existing explicit commit-guard staging/commit.

Surface changes:

- `CommitGuardResult` gains `isolated_commit: boolean`; new issue codes
  `STAGED_UNCLAIMED_FILES_BLOCKED` (block) and `UNCLAIMED_DIRTY_FILES_SKIPPED`
  (warning). CLI human output prints the isolated marker, skipped files, and
  warnings; `--json` carries them in the existing envelope.
- Tool profiles: `safe_commit` and `build_post_edit` now explain isolated
  commits, skipped-file warnings, staged-unclaimed blocks (unstage/review,
  never commit), and that bypassing the guard requires explicit human
  direction.

Tests: `tests/core/coordination/commit_guard.test.ts` (isolated dry-run/commit
dogfood scenario, multi-file isolation, other-agent skip, staged-unclaimed and
staged-other-agent blocks, pre-staged own file allowed, released claim no
longer authorizes, non-git fail-closed, normal commit reports
`isolated_commit: false`), `tests/app/cli/commit_commands.test.ts` (isolated
dry-run/commit envelopes, `STAGED_UNCLAIMED_FILES_BLOCKED`, human output), and
`tests/core/agent_guidance/tool_profiles.test.ts` (Phase 3A guidance).

## 14J. Phase 3B — agent runtime awareness and preflight reliability (Implemented)

Trigger (dogfood findings): a live MCP server can be stale relative to the
current code; long-running tests make an agent heartbeat go stale; shared trees
contain unrelated WIP; and agents could not tell, before acting, whether the
commit guard would isolate a commit or hard-block. Bootstrap returned lots of
useful data but no compact answer to "can I safely edit / finalize / commit
right now, and what exactly should I run next?".

Phase 3B adds a single read-only preflight surface. **No new MCP tool; the tool
count stays 42.** Bootstrap and workspace_info are the carriers:

- New shared core service `src/core/agent_session/runtime_awareness.ts`
  (`getAgentRuntimeAwareness`). Pure function over already-loaded data: no
  filesystem, no git, no scanner, no writes, and no heartbeat/claim/release/
  reap/resolve mutation. Bounded output (fixed sections, task text capped at
  200 chars, recommendation lists deduped and capped at 12).
- `SessionBootstrapResult` gains a `runtime_awareness` section, returned by
  both MCP `vibecode_session_bootstrap` and CLI `vibecode session bootstrap`
  (same core service — full parity except the `server` block below). Sections:
  - `agent` — registered, lifecycle status (active/idle/stale/terminated),
    operating mode, bounded task, `heartbeat_age_ms` / `heartbeat_ttl_ms`, and
    `needs_heartbeat` (recommended after half the TTL; computed only — the
    preflight never heartbeats by itself);
  - `server` — the LIVE MCP server identity (reuses the Phase 2D follow-up
    `server_identity`: name, version, canonical `tool_count`, `started_at`,
    repo root). Filled by the MCP adapter only; the core/CLI value is `null`
    because the CLI always runs the current build. A `tool_count` differing
    from `vibecode mcp tools --json` on the current build means the MCP server
    session is stale — restart/reconnect it or use the CLI fallback;
  - `workspace` — git availability (fails closed when git status is
    unreadable), dirty flag, `shared_tree_dirty`, and full-tree claim-aware
    counts including the new `staged_unclaimed` count (see below);
  - `commit_guard` — `can_edit` (valid fresh build session), `finalize_ready`
    (finalize stays conservative and is NOT weakened: any unclaimed or
    stale-overlap dirty file blocks readiness), `commit_guard_ready`,
    `isolated_commit_possible` (Phase 3A policy mirrored: claimed files
    committable, finalize blocked only by unclaimed dirty files, none staged),
    `staged_unclaimed_blockers`, and `committable_count`. The distinction is
    explicit: finalize readiness may be blocked while the guard can still make
    an isolated claimed-files-only commit; skipped unclaimed files stay dirty
    and are never declared "safe";
  - `coordination` — own active intents, releasable intents (clean-tree
    condition), conflicts involving the agent (from Phase 2D triage, total and
    still-blocking), and stale coordination presence (Phase 2C summary);
  - `recommended_next_tools` / `recommended_cli_commands` — exact, safe,
    state-dependent next commands (register / heartbeat+re-bootstrap / claims
    plan via `build_pre_edit` / git changes + finalize check + commit guard
    dry-run / own-intent dry-run release / conflict_resolution /
    coordination_housekeeping). Never raw `git add/commit`, never a cross-agent
    release, never a force cleanup, never `.vibecode` editing;
  - `warnings` / `blockers` — e.g. `AGENT_STALE`, `HEARTBEAT_RECOMMENDED`,
    `ISOLATED_COMMIT_LIKELY`, `STAGED_UNCLAIMED_FILES_PRESENT`,
    `GIT_UNAVAILABLE` (fail closed), `AGENT_TERMINATED` / `AGENT_NOT_FOUND` /
    `INVALID_AGENT_SESSION` (block).
- `GitChangesSummaryCounts` gains `staged_unclaimed`: full-tree count of
  unclaimed/stale-overlap changed files already staged in the git index (these
  hard-block the commit guard with `STAGED_UNCLAIMED_FILES_BLOCKED`). Counts
  are computed over ALL changed files, never the capped sample.
- New tool profile `runtime_preflight` (profiles 8→9; static, deterministic,
  listed automatically by `vibecode_workspace_info`): teaches bootstrap/
  preflight at start, heartbeat during long work, the stale-MCP-server check
  (live `tool_count` vs `vibecode mcp tools --json`), the CLI fallback, and the
  commit-guard dry-run preview. `vibecode_workspace_info` itself is unchanged —
  it already exposes `server_identity` and the profile list.
- Fix: the bootstrap read_only recommendation previously pointed at a
  nonexistent `vibecode workspace info` CLI command; it now recommends the real
  `vibecode tools profile --profile read_only_orientation --json`.
- MCP/CLI text output gains one `preflight:` line (can_edit / finalize_ready /
  commit_guard_ready / isolated_commit_possible / needs_heartbeat).

How agents handle the dogfood failure modes:

- **Stale MCP server**: compare `runtime_awareness.server.tool_count` (or
  `server_identity`) with the current build's `vibecode mcp tools --json`;
  on drift, restart/reconnect the MCP server or use the CLI fallback.
- **Stale heartbeat/session**: `needs_heartbeat` fires after half the TTL;
  a stale agent gets `AGENT_STALE` plus exact heartbeat / re-bootstrap
  commands; a terminated agent is blocked and told to register a new agent.
- **Shared dirty tree**: `shared_tree_dirty` plus per-classification counts
  say whose the dirty files are; unclaimed dirty files are never hidden and
  never committed; staged unclaimed files block.

Out of scope, confirmed not added: auto-orchestration, handoff, ownership
transfer, branch management, auto cleanup/release/reap/resolve, force cleanup,
background heartbeat daemon/worker, UI, automatic file selection,
scanner-based suggestions, LLM relevance scoring, directory/glob claims, MCP
commit tool. Conflict records remain advisory, not authoritative commit
blockers.

Tests: `tests/core/agent_session/runtime_awareness.test.ts` (pure lifecycle /
shared-tree readiness / coordination / safe-recommendation matrix),
`tests/core/agent_session/bootstrap_runtime_awareness.test.ts` (real-tree
integration incl. staged-unclaimed and isolated-commit scenarios),
`tests/core/workspace/git_changes_summary.test.ts` (`staged_unclaimed`),
`tests/app/mcp/session_bootstrap_tool.test.ts` (MCP fills the `server`
section; agreement with `server_identity`),
`tests/app/cli/session_git_changes_commands.test.ts` (CLI carries the
preflight with `server: null`; CLI/MCP structural parity), and
`tests/core/agent_guidance/tool_profiles.test.ts` (`runtime_preflight`).

## 14K. Phase 3C — session continuity and safe recovery guidance (Implemented)

Trigger: an agent resuming after an interruption (model crash, MCP server
restart, long test run, stale heartbeat, half-finished workflow) had all the
Phase 3B preflight data but still had to derive its own answer to "should I
continue, heartbeat, commit, release, re-plan, re-register, or stop?". Phase 3C
adds that answer as a compact classification. **No new MCP tool; the tool count
stays 42.** Profiles grow 9→10 (`session_recovery`).

- New pure core module `src/core/agent_session/recovery_guidance.ts`
  (`getAgentRecoveryGuidance`): consumes the already-computed runtime awareness
  (plus the agent's own active-claim count) — no filesystem, no git, no writes,
  no mutation. `getAgentRuntimeAwareness` embeds its result as
  `runtime_awareness.recovery` in both MCP `vibecode_session_bootstrap` and CLI
  `vibecode session bootstrap` (full parity; the `server` block remains the
  only MCP-filled section).
- One primary `resume_state` (canonical order):
  `not_registered` (no/missing agent → register; old claims grant nothing),
  `terminated` (blocked; register a NEW agent; never heartbeat/reuse),
  `stale_needs_heartbeat` (heartbeat, then re-run session bootstrap),
  `read_only_observe_only` (observe only; no claim/edit/commit guidance),
  `ready_to_claim` (active build agent, no active claims/intents — re-plan and
  claim explicit files; this is also the released-claims case: a released claim
  never authorizes resuming an edit),
  `ready_to_continue` (own claims/intents still active, nothing committable),
  `ready_to_commit` (dirty claimed files, finalize-ready → git changes,
  finalize check, commit guard dry-run),
  `isolated_commit_possible` (claimed files committable, finalize blocked only
  by unrelated unstaged unclaimed dirty files — guard dry-run with explicit
  warning; skipped files stay untouched and are never called safe; confidence
  `medium`),
  `blocked_by_staged_unclaimed` (staged unclaimed file(s) — inspect/unstage
  yourself; never raw git commit, never auto-unstage),
  `ready_to_release` (own clean intent releasable — dry-run first; own intents
  only, never another agent's),
  `blocked_by_conflict` (still-blocking conflict involving the agent →
  conflict_resolution profile; no auto-resolve),
  `uncertain_state` (git unavailable / invalid session metadata / ambiguous —
  fail safe: inspect-only guidance, never commit/release/cleanup; confidence
  `low`).
- Secondary conditions never compete with the primary state: stale
  coordination (`STALE_COORDINATION_PRESENT` → coordination_housekeeping +
  dry-run reap), an overdue heartbeat on an alive agent
  (`HEARTBEAT_RECOMMENDED`), a conflict that does not block the primary action
  (`CONFLICTS_STILL_BLOCKING`), and unclaimed dirty files whose ownership is
  unclear (`UNCLAIMED_DIRTY_FILES_PRESENT` — do not touch them) surface as
  notices with appended commands.
- DTO (bounded; lists deduped, capped at 12): `resume_state`, `confidence`
  (high/medium/low), one-line `summary`, `recommended_resume_action` token,
  boolean flags (`can_continue_existing_agent`, `requires_new_agent`,
  `requires_heartbeat`, `requires_rebootstrap`, `has_active_claims`,
  `has_active_intents`, `has_dirty_claimed_files`,
  `has_releasable_clean_intents`, `has_unclaimed_dirty_files`,
  `has_staged_blockers`), `recommended_next_tools` /
  `recommended_cli_commands` (real, safe commands only), static
  `mcp_stale_guidance`, and `warnings` / `blockers`.
- MCP stale-server fallback: the recovery section carries static, deterministic
  guidance — if an expected `vibecode_*` tool is missing or
  `runtime_awareness.server.tool_count` differs from the current build
  (`vibecode mcp tools --json`), restart/reconnect the MCP server and use the
  CLI fallback (every recovery command is a CLI command). The core never
  asserts a live mismatch itself (it cannot reliably know the expected build),
  so there are no false-positive stale-server warnings.
- New static tool profile `session_recovery` (profiles 9→10, listed
  automatically by `vibecode_workspace_info`): bootstrap-first resume flow,
  heartbeat-before-resume, terminated/missing → new registration, dirty
  claimed work → finalize/guard dry-run, own clean intent → dry-run release,
  conflict_resolution / coordination_housekeeping handoffs, MCP stale →
  CLI fallback + restart, and the hard prohibitions (no released-claim reuse,
  no editing without an active claim, no `.vibecode` hand-edits, no force
  cleanup/ownership transfer/cross-agent release).
- MCP/CLI human output gains exactly one compact line, e.g.
  `Recovery: ready_to_commit — run git changes, finalize check, then commit
  guard dry-run.`

Example resume workflow (stale heartbeat after a long pause):

```powershell
vibecode session bootstrap --agent <agent_id> --json
vibecode agents heartbeat --agent <agent_id> --json
vibecode session bootstrap --agent <agent_id> --json
vibecode git changes --agent <agent_id> --json
vibecode finalize check --agent <agent_id> --json
vibecode commit guard --agent <agent_id> --dry-run --json
```

(Note: `vibecode session bootstrap --agent <id>` itself heartbeats the agent,
so a stale-but-valid session is revived by the first call; the explicit
heartbeat command is the no-rebootstrap fallback during long-running work.)

Out of scope, confirmed not added: auto-resume, auto-claim, auto-release,
auto-reap, auto-resolve, force cleanup, ownership transfer, handoff, branch
management, background heartbeat daemon/worker, UI, subagent model, automatic
file selection, scanner-based suggestions, LLM relevance scoring,
directory/glob claims, MCP commit tool, `.vibecode` editing workflows.
Vibecode tells the agent what state it is in and which explicit safe commands
exist next; it never decides what the agent works on and never recovers,
transfers, or cleans state itself.

Tests: `tests/core/agent_session/recovery_guidance.test.ts` (pure
classification of every resume state, safety/bounds matrix, purity),
`tests/core/agent_session/bootstrap_recovery_guidance.test.ts` (real-tree
integration incl. staged-unclaimed, isolated-commit, terminated, releasable
intent), `tests/app/mcp/session_bootstrap_tool.test.ts` (recovery + server
identity + compact Recovery text line), `tests/app/cli/
session_git_changes_commands.test.ts` (CLI recovery JSON + human Recovery
line; CLI/MCP parity), and `tests/core/agent_guidance/tool_profiles.test.ts`
(`session_recovery`).

## 14L. Phase 3 closure — integrated review + dogfood (Closed 2026-06-11)

Phase 3 (3A shared-tree commit isolation, 3B runtime preflight awareness,
3C safe resume guidance) is **closed** after an end-of-phase integrated review
of commits `1b54eae`, `171e43e`, and `b05c9ea` against the pre-Phase-3
baseline `0363e33`, one correctness fix, and one integrated live dogfood.

Review verdict: **PASS AFTER FIXES**. The three batches form one coherent
read-only runtime model: `git_changes` is the counting source of truth,
finalize stays conservative, the commit guard is the only mutation point
(CLI-only), runtime awareness mirrors those policies without weakening them,
and recovery classifies a single safe resume state over the awareness.

Fix made during closure (commit `cb62700`,
`fix(agent-session): harden Phase 3 runtime guidance`, TDD):

- The awareness previously gated commit readiness only on `staged_unclaimed`,
  so a file claimed by ANOTHER active agent that was already staged could make
  `commit_guard_ready` / `isolated_commit_possible` read true while the real
  guard blocks with `GIT_INDEX_NOT_CLEAN` (the guard blocks on ANY staged file
  outside the committable set; finalize only warns about other-agent files).
  `GitChangesSummaryCounts` / `RuntimeWorkspaceCounts` gain
  `staged_claimed_by_other_agent`; readiness and the isolated-commit
  prediction now require it to be zero, and a high-visibility
  `STAGED_OTHER_AGENT_FILES_PRESENT` warning explains that the owner must
  commit/unstage — never stage, unstage, or commit another agent's files.
  Recovery consequently never classifies `ready_to_commit` /
  `isolated_commit_possible` in that state (it falls back to the safe
  `ready_to_continue`). No unsafe mutation was ever possible — the guard
  itself always blocked; this fixes guidance overstating readiness.

Integrated dogfood (live, this repo): registered a build agent, bootstrap
classified `ready_to_claim`; claimed the 7 fix files via `claims plan` /
`claims add-bulk` (one intent); created an unrelated unclaimed dirty file;
bootstrap then reported `finalize_ready=false`, `isolated_commit_possible=true`
and recovery `isolated_commit_possible` (confidence medium); `git changes`,
`finalize check` (blocked only by `UNCLAIMED_CHANGED_FILE`), guard dry-run
(7 staged, 1 skipped `unclaimed`), then the real guard commit committed
exactly the 7 claimed files with `isolated_commit: true` and
`UNCLAIMED_DIRTY_FILES_SKIPPED`; the skipped file stayed dirty and
byte-identical and was removed manually afterwards; recovery then reported
`ready_to_release`, the intent was released dry-run-first, recovery returned
to `ready_to_claim`, and the agent was terminated with a clean tree. The live
MCP server session was observed to be stale during the dogfood (it predated
Phase 3B and returned no `runtime_awareness` despite a matching
`tool_count=42`), so the dogfood used the documented CLI fallback — exactly
the Phase 3B/3C stale-server guidance.

Confirmed boundaries (nothing added): no orchestration, no handoff, no
ownership transfer, no auto-claim/release/reap/resolve, no force cleanup, no
branch management, no background heartbeat daemon/worker, no UI, no automatic
file selection, no directory/glob claims, no MCP commit tool. MCP tool count
stays **42**; profiles stay 10.

Known limitations at closure:

- the end-of-phase integrated review was deferred until this pass (now done);
- conflict records remain advisory for the commit guard — they inform triage
  and recovery but do not hard-block a commit;
- `tool_count` equality does NOT prove the MCP server is fresh (a stale server
  with the same count was observed live); missing sections/fields in responses
  are the practical signal, and the CLI fallback is always authoritative;
- a staged generated/ignored file (only possible via `git add -f`) is not
  counted by the readiness mirror; the guard itself still blocks on it;
- `stale_needs_heartbeat` remains mostly classifier-level because
  `session bootstrap --agent <id>` revives a stale-but-valid agent on the
  first call;
- no background heartbeat daemon, no branch management, no agent handoff.

## 14M. Phase 4A — read-only handoff packets and team workflow boundaries (Implemented)

Trigger: when one agent stops and a human (or another agent) must decide who
continues, the open questions are always the same — what was this agent doing,
what does it still own, is the shared tree safe, and what must happen BEFORE
anyone else edits? Phase 4A answers those questions with one bounded, read-only
handoff packet. **New MCP tool `vibecode_handoff_prepare`; tool count 42 →
43.** Profiles grow 10→11 (`team_handoff`).

What a handoff packet IS: visibility plus boundary guidance — who is handing
off, the agent's task/mode/lifecycle, owned active claims/intents (bounded
samples), dirty claimed files, unclaimed dirty shared-tree files, staged
blockers, releasable clean intents, conflicts involving the agent, stale
coordination, one explicit `handoff_state`, `handoff_ready` /
`next_agent_may_continue` / `requires_current_agent_action` flags,
`required_before_handoff` prerequisite tokens, exact safe commands for the
current agent, registration commands for the next agent, and a `do_not_do`
boundary list.

What it is NOT: handoff execution. Prepare never transfers claims, never
assigns or schedules the next agent, never releases/claims/reaps/resolves/
cleans anything, never heartbeats (unlike `session bootstrap --agent`), and
never mutates git, source, or coordination state. A human or external process
still chooses who continues; the next agent always registers separately and
claims exact files itself.

- New core module `src/core/agent_session/handoff_packet.ts`:
  - `buildAgentHandoffPacket` — pure classifier over already-loaded
    coordination data (fixture-testable, mirrors the runtime-awareness input
    shape);
  - `getAgentHandoffPacket` — strictly read-only loader (agents, claim-aware
    git changes, claims, intents, conflict triage, stale coordination) with no
    writes at all.
- One primary `handoff_state` (lifecycle first, fail safe):
  `terminated_or_missing_agent` (no reliable handoff; register a NEW agent;
  old claims are coordination state, never authorization),
  `stale_agent_needs_heartbeat` (heartbeat + re-run prepare; never hand off on
  stale state),
  `read_only_report` (read-only agent → report only; trivially ready),
  `blocked_by_staged_files` (staged unclaimed/other-agent files —
  inspect/unstage safely; never commit them),
  `commit_before_handoff` (dirty claimed files → git changes / finalize /
  guard dry-run; commit or revert first),
  `isolated_commit_before_handoff` (dirty claimed + unrelated unclaimed dirty —
  guard may isolate; skipped files are not safe and not owned),
  `blocked_by_conflict` (still-blocking conflict involving the agent →
  conflict_resolution; no auto-resolve),
  `ready_after_release` (clean active own intents/claims → dry-run then
  release before the next agent claims those files),
  `ready_to_handoff` (no dirty claimed files, no blockers, nothing unreleased —
  next agent may register and plan claims normally),
  `uncertain_state` (git unavailable / invalid session metadata — inspect
  only).
- Readiness rule: `handoff_ready` only for `ready_to_handoff` and
  `read_only_report`. Unclaimed dirty files with clean own work WARN
  (`UNCLAIMED_DIRTY_FILES_PRESENT`) but do not block; staged files block;
  conflicts not involving the agent do not block; stale coordination warns
  (`STALE_COORDINATION_PRESENT` → coordination_housekeeping, dry-run reap)
  without blocking.
- `do_not_do` (static, bounded): no editing files claimed by another active
  agent, released claims authorize nothing, no cross-agent intent release, no
  claim transfer/reuse, no `.vibecode` hand-edits, no raw git add/commit
  bypass, skipped/unclaimed files are not safe, no directory/glob claims.
- MCP `vibecode_handoff_prepare` (input: required `agent_id`, optional
  bounded `max_items` ≤ 50; unknown fields rejected) and CLI parity
  `vibecode handoff prepare --repo <path> --agent <agent_id> [--max-items <n>]
  --json`. Terminated/missing agents return a handoff state inside an ok
  envelope, never a tool error and never a mutation.
- New static tool profile `team_handoff` (profiles 10→11, listed automatically
  by `vibecode_workspace_info`): prepare before ending a session with active
  work, commit/revert dirty claimed files first, dry-run-then-release own
  clean intents or release own clean active claims, next agent registers
  separately and claims exact files,
  `session_recovery` for same-agent resume, `runtime_preflight` at start,
  `conflict_resolution` when blocked — and the hard prohibitions (no ownership
  transfer, no cross-agent release, no raw git bypass, no `.vibecode` edits).

Current agent responsibilities before handoff: run `handoff prepare`, satisfy
`required_before_handoff` (commit/revert via the guard, release own clean
intents dry-run-first, or release own clean active claims when no intent
exists), and re-run prepare until `handoff_ready`. Next agent
responsibilities after handoff: register via session bootstrap, read
`do_not_do`, run `build_pre_edit`, and claim the exact files it needs after
the previous agent released them.

Example handoff workflow:

```powershell
vibecode handoff prepare --agent <agent_id> --json
vibecode commit guard --agent <agent_id> --dry-run --json
vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json
vibecode handoff prepare --agent <agent_id> --json
# next agent (separate registration; no transfer):
vibecode session bootstrap --register --agent-mode build --task "<task>" --json
vibecode tools profile --profile build_pre_edit --json
```

Out of scope, confirmed not added: handoff execution, ownership transfer,
auto handoff, auto-claim/release/reap/resolve, force cleanup, orchestration,
agent scheduling/assignment, branch management, background worker/heartbeat
daemon, UI, chat/notice board, `.vibecode` editing workflows, automatic file
selection, scanner-based suggestions, LLM relevance scoring, directory/glob
claims, MCP commit tool.

Known limitations: no handoff execution or assignment — a human or external
process chooses who continues; the packet is point-in-time (re-run prepare
after every prerequisite step); staged generated/ignored files remain the
Phase 3 closure limitation (guard blocks, prediction does not count them); no
shared chat/notice board.

Tests: `tests/core/agent_session/handoff_packet.test.ts` (pure state matrix,
readiness rules, bounded samples, do_not_do, safe-command safety),
`tests/app/mcp/handoff_tool.test.ts` (registration, schema, validation,
terminated/missing-as-state, no-mutation, canonical envelope),
`tests/app/cli/handoff_commands.test.ts` (CLI parity, validation, compact
human output, no mutation), and
`tests/core/agent_guidance/tool_profiles.test.ts` (`team_handoff`).

## 14N. Phase 4B — next-agent onboarding from handoff packets (Implemented)

Trigger: Phase 4A tells the STOPPING agent what it still owes. The mirror
question was unanswered: an agent that wants to continue had to manually
interpret the packet — is the previous agent actually ready, is its work still
claimed, may I register/continue, which paths are unavailable, what must I
claim myself, what exact commands do I run, what must I never do, and is this
actually a same-agent resume? Phase 4B answers those questions with one
bounded, read-only onboarding guide. **New MCP tool `vibecode_handoff_guide`;
tool count 43 → 44.** Profile count stays 11 (`team_handoff` enhanced with the
consumer side, no new profile).

`handoff prepare` vs `handoff guide`: prepare is the PRODUCER view (state
packet from the stopping agent's perspective); guide is the CONSUMER view
(onboarding guidance for the next agent built FROM that packet). Producer runs
prepare before ending; consumer runs guide before continuing.

What the guide IS: one primary `onboarding_state`, a condensed
`handoff_source` view of the previous agent's packet, the next agent's own
lifecycle (`registered`/`status`/`operating_mode`), explicit onboarding flags
(`can_continue_now`, `can_register_and_plan`, `must_claim_explicitly` always
true, `ownership_transferred` always false, `same_agent_resume`),
`blocked_paths` / `paths_requiring_new_claim_after_release` (bounded samples
from the packet), `path_guidance` stating Vibecode never selects the next
agent's scope, `required_before_continue` tokens, safe commands SEPARATED into
`previous_agent_cli_commands` (run by the from-agent only — e.g. its own
intent release, its own commit guard dry-run) and `next_agent_cli_commands`,
plus a `do_not_do` boundary list.

What it is NOT: handoff execution. The guide never transfers ownership, never
registers/heartbeats/releases/claims/reaps/resolves anything, never assigns
the next agent, and never mutates git/source/coordination state. Agent B may
READ Agent A's packet; Agent B still registers separately and still claims
exact files explicitly.

- New core module `src/core/agent_session/handoff_guide.ts`:
  - `buildNextAgentHandoffGuide` — pure classifier over an already-built
    Phase 4A packet plus the (optional) next agent's resolved session;
  - `getNextAgentHandoffGuide` — strictly read-only loader (packet loader +
    agents listing only; no writes at all).
- One primary `onboarding_state` (previous-agent side first, then next-agent
  side, fail safe):
  `previous_agent_not_ready` (source commit/staged/stale states — do not
  continue on its paths; per-source prerequisites),
  `previous_agent_ready_after_release` (clean active own intents/claims —
  wait; release commands listed for the FROM agent only; next agent may
  register and plan but not edit/claim those paths),
  `blocked_by_active_claims` (terminated/missing previous agent whose claims
  are still ACTIVE in the input — never transferred; explicit dry-run-first
  housekeeping; in live state a terminated agent's claims compute to `stale`,
  so this surfaces from fixtures/races, while live flows route to
  `stale_coordination_requires_housekeeping`),
  `blocked_by_conflict` (still-blocking conflict → conflict_resolution),
  `stale_coordination_requires_housekeeping` (noisy stale state →
  coordination_housekeeping, dry-run reap, never auto cleanup),
  `next_agent_stale_or_terminated` (heartbeat a stale next agent / register a
  NEW one for terminated — no claim/edit guidance until then),
  `next_agent_read_only` (observe/report only),
  `next_agent_not_registered` (no/unknown `for_agent_id`, or invalid session
  metadata → session bootstrap --register; still no transfer),
  `same_agent_resume` (`for_agent_id == from_agent_id` → session_recovery and
  session bootstrap for that agent; no cross-agent onboarding, no
  build_pre_edit/claims plan commands),
  `ready_for_new_agent` (previous agent ready → bootstrap, build_pre_edit,
  claims plan with explicit paths),
  `uncertain_state` (uncertain source, or terminated previous agent with
  unowned staged blockers — inspect only).
- Same-agent resume detection: `for_agent_id == from_agent_id` sets
  onboarding_state `same_agent_resume`, warns `SAME_AGENT_RESUME`,
  `can_continue_now=false`, and points to the `session_recovery` profile
  instead of cross-agent onboarding.
- Claim-only ready-after-release guidance branches from intent release: when
  `active_intents_count > 0`, the previous agent gets `intent-release`
  dry-run/release guidance; when `active_intents_count == 0` and active
  claims remain, it gets claim-list/claim-release guidance and no invented
  intent id.
- Readiness rules: `can_continue_now` only in `ready_for_new_agent`;
  registering/planning stays allowed in waiting states but never editing or
  claiming the previous agent's still-claimed paths; unclaimed dirty
  shared-tree files warn (`UNCLAIMED_DIRTY_FILES_PRESENT`) without blocking;
  stale coordination is a secondary warning unless it is the primary state.
- MCP `vibecode_handoff_guide` (input: required `from_agent_id`, optional
  `for_agent_id`, optional bounded `max_items` ≤ 50; unknown fields rejected)
  and CLI parity `vibecode handoff guide --repo <path> --from-agent <agent_id>
  [--for-agent <agent_id>] [--max-items <n>] --json`. Missing previous/next
  agents return safe onboarding states inside an ok envelope, never a tool
  error and never a mutation. New error code `HANDOFF_GUIDE_FAILED`.
- `team_handoff` profile enhanced (no new profile): producer runs prepare
  before ending; consumer runs handoff guide before continuing; if the
  previous agent is not ready, do not proceed; next agent registers separately
  and claims exact files; claim-only previous ownership is cleared through the
  safe claim-release path by the owning agent; session_recovery for same-agent
  resume;
  runtime_preflight after registering; conflict_resolution /
  coordination_housekeeping when indicated.
- Bootstrap stays lean: no handoff-guide output added to session bootstrap.

Example consumer workflow:

```powershell
# next agent (or human) checks before continuing:
vibecode handoff guide --from-agent <from_agent_id> --json
# if not registered yet:
vibecode session bootstrap --register --agent-mode build --task "<task>" --json
# re-check with its own identity:
vibecode handoff guide --from-agent <from_agent_id> --for-agent <for_agent_id> --json
# then claim explicitly:
vibecode tools profile --profile build_pre_edit --json
vibecode claims plan --agent <for_agent_id> --intent "<intent>" --path <path> --json
```

Out of scope, confirmed not added: ownership transfer, handoff execution or
acceptance mutation, auto-claim/release/reap/resolve, force cleanup,
orchestration, scheduler, subagent assignment, branch management, background
worker, shared chat/notice board, UI, `.vibecode` editing workflows, automatic
file selection, scanner-based suggestions, LLM relevance scoring,
directory/glob claims, MCP commit tool, Phase 4C behavior.

Known limitations: no handoff execution or automatic assignment — a human or
external process still chooses who continues; the guide is point-in-time
(re-run it after each prerequisite step); no shared chat/notice board; the
guide cannot know the next agent's intended scope, so path lists describe the
previous agent's ownership, never a recommendation of what to work on.

Tests: `tests/core/agent_session/handoff_guide.test.ts` (pure onboarding state
matrix, readiness rules, separated command lists, path framing, do_not_do,
bounded output, purity), `tests/app/mcp/handoff_guide_tool.test.ts`
(registration, schema, validation, missing-agents-as-states, no-mutation,
canonical envelope), `tests/app/cli/handoff_guide_commands.test.ts` (CLI
parity, --for-agent behavior, validation, compact human output, no mutation),
and `tests/core/agent_guidance/tool_profiles.test.ts` (`team_handoff`
consumer-side guidance).

## 14O. Phase 4C — MCP tool catalog and agent contract viewer (Implemented)

Trigger: after Phase 4A/4B, the desktop VibecodeMCP panel still showed agent
integration cards plus a flat tool-name list. That was not enough for a user to
understand what each MCP tool does, whether it writes generated coordination
state, what input schema it accepts, or what an agent receives in
`structuredContent`.

What Phase 4C adds: a bounded MCP Tool Catalog / Agent Contract DTO built from
the app MCP registry, tool input schemas, explicit output-contract metadata, and
the existing static tool profiles. The desktop bridge exposes read-only
`mcp:getToolCatalog` and `mcp:getToolDetail` channels, and the preload API
exposes `vibecodeAPI.mcp.getToolCatalog()` /
`vibecodeAPI.mcp.getToolDetail(name)`.

The catalog includes the registry-derived tool count (**44** in the active
Phase 4B/4C tree), groups, every registered tool name, title, summary,
description, side-effect classification, input schema, output contract summary,
CLI equivalents where available, recommending profiles, safety notes, and
source/test pointers. Tool metadata is validated in lockstep with the registry:
every registered tool must have contract metadata, no metadata may point at a
missing tool, every tool exposes an input schema and output summary, CLI
equivalents start with `vibecode `, and profiles in the catalog match
`tool_profiles.ts`.

The desktop VibecodeMCP panel now renders a searchable/filterable catalog with
group, side-effect, and profile filters. Selecting a tool shows when to use it,
the input schema, what the agent receives, CLI equivalent, profiles, safety
notes, and maintainer source/tests. Handoff tools are explicitly marked
read-only: `vibecode_handoff_prepare` is a visibility packet and
`vibecode_handoff_guide` is next-agent onboarding guidance with no ownership
transfer.

Boundaries confirmed not added: no tool execution button, no MCP tool runner,
no orchestration, no ownership transfer, no auto-claim/release/reap/resolve, no
source mutation, no git mutation, and no generated coordination mutation from
the catalog UI. Existing integration cards remain visible and link users toward
the catalog; tool count is shown as a visibility signal, not proof that an
already-running external MCP client is fresh.

Known limitation: output contracts are concise summaries of important
`structuredContent` fields and text-output behavior. They are not full runtime
examples for every tool unless explicit examples are added later.

Tests: `tests/app/mcp/tool_catalog.test.ts` (registry/schema/profile lockstep,
metadata completeness, side effects, handoff read-only contracts, no commit
guard, bounded determinism), `tests/app/desktop/mcp_bridge.test.ts` and
`tests/app/desktop/preload_bridge.test.ts` (read-only bridge/preload contract),
and `tests/app/desktop/mcp_tools_panel.test.ts` /
`tests/app/desktop/vibecodemcp_panel.test.ts` (search/filter/detail rendering,
side-effect badges, empty state, no run-tool mutation control).

## 14P. Phase 4C (team workflow) — read-only team status / team overview (Implemented)

Note on numbering: this is the multi-agent team-workflow Phase 4C
(`vibecode_team_status`), distinct from the desktop MCP tool catalog that
section 14O also labels "Phase 4C".

Trigger: after Phase 4A/4B, a human or agent starting a multi-agent session
still had to call session_bootstrap per agent to learn who is active, stale,
blocked, or holding claims. There was no single bounded read-only overview of
the whole team.

What Phase 4C adds: a read-only team status overview as a pure core service
(`src/core/agent_session/team_status.ts`), exposed as the MCP tool
`vibecode_team_status` (tool count **44 → 45**) and the CLI command
`vibecode team status [--max-agents <n>] [--max-items <n>] --json`, plus a
`team_status` tool profile (profiles **11 → 12**). Both adapters share the
same core service, the MCP schema rejects unknown keys, and `max_agents` /
`max_items` default to 20 and hard-cap at 50.

The overview DTO contains summary counts (agents by status/mode, active
claims/intents, unresolved conflicts, stale coordination, workspace dirty and
staged-blocker state), a bounded per-agent list (status, mode, bounded task,
heartbeat age, claim/intent/conflict counts, real per-agent dirty-claimed
count, recommended action, safe next tools/commands, warnings/blockers),
bounded claim/intent/conflict samples, and deduped, capped global
recommendations.

Per-agent `recommended_action` mirrors the Phase 3C recovery-guidance
ordering and reuses the shared changed-path classifier
(`coordination/path_classification.ts`) and the claim-aware git changes
summary — it is a summary view, not a second state machine: `observe_only`,
`ready_to_claim`, `continue_work`, `commit_claimed_work`,
`isolated_commit_possible`, `release_clean_work`, `blocked_by_conflict`,
`heartbeat_needed`, `housekeeping_needed`, `terminated`, `uncertain`.
Releasability mirrors the Phase 2B intent-release lifecycle (per-path dirty
check, fail-closed when git state is unavailable or the changed-file list was
truncated). Staged unclaimed files and staged files claimed by another active
agent are reported as blockers, never optimistically. Handoff readiness is
intent-driven, so there is no separate handoff action — the release/continue
command lists surface `vibecode handoff prepare` instead. All recommended
commands are real, inspect/dry-run-style `vibecode` commands; the commit
guard and intent release remain the decision points.

Boundaries confirmed not added: no UI, no dashboard rendering, no scheduler,
no orchestration, no agent/subagent assignment, no ownership transfer, no
handoff execution, no auto-claim/release/reap/resolve, no force cleanup, no
MCP commit tool, no raw git bypass, no `.vibecode` hand-editing, no
directory/glob claims, no automatic file selection, and no Phase 4D behavior.
Team status never registers, heartbeats, revives, or mutates coordination/git
state — the CLI contract test pins the coordination state file byte-identical
across a run. The human or external process still chooses work distribution.

Known limitations: point-in-time snapshot (re-run after mutations);
changed-file classification window is capped at 200 files, beyond which
per-agent dirty counts are partial and releasability fails closed with an
explicit truncation warning; per-agent detail remains canonical in
session_bootstrap / handoff prepare / handoff guide / conflict detail.

Tests: `tests/core/agent_session/team_status.test.ts` (classification,
per-path releasability, staged blockers, truncation fail-closed, bounded
output, safe-command validity, no-mutation, no assignment wording),
`tests/app/mcp/team_status_tool.test.ts` (registration, count lockstep,
schema strictness), `tests/app/cli/team_status_commands.test.ts` (envelope,
validation, parity, human output, byte-identical coordination state).

## 14Q. Phase 4D — integrated Phase 4 review and dogfood closure (Closed)

Phase 4D was a review/dogfood phase, not a feature phase: it verified that
Phase 4A (handoff prepare), 4B (handoff guide), and 4C (team status) work
together as one coherent read-only team workflow model and then closed
Phase 4. No production code changed.

Integrated model confirmed: `team status` is the read-only overview of all
agents, `handoff prepare` is the previous-agent packet, `handoff guide` is the
next-agent onboarding view, `session_recovery` covers same-agent resume,
`runtime_preflight` covers one-agent awareness, `conflict_resolution` and
`coordination_housekeeping` cover their domains. No tool replaces another;
detailed tools (session_bootstrap, handoff prepare/guide, conflict detail,
claims list, commit guard) remain the source of truth for detailed action.

Integrated live dogfood (temp repo, two build agents A and B, exact-file
claims via add-bulk intents):

1. dirty claimed file on A → `team status`: A=`commit_claimed_work`,
   B=`release_clean_work`; no assignment wording, safe commands only;
2. `handoff prepare --agent A` → `commit_before_handoff`
   (`commit_or_revert_dirty_claimed_files`), `handoff_ready=false`;
3. `handoff guide --from-agent A --for-agent B` → `previous_agent_not_ready`,
   `can_continue_now=false`, `blocked_paths=[docs/a.md]`, commit-guard
   commands listed only under `previous_agent_cli_commands`;
4. guarded commit by A → prepare reports `ready_after_release`
   (`release_own_clean_intents`); intent release (dry-run first) → guide
   reports `ready_for_new_agent`, `ownership_transferred=false`,
   `must_claim_explicitly=true`, no blocked paths;
5. B independently planned and claimed the released path (`claims plan` →
   claimable, `claims add-bulk` extend intent) — no transfer anywhere;
6. staged rogue-file smoke: an unclaimed staged file flipped every agent to
   `housekeeping_needed` with a team-level staged-blocker — conservative,
   matching the commit guard;
7. same-agent smoke: `handoff guide --from-agent A --for-agent A` →
   `same_agent_resume`, `can_continue_now=false`, session_recovery commands;
8. release/terminate both agents → final `team status`: both `terminated`,
   0 active claims/intents, no staged blockers, tree clean.

Verified contract state at closure: MCP tool count **45**, tool profiles
**12**, MCP/CLI parity over shared core services, strict schemas
(`additionalProperties: false`, unknown-key rejection, capped
`max_items`/`max_agents`), canonical CLI JSON envelopes, raw-git wording only
inside `do_not_do` prohibitions.

Boundaries confirmed not added: no UI, no orchestration, no scheduler, no
agent/subagent assignment, no ownership transfer, no handoff acceptance or
execution, no auto-claim/release/reap/resolve, no force cleanup, no MCP
commit tool, no raw git bypass recommendation, no `.vibecode` hand-editing,
no directory/glob claims, no automatic file selection, no LLM relevance
scoring.

Known limitations at closure: all Phase 4 outputs are point-in-time
snapshots (re-run after mutations); no UI/dashboard, scheduler, or shared
chat/notice board exists; the human or external process still chooses work
distribution; per-agent dirty classification degrades conservatively beyond
the 200-changed-file window; detailed tools remain the source of truth.

Tests at closure: focused Phase 4 suites green (179 tests), core
agent_session+coordination green (535), app/mcp green (300), app/cli green
(313), full suite **3075 passed / 11 skipped / 0 failed**, typecheck and
lint clean.

## 14. Appendix  Open Questions

- Should MCP ever expose commit, or should commit guard remain CLI-only forever?
- Should `standard` or `multi-agent` profile be default inside Vibecode terminal
  sessions?
- Should generated agent protocol be inserted into `AGENTS.md` by explicit
  command, or kept separate as `vibecode agent protocol` output only?
- Should scan artifacts be directly readable by agents, or should most access
  go through summarized views?
- Should claims become stricter than advisory, and if so, what enforcement layer
  owns that without breaking normal editors and git workflows?
- Should `session_bootstrap --register` be mutating by default in terminal
  sessions, or should registration stay an explicit separate step?
- Should `latest` mean chronological newest run or current pointer? Current MCP
  behavior treats `latest/current` as the current pointer in several places;
  this should be made explicit or renamed.
- Should evidence watch become a default terminal background process, or remain
  explicit until Windows watcher behavior is proven stable?
- Should Agent Guidance include profile-specific tool notes, or should profile
  selection itself carry enough guidance?
- Should affected-tests use deterministic scan/import data first and CodeGraph
  second, or depend on CodeGraph when available?
