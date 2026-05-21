# VibecodeLight Vision

## Smysl produktu

VibecodeLight je pracovní plocha pro práci s AI coding agenty nad konkrétním repozitářem.

Jeho jádro stojí na třech věcech:

1. skutečný terminál,
2. per-prompt context-pack,
3. plně viditelný a reprodukovatelný prompt, který je odeslán do aktivní terminálové relace.

VibecodeLight nemá nahrazovat existující nástroje jako Hermes, OpenCode, Codex, Git, test runner nebo shell. Má nad nimi vytvořit průhlednou pracovní vrstvu, která před každým modelem řízeným krokem připraví kontext, ukáže přesný výsledný prompt a odešle jej do skutečného terminálu.

Produktový pocit má být jednoduchý:

```text
Otevřu repo.
Mám před sebou skutečný terminál.
Spustím v něm agenta nebo běžné příkazy.
Když chci poslat modelový úkol, otevřu Vibecode Composer.
Composer vytvoří nový run balíček, sestaví finální prompt, ukáže mi ho a pošle ho do terminálu.
Po runu existují artefakty, změny a commit, ze kterých jde zpětně pochopit, co se stalo.
```

To je základní identita VibecodeLight.

---

## Hlavní cíl

Cílem VibecodeLight je snížit chaos při práci s AI agenty v reálném repozitáři.

Dnešní problém není jen v tom, že model někdy píše špatný kód. Větší problém je, že často neví přesně:

- jak je repo strukturované,
- které soubory jsou relevantní,
- jaké příkazy má spustit,
- jaké konvence má dodržet,
- které dokumenty a instrukce mají prioritu,
- co se v repu změnilo od posledního kroku,
- jaký prompt vlastně dostal,
- jaký stav validace po runu vznikl,
- jaké změny patří ke konkrétnímu runu.

VibecodeLight má tento problém řešit tím, že z každého modelového promptu udělá řízený, dohledatelný a opakovatelný artefakt.

---

## Základní princip

VibecodeLight stojí na jednoduché ose:

```text
Real Terminal
  + Vibecode Composer
  + Per-Prompt Run Package
  + Deterministic Scan
  + Flash Context Compiler
  + Visible Final Prompt
  + Run Artifacts
  + Per-Run Git Commit
```

Každý modelový krok má být dohledatelný.

Uživatel musí být schopný zpětně zjistit:

```text
Co jsem zadal?
Jaký byl stav repa?
Co deterministic scan nasbíral?
Co dostal flash model?
Co flash model vybral?
Jaké skills byly vložené?
Jaký final_prompt.md odešel?
Do jakého terminálu byl odeslán?
Jaké soubory se změnily?
Jaká validace prošla nebo failnula?
Jaký commit tento run vytvořil?
```

Bez této reprodukovatelnosti je práce s AI agentem jen chaotický chat s vedlejšími efekty v repozitáři.

---

## Skutečný terminál je centrální pracovní plocha

Terminál ve VibecodeLight musí být skutečný interaktivní terminál, ne textarea ani simulace konzole.

Musí v něm fungovat běžné příkazy a interaktivní nástroje:

```text
git status
pytest
npm test
pnpm test
uv run pytest
hermes
opencode
codex
```

Terminál je místo, kde běží skutečné procesy. VibecodeLight nad ním nevytváří falešnou repliku agenta. Agent běží v terminálu stejně, jako by běžel mimo aplikaci.

Tím se zachová kompatibilita se současným workflow a uživatel neztrácí kontrolu nad prostředím.

---

## Vibecode Composer je kontrolovaný vstup pro modelové prompty

Vedle nebo nad terminálem existuje Vibecode Composer.

Jeho účel není nahradit terminál. Jeho účel je připravit modelový prompt.

Uživatel napíše do Composeru pracovní záměr, například:

```text
Přidej scanner pro keyword hits a ověř ho testy.
```

Composer z tohoto záměru vytvoří nový run balíček, spustí deterministic scan, sestaví vstup pro flash model, získá context-pack a vykreslí finální prompt.

Uživatel musí vidět přesný prompt před odesláním.

