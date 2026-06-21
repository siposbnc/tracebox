// Bridge injected by the Electron preload script (absent in plain web mode).
export {};

export type UpdateStatus =
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

/** Payload for a desktop watch-rule notification. */
export interface NotifyPayload {
  title: string;
  body: string;
  sessionId: string;
  lineNo: number | null;
}

declare global {
  interface Window {
    tracebox?: {
      openFileDialog(): Promise<string | null>;
      getPathForFile(file: File): string;
      onOpenPath(callback: (path: string) => void): void;
      onUpdateStatus(callback: (status: UpdateStatus) => void): void;
      downloadUpdate(): void;
      installUpdate(): void;
      /** Raise a native OS notification (desktop app only). */
      notify(payload: NotifyPayload): void;
      /** A clicked notification asks the UI to jump to its source line. */
      onNotifyClick(callback: (payload: { sessionId: string; lineNo: number | null }) => void): void;
      /** How to launch the bundled stdio MCP server (desktop app only). */
      mcpInfo(): Promise<{ execPath: string; script: string; sqliteArgs: string[] }>;
    };
  }
}
