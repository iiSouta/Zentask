const { app, BrowserWindow, ipcMain, Tray, Menu, screen: electronScreen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Listening engine (uiohook-napi) -- captures real keyboard/mouse events for
// recording and global hotkeys. Loaded defensively: if it fails to
// install/compile, the app still opens and everything else keeps working.
// ---------------------------------------------------------------------------
let uIOhook = null, UiohookKey = null, uiohookReady = false;
try {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
  uiohookReady = true;
} catch (err) {
  console.error('[engine] uiohook-napi failed to load:', err.message);
}

// Reverse lookup: uiohook keycode (number) -> readable name (string), e.g. 81 -> "Q"
const keycodeToName = new Map();
if (uiohookReady) {
  for (const [name, code] of Object.entries(UiohookKey)) {
    keycodeToName.set(code, name);
  }
}

// Map a captured key NAME to a Win32 virtual-key code. VK_0-VK_9 and VK_A-VK_Z
// are documented to match ASCII codes directly, so every letter/digit is
// covered with certainty; special keys use their well-known, decades-stable
// VK_* constants. This replaced an earlier version that guessed at a
// third-party library's enum names.
const KEY_NAME_TO_VK = {
  Enter: 0x0D, Return: 0x0D, Escape: 0x1B, Space: 0x20, Tab: 0x09, Backspace: 0x08, Delete: 0x2E,
  Shift: 0x10, ShiftLeft: 0xA0, ShiftRight: 0xA1,
  Ctrl: 0x11, CtrlLeft: 0xA2, CtrlRight: 0xA3, Control: 0x11,
  Alt: 0x12, AltLeft: 0xA4, AltRight: 0xA5,
  ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
  Up: 0x26, Down: 0x28, Left: 0x25, Right: 0x27,
  CapsLock: 0x14,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B
};
function mapKeyNameToVK(name) {
  if (!name) return null;
  if (KEY_NAME_TO_VK[name] !== undefined) return KEY_NAME_TO_VK[name];
  if (name.length === 1) {
    const code = name.toUpperCase().charCodeAt(0);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) return code;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Persistence (macro library + settings), stored as plain JSON in userData
// ---------------------------------------------------------------------------
const userDataPath = app.getPath('userData');
const macrosFile = path.join(userDataPath, 'macros.json');
const settingsFile = path.join(userDataPath, 'settings.json');

const DEFAULT_SETTINGS = {
  runAtStartup: false,
  minimizeToTray: true,
  runInBackground: false,
  checkUpdates: true,
  hardwareAccel: true,
  autoSaveMacros: true,
  smartCoordLocking: true,
  autoLoopOnError: false,
  fastPlaybackSafety: true,
  compactUI: false,
  animations: true,
  highContrast: false,
  themeColor: '#5a57f5',
  lightMode: false
};

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('[persist] failed to save', file, err.message);
    return false;
  }
}

let currentSettings = { ...DEFAULT_SETTINGS, ...loadJSON(settingsFile, {}) };

// Hardware acceleration must be toggled before app is ready.
if (currentSettings.hardwareAccel === false) {
  app.disableHardwareAcceleration();
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  const workArea = electronScreen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(560, workArea.width - 40);
  const height = Math.min(150, workArea.height - 60); // starts as a wide, short toolbar; grows down (not further sideways) when a panel opens

  mainWindow = new BrowserWindow({
    width, height,
    frame: false,
    transparent: true,
    resizable: true, // required for -webkit-app-region:drag to work at all (Electron issue #30788) -- resizable:false silently breaks dragging on frameless windows
    maximizable: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.setTitle('ZenTask Pro Utility');

  mainWindow.loadFile('index.html');

  // F12 / Ctrl+Shift+I toggles DevTools so real error text is visible when
  // something misbehaves -- otherwise failures only show in a console the
  // user never sees.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toUpperCase() === 'I')) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && currentSettings.runInBackground) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.once('did-finish-load', async () => {
    const ready = await waitForSimulatorReady(8000);
    mainWindow.webContents.send('engine-status', { uiohookReady, simReady: ready });
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'icon.png');
    tray = new Tray(iconPath);
    tray.setToolTip('ZenTask Pro Utility');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show ZenTask', click: () => mainWindow && mainWindow.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]));
    tray.on('click', () => mainWindow && mainWindow.show());
  } catch (err) {
    console.error('[tray] failed to create tray icon:', err.message);
  }
}

