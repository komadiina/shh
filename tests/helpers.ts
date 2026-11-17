import type { ProcessRunner } from "../src/util/shell.ts";

/** In-memory stand-in for the real process runner, with a tiny tmux simulation. */
export class FakeRunner implements ProcessRunner {
  sessions = new Set<string>();
  commands: string[][] = [];
  detached: string[][] = [];
  inherit: string[][] = [];
  available = new Set<string>(["tmux", "ssh"]);
  inheritExitCode = 0;

  runInherit(argv: readonly string[]): number {
    this.inherit.push([...argv]);
    return this.inheritExitCode;
  }
  capture(argv: readonly string[]): string {
    this.commands.push([...argv]);
    if (argv[0] !== "tmux") throw new Error(`unexpected command ${argv[0]}`);
    const sub = argv[1];
    const target = (argv[argv.indexOf("-t") + 1] ?? "").replace(/^=/, "");
    switch (sub) {
      case "-V":
        return "tmux 3.4\n";
      case "list-sessions":
        return [...this.sessions].join("\n") + "\n";
      case "has-session":
        if (this.sessions.has(target)) return "";
        throw new Error("can't find session");
      case "new-session": {
        const name = argv[argv.indexOf("-s") + 1]!;
        this.sessions.add(name);
        return "";
      }
      case "switch-client":
        if (!this.sessions.has(target)) throw new Error("no session");
        return "";
      case "kill-session":
        if (!this.sessions.delete(target)) throw new Error("no session");
        return "";
      default:
        throw new Error(`unhandled tmux ${sub}`);
    }
  }
  commandExists(name: string): boolean {
    return this.available.has(name);
  }
  spawnDetached(argv: readonly string[]): void {
    this.detached.push([...argv]);
  }
}

