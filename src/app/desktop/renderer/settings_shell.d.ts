// Type declarations for the tabbed settings shell module.

export interface SettingsTab {
  id: 'flash' | 'codegraph' | 'mcp' | 'agent-guidance' | 'terminal' | 'advanced';
  label: string;
  description: string;
}

export interface SettingsTabState {
  tabs: readonly SettingsTab[];
  activeTabId: SettingsTab['id'];
}

export interface SettingsShellView {
  renderTabs(state: SettingsTabState): void;
}

export interface SettingsShellController {
  activate(id: string): void;
  getState(): SettingsTabState;
}

export interface SettingsShellModule {
  SETTINGS_TABS: readonly SettingsTab[];
  initialTabState(): SettingsTabState;
  selectTab(state: SettingsTabState, nextId: string): SettingsTabState;
  createController(opts: { view: SettingsShellView }): SettingsShellController;
}

declare const SettingsShell: SettingsShellModule;
export default SettingsShell;
