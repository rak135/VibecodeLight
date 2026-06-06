# Multi-Agent Coordination UI Design

Minimal desktop UI for visible multi-agent coordination in VibecodeLight.

This document defines the UI surface only. Coordination logic (claims, conflicts, handoffs, heartbeats) lives in `core/` and is consumed through the existing preload bridge pattern. The UI renders state; it does not own state.

---

## Authority

```text
1. AGENTS.md — operational guide
2. ARCHITECTURE_DECISIONS.md — implementation decisions, wins on conflicts
3. MULTI_AGENT_CONFLICT_DESIGN.md — coordination data model and protocols
4. This document — UI surface for coordination
5. ARCHITECTURE.md — module boundaries
```

---

## Core Principle

The user opens terminals manually. No ceremony. VibecodeLight observes coordination state and shows it in the existing UI chrome. The terminal remains the primary working surface. Coordination state lives in a collapsible panel, not a modal, not a wizard, not a separate window.

---

## Existing Layout Context

The current desktop layout:

```text
+------------------+----------------------------+------------------+
| Left Sidebar     | Center                     | Right Rail       |
| (nav icons)      | (terminal grid)            | (context/inspector)|
|                  |                            |                  |
| Runs             |  +--------+ +--------+    | Pipeline Progress|
| Context          |  | Term 1 | | Term 2 |    | Context Flash    |
| Settings         |  +--------+ +--------+    | Runs Browser     |
| (agents)  [NEW]  |  +--------+ +--------+    |                  |
|                  |  | Term 3 | | Term 4 |    |                  |
|                  |  +--------+ +--------+    |                  |
+------------------+----------------------------+------------------+
```

The multi-agent panel integrates into the **right rail**, not as a new sidebar section. The right rail already shows contextual state (pipeline progress, context, runs). Coordination state is contextual — it belongs there.

---

## 1. UI Model — What Components Exist

### Component: CoordinationPanel

Lives in the right rail. Shows active coordination state. Collapsible like existing panels.

```typescript
interface CoordinationPanelState {
  agents: AgentSummary[];
  conflicts: ConflictSummary[];
  handoffs: HandoffSummary[];
  lastUpdated: string;
}

interface AgentSummary {
  agent_id: string;
  agent_name: string;
  agent_type: string;           // 'claude' | 'codex' | 'opencode' | 'custom'
  status: AgentStatus;          // from MULTI_AGENT_CONFLICT_DESIGN.md
  claim_count: number;
  last_activity: string;        // ISO timestamp
  terminal_session_id: string;  // links to terminal tile
}

interface ConflictSummary {
  conflict_id: string;
  type: string;                 // from ConflictType
  severity: ConflictSeverity;
  status: ConflictStatus;
  involved_agents: string[];
  involved_files: string[];
  detected_at: string;
}

interface HandoffSummary {
  handoff_id: string;
  from_agent: string;
  to_agent: string;
  file_count: number;
  status: HandoffStatus;
  requested_at: string;
}
```

### Component: AgentChip

Compact inline indicator on terminal tiles. Shows which agent owns a terminal.

```typescript
interface AgentChip {
  agent_name: string;
  agent_type: string;
  status: AgentStatus;
  claim_count: number;
}
```

Rendered as a small badge on the terminal tile header: `[claude ● 3 files]`

### Component: ConflictBadge

Notification badge on the nav icon and in the coordination panel header.

```typescript
interface ConflictBadge {
  count: number;
  highest_severity: ConflictSeverity;
}
```

Rendered as a red/orange dot on the Agents nav icon with a count.

---

## 2. Screen/Side Panel Concepts

### What the User Sees

**Default state (no conflicts, single agent):**

```text
Right rail shows:
  01 PIPELINE PROGRESS
  02 CONTEXT FLASH
  03 RUNS
  ---
  AGENTS              [collapsible, collapsed by default]
    claude ● 2 files
```

The AGENTS panel is collapsed by default. It only expands automatically when:
- A conflict is detected (severity >= medium)
- A handoff is requested
- A second agent appears

**Multi-agent state:**

