// Electron shell: runs the local server inside the app and shows the UI in a window.
const { app, BrowserWindow, shell, powerSaveBlocker } = require("electron");
const path = require("path");

const PORT = 38211; // fixed so saved watches (localStorage) persist between launches
process.env.PORT = PORT;

// One copy only: a second launch just brings the first window forward.
if (!app.requestSingleInstanceLock()) app.quit();
else require("./server");
app.on("second-instance", () => { if (win) { win.show(); win.focus(); } else createWindow(); });

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: "Campground Bot", titleBarStyle: "hiddenInset",
    backgroundColor: "#dcebf7", icon: path.join(__dirname, "icon.png"),
  });
  win.loadURL(`http://localhost:${PORT}`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

app.whenReady().then(() => {
  powerSaveBlocker.start("prevent-app-suspension"); // keep checking while idle
  createWindow();
});
// Keep watching in the background after the window is closed (like a normal Mac app).
app.on("window-all-closed", () => {});
app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
