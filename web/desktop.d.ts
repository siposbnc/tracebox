// Bridge injected by the Electron preload script (absent in plain web mode).
export {};

declare global {
  interface Window {
    tracebox?: {
      openFileDialog(): Promise<string | null>;
      getPathForFile(file: File): string;
      onOpenPath(callback: (path: string) => void): void;
    };
  }
}
