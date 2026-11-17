/**
 * Thin adapter around the `tmux` CLI.
 *
 * tmux's own session registry is the single source of truth for "is there a
 * resumable session for this server?" — the app keeps no lock files or state of
 * its own (see docs/DESIGN.md for why).
 */
import type { ProcessRunner } from "../util/shell.ts";

/** tmux forbids `.` and `:` in session names (they are target separators); be conservative. */
export function tmuxSessionName(prefix: string, serverName: string): string {
  const raw = `${prefix}${serverName}`;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe === "" ? "ssh-session" : safe;
}

export class Tmux {
  private availableCache: boolean | null = null;
  private versionCache: string | null | undefined;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Is the `tmux` binary on PATH? Cached for the lifetime of the app. */
  isAvailable(): boolean {
    if (this.availableCache === null) this.availableCache = this.runner.commandExists("tmux");
    return this.availableCache;
  }

  /** Reset the cached availability (used by "refresh"). */
  recheck(): boolean {
    this.availableCache = null;
    this.versionCache = undefined;
    return this.isAvailable();
  }

  version(): string | null {
    if (this.versionCache !== undefined) return this.versionCache;
    if (!this.isAvailable()) return (this.versionCache = null);
    try {
      this.versionCache = this.runner.capture(["tmux", "-V"]).trim().replace(/^tmux\s+/, "");
    } catch {
      this.versionCache = null;
    }
    return this.versionCache;
  }

  /** True when the app itself runs inside a tmux client. */
  isInside(): boolean {
    return typeof this.env.TMUX === "string" && this.env.TMUX !== "";
  }

  /** Names of all live sessions; empty when tmux is missing or no server is running. */
  listSessions(): string[] {
    if (!this.isAvailable()) return [];
    try {
      const out = this.runner.capture(["tmux", "list-sessions", "-F", "#{session_name}"]);
      return out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  hasSession(name: string): boolean {
    if (!this.isAvailable()) return false;
    try {
      // `=` forces an exact match instead of tmux's prefix matching.
      this.runner.capture(["tmux", "has-session", "-t", `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Create a detached session whose single window runs `shellCommand` (through `sh -c`). */
  newSessionDetached(name: string, shellCommand: string, windowName = "ssh"): void {
    this.runner.capture(["tmux", "new-session", "-d", "-s", name, "-n", windowName, shellCommand]);
  }

  /** argv to attach the current terminal to a session (used when *outside* tmux). */
  attachArgv(name: string): string[] {
    return ["tmux", "attach-session", "-t", `=${name}`];
  }

  /** Switch the current tmux client to another session (used when *inside* tmux). */
  switchClient(name: string): void {
    this.runner.capture(["tmux", "switch-client", "-t", `=${name}`]);
  }

  killSession(name: string): boolean {
    try {
      this.runner.capture(["tmux", "kill-session", "-t", `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }
}