Composer je vstupní brána pro modelové úkoly. Terminál zůstává pracovní plocha pro skutečné procesy.

---

## Final prompt je pravda

`final_prompt.md` je autoritativní artefakt.

Musí platit:

```text
Obsah final_prompt.md je přesně obsah, který VibecodeLight odesílá do aktivního terminálu.
```

VibecodeLight nesmí po zobrazení preview přidat do promptu skryté instrukce, skryté kontextové bloky ani dodatečné texty.

Toto pravidlo je základ důvěry v celý nástroj.

VibecodeLight může garantovat pouze to, co sám odesílá do terminálu. Nemůže tvrdit, že vidí interní systémové prompty nástrojů jako Hermes, OpenCode nebo Codex, pokud k nim nemá přímou integraci.

---

## Každý modelový prompt vytváří nový run balíček

Před každým odesláním modelového promptu vzniká nový run balíček.

Run balíček je záznam toho, z čeho prompt vznikl, jaký byl stav repozitáře a co bylo odesláno.

Autoritativní historie je vždy v:

```text
.vibecode/runs/<run_id>/
```

`.vibecode/current/` je pouze pohodlný mirror nebo pointer na poslední důležité artefakty.

Základní struktura runu:

```text
.vibecode/runs/<run_id>/
  user_prompt.md
  run_manifest.json
  scanner_config.json

  scan/
    scan_manifest.json
    repo_tree.txt
    file_inventory.json
    git_status.json
    git_diff_stat.txt
    ignore_rules.json
    config_snapshot.json
    manifests.json
    environment.json
    commands.json
    repo_instructions.json
    docs.json
    architecture_docs.json
    symbols.json
    imports.json
    entrypoints.json
    tests.json
    tooling.json
    schemas.json
    keyword_hits.json
    recent_history.json
    previous_run_summary.json

  skills/
    skills_catalog.json
    selected_skills.json
    selected_skill_contents.md

  flash/
    flash_input_manifest.json
    flash_input.md
    flash_output.md
    flash_output_meta.json
    tool_calls.json

  output/
    context_pack.md
    final_prompt.md

  terminal/
    send_metadata.json
    terminal_transcript.md

  after/
    git_status_after.json
    changed_files_after.json
    checks_summary.md
```

`terminal_transcript.md` je volitelný podle konfigurace.

`checks_summary.md` může být v počátku prázdné nebo částečné, dokud aplikace neumí spolehlivě zachytávat výsledky checků.

---

## `.vibecode/current/`

`.vibecode/current/` je pouze pohodlný aktuální pohled.

Není to historická pravda.

Historická pravda je vždy:

```text
.vibecode/runs/<run_id>/
```

Canonical current soubory:

```text
.vibecode/current/
  run_manifest.json
  context_pack.md
  final_prompt.md
  selected_skills.json
  send_metadata.json   # jen po odeslání
```

Pokud je potřeba raw flash input, scan artefakty nebo terminálové výstupy, čtou se z konkrétní složky runu.

---

## `.vibecode/` je generovaný prostor

`.vibecode/` je generovaná pracovní složka VibecodeLight.

Není to human-maintained projektový zdroj.

Pravidla:

- `.vibecode/` je v `.gitignore`,
- `.vibecode/` se neskenuje jako zdrojová část cílového repa,
- `.vibecode/` obsahuje run artefakty, current mirror, flash vstupy/výstupy a terminálové metadata,
- uživatel ji může číst pro debug,
- kód a dokumenty projektu nemají brát `.vibecode/` jako zdrojovou pravdu.

Zdrojová projektová konfigurace není uvnitř `.vibecode/`.

---

## Projektová konfigurace

Jediný human-maintained project config je:

```text
config.yaml
```

Leží v rootu repa.

TypeScript část VibecodeLight ho vytváří, čte, validuje a převádí do per-run scanner konfigurace.

Per-run vstup pro Python scanner:

```text
.vibecode/runs/<run_id>/scanner_config.json
```

Snapshot resolved konfigurace ve scan artefaktech:

```text
.vibecode/runs/<run_id>/scan/config_snapshot.json
```

