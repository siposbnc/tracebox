// Remove electron-builder's unpacked staging output (and any leftover *.tmp) from
// `release/`. Used by the packaging retry wrapper (scripts/dist.mjs) and runnable
// directly (`npm run clean:release`). Installer artifacts in `release/` are left
// untouched. Per-directory errors are swallowed: a still-locked dir is cleared by
// electron-builder on its next run anyway.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function cleanRelease() {
  // npm runs scripts with the package root as cwd, so these resolve to ./release.
  for (const dir of ['win-unpacked', 'win-unpacked.tmp', 'linux-unpacked', 'linux-unpacked.tmp']) {
    try {
      rmSync(`release/${dir}`, { recursive: true, force: true });
    } catch {
      // locked (e.g. antivirus mid-scan) — ignore; the packager retries/cleans itself
    }
  }
}

// Run when invoked directly: `node scripts/clean-release.mjs`.
if (process.argv[1] === fileURLToPath(import.meta.url)) cleanRelease();
