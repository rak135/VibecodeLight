# CodeGraph integrace pro VibecodeLight

## 1. Verdikt

CodeGraph se do VibecodeLight hodí, ale pouze jako **volitelná code-intelligence vrstva**. Nemá nahradit VibecodeLight, nemá nahradit celý Python scanner a nemá se stát povinnou závislostí.

Správný dlouhodobý směr je **hybridní varianta**:

```text
Dlouhodobě:
  VibecodeLight poskytuje vlastní read-only tool/MCP gateway.
  Stdio MCP slouží pro jeden konkrétní repo/projekt.
  HTTP MCP slouží později pro desktop režim s více repozitáři a více agenty.
  Obě varianty používají stejnou interní provider/authorization/logging vrstvu.

Krátkodobě:
  pouze detekce CodeGraphu, .codegraph ignore/exclude handling a prompt hints.
```

Toto je důležité: **CodeGraph je mapa kódu, ne řídicí systém aplikace**. VibecodeLight zůstává control layer nad repozitáři, běžícími terminály, agenty, prompt balíčky, run artefakty a workflow. CodeGraph jen zlepšuje orientaci v kódu.

---

## 2. Cíl integrace

Cílem není „přidat další fancy nástroj“. Cílem je snížit bloudění agentů v repozitáři.

CodeGraph má pomoci hlavně v těchto otázkách:

```text
Kde je relevantní symbol?
Kdo tuto funkci volá?
Co změna ovlivní?
Které testy mohou být dotčené?
Jaké soubory tvoří subsystem?
Kam má agent sáhnout dřív, než začne grepovat celé repo?
```

VibecodeLight má využít CodeGraph dvěma způsoby:

```text
1. Interně pro flash/context pipeline
   Flash model může použít CodeGraph provider jako read-only tool
   při tvorbě lepšího context_pack.md.

2. Externě pro hlavní agenty
   Codex, Hermes, OpenCode, Copilot, Claude Code nebo jiný MCP-capable agent
   může používat VibecodeLight MCP server, který interně volá CodeGraph.
```

Finální stav má být:

```text
Python scanner = základní deterministická fakta
CodeGraph = vztahová mapa kódu
Flash model = výběr a komprese kontextu
Vibecode MCP = read-only tool gateway pro externí agenty
Main agent = pracuje v terminálu, používá tools, ověřuje v souborech a testech
```

---

## 3. Co CodeGraph nenahrazuje

CodeGraph nenahrazuje:

```text
.vibecode/runs/<run_id>/
run_manifest.json
scanner_config.json
flash_input.md
flash_output.md
context_pack.md
final_prompt.md
preview/send workflow
send_metadata.json
skills selection
repo instructions scan
docs scan
commands scan
git status/diff scan
per-run audit trail
terminal/session management
multi-agent control
multi-repo workspace management
```

CodeGraph může časem částečně nahradit nebo posílit jen tuto oblast:

```text
symbols.json
imports.json
entrypoints.json
tests.json částečně
keyword_hits.json částečně
budoucí AST/callgraph scanner
```

Ale ani tady nesmí být jediným zdrojem pravdy. CodeGraph output je **evidence**, ne autorita.

Základní pravidlo:

```text
Graph suggests.
Files verify.
Tests decide.
```

---

## 4. Základní principy

### 4.1 CodeGraph je volitelný

CodeGraph nesmí být povinná dependency VibecodeLight.

Default:

```text
CodeGraph disabled / detect-only.
Pokud není nainstalovaný, VibecodeLight běží dál.
Pokud není inicializovaný, VibecodeLight běží dál.
Chybějící CodeGraph je warning, ne fail.
```

### 4.2 Žádné automatické init/index v základním režimu

VibecodeLight nesmí automaticky spouštět:

```text
codegraph init
codegraph init -i
codegraph index
codegraph sync
codegraph watch
```

Důvod: tyto příkazy mění stav projektu nebo vytváří externí generated state `.codegraph/`.

Automatické vytvoření `.codegraph/` bez výslovného souhlasu uživatele by bylo špatné. Uživatel musí vědět, kdy se do projektu zavádí další index.

### 4.3 `.codegraph/` je external generated state

`.codegraph/` není VibecodeLight truth.

Pravidla:

```text
.codegraph/ musí být ignorovaný gitem.
.codegraph/ nesmí být skenovaný jako source repo content.
.codegraph/ nesmí být vkládaný do flash inputu jako běžné soubory.
.codegraph/ se smí číst pouze přes CodeGraph provider/status, ne raw file tools.
```

