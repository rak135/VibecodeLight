# VibecodeLight — plán integrace existujícího CodeGraph MCP

Datum: 2026-05-31  
Cílové repo: `C:/DATA/PROJECTS/VibecodeLight`  
Cíl dokumentu: dát agentům implementační mapu pro bezpečnou, postupnou integraci existujícího CodeGraph MCP serveru do VibecodeLight.

---

## 0. Verdikt / rozhodnutí

**Neimplementovat vlastní CodeGraph MCP server ve VibecodeLight Phase 1.**

CodeGraph už vlastní MCP server má. Správný směr je nejdřív integrovat, testovat a případně konfigurovat existující server spuštěný přes:

```bash
codegraph serve --mcp
```

VibecodeLight má v první fázi umět:

1. detekovat, že CodeGraph MCP server existuje a funguje,
2. udělat `self-test` přes reálný MCP klient/transport,
3. ověřit dostupné nástroje (`tools/list`),
4. vytisknout konfigurační snippet pro agenty,
5. zachovat současnou CLI CodeGraph integraci jako default,
6. teprve v další fázi volitelně použít MCP transport v prompt/context pipeline.

Tohle chrání projekt před duplicitním serverem, duplicitní sadou toolů a udržovací zátěží proti upstream CodeGraphu.

---

## 1. Zjištění z externích zdrojů

### 1.1 MCP je JSON-RPC transport, ne „dej modelu JSON dump“

MCP používá JSON-RPC 2.0 zprávy mezi hostem, klientem a serverem. Server může poskytovat `tools`, `resources` a `prompts`. Tool výsledky mohou obsahovat textový obsah i `structuredContent`; pokud server vrací strukturovaný výsledek, měl by kvůli kompatibilitě zároveň vracet textovou reprezentaci.

**Důsledek pro VibecodeLight:**

- MCP boundary = JSON-RPC + JSON Schema/tool schema.
- Model-facing CodeGraph context = ideálně Markdown/text.
- Nezaměňovat MCP JSON transport s tím, co posíláme flash modelu.

### 1.2 CodeGraph už má MCP server

CodeGraph je lokální code intelligence nástroj + CLI + MCP server. Per-project data jsou v `.codegraph/`. Podle upstream dokumentace se MCP server spouští přes:

```bash
codegraph serve --mcp
```

CodeGraph installer umí nastavovat agenty a existuje také ruční MCP config snippet:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

### 1.3 CodeGraph MCP nástroje

Upstream CodeGraph MCP server vystavuje mimo jiné tyto tooly:

- `codegraph_search`
- `codegraph_context`
- `codegraph_trace`
- `codegraph_callers`
- `codegraph_callees`
- `codegraph_impact`
- `codegraph_node`
- `codegraph_explore`
- `codegraph_files`
- `codegraph_status`

**Důsledek pro VibecodeLight:**

Neduplikovat tyto tooly ve Vibecode serveru. Phase 1 má integrovat existující server a ověřit, že tyto tooly jsou dostupné.

### 1.4 CodeGraph MCP server auto-syncuje

Upstream popisuje, že když agent spustí `codegraph serve --mcp`, server používá file watcher, staleness signály a connect-time catch-up. Manual `codegraph sync` dává smysl hlavně v sandboxech, vypnutém watcheru nebo při skriptování mimo agent session.

**Důsledek pro VibecodeLight:**

- Nepředpokládat, že MCP cesta je čistě read-only na úrovni interního indexu: server může udržovat index čerstvý.
- Pro Vibecode prompt run pořád platí pravidlo: **Vibecode nesmí sám během prompt generation automaticky spouštět `init/sync/index` přes svoje příkazy.**
- Pokud samotný CodeGraph MCP server auto-syncuje, dokumentovat to jako chování upstream serveru, ne jako Vibecode orchestrace.

---

## 2. Architektonické pravidlo

### 2.1 Neplést tři režimy

VibecodeLight bude mít tři odlišné vrstvy:

