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
});
