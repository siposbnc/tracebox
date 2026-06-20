// Exposes a minimal desktop bridge to the TraceBox web UI. The UI detects
// `window.tracebox` to switch on desktop behaviors (native dialogs, drag &
// drop with real paths, OS "open with" events).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tracebox', {
  /** Native file picker; resolves to an absolute path or null if cancelled. */
  openFileDialog: () => ipcRenderer.invoke('tracebox:open-dialog'),
  /** Real filesystem path of a DataTransfer File (drag & drop). */
  getPathForFile: (file) => webUtils.getPathForFile(file),
  /** Files arriving from the OS (CLI args, "Open with", second instances). */
  onOpenPath: (callback) => {
    ipcRenderer.on('tracebox:open-path', (_event, filePath) => callback(filePath));
  },
  /** Auto-update lifecycle: available → downloading → ready (or error). */
  onUpdateStatus: (callback) => {
    ipcRenderer.on('tracebox:update', (_event, status) => callback(status));
  },
  /** Start downloading an available update (download is opt-in). */
  downloadUpdate: () => ipcRenderer.send('tracebox:download-update'),
  /** Quit and install a downloaded update. */
  installUpdate: () => ipcRenderer.send('tracebox:install-update'),
  /** Raise a native OS notification for a fired watch rule. */
  notify: (payload) => ipcRenderer.send('tracebox:notify', payload),
  /** A clicked watch notification asks the UI to jump to its source line. */
  onNotifyClick: (callback) => {
    ipcRenderer.on('tracebox:notify-click', (_event, payload) => callback(payload));
  },
});
