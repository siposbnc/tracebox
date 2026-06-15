// Bridge injected by the Electron preload script (absent in plain web mode).
export {};

export type UpdateStatus =
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

declare global {
  interface Window {
    tracebox?: {
      openFileDialog(): Promise<string | null>;
      getPathForFile(file: File): string;
      onOpenPath(callback: (path: string) => void): void;
      onUpdateStatus(callback: (status: UpdateStatus) => void): void;
      installUpdate(): void;
    };
  }
}