### 4.4 Python scanner zůstává čistý

CodeGraph orchestrace nesmí jít do Python scanneru.

Důvod:

```text
Python vlastní deterministic scan.
TypeScript vlastní orchestration, tools, config, adapters, run artifacts a externí integrace.
```

CodeGraph je Node/TypeScript ecosystem tool. Patří do TypeScript adapter/core vrstvy.

### 4.5 Read-only nejdřív

První verze nástrojů musí být pouze read-only.

Zakázat v prvních fázích:

```text
write tools
repo mutation tools
auto codegraph init/index tools
file write tools
agent config auto-write tools
git commit/revert přes MCP
```

### 4.6 Malý tool surface

MCP tools nesmí explodovat do dvaceti nástrojů. Hodně tools znamená větší context overhead a horší rozhodování modelu.

První toolset má být malý:

```text
vibecode_status
vibecode_codegraph_status
vibecode_codegraph_search
vibecode_codegraph_context
vibecode_codegraph_impact
```

`vibecode_read_run_artifact` až později.

---

## 5. Cílová architektura

## 5.1 Dlouhodobá varianta: Hybrid D

Cílový stav:

```text
Variant D — Hybrid

1. Stdio MCP
   - project-local
   - jeden process = jeden repo root
   - vhodné pro Codex/OpenCode/Hermes/Claude/VS Code project agent use
   - jednodušší bezpečnost

2. HTTP MCP
   - hostované desktop aplikací
   - lokální 127.0.0.1
   - token/auth
   - více repozitářů
   - více agentů
   - workspace/session/agent registry

3. Shared internal provider layer
   - CodeGraphProvider
   - authorization
   - output caps
   - logging
   - structured diagnostics
```

Proč hybrid:

```text
Stdio je nejlepší první MCP implementace.
HTTP je správné až pro budoucí desktop multi-repo/multi-agent režim.
Sdílená provider vrstva zabrání dvojí implementaci.
```

## 5.2 Krátkodobě: Variant E

První krok není MCP gateway.

První krok:

```text
Detect CodeGraph.
Ignore/exclude .codegraph/.
Record scan/external_tools.json.
Add prompt hints when CodeGraph is available.
Do not run CodeGraph.
Do not create MCP server.
```

To je nejmenší bezpečný krok.

---

## 6. Fázový plán

# Phase 0 — Architektonické rozhodnutí

## Cíl

Zakotvit, že CodeGraph je volitelný external code intelligence provider a že finální směr je hybridní Vibecode MCP gateway.

## Implementovat

Pouze dokumentace.

Změny:

```text
docs/ARCHITECTURE_DECISIONS.md
  - přidat sekci Optional Code Intelligence / CodeGraph

docs/ARCHITECTURE.md nebo docs/CONTEXT.md
  - popsat budoucí roli CodeGraphu jako evidence provideru

README.md
  - zatím maximálně krátká poznámka, pokud uživatel narazí na .codegraph/
```

## Obsah rozhodnutí

Musí být explicitně napsáno:

```text
CodeGraph je optional.
Default je off/detect-only.
VibecodeLight nesmí automaticky spouštět codegraph init/index.
.codegraph/ je external generated state.
.codegraph/ musí být ignored/excluded.
Python scanner nesmí orchestrate CodeGraph.
Budoucí MCP gateway bude read-only-first.
Long-term target je hybrid stdio + HTTP.
```

## Nedělat

```text
nepřidávat dependency
nepsat MCP server
nepsat CodeGraph adapter
nepouštět codegraph init
nevytvářet .codegraph/
```

## Testy

Obvykle žádné, případně doc consistency grep.

## Acceptance criteria

```text
Dokumenty jasně říkají, co CodeGraph je a co není.
Žádná implementace nebyla přidána.
Žádný generated state nevznikl.
```

---

# Phase 1 — CodeGraph detection a generated-state handling

## Cíl

VibecodeLight umí zjistit, jestli je CodeGraph dostupný/inicializovaný, ale nic nespouští a nic nemění.

## Implementovat

### 1. `.codegraph/` ignore/exclude

Přidat `.codegraph/` do:

```text
.gitignore default handling
scanner always-exclude / generated state handling
repo tree exclude
file inventory exclude
search/read tool skip dirs, pokud relevantní
```