Python scanner nečte `config.yaml` přímo. Dostává už resolved scanner config od TypeScript orchestrace.

Tím se zabrání tomu, aby TypeScript a Python měly dvě různé interpretace konfigurace.

---

## Základní tok práce

```text
Repo otevřené ve VibecodeLight
  ↓
Skutečný terminál běží v pracovním adresáři repa
  ↓
Uživatel spustí agenta nebo běžné příkazy
  ↓
Uživatel otevře Vibecode Composer
  ↓
Uživatel napíše pracovní záměr
  ↓
VibecodeLight vytvoří nový run balíček
  ↓
TypeScript vytvoří run layout a scanner_config.json
  ↓
Python scanner deterministicky nasbírá fakta o repozitáři
  ↓
TypeScript sestaví flash_input.md
  ↓
Flash model vytvoří context_pack.md, relevantní soubory, cautions a selected skills
  ↓
TypeScript načte obsah selected skills
  ↓
TypeScript vykreslí final_prompt.md
  ↓
Uživatel zkontroluje přesný prompt
  ↓
VibecodeLight odešle prompt do skutečného terminálu
  ↓
Agent pracuje v terminálu
  ↓
VibecodeLight uloží post-run metadata
  ↓
Run vytvoří git commit zachycující výsledek
```

Tento tok má být jednoduchý, opakovatelný a dohledatelný.

---

## Deterministic scan

Deterministic scan je část systému, která sbírá fakta o repozitáři bez toho, aby se spoléhala na úsudek modelu.

Slovo `preflight` může být použité jako produktové označení této fáze, ale v počáteční implementaci neexistuje žádný canonical `preflight.json`.

Canonical scan artefakty žijí pod:

```text
.vibecode/runs/<run_id>/scan/
```

Deterministic scan má být co nejvíce opakovatelný. Stejný stav repozitáře a stejný vstup mají dát stejná nebo velmi podobná fakta.

### Co deterministic scan sbírá

Deterministic scan sbírá hlavně:

```text
run metadata
git status
git diff stat
complete tree of non-ignored paths
file inventory
ignore rules
config snapshot
manifests and declared dependencies
local environment snapshot
build/test/lint/run commands
repo instructions
main docs
architecture docs
regex-based symbols
imports
entrypoints
test inventory
tooling configs
schemas
keyword hits
recent history
previous run summary
conditional terminal context
provenance metadata
```

Deterministic scan nedělá finální relevance rozhodnutí.

Nedává falešné skóre typu:

```json
{"score": 0.873}
```

Místo toho dodává důkazy:

```text
keyword hit
path match
symbol match
test file found
import relation
command source
doc source
```

Flash model pak z těchto faktů vybírá relevantní materiál.

---

## Python scanner a TypeScript orchestrace

VibecodeLight je hybridní projekt.

Základní rozdělení:

```text
TypeScript owns orchestration.
Python owns deterministic scanning.
```

TypeScript vlastní:

```text
main CLI command: vibecode
workspace initialization
config.yaml
run store
.vibecode/ layout
.vibecode/current
skills catalog/copy/selection loading
LLM provider adapters
flash tools
context assembly
prompt rendering
PTY/terminal integration
desktop shell
JSON schema validation boundary
```

Python vlastní:

```text
internal scanner CLI: vibecode-scan
deterministic repository scanning
repo tree generation
file inventory
manifest parsing
command discovery
docs discovery
regex-based symbol extraction
import extraction
entrypoint detection
test inventory
keyword hits
scan artifact generation
```

Python scanner je read-only vůči cílovému repozitáři.

RunStore vytvoří a autorizuje scan output directory.

Python může zapisovat pouze do tohoto poskytnutého adresáře:

```text
.vibecode/runs/<run_id>/scan/
```

Všechny non-scan zápisy do `.vibecode/` jdou přímo přes RunStore.

---

## Role flash modelu

Flash model není zdroj pravdy o repozitáři. Je to context compiler.

Dostane:

```text
user task
run metadata
git state
diff stat
complete non-ignored repo tree
file inventory
manifest/dependency summary
environment summary
commands
repo instructions
docs
architecture docs
symbol index
import map
entrypoints
tests
tooling
schemas
keyword hits
recent history
previous run summary
terminal excerpt when relevant
skills catalog
read-only tools
```

