import { describe, expect, test } from "bun:test";
import { defaultDefaults, newServer, type Defaults, type ServerEntry } from "../src/config/types.ts";
import { Launcher, LaunchError, type LaunchHost } from "../src/session/launcher.ts";
import { buildSshCommand, SshTargetError } from "../src/session/ssh.ts";
import { detectTerminal, macTerminal, templateTerminal } from "../src/session/terminal.ts";
import { Tmux, tmuxSessionName } from "../src/session/tmux.ts";
import { shellJoin, shellQuote, shellSplit } from "../src/util/shell.ts";
import { FakeRunner } from "./helpers.ts";

const HOME = "/home/me";

function server(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return { ...newServer("web-01"), hostname: "web.example.com", ipv4: "203.0.113.10", ...overrides };
}

function hostSpy(): LaunchHost & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async suspend() {
      log.push("suspend");
    },
    async resume() {
      log.push("resume");
    },
  };
}

describe("shell helpers", () => {
  test("quotes only when needed", () => {
    expect(shellQuote("simple-arg_1")).toBe("simple-arg_1");
    expect(shellQuote("has space")).toBe("'has space'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(shellJoin(["ssh", "-o", "ProxyCommand=nc %h %p"])).toBe("ssh -o 'ProxyCommand=nc %h %p'");
  });

  test("splits shell words", () => {
    expect(shellSplit(`-o "ServerAliveInterval=30" -J 'jump host' -v`)).toEqual([
      "-o",
      "ServerAliveInterval=30",
      "-J",
      "jump host",
      "-v",
    ]);
    expect(shellSplit("")).toEqual([]);
    expect(shellSplit("  a\\ b  ")).toEqual(["a b"]);
  });
});

describe("buildSshCommand", () => {
  test("uses hostname by default and falls back to ipv4", () => {
    const d = defaultDefaults();
    expect(buildSshCommand(server(), d).argv).toEqual(["ssh", "web.example.com"]);
    expect(buildSshCommand(server({ hostname: undefined }), d).argv).toEqual(["ssh", "203.0.113.10"]);
    expect(buildSshCommand(server({ hostname: undefined }), d).via).toBe("ipv4");
    expect(() => buildSshCommand(server({ hostname: undefined, ipv4: undefined }), d)).toThrow(SshTargetError);
  });

  test("honours connect_via overrides", () => {
    const d: Defaults = { ...defaultDefaults(), connect_via: "ipv4" };
    expect(buildSshCommand(server(), d).host).toBe("203.0.113.10");
    expect(buildSshCommand(server({ connect_via: "hostname" }), d).host).toBe("web.example.com");
    expect(buildSshCommand(server(), d, { via: "hostname" }).host).toBe("web.example.com");
  });

  test("applies user, key and port with defaults and server overrides", () => {
    const d: Defaults = { ...defaultDefaults(), user: "root", identity_file: "~/.ssh/default_key", ssh_options: ["-o", "ServerAliveInterval=30"] };
    expect(buildSshCommand(server(), d, { home: HOME }).argv).toEqual([
      "ssh",
      "-i",
      "/home/me/.ssh/default_key",
      "-o",
      "ServerAliveInterval=30",
      "root@web.example.com",
    ]);
    const custom = server({ user: "deploy", identity_file: "/keys/deploy", port: 2222 });
    expect(buildSshCommand(custom, d, { home: HOME }).argv).toEqual([
      "ssh",
      "-p",
      "2222",
      "-i",
      "/keys/deploy",
      "-o",
      "ServerAliveInterval=30",
      "deploy@web.example.com",
    ]);
  });

  test("passes -p for a non-default default port, but not for 22", () => {
    expect(buildSshCommand(server(), { ...defaultDefaults(), port: 22 }).argv).not.toContain("-p");
    expect(buildSshCommand(server(), { ...defaultDefaults(), port: 2200 }).argv).toContain("2200");
    expect(buildSshCommand(server({ port: 22 }), { ...defaultDefaults(), port: 2200 }).argv).toEqual(["ssh", "-p", "22", "web.example.com"]);
  });
});

describe("tmux", () => {
  test("session names are sanitised", () => {
    expect(tmuxSessionName("ssh-", "web-01")).toBe("ssh-web-01");
    expect(tmuxSessionName("ssh-", "db.prod:1")).toBe("ssh-db_prod_1");
    expect(tmuxSessionName("", "")).toBe("ssh-session");
  });

  test("reports availability, version, inside, sessions", () => {
    const runner = new FakeRunner();
    runner.sessions.add("ssh-web-01");
    const tmux = new Tmux(runner, { TMUX: "/tmp/tmux-1000/default,123,0" });
    expect(tmux.isAvailable()).toBe(true);
    expect(tmux.version()).toBe("3.4");
    expect(tmux.isInside()).toBe(true);
    expect(tmux.listSessions()).toEqual(["ssh-web-01"]);
    expect(tmux.hasSession("ssh-web-01")).toBe(true);
    expect(tmux.hasSession("nope")).toBe(false);
    expect(tmux.killSession("ssh-web-01")).toBe(true);
    expect(tmux.listSessions()).toEqual([]);

    const none = new Tmux(new FakeRunner(), {});
    expect(none.isInside()).toBe(false);
    runner.available.delete("tmux");
    const missing = new Tmux(runner, {});
    expect(missing.isAvailable()).toBe(false);
    expect(missing.listSessions()).toEqual([]);
    expect(missing.version()).toBeNull();
  });
});

describe("Launcher", () => {
  function make(env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = "linux") {
    const runner = new FakeRunner();
    const tmux = new Tmux(runner, env);
    const launcher = new Launcher(tmux, runner, { env, platform, home: HOME });
    return { runner, tmux, launcher };
  }

  test("auto resolves to tmux when installed, inline otherwise; tmux mode warns when missing", () => {
    const { launcher, runner } = make();
    expect(launcher.resolveMode(defaultDefaults()).mode).toBe("tmux");
    runner.available.delete("tmux");
    const { launcher: l2 } = make();
    l2.tmux.recheck();
    const without = make();
    without.runner.available.delete("tmux");
    expect(without.launcher.resolveMode(defaultDefaults()).mode).toBe("inline");
    const forced = without.launcher.resolveMode({ ...defaultDefaults(), launch: "tmux" });
    expect(forced.mode).toBe("inline");
    expect(forced.warning).toMatch(/not installed/);
  });

  test("inline: suspends, runs ssh with inherited stdio, resumes, counts", async () => {
    const { launcher, runner } = make();
    const host = hostSpy();
    const outcome = await launcher.launch(server(), { ...defaultDefaults(), launch: "inline", user: "ops" }, host);
    expect(host.log).toEqual(["suspend", "resume"]);
    expect(runner.inherit).toEqual([["ssh", "ops@web.example.com"]]);
    expect(outcome.newSession).toBe(true);
    expect(outcome.mode).toBe("inline");
    expect(outcome.message).toMatch(/ended/);

    runner.inheritExitCode = 255;
    const failed = await launcher.launch(server(), { ...defaultDefaults(), launch: "inline" }, host);
    expect(failed.exitCode).toBe(255);
    expect(failed.message).toMatch(/status 255/);
  });

  test("tmux outside: creates a detached session then attaches; second launch resumes", async () => {
    const { launcher, runner } = make();
    const host = hostSpy();
    const d = defaultDefaults();
    const first = await launcher.launch(server(), d, host);
    expect(first.action).toBe("created");
    expect(first.newSession).toBe(true);
    const created = runner.commands.find((c) => c[1] === "new-session")!;
    expect(created.slice(0, 7)).toEqual(["tmux", "new-session", "-d", "-s", "ssh-web-01", "-n", "ssh"]);
    expect(created[7]).toContain("ssh web.example.com");
    expect(created[7]).toContain("Press Enter to close"); // hold_on_error wrapper
    expect(runner.inherit).toEqual([["tmux", "attach-session", "-t", "=ssh-web-01"]]);
    expect(host.log).toEqual(["suspend", "resume"]);
    expect(first.message).toMatch(/Detached/);

    const second = await launcher.launch(server(), d, host);
    expect(second.action).toBe("resumed");
    expect(second.newSession).toBe(false);
    expect(runner.commands.filter((c) => c[1] === "new-session").length).toBe(1);
    expect(launcher.activeSessions([server(), server({ name: "other" })], d)).toEqual(new Set(["web-01"]));
    expect(launcher.killSession(server(), d)).toBe(true);
    expect(launcher.activeSessions([server()], d).size).toBe(0);
  });

  test("tmux without hold_on_error runs plain ssh in the session", async () => {
    const { launcher, runner } = make();
    const d: Defaults = { ...defaultDefaults(), tmux: { session_prefix: "ssh-", hold_on_error: false } };
    await launcher.launch(server(), d, hostSpy());
    const created = runner.commands.find((c) => c[1] === "new-session")!;
    expect(created[7]).toBe("sh -c 'ssh web.example.com'");
  });

  test("tmux inside: switches client without suspending the TUI", async () => {
    const { launcher, runner } = make({ TMUX: "/tmp/tmux-1000/default,1,0" });
    const host = hostSpy();
    const outcome = await launcher.launch(server(), defaultDefaults(), host);
    expect(host.log).toEqual([]);
    expect(runner.inherit).toEqual([]);
    expect(runner.commands.some((c) => c[1] === "switch-client" && c[3] === "=ssh-web-01")).toBe(true);
    expect(outcome.action).toBe("created");
  });

  test("tmux outside: reports a session that died before attach", async () => {
    const { launcher, runner } = make();
    runner.inheritExitCode = 1;
    const d = defaultDefaults();
    // simulate ssh dying immediately: session disappears when attach runs
    const origRun = runner.runInherit.bind(runner);
    runner.runInherit = (argv) => {
      runner.sessions.clear();
      return origRun(argv);
    };
    const outcome = await launcher.launch(server(), d, hostSpy());
    expect(outcome.message).toMatch(/ended before it could be attached/);
  });

  test("terminal: spawns the configured template, tmux-backed when available", async () => {
    const { launcher, runner } = make();
    const d: Defaults = { ...defaultDefaults(), launch: "terminal", terminal_command: "alacritty -e {cmd}" };
    const outcome = await launcher.launch(server(), d, hostSpy());
    expect(outcome.mode).toBe("terminal");
    expect(outcome.newSession).toBe(true);
    expect(runner.detached.length).toBe(1);
    const [sh, dashC, line = ""] = runner.detached[0]!;
    expect([sh, dashC]).toEqual(["sh", "-c"]);
    expect(line.startsWith("alacritty -e sh -c ")).toBe(true);
    expect(line).toContain("tmux new-session -A -s ssh-web-01");
    expect(line).toContain("ssh web.example.com");
    expect(outcome.message).toMatch(/new terminal_command window/);
  });

  test("terminal: without tmux runs ssh directly; errors when no terminal is found", async () => {
    const { launcher, runner } = make();
    runner.available.delete("tmux");
    launcher.tmux.recheck();
    runner.available.add("kitty");
    const d: Defaults = { ...defaultDefaults(), launch: "terminal" };
    const outcome = await launcher.launch(server(), d, hostSpy());
    expect(runner.detached[0]![2]).toMatch(/^kitty sh -c /);
    expect(runner.detached[0]![2]).not.toContain("tmux");
    expect(outcome.message).toMatch(/kitty window/);

    runner.available.delete("kitty");
    await expect(launcher.launch(server(), d, hostSpy())).rejects.toThrow(LaunchError);
  });

  test("detectTerminal precedence: template > $TERMINAL > platform defaults", () => {
    const runner = new FakeRunner();
    runner.available.add("xterm");
    expect(detectTerminal("foo {cmd}", runner, "linux", {})!.label).toBe("terminal_command");
    expect(detectTerminal("", runner, "linux", { TERMINAL: "wezterm" })!.argv("sh -c x")).toEqual(["sh", "-c", "wezterm -e sh -c x"]);
    expect(detectTerminal("", runner, "linux", {})!.label).toBe("xterm");
    expect(detectTerminal("", runner, "darwin", {})!.label).toBe("Terminal.app");
    expect(detectTerminal("", new FakeRunner(), "linux", {})).toBeNull();
    // template without placeholder appends the command
    expect(templateTerminal("foot").argv("sh -c x")).toEqual(["sh", "-c", "foot sh -c x"]);
    // AppleScript escaping
    expect(macTerminal().argv(`sh -c 'echo "hi"'`)[2]).toBe(`tell application "Terminal" to do script "sh -c 'echo \\"hi\\"'"`);
  });
});