```text
Right rail shows:
  01 PIPELINE PROGRESS
  02 CONTEXT FLASH
  03 RUNS
  ---
  AGENTS              [expanded]
  ┌─────────────────────────────────┐
  │ ACTIVE                           │
  │ ┌─────────────────────────────┐ │
  │ │ claude ● active   3 files  │ │
  │ │ codex  ● active   1 file   │ │
  │ └─────────────────────────────┘ │
  │                                  │
  │ FILES                            │
  │ ┌─────────────────────────────┐ │
  │ │ src/core/runs/store.ts  A   │ │
  │ │ src/core/runs/current.ts A  │ │
  │ │ src/app/cli.ts          B   │ │
  │ └─────────────────────────────┘ │
  │                                  │
  │ CONFLICTS                        │
  │ ┌─────────────────────────────┐ │
  │ │ ⚠ store.ts  concurrent_edit│ │
  │ │   A ↔ B   [resolve]        │ │
  │ └─────────────────────────────┘ │
  │                                  │
  │ HANDOFFS                         │
  │ ┌─────────────────────────────┐ │
  │ │ claude → codex  2 files    │ │
  │ │ pending  [accept] [reject]  │ │
  │ └─────────────────────────────┘ │
  └─────────────────────────────────┘
```

**Conflict alert state:**

When a high/critical conflict is detected:
1. The Agents nav icon gets a red badge with the conflict count
2. The coordination panel auto-expands
3. A toast notification appears at the bottom of the terminal area (non-blocking, auto-dismiss after 10s)

```text
┌──────────────────────────────────────────────────┐
│ ⚠ CONCURRENT EDIT: store.ts modified by A and B │
│   [View] [Resolve] [Dismiss]                      │
└──────────────────────────────────────────────────┘
```

The toast does NOT block the terminal. The user can keep working.

### Terminal Tile Agent Chip

Each terminal tile header shows a compact chip:

```text
┌─ Term 1: claude ●─────────────────────[×]┐
│                                            │
│  terminal content here...                  │
│                                            │
└────────────────────────────────────────────┘
```

The chip is informational only. It does not add UI controls for claiming/releasing — those go through MCP tools or CLI commands that the agent itself uses.

---

## 3. What MUST Be Visible (Critical Information)

These items must be visible at all times when multi-agent coordination is active:

| Information | Where | Format |
|---|---|---|
| Active agents | Coordination panel, agent chip on tiles | Name + status dot + claim count |
| File ownership | Coordination panel, files section | File path + agent letter badge |
| Active conflicts | Coordination panel, conflicts section + nav badge | Severity glyph + type + agents |
| Pending handoffs | Coordination panel, handoffs section | From → to + file count + status |
| Commit/finalize state | Per-terminal: in the tile header or chip | Status glyph (committed/blocked/pending) |
| Agent health | Coordination panel | Stale/terminated agents shown with warning color |

**Severity glyphs:**

```text
low      → ℹ  (info blue)
medium   → ⚠  (warning amber)
high     → 🔴 (red)
critical → 🔴 (red + pulse animation)
```

**Agent status dots:**

```text
active      → ● (green)
idle        → ◌ (dim)
stale       → ◌ (amber)
terminated  → ○ (red outline)
unknown     → ? (gray)
```

---

## 4. What Should NOT Be Built Yet (Deferred)

These features are explicitly deferred to avoid bloat:

| Deferred | Why |
|---|---|
| File ownership tree view | The flat list is sufficient. A tree is UI sugar. |
| Diff viewer for conflicts | Users can run `git diff` in the terminal. A built-in diff is a large component. |
| Merge tool integration | Merge repair runs handle this through the terminal. |
| Real-time file change highlighting | Requires deep file watcher integration. Not needed for coordination awareness. |
| Agent terminal output streaming | Terminal tiles already show output. Streaming coordination events into terminals adds complexity. |
| Drag-and-drop file reassignment | Users can CLI-reassign. Drag-and-drop is UI luxury. |
| Conflict resolution wizard | Resolution goes through CLI/MCP. A multi-step wizard is bloat. |
| Agent configuration UI | Agent config lives in agent-guidance-config.yaml. Settings UI handles it. |
| Historical conflict timeline | Current state is enough. History lives in `.vibecode/coordination/`. |
| Agent messaging/chat | Agents communicate through handoff requests. A chat UI is a separate product. |

---

## 5. UX Rules to Avoid Becoming a Bloated IDE

### Rule 1: Terminal is Primary

The terminal occupies 70%+ of the screen. Coordination state is peripheral. Never overlay coordination state on top of the terminal. Never steal focus from the terminal for coordination events.

### Rule 2: Panel, Not Page

Coordination state lives in the right rail panel. It does not get its own view, its own sidebar section, its own window, or its own route. It is collapsible. It shares space with pipeline progress, context, and runs.

### Rule 3: State, Not Controls

The coordination panel shows state. It does not provide controls for claiming files, resolving conflicts, or accepting handoffs. Those actions go through:
- MCP tools (for agents)
- CLI commands (for humans and agents)
- Toast notification actions (for quick approve/reject of handoffs only)

The only controls in the coordination panel are:
- `[resolve]` on conflict rows (opens terminal with the resolve command pre-filled)
- `[accept]` / `[reject]` on handoff rows (fires MCP handoff accept/reject)
- `[expand]` on agent rows to see file list