// Full-screen overlay used for the box/point pickers. Only covers the
// primary display -- multi-monitor selection isn't handled.
let overlayResolveFn = null;
function openOverlay(mode) {
  return new Promise((resolve) => {
    if (overlayWindow) { resolve(null); return; }
    overlayResolveFn = resolve;
    const bounds = electronScreen.getPrimaryDisplay().bounds;
    overlayWindow = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, transparent: true, alwaysOnTop: true, resizable: false,
      skipTaskbar: true, hasShadow: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.loadFile('overlay.html', { search: `mode=${mode}` });
    overlayWindow.on('closed', () => { overlayWindow = null; });
  });
}
function closeOverlayWith(result) {
  if (overlayResolveFn) { overlayResolveFn(result); overlayResolveFn = null; }
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
}

// ---------------------------------------------------------------------------
// Click/move/type simulation -- a persistent PowerShell helper calling
// Win32 user32.dll directly (mouse_event / SetCursorPos / keybd_event).
// This replaced an npm native module (@nut-tree-fork/nut-js) after repeated
// reports that clicking silently didn't work -- that package's API had
// shifted across versions and its parent project went behind a paywall for
// prebuilt binaries, both of which made it a poor fit here. Win32 calls via
// PowerShell need no native compilation and the function signatures have
// been stable for decades, matching the approach already used for the
// window list and screenshots.
// ---------------------------------------------------------------------------
let simProcess = null;
let simReady = false;
let simStartupWaiters = [];
let simResponseQueue = [];
let simStdoutBuffer = '';

