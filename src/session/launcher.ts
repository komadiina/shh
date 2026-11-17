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
 *   mode "window"   – GUI clients (RDP) open their own window; tmux is not involved.
 *
 * The same applies to telnet. Stored passwords never go into argv: see `secrets.ts`.
 */
import { protocolOf, type ConnectVia, type Defaults, type ServerEntry } from "../config/types.ts";
import { shellJoin, shellQuote, type ProcessRunner } from "../util/shell.ts";
import type { SessionCommand } from "./command.ts";
import { buildSessionCommand, detectClients, protocolUnavailable, type ClientStatus } from "./protocols.ts";
import { FileSecretStager, type SecretStager } from "./secrets.ts";
import { detectTerminal } from "./terminal.ts";
import { Tmux, tmuxSessionName } from "./tmux.ts";

export type ResolvedMode = "tmux" | "inline" | "terminal";

/** What the launcher needs from the UI: give the terminal away and take it back. */
export interface LaunchHost {
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

export interface LaunchOutcome {
  mode: ResolvedMode | "window";
  action: "resumed" | "created" | "spawned";
  /** True when a brand-new ssh session was started (and the counter should be bumped). */
  newSession: boolean;
  exitCode?: number;
  message: string;
  warnings: string[];
  command: SessionCommand;
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
  /** Where stored passwords are staged for the session; defaults to a private runtime dir. */
  secrets?: SecretStager;
}

export class Launcher {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string | undefined;
  private secretStager: SecretStager | undefined;
  private clientCache: ClientStatus | null = null;

  constructor(
    readonly tmux: Tmux,
    private readonly runner: ProcessRunner,
    options: LauncherOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.home = options.home;
    this.secretStager = options.secrets;
  }

  private get secrets(): SecretStager {
    this.secretStager ??= new FileSecretStager();
    return this.secretStager;
  }

  /** Which session clients are installed (cached; see `recheckClients`). */
  clients(): ClientStatus {
    this.clientCache ??= detectClients(this.runner);
    return this.clientCache;
  }

  recheckClients(): void {
    this.clientCache = null;
  }

  /** GUI sessions (RDP) live in their own window and never in tmux. */
  isWindowed(server: ServerEntry): boolean {
    return protocolOf(server) === "rdp";
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
      if (this.isWindowed(server)) continue;
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

  /**
   * Shell snippet that runs the client and, optionally, waits for Enter when it
   * fails. A stored password is staged here, so only call it when the script will
   * really run (otherwise the staged file is never consumed).
   */
  sessionScript(command: SessionCommand, hold: boolean): string {
    const run = this.secretPrelude(command) + shellJoin(this.clientArgv(command));
    if (!hold) return run;
    return (
      `${run}; ec=$?; if [ "$ec" -ne 0 ]; then ` +
      `printf '\\n[shh] ${command.protocol} exited with status %s. Press Enter to close.\\n' "$ec"; read -r _; fi; exit "$ec"`
    );
  }

  /** Read the staged password into $SHH_SECRET and delete the file before the client starts. */
  private secretPrelude(command: SessionCommand): string {
    if (command.secret === undefined) return "";
    const file = shellQuote(this.secrets.stage(command.secret));
    let prelude = `SHH_SECRET=$(cat ${file}); rm -f ${file}; export SHH_SECRET; `;
    if (command.secretVia === "askpass") {
      prelude += `SSH_ASKPASS=${shellQuote(this.secrets.helper("askpass"))} SSH_ASKPASS_REQUIRE=force; export SSH_ASKPASS SSH_ASKPASS_REQUIRE; `;
    }
    return prelude;
  }

  /** The argv that actually runs: telnet with a stored password is wrapped in the expect login helper. */
  private clientArgv(command: SessionCommand): string[] {
    if (command.secret !== undefined && command.secretVia === "expect") {
      return ["expect", "-f", this.secrets.helper("telnet-login"), command.user ?? "", ...command.argv];
    }
    return command.argv;
  }

  async launch(
    server: ServerEntry,
    defaults: Defaults,
    host: LaunchHost,
    options: { via?: ConnectVia } = {},
  ): Promise<LaunchOutcome> {
    const clients = this.clients();
    const unavailable = protocolUnavailable(protocolOf(server), clients);
    if (unavailable) throw new LaunchError(`Cannot connect to ${server.name}: ${unavailable}`);
    if (protocolOf(server) === "telnet" && server.password_b64 && !clients.expect) {
      throw new LaunchError(`Cannot log in to ${server.name}: a stored telnet password needs expect (not installed)`);
    }
    const command = buildSessionCommand(server, defaults, clients, { via: options.via, home: this.home });
    if (command.kind === "gui") return this.launchWindow(command, host);

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

  private async launchInline(command: SessionCommand, host: LaunchHost, warnings: string[]): Promise<LaunchOutcome> {
    const argv = command.secret === undefined ? command.argv : ["sh", "-c", this.sessionScript(command, false)];
    await host.suspend();
    let exitCode: number;
    try {
      exitCode = this.runner.runInherit(argv);
    } finally {
      await host.resume();
    }
    return {
      mode: "inline",
      action: "created",
      newSession: true,
      exitCode,
      message: exitCode === 0 ? `Session to ${command.target} ended` : `${command.protocol} to ${command.target} exited with status ${exitCode}`,
      warnings,
      command,
    };
  }

  private async launchTmux(
    server: ServerEntry,
    defaults: Defaults,
    command: SessionCommand,
    host: LaunchHost,
    warnings: string[],
  ): Promise<LaunchOutcome> {
    const name = this.sessionNameFor(server, defaults);
    const existed = this.tmux.hasSession(name);
    if (!existed) {
      const script = shellJoin(["sh", "-c", this.sessionScript(command, defaults.tmux.hold_on_error)]);
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
      message = `tmux session ${name} ended before it could be attached (${command.protocol} probably failed)`;
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
    command: SessionCommand,
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
      if (existed) {
        script = shellJoin(this.tmux.attachArgv(name));
      } else {
        // -A attaches if the session appeared in the meantime, otherwise creates it.
        const inner = shellJoin(["sh", "-c", this.sessionScript(command, defaults.tmux.hold_on_error)]);
        script = shellJoin(["tmux", "new-session", "-A", "-s", name, inner]);
      }
      where = `tmux session ${name}`;
    } else {
      script = this.sessionScript(command, defaults.tmux.hold_on_error);
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

  /**
   * GUI clients. With a stored password the client runs detached and gets its
   * arguments (password included) on stdin. Without one it runs in the app's
   * terminal so it can prompt for the password; the TUI waits until it closes.
   */
  private async launchWindow(command: SessionCommand, host: LaunchHost): Promise<LaunchOutcome> {
    const [client, ...args] = command.argv;
    if (command.secret !== undefined) {
      const input = [...args, `/p:${command.secret}`].join("\n") + "\n";
      this.runner.spawnDetached([client!, "/args-from:stdin"], { stdin: input });
      return {
        mode: "window",
        action: "spawned",
        newSession: true,
        message: `Opened RDP window for ${command.target}`,
        warnings: [],
        command,
      };
    }
    await host.suspend();
    let exitCode: number;
    try {
      exitCode = this.runner.runInherit(command.argv);
    } finally {
      await host.resume();
    }
    return {
      mode: "window",
      action: "created",
      newSession: true,
      exitCode,
      message: exitCode === 0 ? `RDP session to ${command.target} ended` : `${client} exited with status ${exitCode}`,
      warnings: [],
      command,
    };
  }
}