A vytvoří strukturovaný Markdown výstup:

```text
flash_output.md
```

Počáteční flash output je Markdown-first.

Musí mít stabilní sekce:

```markdown
# Task Summary

# Relevant Files

# Files To Read With Tools

# Relevant Tests

# Commands To Run

# Selected Skills

# Cautions

# Context Pack
```

Volitelně lze z tohoto výstupu extrahovat metadata do:

```text
flash_output_meta.json
```

Budoucí structured JSON mód je možný, ale není počátečním kontraktem.

Pokud bude později přidán `flash_output.json`, musí být schema-validovaný před použitím.

---

## Co má flash model dělat

Flash model má:

- shrnout deterministic scan data,
- vybrat pravděpodobně relevantní soubory,
- vysvětlit, proč je vybral,
- vybrat relevantní testy,
- vybrat relevantní skills,
- upozornit na cautions,
- označit místa, kde si není jistý,
- vytvořit kompaktní context-pack pro hlavní model nebo agenta.

Cautions nejsou automaticky tvrdá fakta.

Pokud caution vznikla úsudkem modelu, má být prezentovaná jako caution, ne jako ověřené pravidlo.

---

## Skills

Skills jsou VibecodeLight-managed instrukce pro opakované pracovní postupy.

Primární zdroj skills je uživatelský profil:

```text
%APPDATA%/VibecodeLight/skills/
  default/
  user/
```

Projekt může obsahovat snapshot skills v rootu:

```text
SKILLS/
```

`SKILLS/` je mimo `.vibecode/`.

Copy skills do projektu je explicitní snapshot operace.

Žádný automatický sync.  
Žádné tiché přepisování.  
Žádné zdrojové skills uvnitř `.vibecode/`.

### Skills ownership

TypeScript vlastní skills systém.

TypeScript:

```text
načítá user-profile skills
načítá project SKILLS/ snapshot
tvoří skills_catalog.json
zpracovává selected_skills.json
načítá obsah selected skills
vkládá selected_skill_contents.md do final promptu
```

Python scanner:

```text
může vidět SKILLS/ jako běžné soubory ve stromu/inventory/docs
nesmí tvořit canonical skills_catalog.json
nesmí kopírovat, synchronizovat ani spravovat skills
```

Flash model dostane skills katalog jako metadata.

Plný obsah dostane jen u vybraných skills.

---

## Final prompt

Final prompt je výsledný text, který VibecodeLight odešle do terminálu.

Měl by být sestaven z těchto částí:

```text
User task
Context-pack
Selected skill contents
Relevant files
Files to inspect with tools
Project instructions
Cautions
Suggested checks
Expected final report format
```

Příklad tvaru:

```markdown
# Task

Implement ...

# Repository Context

...

# Selected Skills

...

# Relevant Files

...

# Instructions

...

# Checks

Run ...

# Output Requirements

Return a concise final report with changed files, checks run, and remaining issues.
```

Final prompt nemá být magický. Nemá být skrytý. Nemá být přepisován po zobrazení.

---

## Odeslání do terminálu

VibecodeLight odesílá `final_prompt.md` do aktivní terminálové relace.

Počáteční podoba nemá rozpoznávat, jestli terminál běží jako shell, Hermes, OpenCode, Codex nebo jiný interaktivní nástroj.

Počáteční pravidlo:

```text
VibecodeLight se chová jako komunikace se skutečným terminálem.
Uživatel odpovídá za stav aktivního terminálu při odeslání promptu.
```

Později mohou vzniknout adaptery nebo send policies pro konkrétní nástroje, ale nejsou základem první implementace.

Send metadata se ukládá do:

```text
.vibecode/runs/<run_id>/terminal/send_metadata.json
```

Volitelný celý transcript:

```text
.vibecode/runs/<run_id>/terminal/terminal_transcript.md
```

---

## Post-run stav

Po odeslání a dokončení práce je potřeba zachytit stav repozitáře a validace.

Post-run artefakty:

```text
.vibecode/runs/<run_id>/after/
  git_status_after.json
  changed_files_after.json
  checks_summary.md
```

Tyto artefakty mají pomoci odpovědět:

```text
Co se změnilo?
Jaké soubory byly dotčené?
Jaká validace proběhla?
Co failnulo?
```

V počáteční implementaci může být `checks_summary.md` částečné nebo ručně plněné podle možností zachycení terminálu.

---

## Git commit pro každý run

Každý modelový run má vytvořit deterministický git commit zachycující výsledek runu.

Toto je produktové rozhodnutí.

Důvod:

```text
Každý run má být dohledatelný nejen v .vibecode artefaktech, ale i v git historii.
Uživatel má mít možnost jasně vidět, které změny vznikly kterým runem.
Pozdější revert má být navázaný na konkrétní run.
```

Pokud testy nebo validace failnou, commit se stále vytvoří, ale stav selhání musí být jasně označený:

```text
v run metadatech
v checks_summary.md
ve final reportu agenta
v commit message nebo commit body
```

VibecodeLight má později nabídnout možnost vrátit změny konkrétního runu přes UI/CLI.

Generated `.vibecode/` artefakty se necommitují.

Commit se má vztahovat ke změnám v pracovním stromu, ne k runtime artefaktům VibecodeLight.

Toto pravidlo vyžaduje disciplínu:

- žádné unrelated změny,
- jasně označený fail stav,
- možnost revertu,
- čitelná vazba mezi runem a commitem.

---

## Soukromá a citlivá data

Počáteční VibecodeLight nedělá agresivní secret redaction ani pevnou filename cenzuru.

Respektuje ignore rules.

Uživatel odpovídá za to, že citlivá data nejsou v neignorované části repozitáře.

Provider secrets a API klíče nesmí být v commitovaných projektových souborech.

Praktické pravidlo:

```text
VibecodeLight není secret scanner.
Neslibuje ochranu tajemství.
Respektuje ignore pravidla.
Uživatel musí držet secrets mimo neignorovaný projektový obsah.
```

---

## Testování a validace

VibecodeLight má být stavěný test-driven.

Pro implementaci platí:

```text
tests before code
RED-GREEN-REFACTOR
default tests without live model calls
live tests only explicit
```

Jednotné příkazy:

TypeScript:

```powershell
pnpm test
pnpm test:live
pnpm lint
pnpm typecheck
pnpm build
```

Python scanner:

```powershell
cd src/core/scanning/python
uv run pytest
uv run pytest -m live
uv run ruff check .
```

Live tests jsou explicitní a tokenově úsporné.

Default testy nesmí volat reálné model providery.

---

## Budoucí subagenti

Subagenti jsou přirozené rozšíření stejné architektury.

Základní princip se nemění:

```text
subagent = vlastní terminálová relace + vlastní run balíček + vlastní context-pack + vlastní log + vlastní commit
```

Pokud hlavní agent nebo uživatel vytvoří subúkol, VibecodeLight může pro tento subúkol otevřít další terminálovou relaci a vytvořit samostatný context-pack.

Subagent nesmí být anonymní proces někde na pozadí. Musí být vidět jako konkrétní pracovní relace:

```text
Subagent: tests
Subagent: docs
Subagent: refactor
Subagent: review
```

Každý má mít vlastní:

```text
terminal
user/subtask prompt
scan
context_pack
final_prompt
git/worktree metadata
status
log
commit
```

Orchestrace subagentů má smysl až tehdy, když základní promptový a kontextový tok funguje spolehlivě.

---

## Budoucí orchestrace

Orchestrace může vzniknout později jako vrstva nad stejnými artefakty.

Orchestrátor by mohl:

- rozdělit úkol na podúkoly,
- vytvořit pro každý podúkol context-pack,
- spustit samostatné terminály,
- sledovat výstupy,
- porovnat změny,
- vyžádat opravy,
- připravit finální review.

Ale i při orchestrace musí zůstat zachována hlavní pravidla:

```text
každý prompt je viditelný
každý prompt má run balíček
každý subagent má vlastní context-pack
každá změna je dohledatelná
každý run má commit
nic podstatného není skryté
```

