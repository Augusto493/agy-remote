// Agy Remote — programa para Windows.
// Roda o servidor ponte dentro do app, mostra a interface numa janela e fica na bandeja do sistema
// para o celular continuar conectado mesmo com a janela fechada.
'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, clipboard, dialog, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.agyremote.desktop');

const isPackaged = app.isPackaged;
const res = (...p) => (isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '..', ...p));
const ICON = isPackaged ? path.join(__dirname, 'build', 'icon.png') : path.join(__dirname, 'build', 'icon.png');
const startHidden = process.argv.includes('--hidden');

// Dados do servidor ficam em %APPDATA%\Agy Remote\data (sobrevivem a atualizações).
const dataDir = path.join(app.getPath('userData'), 'data');
fs.mkdirSync(dataDir, { recursive: true });
// Migra dados da versão "solta" (server/data) na primeira execução.
const legacy = path.join(__dirname, '..', 'server', 'data');
if (!fs.existsSync(path.join(dataDir, 'config.json')) && fs.existsSync(path.join(legacy, 'config.json'))) {
  for (const f of fs.readdirSync(legacy)) fs.copyFileSync(path.join(legacy, f), path.join(dataDir, f));
}
process.env.AGY_REMOTE_DATA = dataDir;
process.env.AGY_REMOTE_APK = res('AgyRemote.apk');

let server, win, tray, quitting = false, serverError = null, hintShown = false;

function baseUrl() { return `http://localhost:${server.info().port}`; }

function overlayColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#000000', symbolColor: '#f5f5f5', height: 40 }
    : { color: '#ffffff', symbolColor: '#0a0a0a', height: 40 };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 420, minHeight: 520,
    title: 'Agy Remote', icon: ICON, backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    autoHideMenuBar: true, show: !startHidden,
    titleBarStyle: 'hidden', titleBarOverlay: overlayColors(),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  nativeTheme.on('updated', () => { try { win.setTitleBarOverlay(overlayColors()); } catch {} });
  win.removeMenu();
  if (serverError) win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage(serverError)));
  else win.loadURL(baseUrl());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!hintShown && Notification.isSupported()) {
      hintShown = true;
      new Notification({ title: 'Agy Remote continua rodando', body: 'O celular segue conectado. Para sair de verdade, use o ícone na bandeja → Sair.', icon: ICON }).show();
    }
  });
}

function errorPage(err) {
  const busy = err.code === 'EADDRINUSE';
  return `<body style="background:#1c1b19;color:#ece8e1;font:15px system-ui;padding:40px">
    <h2>Não consegui iniciar o servidor</h2>
    <p>${busy ? 'A porta 8790 já está em uso — provavelmente o "Iniciar Agy Remote.cmd" está aberto. Feche aquela janela e abra o programa de novo.' : String(err.message)}</p></body>`;
}

function showWindow(js) {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  if (js) win.webContents.executeJavaScript(js).catch(() => {});
}

function fmtTok(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + ' mi' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }

function buildTray() {
  const info = server && !serverError ? server.info() : null;
  let today = null;
  try { today = server.usage().totals.today; } catch {}
  const login = app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  const addr = info && info.addresses[0] ? `http://${info.addresses[0].ip}:${info.port}` : null;
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir Agy Remote', click: () => showWindow(), type: 'normal' },
    { type: 'separator' },
    ...(info ? [
      { label: `Código de pareamento: ${info.pairCode}`, click: () => clipboard.writeText(info.pairCode) },
      ...(addr ? [{ label: `Endereço p/ celular: ${addr.replace('http://', '')}`, click: () => clipboard.writeText(addr) }] : []),
      { label: 'Conectar celular…', click: () => showWindow("go('settings')") },
      { type: 'separator' },
      ...(() => {
        let act = [];
        try { act = server.missions().filter((m) => ['planejando', 'executando', 'integrando', 'aguardando'].includes(m.state)).sort((a, b) => b.updatedAt - a.updatedAt); } catch {}
        return [{ label: act.length ? `💬 Chat dos agentes (${act.length} missão${act.length > 1 ? 'ões' : ''} ativa${act.length > 1 ? 's' : ''})` : '💬 Chat dos agentes',
          click: () => (act.length ? openMini(act[0].id) : showWindow("go('os')")) }];
      })(),
      { label: info.activeRuns ? `⏳ ${info.activeRuns} tarefa(s) rodando` : 'Nenhuma tarefa rodando', enabled: false },
      ...(today ? [{ label: `Hoje: ${fmtTok(today.total)} tokens · ${today.turns} respostas`, click: () => showWindow("go('usage')") }] : []),
    ] : [{ label: 'Servidor parado', enabled: false }]),
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows', type: 'checkbox', checked: login,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); buildTray(); },
    },
    { label: 'Abrir pasta de dados', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(info ? `Agy Remote — ${info.activeRuns ? info.activeRuns + ' tarefa(s) rodando' : 'pronto'} · código ${info.pairCode}` : 'Agy Remote — servidor parado');
}

app.whenReady().then(async () => {
  try {
    server = require(res('server', 'server.js'));
  } catch (e) {
    dialog.showErrorBox('Agy Remote', 'Falha ao carregar o servidor: ' + e.message);
    app.quit(); return;
  }
  await new Promise((resolve) => {
    server.events.once('ready', resolve);
    server.events.once('error', (err) => { serverError = err; resolve(); });
  });

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', () => showWindow());
  buildTray();
  setInterval(buildTray, 30000);

  server.events.on('run-start', () => buildTray());
  server.events.on('run-done', (r) => {
    buildTray();
    const focused = win && win.isVisible() && win.isFocused();
    if (focused || !Notification.isSupported()) return;
    const body = (r.text || (r.status === 'SUCCESS' ? 'Concluído' : 'Terminou: ' + r.status)).replace(/[*`#]/g, '').slice(0, 180);
    const n = new Notification({ title: r.title ? 'Pronto: ' + r.title : 'Resposta pronta', body, icon: ICON });
    n.on('click', () => showWindow(r.convId ? `openConv(${JSON.stringify(r.convId)})` : ''));
    n.show();
  });

  createWindow();
});

ipcMain.handle('set-theme', (_e, mode) => {
  nativeTheme.themeSource = ['light', 'dark'].includes(mode) ? mode : 'system';
  try { win.setTitleBarOverlay(overlayColors()); win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff'); } catch {}
});

// ---------- mini-janela do chat dos agentes (sempre por cima) ----------
let mini = null;
function openMini(missionId) {
  if (!server || serverError) return;
  const url = `${baseUrl()}/?mini=${encodeURIComponent(missionId || '')}`;
  if (mini && !mini.isDestroyed()) { mini.loadURL(url); mini.show(); mini.focus(); return; }
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workArea;
  const w = 420, h = Math.min(720, area.height - 40);
  mini = new BrowserWindow({
    width: w, height: h, x: area.x + area.width - w - 20, y: area.y + area.height - h - 20,
    minWidth: 320, minHeight: 360, title: 'Agentes — Agy Remote', icon: ICON, alwaysOnTop: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff', autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { ...overlayColors(), height: 36 },
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  mini.setAlwaysOnTop(true, 'floating');
  mini.removeMenu();
  mini.loadURL(url);
  mini.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  mini.on('closed', () => { mini = null; });
}
ipcMain.handle('open-mini', (_e, id) => { openMini(id); return true; });
ipcMain.handle('close-mini', () => { if (mini && !mini.isDestroyed()) mini.close(); return true; });
ipcMain.handle('mini-on-top', (_e, on) => { if (mini && !mini.isDestroyed()) mini.setAlwaysOnTop(!!on, 'floating'); return true; });

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Escolher pasta do projeto', properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => { /* fica na bandeja */ });
