// Electron shell: runs the local server inside the app and shows the UI in a window.
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, powerSaveBlocker } = require("electron");
const path = require("path");

const isMac = process.platform === "darwin";
const PORT = 38211; // fixed so saved watches (localStorage) persist between launches
process.env.PORT = PORT;

// Windows only shows notifications for apps that have an app ID.
if (process.platform === "win32") app.setAppUserModelId("com.campsitewatcher.app");

// One copy only: a second launch just brings the first window forward.
if (!app.requestSingleInstanceLock()) app.quit();
else require("./server");
app.on("second-instance", () => showWindow());

let win, tray, quitting = false, toldAboutTray = false;
app.on("before-quit", () => { quitting = true; });

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 960, minHeight: 600, // wide enough to keep the side-by-side layout
    title: "Campsite Watcher", backgroundColor: "#dcebf7", icon: path.join(__dirname, "icon.png"),
    // Mac: content runs under the traffic lights. Windows: normal title bar, no File/Edit menu.
    ...(isMac ? { titleBarStyle: "hiddenInset" } : { autoHideMenuBar: true }),
    // The checks run in this page, so keep its timers at full speed while the window is hidden.
    webPreferences: { backgroundThrottling: false },
  });
  win.loadURL(`http://localhost:${PORT}`);
  // Mac: the title bar is hidden, so add a strip along the top to drag the window by.
  if (isMac) win.webContents.on("did-finish-load", () => win.webContents.insertCSS(
    '.side::before,.main::before{content:"";position:fixed;top:0;left:0;right:0;height:32px;-webkit-app-region:drag;z-index:5}'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });

  // Closing the window hides it so watching carries on. Quit from the Dock / Cmd+Q on Mac,
  // or from the tray icon on Windows.
  win.on("close", e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (tray && !toldAboutTray && process.platform === "win32") {
      toldAboutTray = true;
      tray.displayBalloon({ title: "Campsite Watcher is still watching",
        content: "It keeps checking in the background. Right-click the tent icon to open it or quit." });
    }
  });
  // Let Windows shut down or log off without the hidden window holding things up.
  win.on("query-session-end", () => { quitting = true; });
  win.on("session-end", () => { quitting = true; });
  win.on("closed", () => { win = null; });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 32, height: 32, quality: "best" });
  tray = new Tray(img);
  tray.setToolTip("Campsite Watcher");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Campsite Watcher", click: showWindow },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
}

app.whenReady().then(() => {
  powerSaveBlocker.start("prevent-app-suspension"); // keep checking while idle
  createWindow();
  if (!isMac) createTray(); // Windows has no Dock, so the tray icon is how you get back to it
});
app.on("window-all-closed", () => {}); // stay running in the background
app.on("activate", () => showWindow()); // Mac: clicking the Dock icon
