// Packaging wrapper that retries electron-builder on the transient Windows
// `EPERM: ... rename win-unpacked.tmp -> win-unpacked` failure.
//
// electron-builder extracts Electron into `release/win-unpacked.tmp` and renames
// it onto `win-unpacked`. On Windows, antivirus real-time scanning briefly holds a
// handle on the freshly-written files, so the immediate directory rename can fail
// with EPERM — even on a clean `release/`. The lock is transient (hence "delete it
// and re-run works"), so we clean and retry a few times instead of needing a manual
// delete or an antivirus exclusion.
//
// Usage: node scripts/dist.mjs <electron-builder args...>   (e.g. --win, --publish always)
import { spawnSync } from 'node:child_process';
import { cleanRelease } from './clean-release.mjs';

const args = process.argv.slice(2);
const MAX_ATTEMPTS = 3;
// Block synchronously between attempts to give antivirus time to release the handle.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  cleanRelease();
  const result = spawnSync('electron-builder', args, { stdio: 'inherit', shell: true });
  if (result.status === 0) process.exit(0);

  if (attempt < MAX_ATTEMPTS) {
    const wait = attempt * 4000;
    process.stderr.write(
      `\n[dist] electron-builder failed (attempt ${attempt}/${MAX_ATTEMPTS}) — likely a transient ` +
        `Windows file lock (antivirus scanning the extracted files). Cleaning and retrying in ${wait / 1000}s...\n\n`,
    );
    sleep(wait);
  }
}

process.stderr.write(
  `\n[dist] electron-builder still failing after ${MAX_ATTEMPTS} attempts. If this persists, add a ` +
    `Microsoft Defender exclusion for this folder (the EPERM is antivirus locking the extracted files).\n`,
);
process.exit(1);