Pozor: pokud se `.codegraph/` přidává do existujícího `.gitignore`, musí to být idempotentní.

### 2. External tools scan artifact

Přidat artefakt:

```text
.vibecode/runs/<run_id>/scan/external_tools.json
```

Minimální tvar:

```json
{
  "codegraph": {
    "available": false,
    "initialized": false,
    "mode": "detect-only",
    "warnings": [
      {
        "code": "CODEGRAPH_NOT_FOUND",
        "message": "CodeGraph command was not found on PATH."
      }
    ]
  }
}
```

Když existuje:

```json
{
  "codegraph": {
    "available": true,
    "initialized": true,
    "mode": "detect-only",
    "project_index_dir": ".codegraph/",
    "warnings": []
  }
}
```

### 3. Detekce

Detekce má zjistit:

```text
existuje příkaz codegraph?
existuje <repo>/.codegraph/?
lze volitelně získat status bez mutace?
```

Status call nesmí být hard dependency. Selhání statusu = warning.

## Doporučené soubory

První nejmenší tvar:

```text
src/adapters/codegraph/codegraph_cli.ts
src/core/scanning/external_tools.ts
```

Pokud projekt už má scanning phase orchestrator, připojit external_tools jako volitelný TypeScript-owned scan artifact.

## Nedělat

```text
nevolat codegraph init
nevolat codegraph index
nevolat codegraph sync
nepoužívat MCP
nepřidávat CodeGraph jako dependency
necpát CodeGraph output do flash_input.md
```

## Testy

Povinné testy:

```text
missing codegraph command does not fail scan
.codegraph/ absent => initialized false
.codegraph/ present => initialized true
status failure becomes warning, not failure
.codegraph/ excluded from repo_tree.txt
.codegraph/ excluded from file_inventory.json
external_tools.json is written when scan runs
```

## Acceptance criteria

```text
Scan nikdy nefailne jen proto, že CodeGraph není dostupný.
.codegraph/ není skenovaný jako source.
external_tools.json je čitelný, malý a stabilní.
Žádné CodeGraph init/index nebylo spuštěno.
```

---

# Phase 2 — Prompt hints pro hlavního agenta

## Cíl

Pokud je CodeGraph dostupný/inicializovaný, VibecodeLight to řekne agentovi ve final promptu jako volitelnou možnost průzkumu.

## Implementovat

V prompt rendereru přidat sekci typu:

```markdown
# Available Repository Tools

CodeGraph appears initialized for this repository.
For broad code exploration, prefer using CodeGraph before broad grep/read:

- codegraph context "<task>"
- codegraph impact <symbol>
- codegraph affected <changed-files>

Treat CodeGraph output as guidance. Verify exact files before editing. Tests decide.
```

Tato sekce se zobrazí pouze když:

```text
external_tools.json říká codegraph.available=true
external_tools.json říká codegraph.initialized=true
```

Pokud CodeGraph není inicializovaný, prompt může mlčet nebo dát krátkou non-blocking poznámku pouze v debug režimu. Neotravovat hlavní prompt.

## Doporučené soubory

```text
src/core/prompting/renderer.ts
src/core/context/flash_input_manifest.ts nebo relevantní artifact resolver
src/core/context/flash_compaction.ts, pokud final prompt vychází z compact contextu
```

## Nedělat

```text
nepřidávat MCP
nevolat CodeGraph automaticky
nepřidávat dlouhé CodeGraph outputy do promptu
```

## Testy

```text
when CodeGraph initialized, final_prompt.md includes short CodeGraph tool hint
when CodeGraph absent, final_prompt.md does not include CodeGraph hint
hint is short and deterministic
hint says graph output is guidance, not truth
```

## Acceptance criteria

```text
Agenti mohou používat CodeGraph CLI, pokud je dostupný.
VibecodeLight stále nic neinicializuje.
Prompt není zahlcený.
```

---

# Phase 3 — Interní CodeGraph provider pro flash model

## Cíl

Flash model může během context buildingu použít omezené read-only CodeGraph nástroje přes VibecodeLight, aby lépe vybral relevantní soubory a testy.

## Princip

Nedávat CodeGraph raw dump do promptu. Místo toho zpřístupnit malé nástroje přes existující tool dispatcher model.

## Implementovat

### 1. Adapter

```text
src/adapters/codegraph/
  codegraph_cli.ts
  codegraph_types.ts
  codegraph_diagnostics.ts
```

