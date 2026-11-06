// Copy Node ID plugin: main thread code.
// Sends the current selection to the UI and handles UI messages.
// Runs in Figma's sandbox; the UI lives in ui.html (see manifest.json).

interface SelectedNode {
  id: string;
  name: string;
  type: string;
}

interface SelectionMessage {
  type: 'selection';
  fileKey: string | null;
  nodes: SelectedNode[];
}

interface Settings {
  send: boolean;
  token: string;
}

interface SettingsMessage {
  type: 'settings';
  settings: Settings;
}

type PluginMessage = SelectionMessage | SettingsMessage;

type UIMessage =
  | { type: 'notify'; message: string }
  | { type: 'close' }
  | { type: 'save-settings'; settings: Settings };

const SETTINGS_KEY = 'settings';
const DEFAULT_SETTINGS: Settings = { send: false, token: '' };

// Settings must be exactly { send: boolean, token: string } with no extra keys.
function isSettings(value: unknown): value is Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('send') || !keys.includes('token')) {
    return false;
  }
  return typeof record.send === 'boolean' && typeof record.token === 'string';
}

function isUIMessage(value: unknown): value is UIMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'close') {
    return true;
  }
  if (record.type === 'notify') {
    return typeof record.message === 'string';
  }
  if (record.type === 'save-settings') {
    return isSettings(record.settings);
  }
  return false;
}

function postSelection(): void {
  const nodes: SelectedNode[] = figma.currentPage.selection.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
  }));
  const message: SelectionMessage = {
    type: 'selection',
    fileKey: figma.fileKey ?? null,
    nodes,
  };
  figma.ui.postMessage(message);
}

async function loadSettings(): Promise<Settings> {
  try {
    const stored: unknown = await figma.clientStorage.getAsync(SETTINGS_KEY);
    if (isSettings(stored)) {
      return { send: stored.send, token: stored.token };
    }
  } catch {
    // Storage unavailable: fall back to defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings(settings: Settings): Promise<void> {
  try {
    await figma.clientStorage.setAsync(SETTINGS_KEY, { send: settings.send, token: settings.token });
  } catch {
    figma.notify('Не вдалося зберегти налаштування');
  }
}

// Stays false until the stored settings have been sent to the UI, so the first
// selection the UI sees always comes after the settings it depends on.
let ready = false;

figma.showUI(__html__, { width: 320, height: 360 });

figma.ui.onmessage = (msg: unknown) => {
  if (!isUIMessage(msg)) {
    return;
  }
  switch (msg.type) {
    case 'notify':
      figma.notify(msg.message);
      break;
    case 'close':
      figma.closePlugin();
      break;
    case 'save-settings':
      void saveSettings(msg.settings);
      break;
  }
};

figma.on('selectionchange', () => {
  if (ready) {
    postSelection();
  }
});

async function start(): Promise<void> {
  const settings = await loadSettings();
  const message: PluginMessage = { type: 'settings', settings };
  figma.ui.postMessage(message);
  ready = true;
  postSelection();
}

void start();
