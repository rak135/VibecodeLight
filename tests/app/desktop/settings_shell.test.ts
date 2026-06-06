import SettingsShell from '../../../src/app/desktop/renderer/settings_shell.js';

describe('settings shell — tab definitions', () => {
  test('SETTINGS_TABS lists the six tabs in order', () => {
    const tabs = SettingsShell.SETTINGS_TABS.map((t: { id: string }) => t.id);
    expect(tabs).toEqual([
      'flash',
      'codegraph',
      'mcp',
      'agent-guidance',
      'terminal',
      'advanced',
    ]);
  });

  test('every tab has a label, id, and description', () => {
    for (const tab of SettingsShell.SETTINGS_TABS) {
      expect(typeof tab.id).toBe('string');
      expect(typeof tab.label).toBe('string');
      expect(typeof tab.description).toBe('string');
      expect(tab.label.length).toBeGreaterThan(0);
    }
  });

  test('Terminal tab description states preflight exists without hidden PTY injection', () => {
    const terminalTab = SettingsShell.SETTINGS_TABS.find(
      (t: { id: string }) => t.id === 'terminal',
    );
    expect(terminalTab).toBeTruthy();
    expect(terminalTab?.description.toLowerCase()).toMatch(/terminal agent preflight/);
    expect(terminalTab?.description.toLowerCase()).toMatch(/pty/);
    expect(terminalTab?.description.toLowerCase()).toMatch(/does not start agents/);
  });
});

describe('settings shell — tab state', () => {
  test('initialTabState selects the first tab by default', () => {
    const state = SettingsShell.initialTabState();
    expect(state.activeTabId).toBe('flash');
  });

  test('selectTab updates activeTabId when the id is valid', () => {
    const state = SettingsShell.selectTab(SettingsShell.initialTabState(), 'agent-guidance');
    expect(state.activeTabId).toBe('agent-guidance');
  });

  test('selectTab leaves activeTabId unchanged when the id is unknown', () => {
    const state = SettingsShell.selectTab(SettingsShell.initialTabState(), 'unknown');
    expect(state.activeTabId).toBe('flash');
  });
});

describe('settings shell — controller', () => {
  test('createController renders tab buttons and panels via the view', () => {
    const calls: Array<{ active: string; tabs: ReadonlyArray<{ id: string }> }> = [];
    const view = {
      renderTabs(state: { tabs: ReadonlyArray<{ id: string }>; activeTabId: string }) {
        calls.push({ active: state.activeTabId, tabs: state.tabs });
      },
    };
    const controller = SettingsShell.createController({ view });
    controller.activate('agent-guidance');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1].active).toBe('agent-guidance');
    expect(calls[calls.length - 1].tabs.map((t) => t.id)).toEqual([
      'flash',
      'codegraph',
      'mcp',
      'agent-guidance',
      'terminal',
      'advanced',
    ]);
  });
});