Adapter odpovídá za:

```text
spuštění codegraph CLI
parsování výstupu
timeouty
structured errors
bounded output
žádné mutace
```

### 2. Core provider

```text
src/core/tools/
  codegraph_provider.ts
  tool_authorization.ts
  tool_call_log.ts
```

Pokud je `src/core/tools` zatím příliš velká abstrakce, začít menším modulem a vytáhnout společnou vrstvu až při MCP implementaci.

### 3. Flash tools

Přidat read-only tools:

```text
codegraph_status
codegraph_search
codegraph_context
codegraph_impact
```

Možné pozdější tools:

```text
codegraph_callers
codegraph_callees
codegraph_affected_tests
```

### 4. Logování

Flash CodeGraph tool calls logovat do:

```text
.vibecode/runs/<run_id>/flash/tool_calls.json
```

Není to stejné jako externí MCP calls. Flash calls patří do flash tool logu.

## Konfigurační gate

Default off nebo detect-only.

Minimální config:

```yaml
context:
  codegraph:
    mode: detect   # off | detect | use-existing
    include_code: false
    max_results: 30
```

Pro Phase 3 musí být potřeba explicitně:

```yaml
context:
  codegraph:
    mode: use-existing
```

## Output caps

Default:

```text
max 20-30 výsledků
max 50-100 KB textu
include_code=false
structured truncated=true metadata
```

## Nedělat

```text
nepřidávat write tools
nepouštět init/index
nepředávat celé source bloky defaultně
nepouštět CodeGraph, když není initialized
```

## Testy

```text
mocked CodeGraph provider returns bounded context
provider respects repo boundary
provider failure is structured diagnostic
flash tool calls are logged
include_code defaults false
large output is truncated with metadata
CodeGraph not initialized => tool returns CODEGRAPH_NOT_INITIALIZED, not crash
```

## Acceptance criteria

```text
Flash model může získat lepší graph evidence.
Výstupy jsou omezené.
Žádná mutace projektu.
Žádný hard failure, pokud CodeGraph chybí.
```

---

# Phase 4 — Stdio MCP server pro jeden repo

## Cíl

Externí agenti mohou používat VibecodeLight tools přes MCP, ale pouze v jednoduchém project-local režimu.

## Command

```powershell
vibecode mcp serve --repo C:\DATA\PROJECTS\SomeRepo
```

Stdio server je vázaný na jeden repo root.

Důležité:

```text
Ve stdio režimu není potřeba workspace_id.
Repo je určeno při startu procesu.
Každý MCP process = jeden repo.
```

## Implementovat

```text
src/app/mcp/
  server_stdio.ts
  tool_registry.ts
  schemas.ts

src/app/cli/index.ts
  mcp serve command
```

Použít shared CodeGraph provider z Phase 3.

## První MCP tools

Minimal read-only sada:

```text
vibecode_status
vibecode_codegraph_status
vibecode_codegraph_search
vibecode_codegraph_context
vibecode_codegraph_impact
```

### vibecode_status

Input:

```json
{}
```

Output:

```json
{
  "ok": true,
  "data": {
    "mode": "stdio",
    "repo_root": "C:/DATA/PROJECTS/SomeRepo",
    "codegraph": {
      "available": true,
      "initialized": true
    }
  }
}
```

### vibecode_codegraph_status

Input:

```json
{}
```

Output:

```json
{
  "ok": true,
  "data": {
    "available": true,
    "initialized": true,
    "freshness": "unknown",
    "warnings": []
  }
}
```

### vibecode_codegraph_context

Input:

```json
{
  "query": "fix prompt send metadata",
  "max_results": 30,
  "include_code": false
}
```

Output:

```json
{
  "ok": true,
  "data": {
    "items": [],
    "truncated": false,
    "provenance": "codegraph"
  }
}
```

### vibecode_codegraph_search

Input:

```json
{
  "query": "sendFinalPrompt",
  "kind": "symbol",
  "limit": 20
}
```

### vibecode_codegraph_impact

Input:

```json
{
  "symbol": "sendFinalPrompt",
  "depth": 2,
  "include_tests": true
}
```

## Logging

Externí MCP tool calls nejsou flash calls.

Navržené logování pro stdio Phase 4:

```text
.vibecode/mcp/tool_calls/YYYY-MM-DD.jsonl
```

Každý záznam:

```json
{
  "timestamp": "...",
  "connection_id": "...",
  "transport": "stdio",
  "repo_root": "...",
  "tool": "vibecode_codegraph_context",
  "args_summary": {},
  "ok": true,
  "output_bytes": 12345,
  "truncated": false
}
```

Pokud později existuje run binding:

```text
.vibecode/runs/<run_id>/tools/tool_calls.jsonl
```

## Nedělat

```text
žádné HTTP
žádné multi-repo
žádné write tools
žádné read arbitrary file tool
žádný agent config auto-write
```

## Testy

```text
mcp serve starts in stdio mode with repo binding
vibecode_status returns repo root
CodeGraph missing returns structured CODEGRAPH_NOT_FOUND
CodeGraph initialized returns status
Tools reject path/workspace escape
Output caps apply
Tool call log is written
No source mutation occurs
```

## Acceptance criteria

```text
Codex/OpenCode/Hermes/Claude/VS Code mohou připojit VibecodeLight jako lokální stdio MCP server.
Server je read-only.
Server je repo-bound.
Výstupy jsou omezené.
Chybějící CodeGraph necrashne server.
```

---

# Phase 5 — Agent config helpers

## Cíl

Usnadnit uživateli připojení VibecodeLight MCP k agentům, ale bez automatických zápisů do jejich configů.

## Implementovat

CLI:

```powershell
vibecode mcp print-config --client codex --repo .
vibecode mcp print-config --client opencode --repo .
vibecode mcp print-config --client hermes --repo .
vibecode mcp print-config --client vscode --repo .
vibecode mcp print-config --client claude --repo .
```

Výstup pouze vypíše konfiguraci, kterou si uživatel může vložit sám.

Později lze přidat:

```powershell
vibecode mcp install-config --client opencode --repo .
```

ale pouze s potvrzením a jasným diffem.

## Nedělat

```text
nepřepisovat configy automaticky
neinstalovat MCP server do všech agentů bez souhlasu
neřešit cloud Copilot jako lokální proces
```

## Testy

```text
print-config outputs valid snippet for supported clients
print-config includes repo binding
print-config does not modify filesystem
unsupported client returns structured error
```

## Acceptance criteria

```text
Uživatel snadno ví, jak MCP připojit.
Žádný agent config není změněný bez explicitní akce.
```

---

# Phase 6 — Desktop HTTP MCP server pro multi-repo/multi-agent

## Cíl

Běžící VibecodeLight desktop app hostuje lokální HTTP MCP server, který dokáže obsloužit více repozitářů a více agentů.

## Kdy to dělat

Až když existuje:

```text
stabilní workspace registry
multi-terminal session model
agent/session identity model
stdio MCP zkušenosti
CodeGraph provider stabilní
UI základ pro workspace/session state
```

Nedělat dřív. HTTP MCP bez těchto základů by byl špatná architektura.

## Transport

```text
host: 127.0.0.1
port: random/default configurable
require_token: true
```

## Workspace model

HTTP tools musí být explicitní:

```text
workspace_id required for repo-scoped tools
```

Žádné implicitní current repo pro externí agenty.

Výjimka: UI může mít session-bound token, ale externí tool calls mají být explicitní.

## Implementovat

```text
src/app/mcp/server_http.ts
src/app/mcp/auth.ts
src/core/workspaces/workspace_registry.ts
src/core/agents/agent_connection.ts
src/core/tools/tool_call_log.ts
```

## HTTP tools

Rozšíření:

```text
vibecode_list_workspaces
vibecode_current_workspace
vibecode_codegraph_status { workspace_id }
vibecode_codegraph_context { workspace_id, query, ... }
vibecode_codegraph_search { workspace_id, query, ... }
vibecode_codegraph_impact { workspace_id, symbol, ... }
```

## Security

Povinné:

```text
bind 127.0.0.1 only
token auth
workspace_id required
realpath boundary checks
symlink/junction resolution
output caps
read-only tools only
structured diagnostics
connection logging
```

## Logging

HTTP tool calls:

```text
.vibecode/mcp/tool_calls/YYYY-MM-DD.jsonl
```

Pokud volání obsahuje `run_id` nebo je session-bound k runu:

```text
.vibecode/runs/<run_id>/tools/tool_calls.jsonl
```

## Testy