```text
A. Existing CLI adapter
   pipeline -> codegraph CLI commands
   current default

B. Existing CodeGraph MCP server integration
   Vibecode MCP client -> codegraph serve --mcp -> CodeGraph tools
   optional, Phase 1B+

C. Agent config/export
   Vibecode vytiskne/později instaluje config pro Claude/Codex/OpenCode/Hermes
   agent volá CodeGraph MCP přímo
```

Tyto vrstvy nesmí být smíchané.

### 2.2 Default zůstává bezpečný

Default chování po Phase 1A:

```text
Prompt pipeline: používá stávající CLI CodeGraph adapter.
MCP: dostupné jen jako self-test/config helper.
CodeGraph mode default: detect-only.
Žádný auto-init/sync/index z Vibecode prompt pipeline.
```

### 2.3 MCP není náhrada final promptu

CodeGraph MCP tool výsledky mohou být JSON/structured, ale pro flash/final prompt stále platí:

```text
Model-facing context má být zhutněný Markdown/text.
Syrový JSON dump nepatří do final_prompt.md.
```

---

## 3. Fáze implementace

## Phase 1A — Detect + Self-test + Config print

**Cíl:** VibecodeLight umí ověřit existující CodeGraph MCP server a vytisknout agent config. Pipeline se zatím nepřepojuje.

### Scope

Přidat:

```bash
vibecode codegraph mcp self-test --repo <path>
vibecode codegraph mcp self-test --repo <path> --json
vibecode codegraph mcp config --agent <agent> --repo <path> --print
```

Alternativa názvů je přípustná, ale doporučení je držet namespace pod existujícím `vibecode codegraph`.

### Non-goals

- nepsat vlastní MCP server,
- nepřepojovat prompt pipeline,
- neinstalovat agent config do souborů bez explicitního příkazu,
- nespouštět `codegraph init/sync/index`,
- neměnit aktuální `codegraph_usage.json` pro běžné prompt runy.

### Self-test očekávané chování

`vibecode codegraph mcp self-test --repo C:/DATA/PROJECTS/VibecodeLight --json` vrátí například:

```json
{
  "ok": true,
  "repoRoot": "C:/DATA/PROJECTS/VibecodeLight",
  "transport": "stdio",
  "serverCommand": "codegraph",
  "serverArgs": ["serve", "--mcp"],
  "tools": [
    "codegraph_status",
    "codegraph_context",
    "codegraph_search",
    "codegraph_files"
  ],
  "missingExpectedTools": [],
  "warnings": []
}
```

Pokud CodeGraph není dostupný:

```json
{
  "ok": false,
  "reason": "CODEGRAPH_BINARY_NOT_FOUND",
  "warnings": ["codegraph was not found on PATH"]
}
```

Pokud MCP server naběhne, ale nemá očekávané tooly:

```json
{
  "ok": false,
  "reason": "CODEGRAPH_MCP_TOOLS_MISSING",
  "tools": ["..."],
  "missingExpectedTools": ["codegraph_context"]
}
```

### Expected tools pro Phase 1A

Minimální očekávané tooly:

```text
codegraph_status
codegraph_context
codegraph_search
codegraph_files
```

Doporučené tooly k vypsání, pokud existují:

```text
codegraph_trace
codegraph_callers
codegraph_callees
codegraph_impact
codegraph_node
codegraph_explore
```

### Agent config print

Příkaz:

```bash
vibecode codegraph mcp config --agent claude --repo C:/DATA/PROJECTS/VibecodeLight --print
```

může vytisknout:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

Pro další agenty (`codex`, `opencode`, `hermes`) v Phase 1A stačí:

- buď vytisknout známý snippet, pokud je config format v repo známý,
- nebo vrátit jasnou zprávu `AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED`,
- žádné tiché hádání.

### Files to inspect

Agent má nejdřív otevřít:

```text
AGENTS.md
README.md
docs/codegraph.md
docs/codegraph_mcp_roadmap.md
src/app/cli/index.ts
src/adapters/codegraph/*
src/core/scanning/codegraph_status.ts
package.json
```

Pak zjistit, zda v repo už existuje MCP SDK dependency. Pokud ne, rozhodnout, zda:

1. přidat oficiální `@modelcontextprotocol/sdk`, nebo
2. v Phase 1A udělat self-test přes malý subprocess wrapper až po zjištění, že CodeGraph CLI umí `tools/list` testovat jinak.

Preferované: **použít oficiální MCP SDK / stdio client transport**, ne ručně parsovat newline JSON.

---

## Phase 1B — Volitelný MCP transport pro CodeGraph v pipeline

**Cíl:** Prompt/context pipeline může volitelně použít CodeGraph MCP místo CLI adapteru. Default stále CLI.

### Config návrh

Preferovaná config hodnota:

```yaml
codegraph:
  transport: cli # cli | mcp
  mcp_fallback_to_cli: true
```

Default:

```text
transport = cli
mcp_fallback_to_cli = true
```

Alternativa:

```yaml
codegraph:
  mcp_enabled: false
```

Ale `transport: cli | mcp` je čitelnější a do budoucna rozšiřitelnější.

### Pipeline pravidla

```text
detect-only:
  - nedotazovat codegraph_context
  - může ověřit status podle současného chování

use-existing + transport=cli:
  - současný adapter

use-existing + transport=mcp:
  - MCP client -> codegraph_context
  - pokud MCP selže a fallback povolen -> CLI adapter + warning
  - pokud fallback vypnut -> structured failure/warning podle existující pipeline policy
```

### Artifacts

`scan/codegraph_usage.json` rozšířit o:

```json
{
  "transport": "mcp",
  "mcp": {
    "serverCommand": "codegraph",
    "serverArgs": ["serve", "--mcp"],
    "toolsUsed": ["codegraph_context"],
    "fallbackUsed": false
  }
}
```

Při fallbacku:

```json
{
  "transport": "cli",
  "requestedTransport": "mcp",
  "mcpFallbackReason": "CODEGRAPH_MCP_CONNECTION_FAILED",
  "warnings": ["CodeGraph MCP failed; used CLI adapter fallback."]
}
```

Nepřidávat nové artefakty, pokud to není nutné.

### Progress events

Současné CodeGraph progress events stačí rozšířit o detail:

```text
CodeGraph started: Building CodeGraph context from existing index. — transport: MCP
CodeGraph completed: CodeGraph context attached. — MCP / EXISTING_INDEX
```

Při fallbacku:

```text
! CodeGraph warning: CodeGraph MCP failed; falling back to CLI adapter.
```

Nepřidávat spam eventů, pokud informace jde dát do `detail`.

---

## Phase 2 — Agent config integration

**Cíl:** VibecodeLight pomůže uživateli připojit CodeGraph MCP přímo do agentů.

### Příkazy

Print-only:

```bash
vibecode codegraph mcp config --agent claude --print
vibecode codegraph mcp config --agent codex --print
vibecode codegraph mcp config --agent opencode --print
vibecode codegraph mcp config --agent hermes --print
```

Později install:

```bash
vibecode codegraph mcp install --agent claude --scope local
vibecode codegraph mcp install --agent codex --scope local
```

### Pravidlo

Nikdy nepřepisovat agent config bez:

1. zobrazení diffu,
2. potvrzení uživatele,
3. backupu původního configu.

### Priorita agentů

1. Claude Code — formát je podle CodeGraph README jasný.
2. Codex CLI — zkontrolovat aktuální formát v docs/repo před implementací.
3. OpenCode — zkontrolovat aktuální formát v docs/repo.
4. Hermes — implementovat jen pokud je formát v Hermes projektu jasný.

---

## Phase 3 — Main model / terminal agent workflow

**Cíl:** Agent běžící v terminálu může používat CodeGraph MCP přímo, mimo Vibecode flash pipeline.

Tohle není Phase 1. Nejdřív musí být stabilní:

- self-test,
- config print/install,
- volitelný pipeline transport,
- artifact/progress truth.

Potom lze řešit:

```text
Vibecode workspace spravuje více repozitářů a více terminálů.
Každý agent může mít MCP config s CodeGraph serverem pro konkrétní repo.
Vibecode UI ukazuje stav CodeGraph MCP per repo/session.
```

---

## 4. Bezpečnostní pravidla

### 4.1 Zakázat vlastní shell tools

