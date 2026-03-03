const path = require("path");
const express = require("express");
const { app, BrowserWindow } = require("electron");

let server;
let win;

async function startStaticServer() {
  const web = express();
  const staticRoot = path.join(__dirname, "..");

  web.use(express.static(staticRoot, { index: "index.html" }));

  return new Promise((resolve, reject) => {
    server = web.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind local server"));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}`);
    });

    server.on("error", reject);
  });
}

async function createWindow() {
  const url = await startStaticServer();

  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadURL(url);
}

app.whenReady().then(createWindow).catch((err) => {
  console.error("App boot failed:", err);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

app.on("before-quit", () => {
  if (server) {
    server.close();
  }
});
