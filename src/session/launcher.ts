/**
 * Starts (or resumes) the SSH session for a server.
 *
 *   mode "tmux"     – the session lives in a tmux session named `<prefix><server>`.
 *                     Existing session → resume (attach / switch-client).
 *                     Otherwise a detached session is created, then attached.
 *                     Inside tmux the app stays open and the client is switched;
 *                     outside tmux the TUI is suspended while `tmux attach` runs.
 *   mode "inline"   – ssh runs in the app's own terminal (TUI suspended). No persistence.
 *   mode "terminal" – a new terminal-emulator window runs the session (tmux-backed
 *                     when tmux is installed, so it is resumable too).
 */
import type { ConnectVia, Defaults, ServerEntry } from "../config/types.ts";
import { shellJoin, type ProcessRunner } from "../util/shell.ts";
import { buildSshCommand, type SshCommand } from "./ssh.ts";
import { detectTerminal } from "./terminal.ts";
import { Tmux, tmuxSessionName } from "./tmux.ts";

export type ResolvedMode = "tmux" | "inline" | "terminal";

/** What the launcher needs from the UI: give the terminal away and take it back. */
export interface LaunchHost {
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

export interface LaunchOutcome {
  mode: ResolvedMode;
  action: "resumed" | "created" | "spawned";
  /** True when a brand-new ssh session was started (and the counter should be bumped). */
  newSession: boolean;
  exitCode?: number;
  message: string;
  warnings: string[];
  command: SshCommand;
}

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

export interface LauncherOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export class Launcher {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string | undefined;

  constructor(
    readonly tmux: Tmux,
    private readonly runner: ProcessRunner,
    options: LauncherOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.home = options.home;
  }

  /** Turn the configured launch mode into what will actually happen on this machine. */
  resolveMode(defaults: Defaults): { mode: ResolvedMode; warning?: string } {
    switch (defaults.launch) {
      case "inline":
        return { mode: "inline" };
      case "terminal":
        return { mode: "terminal" };
      case "tmux":
        if (this.tmux.isAvailable()) return { mode: "tmux" };
        return { mode: "inline", warning: "launch: tmux is configured but tmux is not installed; running inline" };
      case "auto":
      default:
        return this.tmux.isAvailable() ? { mode: "tmux" } : { mode: "inline" };
    }
  }

  sessionNameFor(server: ServerEntry, defaults: Defaults): string {
    return tmuxSessionName(defaults.tmux.session_prefix, server.name);
  }

  /** Names of servers that currently have a live tmux session. */
  activeSessions(servers: readonly ServerEntry[], defaults: Defaults): Set<string> {
    const live = new Set(this.tmux.listSessions());
    const active = new Set<string>();
    if (live.size === 0) return active;
    for (const server of servers) {
      if (live.has(this.sessionNameFor(server, defaults))) active.add(server.name);
    }
    return active;
  }

  hasSession(server: ServerEntry, defaults: Defaults): boolean {
    return this.tmux.hasSession(this.sessionNameFor(server, defaults));
  }

  killSession(server: ServerEntry, defaults: Defaults): boolean {
    return this.tmux.killSession(this.sessionNameFor(server, defaults));
  }

  /** Shell snippet that runs ssh and, optionally, waits for Enter when it fails. */
  sshScript(command: SshCommand, defaults: Defaults): string {
    const ssh = shellJoin(command.argv);
    if (!defaults.tmux.hold_on_error) return ssh;
    return (
      `${ssh}; ec=$?; if [ "$ec" -ne 0 ]; then ` +
      `printf '\\n[sshtui] ssh exited with status %s. Press Enter to close.\\n' "$ec"; read -r _; fi; exit "$ec"`
    );
  }

  async launch(
    server: ServerEntry,
    defaults: Defaults,
    host: LaunchHost,
    options: { via?: ConnectVia } = {},
  ): Promise<LaunchOutcome> {
    const command = buildSshCommand(server, defaults, { via: options.via, home: this.home });
    const { mode, warning } = this.resolveMode(defaults);
    const warnings = warning ? [warning] : [];

    switch (mode) {
      case "tmux":
        return this.launchTmux(server, defaults, command, host, warnings);
      case "terminal":
        return this.launchTerminal(server, defaults, command, warnings);
      case "inline":
      default:
        return this.launchInline(command, host, warnings);
    }
  }

  private async launchInline(command: SshCommand, host: LaunchHost, warnings: string[]): Promise<LaunchOutcome> {
    await host.suspend();
    let exitCode: number;
    try {
      exitCode = this.runner.runInherit(command.argv);
    } finally {
      await host.resume();
    }
    return {
      mode: "inline",
      action: "created",
      newSession: true,
      exitCode,
      message: exitCode === 0 ? `Session to ${command.target} ended` : `ssh to ${command.target} exited with status ${exitCode}`,
      warnings,
      command,
    };
  }

  private async launchTmux(
    server: ServerEntry,
    defaults: Defaults,
    command: SshCommand,
    host: LaunchHost,
    warnings: string[],
  ): Promise<LaunchOutcome> {
    const name = this.sessionNameFor(server, defaults);
    const existed = this.tmux.hasSession(name);
    if (!existed) {
      const script = shellJoin(["sh", "-c", this.sshScript(command, defaults)]);
      this.tmux.newSessionDetached(name, script);
    }

    if (this.tmux.isInside()) {
      this.tmux.switchClient(name);
      return {
        mode: "tmux",
        action: existed ? "resumed" : "created",
        newSession: !existed,
        message: existed ? `Switched to session ${name}` : `Started ${command.target} in tmux session ${name}`,
        warnings,
        command,
      };
    }

    await host.suspend();
    let exitCode: number;
    try {
      exitCode = this.runner.runInherit(this.tmux.attachArgv(name));
    } finally {
      await host.resume();
    }
    const stillAlive = this.tmux.hasSession(name);
    let message: string;
    if (exitCode !== 0 && !stillAlive) {
      message = `tmux session ${name} ended before it could be attached (ssh probably failed)`;
    } else if (stillAlive) {
      message = `Detached from ${name}; the session keeps running and can be resumed`;
    } else {
      message = `Session ${name} ended`;
    }
    return {
      mode: "tmux",
      action: existed ? "resumed" : "created",
      newSession: !existed,
      exitCode,
      message,
      warnings,
      command,
    };
  }

  private async launchTerminal(
    server: ServerEntry,
    defaults: Defaults,
    command: SshCommand,
    warnings: string[],
  ): Promise<LaunchOutcome> {
    const terminal = detectTerminal(defaults.terminal_command, this.runner, this.platform, this.env);
    if (!terminal) {
      throw new LaunchError("No terminal emulator found; set defaults.terminal_command (e.g. \"alacritty -e {cmd}\")");
    }

    let script: string;
    let existed = false;
    let where: string;
    if (this.tmux.isAvailable()) {
      const name = this.sessionNameFor(server, defaults);
      existed = this.tmux.hasSession(name);
      // -A attaches when the session already exists, otherwise creates it.
      const inner = shellJoin(["sh", "-c", this.sshScript(command, defaults)]);
      script = shellJoin(["tmux", "new-session", "-A", "-s", name, inner]);
      where = `tmux session ${name}`;
    } else {
      script = this.sshScript(command, defaults);
      where = command.target;
    }
    const argv = terminal.argv(shellJoin(["sh", "-c", script]));
    this.runner.spawnDetached(argv);

    return {
      mode: "terminal",
      action: "spawned",
      newSession: !existed,
      message: `${existed ? "Resumed" : "Opened"} ${where} in a new ${terminal.label} window`,
      warnings,
      command,
    };
  }
}