function buildSimulatorScript() {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZTInput {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public struct POINT { public int X; public int Y; }
}
"@
$LD=0x02; $LU=0x04; $RD=0x08; $RU=0x10; $MD=0x20; $MU=0x40; $KU=0x0002
[Console]::Error.WriteLine("ZTSIM_READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(":")
  try {
    switch ($p[0]) {
      "MOVE" { [ZTInput]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null; Write-Output "OK:MOVE" }
      "DOWN" {
        $f = if ($p[1] -eq "right") { $RD } elseif ($p[1] -eq "middle") { $MD } else { $LD }
        [ZTInput]::mouse_event($f, 0, 0, 0, [UIntPtr]::Zero)
        Write-Output "OK:DOWN"
      }
      "UP" {
        $f = if ($p[1] -eq "right") { $RU } elseif ($p[1] -eq "middle") { $MU } else { $LU }
        [ZTInput]::mouse_event($f, 0, 0, 0, [UIntPtr]::Zero)
        Write-Output "OK:UP"
      }
      "GETPOS" {
        $pt = New-Object ZTInput+POINT
        [ZTInput]::GetCursorPos([ref]$pt) | Out-Null
        Write-Output "POS:$($pt.X):$($pt.Y)"
      }
      "KEYDOWN" { [ZTInput]::keybd_event([byte]$p[1], 0, 0, [UIntPtr]::Zero); Write-Output "OK:KEYDOWN" }
      "KEYUP" { [ZTInput]::keybd_event([byte]$p[1], 0, $KU, [UIntPtr]::Zero); Write-Output "OK:KEYUP" }
      default { Write-Output "ERR" }
    }
  } catch {
    [Console]::Error.WriteLine("Command '" + $p[0] + "' failed: " + $_.Exception.Message)
    Write-Output "ERR"
  }
}
`.trim();
}

function startSimulatorProcess() {
  if (simProcess) return;
  try {
    const scriptPath = path.join(app.getPath('userData'), 'zentask-simulator.ps1');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, buildSimulatorScript());

    simProcess = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }
    );

    simProcess.stdout.on('data', (chunk) => {
      simStdoutBuffer += chunk.toString();
      let idx;
      while ((idx = simStdoutBuffer.indexOf('\n')) !== -1) {
        const line = simStdoutBuffer.slice(0, idx).trim();
        simStdoutBuffer = simStdoutBuffer.slice(idx + 1);
        if (line && simResponseQueue.length > 0) simResponseQueue.shift()(line);
      }
    });

    simProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('ZTSIM_READY') && !simReady) {
        simReady = true;
        simStartupWaiters.forEach((r) => r(true));
        simStartupWaiters = [];
      }
      if (!text.includes('ZTSIM_READY')) console.error('[simulator]', text.trim());
    });

    simProcess.on('exit', (code) => {
      console.error('[simulator] process exited with code', code);
      simProcess = null;
      simReady = false;
    });

    simProcess.on('error', (err) => {
      console.error('[simulator] failed to spawn:', err.message);
      simProcess = null;
      simReady = false;
      simStartupWaiters.forEach((r) => r(false));
      simStartupWaiters = [];
    });
  } catch (err) {
    console.error('[simulator] setup failed:', err.message);
  }
}

function waitForSimulatorReady(timeoutMs) {
  return new Promise((resolve) => {
    if (simReady) { resolve(true); return; }
    startSimulatorProcess();
    simStartupWaiters.push(resolve);
    setTimeout(() => resolve(simReady), timeoutMs || 8000);
  });
}

function sendSimCommand(cmd) {
  return new Promise((resolve) => {
    if (!simProcess || !simReady) { resolve('ERR'); return; }
    simResponseQueue.push(resolve);
    try {
      simProcess.stdin.write(cmd + '\n');
    } catch (err) {
      console.error('[simulator] write failed:', err.message);
      const idx = simResponseQueue.indexOf(resolve);
      if (idx !== -1) simResponseQueue.splice(idx, 1);
      resolve('ERR');
      return;
    }
    setTimeout(() => {
      const idx = simResponseQueue.indexOf(resolve);
      if (idx !== -1) { simResponseQueue.splice(idx, 1); resolve('ERR:timeout'); }
    }, 3000);
  });
}

// ---------------------------------------------------------------------------
// Auto-clicker
// ---------------------------------------------------------------------------
let clickerConfig = {
  intervalMs: 100, button: 'left', clickType: 'single',
  activation: 'toggle', cursorMode: 'current', fixedX: 500, fixedY: 300
};
let isClicking = false;
let clickerTimer = null;

function simButtonName(name) {
  if (name === 'right') return 'right';
  if (name === 'middle') return 'middle';
  return 'left';
}

async function setMousePosition(x, y) {
  const res = await sendSimCommand(`MOVE:${Math.round(x)}:${Math.round(y)}`);
  if (!res || !res.startsWith('OK')) console.error('[mouse] move failed:', res);
  return !!(res && res.startsWith('OK'));
}

async function performClick(buttonName, doubleClick) {
  const down = await sendSimCommand(`DOWN:${buttonName}`);
  if (!down || !down.startsWith('OK')) { console.error('[clicker] mousedown failed:', down); return false; }
  const up = await sendSimCommand(`UP:${buttonName}`);
  if (!up || !up.startsWith('OK')) { console.error('[clicker] mouseup failed:', up); return false; }
  if (doubleClick) {
    await sleep(50);
    await sendSimCommand(`DOWN:${buttonName}`);
    await sendSimCommand(`UP:${buttonName}`);
  }
  return true;
}

async function clickerTick() {
  if (clickerConfig.cursorMode === 'fixed') {
    await setMousePosition(clickerConfig.fixedX, clickerConfig.fixedY);
  }
  return performClick(simButtonName(clickerConfig.button), clickerConfig.clickType === 'double');
}

let clickerFailCount = 0;
function startClicker() {
  if (isClicking) return { success: true };
  if (!simReady) { console.error('[clicker] start requested but the simulator is not ready'); return { success: false, reason: 'engine-unavailable' }; }
  console.log('[clicker] starting with config:', JSON.stringify(clickerConfig));
  isClicking = true;
  clickerFailCount = 0;
  const loop = async () => {
    if (!isClicking) return;
    const ok = await clickerTick();
    clickerFailCount = ok ? 0 : clickerFailCount + 1;
    if (clickerFailCount >= 2) {
      stopClicker();
      if (mainWindow) mainWindow.webContents.send('engine-notice', {
        context: 'clicker',
        message: 'Auto-clicker stopped itself -- the click simulation is failing. Open DevTools (F12) → Console and look for "[clicker]" or "[simulator]" lines for the exact error.'
      });
      return;
    }
    if (isClicking) clickerTimer = setTimeout(loop, Math.max(5, clickerConfig.intervalMs));
  };
  loop();
  return { success: true };
}
function stopClicker() {
  isClicking = false;
  if (clickerTimer) clearTimeout(clickerTimer);
  clickerTimer = null;
  return { success: true };
}

// ---------------------------------------------------------------------------
// Macro recording (captures the user's own input only while REC is active)
// ---------------------------------------------------------------------------
let isRecording = false;
let recordedSteps = [];
let recordStartTime = 0;

function startRecording() {
  if (!uiohookReady) return { success: false, reason: 'engine-unavailable' };
  isRecording = true;
  recordedSteps = [];
  recordStartTime = Date.now();
  return { success: true };
}
function stopRecording() {
  isRecording = false;
  return { steps: recordedSteps, duration: Date.now() - recordStartTime };
}

// ---------------------------------------------------------------------------
// Macro playback
// ---------------------------------------------------------------------------
let isPlaying = false;
let playbackShouldStop = false;
let playbackPaused = false;

async function executeStep(step) {
  if (!simReady) return;
  try {
    if (step.type === 'move') {
      await setMousePosition(step.x, step.y);
    } else if (step.type === 'mouse') {
      const btn = simButtonName(step.button === 2 ? 'right' : step.button === 1 ? 'middle' : 'left');
      await setMousePosition(step.x, step.y);
      if (step.action === 'down') await sendSimCommand(`DOWN:${btn}`);
      else if (step.action === 'up') await sendSimCommand(`UP:${btn}`);
    } else if (step.type === 'key') {
      const vk = mapKeyNameToVK(step.name);
      if (vk !== null) {
        if (step.action === 'down') await sendSimCommand(`KEYDOWN:${vk}`);
        else if (step.action === 'up') await sendSimCommand(`KEYUP:${vk}`);
      }
    }
  } catch (err) {
    console.error('[playback] step failed:', err.message);
    if (!currentSettings.autoLoopOnError) throw err;
  }
}

async function playMacroSteps(steps, name) {
  if (isPlaying) return { success: false, reason: 'already-playing' };
  if (!simReady) return { success: false, reason: 'engine-unavailable' };
  isPlaying = true;
  playbackShouldStop = false;
  const floor = currentSettings.fastPlaybackSafety ? 5 : 0;
  const playbackStart = Date.now();
  let pausedDuration = 0;
  try {
    for (const step of steps) {
      while (playbackPaused && !playbackShouldStop) {
        const pauseStart = Date.now();
        await sleep(50);
        pausedDuration += Date.now() - pauseStart;
      }
      if (playbackShouldStop) break;
      // Wait based on how far real elapsed time is from the recorded target,
      // not just the gap since the last step -- this way, any time a step's
      // own execution (the PowerShell round-trip) takes a few ms longer than
      // expected, the NEXT wait shortens to compensate instead of the delay
      // silently stacking up over the whole macro.
      const targetElapsed = Math.max(0, step.t);
      const actualElapsed = Date.now() - playbackStart - pausedDuration;
      const wait = Math.max(floor, targetElapsed - actualElapsed);
      if (wait > 0) await sleep(wait);
      await executeStep(step);
    }
    isPlaying = false;
    if (mainWindow) mainWindow.webContents.send('playback-finished', { success: true });
    fireWebhook({ name: name || 'Macro', event: 'Successfully', status: 'OK' });
    return { success: true };
  } catch (err) {
    isPlaying = false;
    if (mainWindow) mainWindow.webContents.send('playback-finished', { success: false, error: err.message });
    fireWebhook({ name: name || 'Macro', event: 'with an Error', status: 'ERROR' });
    return { success: false, error: err.message };
  }
}
function stopPlayback() { playbackShouldStop = true; playbackPaused = false; return { success: true }; }
function togglePlaybackPause() {
  if (!isPlaying) return { paused: false };
  playbackPaused = !playbackPaused;
  return { paused: playbackPaused };
}

// ---------------------------------------------------------------------------
// Global hotkeys -- driven entirely off uiohook's live keydown/keyup stream,
// so combos work no matter which window (or app) currently has focus.
// ---------------------------------------------------------------------------
let heldKeys = new Set();
let registeredHotkeys = new Map(); // id -> { keys: string[], action: string }
let comboFired = new Set();

let isCapturingHotkey = false;
let capturingSet = new Set();
let capturingResolve = null;
let captureFinalizeTimer = null;

function startHotkeyCapture() {
  return new Promise((resolve) => {
    isCapturingHotkey = true;
    capturingSet = new Set();
    capturingResolve = resolve;
  });
}
function cancelHotkeyCapture() {
  finalizeCaptureAndResolve(null);
}
function finalizeCaptureAndResolve(result) {
  isCapturingHotkey = false;
  clearTimeout(captureFinalizeTimer);
  if (capturingResolve) { capturingResolve(result); capturingResolve = null; }
}
function handleCapturingKeydown(name) {
  if (name === 'Escape' && capturingSet.size === 0) { finalizeCaptureAndResolve(null); return; }
  capturingSet.add(name);
  if (mainWindow) mainWindow.webContents.send('hotkey-live-update', Array.from(capturingSet));
  if (capturingSet.size >= 3) finalizeCaptureAndResolve(Array.from(capturingSet));
}
function handleCapturingKeyup() {
  if (capturingSet.size === 0) return;
  clearTimeout(captureFinalizeTimer);
  captureFinalizeTimer = setTimeout(() => finalizeCaptureAndResolve(Array.from(capturingSet)), 400);
}

function comboMatches(comboKeys) {
  return comboKeys.length > 0 && comboKeys.every((k) => heldKeys.has(k)) && heldKeys.size === comboKeys.length;
}
function checkHotkeyMatch(direction) {
  for (const [id, hk] of registeredHotkeys) {
    const matches = comboMatches(hk.keys);
    if (direction === 'down' && matches && !comboFired.has(id)) {
      comboFired.add(id);
      if (mainWindow) mainWindow.webContents.send('hotkey-triggered', { id, action: hk.action, phase: 'down' });
    } else if (direction === 'up' && comboFired.has(id) && !matches) {
      comboFired.delete(id);
      if (mainWindow) mainWindow.webContents.send('hotkey-triggered', { id, action: hk.action, phase: 'up' });
    }
  }
}

if (uiohookReady) {
  uIOhook.on('keydown', (e) => {
    const name = keycodeToName.get(e.keycode);
    if (name) {
      heldKeys.add(name);
      if (isCapturingHotkey) handleCapturingKeydown(name);
      else checkHotkeyMatch('down');
    }
    if (isRecording) recordedSteps.push({ type: 'key', action: 'down', name, t: Date.now() - recordStartTime });
  });
  uIOhook.on('keyup', (e) => {
    const name = keycodeToName.get(e.keycode);
    if (name) {
      heldKeys.delete(name);
      if (isCapturingHotkey) handleCapturingKeyup();
      else checkHotkeyMatch('up');
    }
    if (isRecording) recordedSteps.push({ type: 'key', action: 'up', name, t: Date.now() - recordStartTime });
  });
  let lastMoveRecordedAt = 0;
  uIOhook.on('mousedown', (e) => {
    if (isRecording) {
      if (typeof e.x !== 'number' || typeof e.y !== 'number') {
        console.error('[record] mousedown event missing x/y — got:', JSON.stringify(e));
      } else {
        recordedSteps.push({ type: 'mouse', action: 'down', button: e.button, x: e.x, y: e.y, t: Date.now() - recordStartTime });
      }
    }
  });
  uIOhook.on('mouseup', (e) => {
    if (isRecording) {
      if (typeof e.x !== 'number' || typeof e.y !== 'number') {
        console.error('[record] mouseup event missing x/y — got:', JSON.stringify(e));
      } else {
        recordedSteps.push({ type: 'mouse', action: 'up', button: e.button, x: e.x, y: e.y, t: Date.now() - recordStartTime });
      }
    }
  });
  uIOhook.on('mousemove', (e) => {
    if (!isRecording) return;
    const now = Date.now();
    if (now - lastMoveRecordedAt < 20) return; // throttle to ~50 samples/sec -- smoother path without excessive step count
    if (typeof e.x !== 'number' || typeof e.y !== 'number') return;
    lastMoveRecordedAt = now;
    recordedSteps.push({ type: 'move', x: e.x, y: e.y, t: now - recordStartTime });
  });
  try { uIOhook.start(); } catch (err) { console.error('[engine] uIOhook.start() failed:', err.message); }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
let webhookConfig = {
  url: '', triggerCondition: 'always', embedColor: 'auto', mentionTag: '',
  messageTemplate: 'Macro "{name}" finished {event} at {time} | Box Area: {resolution}',
  lastRegion: 'X: 150 | Y: 100 | W: 300 | H: 200',
  lastRegionBounds: { x: 150, y: 100, w: 300, h: 200 },
  attachScreenshot: true
};
const EMBED_COLORS = { auto: 0x5a57f5, green: 0x10b981, red: 0xef4444, blue: 0x3b82f6 };

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

async function sendWebhookNow(vars, { manual = false } = {}) {
  const cfg = webhookConfig;
  if (!cfg.url) return { success: false, error: 'No webhook URL configured' };
  const fullVars = {
    time: new Date().toLocaleTimeString(),
    resolution: cfg.lastRegion,
    user: os.userInfo().username,
    ...vars
  };
  const message = fillTemplate(cfg.messageTemplate, fullVars);
  const isDiscord = cfg.url.includes('discord.com/api/webhooks');

  let screenshotBuffer = null;
  if (isDiscord && cfg.attachScreenshot !== false) {
    screenshotBuffer = await captureRegionScreenshot(cfg.lastRegionBounds).catch(() => null);
  }

  try {
    if (isDiscord) {
      const status = (fullVars.status || '').toUpperCase();
      const statusEmoji = status === 'OK' ? '✅' : status === 'ERROR' ? '⚠️' : 'ℹ️';
      const resolvedColor = (cfg.embedColor && cfg.embedColor !== 'auto')
        ? (EMBED_COLORS[cfg.embedColor] ?? EMBED_COLORS.auto)
        : (status === 'OK' ? EMBED_COLORS.green : status === 'ERROR' ? EMBED_COLORS.red : EMBED_COLORS.auto);

      const embed = {
        author: { name: 'ZenTask Pro Utility' },
        title: `${statusEmoji}  ${fullVars.name || 'Macro'}`,
        description: message,
        color: resolvedColor,
        fields: [
          { name: 'Status', value: status || '—', inline: true },
          { name: 'User', value: fullVars.user || '—', inline: true }
        ],
        footer: { text: 'ZenTask Pro Utility  •  ' + (fullVars.resolution || '') },
        timestamp: new Date().toISOString()
      };
      if (screenshotBuffer) embed.image = { url: 'attachment://screenshot.png' };

      const payload = { content: cfg.mentionTag || undefined, embeds: [embed] };
      let res;
      if (screenshotBuffer) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        form.append('files[0]', new Blob([screenshotBuffer], { type: 'image/png' }), 'screenshot.png');
        res = await fetch(cfg.url, { method: 'POST', body: form });
      } else {
        res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      }
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      return { success: true, screenshotAttached: !!screenshotBuffer };
    } else {
      const body = { text: (cfg.mentionTag ? cfg.mentionTag + ' ' : '') + '*ZenTask Pro Utility*\n' + message };
      const res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      return { success: true, screenshotAttached: false };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}
function fireWebhook(vars) {
  const cond = webhookConfig.triggerCondition;
  if (cond === 'success' && vars.status !== 'OK') return;
  if (cond === 'error' && vars.status === 'OK') return;
  if (!webhookConfig.url) return;
  sendWebhookNow(vars, { manual: false }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Window listing -- uses PowerShell + Win32 GetWindowRect instead of nut.js,
// since Get-Process | Where MainWindowTitle reliably returns only real,
// visible, taskbar-style application windows (not every hidden/system
// window on the box).
// ---------------------------------------------------------------------------
const OWN_WINDOW_TITLES = new Set(['ZenTask Pro Utility']);

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: timeoutMs || 8000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.error('[powershell] execution failed:', err.message, stderr ? ('| stderr: ' + stderr) : '');
          resolve(null);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function listOpenWindows() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZTWin32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $rect = New-Object ZTWin32+RECT
  [ZTWin32]::GetWindowRect($_.MainWindowHandle, [ref]$rect) | Out-Null
  "$($_.MainWindowTitle)|$($rect.Left)|$($rect.Top)|$($rect.Right - $rect.Left)|$($rect.Bottom - $rect.Top)"
}
`.trim();

  const stdout = await runPowerShell(script);
  if (!stdout) return [];
  const seen = new Set();
  const results = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (parts.length !== 5) continue;
    const [title, x, y, w, h] = parts;
    if (!title || OWN_WINDOW_TITLES.has(title) || seen.has(title)) continue;
    const width = parseInt(w, 10), height = parseInt(h, 10);
    if (!width || !height || width <= 0 || height <= 0) continue;
    seen.add(title);
    results.push({ title, x: parseInt(x, 10), y: parseInt(y, 10), w: width, h: height });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Screenshot capture -- also PowerShell-based (System.Drawing), so it doesn't
// depend on nut.js's screenshot API, which has changed shape across versions.
// ---------------------------------------------------------------------------
function captureRegionScreenshot(bounds) {
  return new Promise((resolve) => {
    if (!bounds || !bounds.w || !bounds.h || bounds.w <= 0 || bounds.h <= 0) { resolve(null); return; }
    const tmpFile = path.join(os.tmpdir(), `zentask-shot-${Date.now()}.png`);
    const psPath = tmpFile.replace(/\\/g, '/'); // forward slashes are valid on Windows and avoid PS/JS escaping headaches
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap ${Math.round(bounds.w)}, ${Math.round(bounds.h)}
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen(${Math.round(bounds.x)}, ${Math.round(bounds.y)}, 0, 0, (New-Object System.Drawing.Size ${Math.round(bounds.w)}, ${Math.round(bounds.h)}))
$bitmap.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`.trim();
    runPowerShell(script, 8000).then(() => {
      try {
        const buf = fs.readFileSync(tmpFile);
        fs.unlink(tmpFile, () => {});
        resolve(buf);
      } catch (readErr) {
        console.error('[screenshot] read failed:', readErr.message);
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IPC wiring
// ---------------------------------------------------------------------------
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-close', () => mainWindow && mainWindow.close());
ipcMain.on('resize-window', (e, { width, height }) => {
  if (!mainWindow || !width || !height) return;
  const workArea = electronScreen.getPrimaryDisplay().workAreaSize;
  const w = Math.round(Math.min(Math.max(width, 260), workArea.width - 40));
  const h = Math.round(Math.min(Math.max(height, 100), workArea.height - 60));
  mainWindow.setSize(w, h);
});

ipcMain.handle('get-cursor-position', async () => {
  if (!simReady) return { x: 0, y: 0 };
  const res = await sendSimCommand('GETPOS');
  if (res && res.startsWith('POS:')) {
    const parts = res.split(':');
    return { x: parseInt(parts[1], 10) || 0, y: parseInt(parts[2], 10) || 0 };
  }
  return { x: 0, y: 0 };
});
ipcMain.handle('open-point-picker', async () => openOverlay('point'));
ipcMain.handle('open-box-picker', async () => openOverlay('box'));
ipcMain.handle('list-windows', async () => listOpenWindows());

ipcMain.on('overlay-result', (e, data) => {
  if (data && data.w !== undefined) {
    webhookConfig.lastRegion = `X: ${data.x} | Y: ${data.y} | W: ${data.w} | H: ${data.h}`;
    webhookConfig.lastRegionBounds = { x: data.x, y: data.y, w: data.w, h: data.h };
  }
  closeOverlayWith(data);
});
ipcMain.on('overlay-cancel', () => closeOverlayWith(null));

ipcMain.handle('clicker-set-config', (e, config) => { clickerConfig = { ...clickerConfig, ...config }; return { success: true }; });
ipcMain.handle('clicker-start', () => startClicker());
ipcMain.handle('clicker-stop', () => stopClicker());

ipcMain.handle('record-start', () => startRecording());
ipcMain.handle('record-stop', () => stopRecording());
ipcMain.handle('macro-play', (e, { steps, name } = {}) => playMacroSteps(steps || [], name));
ipcMain.handle('macro-stop', () => stopPlayback());
ipcMain.handle('macro-pause', () => togglePlaybackPause());

ipcMain.handle('macros-load', () => loadJSON(macrosFile, []));
ipcMain.handle('macros-save', (e, macros) => ({ success: saveJSON(macrosFile, macros) }));
ipcMain.handle('macros-import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'ZenTask Macro', extensions: ['json'] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  try { return JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8')); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('settings-load', () => currentSettings);
ipcMain.handle('settings-save', (e, settings) => {
  currentSettings = { ...currentSettings, ...settings };
  saveJSON(settingsFile, currentSettings);
  try { app.setLoginItemSettings({ openAtLogin: !!currentSettings.runAtStartup }); } catch {}
  return { success: true, restartNeededFor: ['hardwareAccel'] };
});

ipcMain.handle('hotkey-capture-start', () => startHotkeyCapture());
ipcMain.on('hotkey-capture-cancel', () => cancelHotkeyCapture());
ipcMain.handle('hotkey-register', (e, { id, keys, action }) => { registeredHotkeys.set(id, { keys, action }); return { success: true }; });
ipcMain.handle('hotkey-unregister', (e, { id }) => { registeredHotkeys.delete(id); comboFired.delete(id); return { success: true }; });

ipcMain.handle('webhook-set-config', (e, config) => { webhookConfig = { ...webhookConfig, ...config }; return { success: true }; });
ipcMain.handle('webhook-send-test', async () => {
  return sendWebhookNow({ name: 'Test Message', event: 'Successfully', status: 'OK' }, { manual: true });
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  try { app.setLoginItemSettings({ openAtLogin: !!currentSettings.runAtStartup }); } catch {}
  startSimulatorProcess();
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  if (uiohookReady) { try { uIOhook.stop(); } catch {} }
  if (simProcess) { try { simProcess.kill(); } catch {} }
});
