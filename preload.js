const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zentask', {
  // ---- window controls ----
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', { width, height }),

  // ---- engine status ----
  onEngineStatus: (cb) => ipcRenderer.on('engine-status', (_e, data) => cb(data)),
  onEngineNotice: (cb) => ipcRenderer.on('engine-notice', (_e, data) => cb(data)),

  // ---- cursor / screen picking ----
  getCursorPosition: () => ipcRenderer.invoke('get-cursor-position'),
  pickPoint: () => ipcRenderer.invoke('open-point-picker'),
  pickBox: () => ipcRenderer.invoke('open-box-picker'),
  listWindows: () => ipcRenderer.invoke('list-windows'),

  // ---- auto clicker ----
  clickerSetConfig: (config) => ipcRenderer.invoke('clicker-set-config', config),
  clickerStart: () => ipcRenderer.invoke('clicker-start'),
  clickerStop: () => ipcRenderer.invoke('clicker-stop'),

  // ---- macro record / playback ----
  recordStart: () => ipcRenderer.invoke('record-start'),
  recordStop: () => ipcRenderer.invoke('record-stop'),
  macroPlay: (steps, name) => ipcRenderer.invoke('macro-play', { steps, name }),
  macroStop: () => ipcRenderer.invoke('macro-stop'),
  macroPause: () => ipcRenderer.invoke('macro-pause'),
  onPlaybackFinished: (cb) => ipcRenderer.on('playback-finished', (_e, data) => cb(data)),

  // ---- macro library persistence ----
  macrosLoad: () => ipcRenderer.invoke('macros-load'),
  macrosSave: (macros) => ipcRenderer.invoke('macros-save', macros),
  macrosImport: () => ipcRenderer.invoke('macros-import'),

  // ---- settings persistence ----
  settingsLoad: () => ipcRenderer.invoke('settings-load'),
  settingsSave: (settings) => ipcRenderer.invoke('settings-save', settings),

  // ---- global hotkeys ----
  hotkeyCaptureStart: () => ipcRenderer.invoke('hotkey-capture-start'),
  hotkeyCaptureCancel: () => ipcRenderer.send('hotkey-capture-cancel'),
  onHotkeyLiveUpdate: (cb) => ipcRenderer.on('hotkey-live-update', (_e, data) => cb(data)),
  hotkeyRegister: (id, keys, action) => ipcRenderer.invoke('hotkey-register', { id, keys, action }),
  hotkeyUnregister: (id) => ipcRenderer.invoke('hotkey-unregister', { id }),
  onHotkeyTriggered: (cb) => ipcRenderer.on('hotkey-triggered', (_e, data) => cb(data)),
  onStateSync: (cb) => ipcRenderer.on('state-sync', (_e, data) => cb(data)),

  // ---- webhook ----
  webhookSetConfig: (config) => ipcRenderer.invoke('webhook-set-config', config),
  webhookSendTest: () => ipcRenderer.invoke('webhook-send-test'),

  // ---- overlay window internal plumbing (used only by overlay.html) ----
  overlaySendResult: (data) => ipcRenderer.send('overlay-result', data),
  overlaySendCancel: () => ipcRenderer.send('overlay-cancel')
});