Vibecode MCP integrace nesmí přidat obecný tool typu:

```text
run_command
shell
exec
write_file
```

Phase 1 pracuje jen s existujícím CodeGraph serverem.

### 4.2 Repo root validation

Každý příkaz s `--repo` musí:

- normalizovat cestu,
- ověřit, že cesta existuje,
- ověřit, že jde o adresář,
- nepustit traversal / podivné hodnoty,
- ideálně hlásit, zda existuje `.codegraph/`.

### 4.3 Žádný auto-init/index z Vibecode prompt runu

Prompt pipeline nesmí kvůli MCP sama zavolat:

```text
codegraph init
codegraph index
codegraph sync
```

Výjimka: uživatel explicitně spustí maintenance command.

### 4.4 Jasné warningy

Když MCP není dostupné, musí být jasně vidět:

- v CLI outputu,
- v `codegraph_usage.json`, pokud šlo o pipeline run,
- v Pipeline Progress warningu,
- ve final reportu agenta.

---

## 5. Doporučené implementační prompty pro agenty

## Prompt 1 — Phase 1A self-test

```text
Goal:
Implement Phase 1A CodeGraph MCP integration by adding a self-test command for the existing upstream CodeGraph MCP server.

Repository:
C:/DATA/PROJECTS/VibecodeLight

Do not implement a custom Vibecode MCP server.
Do not wire prompt pipeline to MCP yet.
Do not run codegraph init/sync/index.
Do not write agent config files.

Implement:
- vibecode codegraph mcp self-test --repo <path>
- vibecode codegraph mcp self-test --repo <path> --json

Behavior:
- verify codegraph binary availability
- start existing server: codegraph serve --mcp
- use official MCP SDK stdio client transport if available/added
- initialize MCP session
- call tools/list
- verify expected tools:
  - codegraph_status
  - codegraph_context
  - codegraph_search
  - codegraph_files
- exit server cleanly
- no repo mutation

JSON output shape:
{
  "ok": true,
  "repoRoot": "...",
  "transport": "stdio",
  "serverCommand": "codegraph",
  "serverArgs": ["serve", "--mcp"],
  "tools": ["..."],
  "missingExpectedTools": [],
  "warnings": []
}

Tests:
- mocked MCP server success
- missing codegraph binary
- server starts but missing expected tools
- server startup failure
- --json output shape
- command does not call init/sync/index

Validation:
- pnpm typecheck
- pnpm lint
- pnpm test

Commit:
feat(codegraph): add MCP self-test for existing server

Final report:
- files changed
- exact command added
- SDK/transport used
- tests added
- validation results
- git status
- commit hash
```

## Prompt 2 — Phase 1A config print

```text
Goal:
Add print-only CodeGraph MCP config snippets for supported agents.

Repository:
C:/DATA/PROJECTS/VibecodeLight

Do not write config files.
Do not modify user config.
Do not guess unsupported agent formats.

Implement:
- vibecode codegraph mcp config --agent claude --print
- optionally --agent codex/opencode/hermes only if the format is known in repo/docs

Claude output should include:
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}

If format is unknown:
- return structured diagnostic AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED
- do not emit fake config

Tests:
- claude print output
- unsupported agent diagnostic
- --json if added
- no file writes

Validation:
- pnpm typecheck
- pnpm lint
- pnpm test

Commit:
feat(codegraph): print MCP config snippets
```

## Prompt 3 — Phase 1B optional pipeline transport

```text
Goal:
Add optional CodeGraph MCP transport for prompt/context pipeline while keeping CLI transport as default.

Repository:
C:/DATA/PROJECTS/VibecodeLight

Prerequisite:
Phase 1A self-test exists and passes.

Do not make MCP default.
Do not remove CLI adapter.
Do not auto-init/sync/index.

Config:
codegraph.transport = cli | mcp
Default: cli

Behavior:
- detect-only: do not call codegraph_context
- use-existing + cli: current behavior
- use-existing + mcp: call CodeGraph MCP tool codegraph_context
- MCP failure + fallback enabled: warn and use CLI adapter
- MCP failure + strict/no fallback: structured diagnostic/failure according to existing pipeline policy

Artifacts:
- scan/codegraph_usage.json includes requested/effective transport
- fallback reason recorded if used

Progress:
- CodeGraph progress detail says transport: MCP or CLI
- fallback emits pipeline_warning

Tests:
- default still CLI
- MCP enabled calls mocked codegraph_context
- detect-only does not call context tool
- MCP failure fallback to CLI warning
- codegraph_usage records transport
- final_prompt remains stable

Validation:
- pnpm typecheck
- pnpm lint
- pnpm test

Commit:
feat(codegraph): support optional MCP transport
```

