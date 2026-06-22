import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, writeFileSync, type WriteStream } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

/**
 * A live byte source — a spawned shell command, or any readable stream — spooled
 * to a capture file on disk. A {@link LogSession} indexes and tail-follows that
 * file exactly as it would a plain log: the producer here just keeps appending
 * bytes.
 *
 * Emits `wrote` (throttled) when new bytes have been captured, and `exit` once
 * the producer ends (process exit, stream end, a `stop()`, or a spawn failure).
 */

/** running: producer active; exited: ended normally; failed: never started (e.g. command not found). */
export type CaptureState = 'running' | 'exited' | 'failed';

export interface CaptureStatus {
  command: string;
  state: CaptureState;
  pid: number | null;
  /** Process exit code (null while running, on a signal kill, or for stdin). */
  exitCode: number | null;
  bytes: number;
  error: string | null;
}

/** Coalesce the byte-arrival notifications the session reacts to. */
const NOTIFY_MS = 120;

export class CaptureSource extends EventEmitter {
  /** Human-readable label for the producer (the command line, or `(stdin)`). */
  readonly command: string;
  /** Path of the capture file the session reads. */
  readonly file: string;

  state: CaptureState = 'running';
  pid: number | null = null;
  exitCode: number | null = null;
  bytes = 0;
  error: string | null = null;

  private child: ChildProcess | null = null;
  private readonly out: WriteStream;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;
  /** The producer streams being spooled, so reading can be paused/resumed. */
  private readonly streams: Readable[] = [];
  private paused = false;

  /**
   * `stdin` (when given) is piped instead of spawning a process — capturing an
   * already-open stream. Otherwise `command` is run through the system shell so
   * pipes, globs, and env vars behave as the user expects; its stderr is merged
   * into the capture unless `mergeStderr` is `false`.
   */
  constructor(opts: { command: string; file: string; mergeStderr?: boolean; stdin?: Readable }) {
    super();
    this.command = opts.command;
    this.file = opts.file;
    // create the file up front so the session can stat it before any bytes land
    writeFileSync(this.file, '');
    this.out = createWriteStream(this.file, { flags: 'a' });
    this.out.on('error', (err) => this.fail(err));
    if (opts.stdin) {
      this.follow(opts.stdin);
      opts.stdin.on('end', () => this.finish('exited'));
      opts.stdin.on('error', (err) => this.fail(err));
    } else {
      this.spawnCommand(opts.command, opts.mergeStderr !== false);
    }
  }

  private spawnCommand(command: string, mergeStderr: boolean): void {
    let child: ChildProcess;
    try {
      child = spawn(command, { shell: true });
    } catch (err) {
      this.fail(err);
      return;
    }
    this.child = child;
    this.pid = child.pid ?? null;
    child.on('error', (err) => this.fail(err));
    child.on('exit', (code) => {
      this.exitCode = code;
      this.finish('exited');
    });
    if (child.stdout) this.follow(child.stdout);
    if (mergeStderr && child.stderr) this.follow(child.stderr);
  }

  /** Pipe one producer stream into the capture file, counting bytes as they pass. */
  private follow(src: Readable): void {
    this.streams.push(src);
    src.on('data', (chunk: Buffer) => {
      this.bytes += chunk.length;
      this.scheduleNotify();
    });
    src.pipe(this.out, { end: false });
    if (this.paused) src.pause();
  }

  /**
   * Pause spooling the producer's output. The streams stop flowing, which back-
   * pressures the process (its pipe buffer fills and it blocks) — so a paused
   * capture stops growing. {@link resume} continues where it left off. No-op once
   * the producer has ended.
   */
  pause(): void {
    if (this.ended || this.paused) return;
    this.paused = true;
    for (const s of this.streams) s.pause();
  }

  resume(): void {
    if (this.ended || !this.paused) return;
    this.paused = false;
    for (const s of this.streams) s.resume();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer || this.ended) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.emit('wrote');
    }, NOTIFY_MS);
  }

  private fail(err: unknown): void {
    this.error = err instanceof Error ? err.message : String(err);
    this.finish('failed');
  }

  /** Finalize exactly once: flush the capture, mark terminal state, notify. */
  private finish(state: CaptureState): void {
    if (this.ended) return;
    this.ended = true;
    if (this.state === 'running') this.state = state;
    this.out.end();
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    // a final 'wrote' lets the session drain the last bytes before it stops following
    this.emit('wrote');
    this.emit('exit');
  }

  /** Stop the producer but keep the captured data (the session freezes, still searchable). */
  stop(): void {
    if (this.ended) return;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // already gone — the exit handler will finalize
      }
    } else {
      this.finish('exited');
    }
  }

  status(): CaptureStatus {
    return {
      command: this.command,
      state: this.state,
      pid: this.pid,
      exitCode: this.exitCode,
      bytes: this.bytes,
      error: this.error,
    };
  }
}