---

## Rozhraní mezi komponentami

VibecodeLight má být postavený na jasných hranicích komponent.

### Terminal Layer

Odpovědnost:

```text
spustit skutečný terminál
držet pracovní adresář
předávat input do PTY
číst output z PTY
spravovat více terminálových relací
```

Terminal Layer neřeší, co je dobrý prompt.

### Composer Layer

Odpovědnost:

```text
přijmout uživatelský záměr
spustit vytvoření run balíčku
zobrazit final prompt
odeslat final prompt do zvolené terminálové relace
```

Composer Layer neanalyzuje repo sám. Volá core pipeline.

### Scanner Layer

Odpovědnost:

```text
sbírat deterministická fakta o repozitáři
vytvořit scan artefakty
neprovádět těžké modelové rozhodování
```

### Context Compiler

Odpovědnost:

```text
vzít scan artefakty a user task
zavolat flash model
vytvořit context_pack.md
označit relevantní soubory
vybrat skills
popsat cautions
```

### Prompt Renderer

Odpovědnost:

```text
vzít user_prompt + context_pack + selected skills + instructions
vytvořit final_prompt.md
zajistit deterministický tvar promptu
nepřidávat nic po preview
```

### Run Store

Odpovědnost:

```text
vytvářet run balíčky
ukládat current artefakty
ukládat historii runs
uchovávat metadata terminálu
uchovávat git stav
uchovávat post-run artefakty
umožnit pozdější dohledání
```

### Agent Adapters

Odpovědnost v budoucnu:

```text
vědět, jak nejlépe poslat prompt do Hermese
vědět, jak nejlépe poslat prompt do OpenCode
vědět, jak nejlépe poslat prompt do Codexu
vědět, jak poznat ready stav nástroje, pokud je to možné
```

Adaptery nemají měnit význam promptu. Mohou měnit pouze techniku odeslání nebo obal vyžadovaný konkrétním nástrojem.

---

## Kvalita systému

VibecodeLight bude dobrý tehdy, když splní tyto vlastnosti.

### Transparentnost

Uživatel vždy vidí, co se posílá do modelu.

### Reprodukovatelnost

Každý modelový prompt má dohledatelný run balíček a commit.

### Praktičnost

Nástroj funguje s reálným terminálem a běžnými CLI nástroji, ne pouze v idealizovaném demo scénáři.

### Kontextová užitečnost

Context-pack skutečně pomáhá agentovi pracovat rychleji a méně bloudit v repu.

### Nízká režie

VibecodeLight nesmí dělat z jednoduchého promptu byrokratickou operaci. Kontextový tok má přidat kontrolu, ne tření.

### Rozšiřitelnost

Základní architektura musí unést pozdější subagenty a orchestrace bez přepsání celého jádra.

---

## Praktický úspěch

VibecodeLight je úspěšný, když uživatel po několika dnech používání vidí, že:

```text
agent méně bloudí v repu
prompt je vždy dohledatelný
kontext se dá zkontrolovat před odesláním
testy a relevantní soubory jsou modelu připomenuté
subjektivní chaos při práci s AI agenty klesá
uživatel stále pracuje ve skutečném terminálu
každý run má dohledatelný commit
failnuté validace nejsou schované
revert konkrétního runu je mentálně i technicky představitelný
```

Nejde o to vytvořit další krásnou vrstvu okolo AI. Jde o to udělat práci s agenty kontrolovatelnější, méně náhodnou a méně závislou na tom, jestli si model sám najde správné soubory.

---

## Shrnutí architektury

VibecodeLight stojí na jednoduché ose:

```text
Real Terminal
  + Vibecode Composer
  + Per-Prompt Run Package
  + Deterministic Scan
  + Flash Context Compiler
  + Visible Final Prompt
  + Run Artifacts
  + Per-Run Commit
```

Základní hodnota produktu je v tom, že každý modelový krok nad repozitářem má připravený kontext, viditelný prompt, dohledatelný záznam a commit, který zachycuje výsledek runu.

Tohle je architektonické jádro. Všechno další musí na tomto jádru stavět, ne ho obcházet.