### Rule 4: No New Navigation Items

The left sidebar does not get a new "Agents" icon. The coordination panel lives in the right rail. Adding nav items is how sidebars bloat.

### Rule 5: Toast, Not Modal

Conflict alerts and handoff requests appear as toasts at the bottom of the terminal area. They auto-dismiss. They never block the terminal. The user can dismiss them manually. Modals are forbidden for coordination events.

### Rule 6: No Background Animations

Agent status changes update the panel state. No spinning indicators, no particle effects, no pulsing backgrounds (except the critical severity pulse, which is functional). The UI should feel quiet and fast.

### Rule 7: Compact by Default

Each agent row is one line. Each conflict row is one line. Each handoff row is one line. File lists use compact paths. No expand-on-hover, no accordion animations, no transition effects. Show the data, move on.

### Rule 8: Core Owns State, UI Renders It

The coordination panel reads from a single data source: the `WorkspaceConflictState` exposed through the preload bridge. The renderer does not compute, filter, or transform coordination state. It renders what core provides. This prevents UI-specific state bugs.

### Rule 9: No Configuration for the Panel

The coordination panel is always available when coordination state exists. There is no setting to enable/disable it, no setting to change its position, no setting to customize what it shows. If there are zero agents, it collapses to one line. If there are conflicts, it expands. The UI does not need configuration.

### Rule 10: One Panel, Not Many

There is one coordination panel. It does not split into sub-panels, pop-out windows, or tabbed views. Agent details, file ownership, conflicts, and handoffs are sections within the same panel. Separating them would create visual noise.

---

## 6. Data Flow

```text
Coordination State (.vibecode/coordination/state.json)
  ↓
TypeScript coordination service (core/)
  ↓ (IPC through preload bridge)
Renderer coordination panel (app/desktop/renderer/)
  ↓
DOM updates
```

The renderer does not poll. The coordination service pushes state updates through the existing IPC bridge when state changes (new agent, new conflict, new handoff, status change).

### Bridge API

```typescript
// Added to preload bridge
interface CoordinationBridge {
  getState(): Promise<CoordinationPanelState>;
  onStateChanged(callback: (state: CoordinationPanelState) => void): void;
  resolveConflict(conflictId: string): Promise<void>;  // opens terminal with resolve command
  acceptHandoff(handoffId: string): Promise<void>;
  rejectHandoff(handoffId: string): Promise<void>;
}
```

---

## 7. Implementation Phases

Aligned with MULTI_AGENT_CONFLICT_DESIGN.md phases:

### Phase 1: Agent awareness

- CoordinationPanel component in right rail
- AgentChip on terminal tiles
- Read-only: shows active agents and their claim counts
- No conflict detection yet, no controls

### Phase 2: File ownership view

- Files section in coordination panel
- Compact file list with agent letter badges
- Refreshed when coordination state changes

### Phase 3: Conflict visibility

- Conflicts section in coordination panel
- Severity glyphs and conflict type display
- Nav badge with conflict count
- Toast notifications for new conflicts
- `[resolve]` action on conflict rows

### Phase 4: Handoff visibility

- Handoffs section in coordination panel
- `[accept]` / `[reject]` actions
- Toast notifications for incoming handoff requests

### Phase 5: Finalize/commit state

- Per-terminal commit status in agent chip
- Blocks indicated in coordination panel when commit guard is active

---

## 8. Style Guidelines

Follow the existing Elegant Dark theme:

```text
Font: monospace (same as terminal)
Colors: use --bg, --accent, --fg CSS variables
Spacing: compact, 4px-8px padding
Borders: subtle 1px borders, no shadows
Animations: none except critical severity pulse
Icons: text glyphs only (●, ◌, ○, ?, ⚠, ℹ)
```

No new CSS variables. No new font families. No new animation libraries.

---

## 9. Testing Strategy

Each UI component gets:

1. **Structural test**: Component exists in DOM when coordination state is non-empty
2. **Render test**: Agent names, file paths, conflict types render correctly
3. **State test**: Panel updates when coordination state changes
4. **Collapse test**: Panel collapses when no active coordination
5. **Badge test**: Nav badge shows correct conflict count
6. **Toast test**: Toast appears for new conflicts/handoffs, auto-dismisses
7. **No-blocking test**: Toasts never block terminal input

Tests follow existing renderer test patterns (file-system based, checking HTML/CSS content).

---

## Summary

```text
One panel in the right rail.
One chip per terminal tile.
One toast for alerts.
No new nav items.
No modals.
No configuration.
No animations.
Core owns state.
UI renders it.
Terminal stays primary.
```
