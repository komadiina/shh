import { execFileSync, spawn, spawnSync } from "node:child_process";

/** POSIX single-quote shell quoting. Safe for any string, including empty. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/**
 * Minimal shell-words splitter (handles single/double quotes and backslash
 * escapes). Used for the `ssh_options` text field in the config pane.
 */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < input.length) current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) out.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) out.push(current);
  return out;
}

export interface ProcessRunner {
  /** Run `argv[0]` with inherited stdio and wait; returns the exit code (or -1 on signal/failure). */
  runInherit(argv: readonly string[]): number;
  /** Run a command and capture stdout; throws on non-zero exit. */
  capture(argv: readonly string[]): string;
  /** Does an executable with this name exist on PATH? */
  commandExists(name: string): boolean;
  /**
   * Start `argv` detached from this process (own session, no output) and return
   * immediately. `stdin`, when given, is written to the child's stdin.
   */
  spawnDetached(argv: readonly string[], options?: { stdin?: string }): void;
}

export class CommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`"${command}" is not installed or not in PATH`);
    this.name = "CommandNotFoundError";
  }
}

export const realRunner: ProcessRunner = {
  runInherit(argv) {
    const [cmd, ...args] = argv;
    if (!cmd) return -1;
    const result = spawnSync(cmd, args, { stdio: "inherit" });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new CommandNotFoundError(cmd);
      throw result.error;
    }
    return result.status ?? -1;
  },
  capture(argv) {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("empty argv");
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  },
  commandExists(name) {
    const probe = process.platform === "win32" ? ["where", name] : ["sh", "-c", `command -v ${shellQuote(name)}`];
    const result = spawnSync(probe[0]!, probe.slice(1), { stdio: "ignore" });
    return result.status === 0;
  },
  spawnDetached(argv, options = {}) {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("empty argv");
    const withInput = options.stdin !== undefined;
    const child = spawn(cmd, args, { detached: true, stdio: withInput ? ["pipe", "ignore", "ignore"] : "ignore" });
    child.on("error", () => {
      /* reported through the launcher's pre-flight checks; nothing to do here */
    });
    if (withInput && child.stdin) {
      child.stdin.on("error", () => {
        /* the client exited before reading its input */
      });
      child.stdin.end(options.stdin);
    }
    child.unref();
  },
};