```text
HTTP server binds only local host
token required
token failure rejected
workspace_id required for repo tools
workspace A cannot access workspace B
symlink/junction escape rejected
multiple clients get distinct connection ids
CodeGraph status per workspace
bounded output/truncation
```

## Acceptance criteria

```text
Desktop app může bezpečně sloužit MCP tools pro více repozitářů.
Agenti nemohou omylem číst špatný repo.
Uživatel později uvidí connected clients/tool calls v UI.
```

---

# Phase 7 — UI pro connected agents/tools

## Cíl

Uživatel vidí, kteří agenti jsou připojení, k jakému repu/session, jaké tools používají a kdy.

## Implementovat

UI panely:

```text
Connected Agents
  - client/connection id
  - transport stdio/http
  - workspace/repo
  - last tool call
  - status

Tool Calls
  - timestamp
  - agent
  - workspace
  - tool
  - ok/fail
  - output size
  - truncated
```

Možné akce:

```text
copy MCP config
stop HTTP MCP server
revoke token
open tool call log
```

## Nedělat

```text
nepřidávat orchestrace subagentů jen kvůli UI
nepřidávat write tools
nepřidávat remote bind
```

## Testy

```text
UI shows connected clients
UI shows recent tool calls
revoked token disconnects/fails future calls
workspace labels are correct
```

## Acceptance criteria

```text
VibecodeLight začíná plnit budoucí roli control layer pro více agentů.
Tool usage je viditelný, ne skrytý.
```

---

# Phase 8 — Volitelné CodeGraph init/index přes explicitní user action

## Cíl

Teprve později umožnit uživateli inicializovat CodeGraph z VibecodeLight, ale pouze explicitně a auditovatelně.

## Command/UI

```powershell
vibecode codegraph init --repo .
vibecode codegraph status --repo .
vibecode codegraph index --repo .
```

UI:

```text
CodeGraph: not initialized
[Initialize CodeGraph]
```

Před akcí ukázat:

```text
This will create .codegraph/ in the repository root.
It should be ignored by git.
VibecodeLight will not treat it as run truth.
```

## Podmínky

```text
explicit user action required
confirm before creating .codegraph/
add .codegraph/ to .gitignore if missing
no auto watch by default
show command/output
log operation
```

## Nedělat

```text
auto init on repo open
auto index on every prompt
auto watch bez explicitní volby
```

## Testy

```text
init requires explicit command
init adds .codegraph/ ignore entry
init command output captured
cancel does nothing
auto prompt flow never init/indexes
```

## Acceptance criteria

```text
Uživatel může CodeGraph zavést z appky, ale appka ho nikdy nezavádí potichu.
```

---

## 7. Konfigurační návrh

Držet config malý. Nevyrábět policy engine.

Doporučený směr:

```yaml
context:
  codegraph:
    mode: detect   # off | detect | use-existing
    include_code: false
    max_results: 30

mcp:
  mode: off        # off | stdio | http | hybrid
  http:
    host: 127.0.0.1
    port: 0
    require_token: true
```

Vysvětlení:

```text
context.codegraph.mode=off
  VibecodeLight CodeGraph ignoruje.

context.codegraph.mode=detect
  VibecodeLight pouze detekuje dostupnost a initialized state.

context.codegraph.mode=use-existing
  VibecodeLight může použít existující inicializovaný CodeGraph pro read-only context/tools.
  Nesmí init/index.

mcp.mode=off
  žádný MCP server.

mcp.mode=stdio
  povolit CLI stdio MCP server.

mcp.mode=http
  desktop HTTP MCP server.

mcp.mode=hybrid
  dlouhodobý režim, až existuje obě transporty stabilně.
```

Zatím nezavádět:

```yaml
auto_init: true
auto_index: true
auto_watch: true
```

Tyto volby jsou rizikové a patří až do budoucí explicitní CodeGraph management fáze.

---

## 8. Modulární layout

## 8.1 Phase 1 minimální layout

```text
src/adapters/codegraph/
  codegraph_cli.ts
  codegraph_types.ts

src/core/scanning/
  external_tools.ts
```

## 8.2 Phase 3 provider layout

```text
src/adapters/codegraph/
  codegraph_cli.ts
  codegraph_types.ts
  codegraph_diagnostics.ts

src/core/tools/
  codegraph_provider.ts
  tool_authorization.ts
  tool_call_log.ts
  tool_output_limits.ts
```

## 8.3 Phase 4 stdio MCP layout