---

## 6. Testovací checklist

### Unit / CLI

- `vibecode codegraph mcp self-test --repo <fixture> --json` success shape.
- Missing binary returns structured error.
- Server startup failure returns structured error.
- Missing expected tool returns structured error.
- Self-test does not call `init`, `sync`, or `index`.
- Config print does not write files.

### Integration

- Mock MCP server: `tools/list` contains expected CodeGraph tools.
- Optional Phase 1B: pipeline with `transport=mcp` calls `codegraph_context`.
- Optional Phase 1B: `detect-only` does not call `codegraph_context`.
- Optional Phase 1B: MCP failure fallback is visible as warning.

### Artifacts

- Self-test does not create `.vibecode/runs` unless explicitly designed to.
- Prompt pipeline artifacts unchanged in Phase 1A.
- Phase 1B updates `scan/codegraph_usage.json` with transport info.

### UX / docs

- README/docs state clearly:
  - Phase 1 uses existing CodeGraph MCP server.
  - Vibecode does not implement own CodeGraph MCP server.
  - MCP optional/default off for pipeline.
  - Existing CLI adapter remains.

---

## 7. Acceptance criteria

Phase 1A is done when:

```text
- vibecode codegraph mcp self-test exists
- it uses real MCP stdio client semantics, not hand-rolled newline JSON
- it verifies tools/list
- it fails clearly when server/tools are unavailable
- it does not mutate repo
- config print exists at least for Claude or unsupported agents fail honestly
- docs describe current state accurately
- tests/typecheck/lint pass
```

Phase 1B is done when:

```text
- pipeline can use codegraph.transport=mcp
- default remains cli
- detect-only semantics preserved
- use-existing MCP path tested
- fallback/warnings/artifacts are clear
- final_prompt does not get raw JSON dumps
```

Phase 2 is done when:

```text
- Vibecode can print/install agent MCP configs safely
- install requires explicit user confirmation
- supports at least one real agent format end-to-end
- no config is overwritten without backup/diff
```

---

## 8. Open questions for agents to answer before implementation

1. Does VibecodeLight already depend on `@modelcontextprotocol/sdk`?
2. If not, is adding it acceptable under current project dependency policy?
3. Is there already an internal process wrapper for long-running stdio child processes?
4. Does current CLI parser support nested commands like `codegraph mcp self-test` cleanly?
5. Where should CodeGraph MCP helper live?
   - `src/adapters/codegraph/mcp_client.ts`
   - `src/app/cli/codegraph_mcp.ts`
   - other project-preferred location
6. How are structured diagnostics represented in current CLI?
7. Which agent config formats are already documented in this repo?
8. Do we want config print to support only Claude first, or multiple agents?

---

## 9. Recommended first implementation commit

Start with the smallest useful checkpoint:

```text
feat(codegraph): add MCP self-test for existing server
```

Do **not** implement Phase 1B in the same commit unless Phase 1A is already clean and fully tested.

---

## 10. Source notes

- MCP specification: https://modelcontextprotocol.io/specification/2025-11-25
- MCP tools specification: https://modelcontextprotocol.io/specification/draft/server/tools
- CodeGraph upstream repository: https://github.com/colbymchenry/codegraph
- CodeGraph MCP command: `codegraph serve --mcp`
- CodeGraph manual MCP config: `command: "codegraph", args: ["serve", "--mcp"]`
- CodeGraph tools listed upstream: `codegraph_search`, `codegraph_context`, `codegraph_trace`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_explore`, `codegraph_files`, `codegraph_status`