```text
src/app/mcp/
  server_stdio.ts
  tool_registry.ts
  schemas.ts
  response.ts
```

## 8.4 Phase 6 HTTP MCP layout

```text
src/app/mcp/
  server_http.ts
  auth.ts
  client_connections.ts

src/core/workspaces/
  workspace_registry.ts

src/core/agents/
  agent_connection.ts
```

## 8.5 Co neudělat

```text
Nedávat MCP server do src/adapters/llm.
Nedávat CodeGraph orchestration do Python scanneru.
Nedávat multi-agent registry do desktop rendereru.
Nedávat tool authorization do UI vrstvy.
```

---

## 9. MCP tool surface — finální návrh

## 9.1 První stdio toolset

```text
vibecode_status
vibecode_codegraph_status
vibecode_codegraph_search
vibecode_codegraph_context
vibecode_codegraph_impact
```

## 9.2 Pozdější HTTP/multi-repo toolset

```text
vibecode_list_workspaces
vibecode_current_workspace
vibecode_codegraph_status
vibecode_codegraph_search
vibecode_codegraph_context
vibecode_codegraph_impact
vibecode_read_run_artifact
```

## 9.3 Až později

```text
vibecode_read_run_artifact
vibecode_list_runs
vibecode_get_context_pack
vibecode_get_final_prompt
```

Tyto nástroje jsou citlivější, protože čtou `.vibecode/`. Přidat je až po jasném artifact authorization modelu.

## 9.4 Nikdy v prvních verzích

```text
vibecode_write_file
vibecode_run_command
vibecode_git_commit
vibecode_codegraph_init
vibecode_codegraph_index
vibecode_terminal_write
```

Tyto write/action tools by udělaly z VibecodeLight agent framework. To není cíl pro tuto integraci.

---

## 10. Multi-repo / multi-agent pravidla

## 10.1 Workspace identity

Každý otevřený repo musí mít:

```text
workspace_id
repo_root_realpath
label/name
.vibecode path
CodeGraph status
terminal sessions
agent connections
```

## 10.2 Session identity

Každý terminál:

```text
terminal_session_id
workspace_id
label
cwd
status
```

## 10.3 Agent connection identity

Každý MCP klient:

```text
agent_connection_id
transport
client_name if known
workspace binding if any
started_at
last_tool_call_at
```

## 10.4 Stdio vs HTTP pravidlo

```text
Stdio:
  one repo per process
  workspace_id optional / implicit

HTTP:
  multi-repo
  workspace_id required for repo tools
```

## 10.5 Cross-repo protection

Povinné:

```text
canonical realpath workspace roots
reject path traversal
resolve symlinks/junctions
reject access outside workspace
.codegraph only through CodeGraph provider
.vibecode only through explicit artifact tools
```

---

## 11. Logging model

## 11.1 Flash tool calls

```text
.vibecode/runs/<run_id>/flash/tool_calls.json
```

Použít pouze pro flash model tool calls.

## 11.2 MCP calls bez runu

```text
.vibecode/mcp/tool_calls/YYYY-MM-DD.jsonl
```

## 11.3 MCP calls s run bindingem

```text
.vibecode/runs/<run_id>/tools/tool_calls.jsonl
```

## 11.4 Log record

```json
{
  "timestamp": "2026-05-24T10:00:00+02:00",
  "transport": "stdio",
  "connection_id": "...",
  "workspace_id": "...",
  "run_id": null,
  "tool": "vibecode_codegraph_context",
  "args_summary": {
    "query_length": 42,
    "include_code": false,
    "max_results": 30
  },
  "ok": true,
  "output_bytes": 12345,
  "truncated": false,
  "duration_ms": 120
}
```

Nikdy nelogovat obrovské raw payloady do summary logu. Detailní output má být buď v tool response nebo explicitním artifactu.

---

## 12. Security model

## 12.1 HTTP

```text
bind pouze 127.0.0.1
random token defaultně
žádný public bind
žádné remote expose
jasný port/lifecycle management
```

## 12.2 Stdio

```text
repo-bound process
read-only tools
client trust inherited, ale stále boundary checks
```

## 12.3 Path safety

```text
realpath everything
reject .. traversal
resolve symlinks/junctions
workspace root allowlist
```

## 12.4 Output safety

```text
max item count
max byte size
include_code=false default
truncated metadata
no full source by default
```

## 12.5 Generated state

```text
.codegraph/ external generated state
.vibecode/ Vibecode generated state
ani jedno necommitovat
ani jedno neskenovat jako source
```

---

## 13. Co nikdy nedělat

```text
Nedělat CodeGraph povinný.
Nespouštět codegraph init/index automaticky.
Nedávat CodeGraph orchestration do Python scanneru.
Nedělat z VibecodeLight univerzální MCP router pro všechny možné nástroje.
Nevystavovat arbitrary filesystem read přes MCP.
Nevystavovat write tools v prvních verzích.
Nedělat HTTP MCP bez workspace_id a token auth.
Nevěřit CodeGraph outputu bez ověření v souborech/testech.
Nezahlcovat final_prompt.md velkými graph dumpy.
```

---

## 14. Rozhodovací brány

## Gate 1 — Po Phase 1

Pokračovat jen pokud:

```text
.codegraph/ je skutečně excluded
external_tools.json je stabilní
scan bez CodeGraphu nefailuje
žádné auto init/index se neděje
```

## Gate 2 — Před Phase 3

Implementovat internal provider jen pokud:

```text
flash context výběr je reálně slabý bez lepší code intelligence
máme testy na bounded output
máme jasné tool logging místo
```

## Gate 3 — Před Phase 4

Implementovat stdio MCP jen pokud:

```text
CodeGraph provider je stabilní
tool authorization/logging existuje
víme, jak agentům předat config
```

## Gate 4 — Před Phase 6

Implementovat HTTP MCP jen pokud:

```text
existuje workspace registry
existuje session/agent identity model
existuje UI/lifecycle plán
existuje token auth
existují multi-workspace isolation testy
```

Bez těchto věcí HTTP MCP nedělat.

---

## 15. Doporučené commity/checkpointy

```text
Phase 0:
  docs: record optional CodeGraph integration strategy

Phase 1:
  feat(scan): detect optional CodeGraph availability

Phase 2:
  feat(prompt): add optional CodeGraph usage hints

Phase 3:
  feat(context): add read-only CodeGraph provider for flash tools

Phase 4:
  feat(mcp): expose repo-bound stdio MCP server

Phase 5:
  feat(mcp): print client config snippets

Phase 6:
  feat(mcp): add local HTTP MCP server for desktop workspaces

Phase 7:
  feat(desktop): show connected MCP agents and tool calls

Phase 8:
  feat(codegraph): add explicit CodeGraph init/index actions
```

Každý checkpoint má být malý, testovatelný a commitnutý samostatně.

---

## 16. Shrnutí finálního cíle

Finální CodeGraph/VibecodeLight integrace má vypadat takto:

```text
Uživatel otevře více repozitářů ve VibecodeLight.
Každý repo má vlastní workspace_id.
Každý repo může mít vlastní CodeGraph status.
VibecodeLight spravuje terminály a běžící agenty.
Flash model může používat read-only CodeGraph provider pro lepší context pack.
Externí agenti mohou přes Vibecode MCP používat stejné CodeGraph-backed tools.
Stdio MCP slouží pro jednoduchý one-repo use case.
HTTP MCP slouží pro desktop multi-repo/multi-agent control.
Všechno je read-only-first, bounded, logged a repo-isolated.
```

Cíl není vytvořit další obří agent framework.

Cíl je dát agentům lepší mapu repozitáře přes VibecodeLight, aniž by VibecodeLight ztratil svoji identitu:

```text
real terminal
visible final prompt
reproducible run artifacts
controlled context
multiple agents/repositories later
minimum hidden magic
```

---

## 17. Zdroje / reference pro další výzkum

Použité směry a zdroje z auditů:

```text
CodeGraph @colbymchenry/codegraph
https://github.com/colbymchenry/codegraph

Codex MCP docs
https://developers.openai.com/codex/mcp

OpenCode MCP docs
https://opencode.ai/docs/mcp-servers
https://opencode.ai/docs/config

Hermes MCP docs
https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference

VS Code / Copilot MCP docs
https://code.visualstudio.com/docs/copilot/customization/mcp-servers
https://code.visualstudio.com/docs/copilot/reference/mcp-configuration

GitHub Copilot cloud agent MCP docs
https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/extend-cloud-agent-with-mcp

Claude Code MCP docs
https://code.claude.com/docs/en/mcp
```

Tyto zdroje je potřeba znovu ověřit před skutečnou implementací konkrétního klientského configu, protože MCP konfigurace u agentů se rychle mění.
