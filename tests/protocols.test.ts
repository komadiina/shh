import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { normalizeConfig } from "../src/config/schema.ts";
import { decodePassword, encodePassword } from "../src/config/secret.ts";
import { ConfigStore } from "../src/config/store.ts";
import { defaultDefaults, newServer, type Defaults, type ServerEntry } from "../src/config/types.ts";
import { SshTargetError, type SessionCommand } from "../src/session/command.ts";
import { Launcher, LaunchError, type LaunchHost } from "../src/session/launcher.ts";
import { authUnavailable, detectClients, protocolUnavailable } from "../src/session/protocols.ts";
import { buildRdpCommand } from "../src/session/rdp.ts";
import { FileSecretStager } from "../src/session/secrets.ts";
import { buildSshCommand } from "../src/session/ssh.ts";
import { buildTelnetCommand } from "../src/session/telnet.ts";
import { Tmux } from "../src/session/tmux.ts";
import { FakeRunner, FakeStager } from "./helpers.ts";

const PASSWORD = "hunter2 'quoted' $HOME";
const B64 = encodePassword(PASSWORD);

function server(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return { ...newServer("box"), hostname: "box.example.com", ...overrides };
}

const noopHost: LaunchHost = { suspend: async () => {}, resume: async () => {} };

function setup(available: string[] = ["tmux", "ssh"], env: NodeJS.ProcessEnv = {}) {
  const runner = new FakeRunner();
  runner.available = new Set(available);
  const stager = new FakeStager();
  const launcher = new Launcher(new Tmux(runner, env), runner, { env, platform: "linux", home: "/home/me", secrets: stager });
  return { runner, stager, launcher };
}

function inlineDefaults(): Defaults {
  return { ...defaultDefaults(), launch: "inline" };
}

describe("password encoding", () => {
  test("round-trips unicode and rejects garbage", () => {
    expect(decodePassword(encodePassword("pä$$ wörd"))).toBe("pä$$ wörd");
    expect(decodePassword("aHVudGVyMg==")).toBe("hunter2");
    expect(decodePassword("not base64!")).toBeUndefined();
    expect(decodePassword("//79")).toBeUndefined(); // valid base64, invalid UTF-8
  });
});

describe("config: protocols and credentials", () => {
  test("normalizes protocol, auth, password and rdp settings", () => {
    const { config, warnings } = normalizeConfig({
      servers: [
        { name: "a", hostname: "a", auth: "userpass", password_b64: B64 },
        { name: "b", hostname: "b", protocol: "telnet", auth: "pubkey" },
        { name: "c", hostname: "c", protocol: "rdp", password_b64: "%%%", rdp: { domain: "CORP", resolution: "1920x1080", cert: "ignore", clipboard: false } },
        { name: "d", hostname: "d", protocol: "gopher", rdp: { resolution: "huge" } },
      ],
    });
    const [a, b, c, d] = config.servers;
    expect(a).toMatchObject({ auth: "userpass", password_b64: B64 });
    expect(b!.auth).toBe("none");
    expect(c).toMatchObject({ protocol: "rdp", password_b64: undefined, rdp: { domain: "CORP", resolution: "1920x1080", cert: "ignore", clipboard: false } });
    expect(d!.protocol).toBe("ssh");
    expect(d!.rdp).toBeUndefined();
    expect(warnings.some((w) => w.includes('servers[1].auth: "pubkey" is not supported for telnet'))).toBe(true);
    expect(warnings.some((w) => w.includes("servers[2].password_b64: not valid base64"))).toBe(true);
    expect(warnings.some((w) => w.includes("servers[3].protocol"))).toBe(true);
    expect(warnings.some((w) => w.includes("servers[3].rdp.resolution"))).toBe(true);
  });

  test("store writes the new keys in order and drops empty ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "shh-proto-"));
    const store = new ConfigStore(join(dir, "config.yaml"));
    const { config } = store.load();
    config.servers = [
      server({ name: "win", protocol: "rdp", user: "admin", password_b64: B64, rdp: { domain: "CORP", drive: undefined } }),
      server({ name: "plain" }),
    ];
    config.defaults.rdp_options = ["/sound"];
    store.save(config);
    const text = readFileSync(store.path, "utf8");
    const saved = parse(text);
    expect(saved.servers[0]).toMatchObject({ name: "win", protocol: "rdp", password_b64: B64, rdp: { domain: "CORP" } });
    expect(saved.servers[0].rdp).not.toHaveProperty("drive");
    expect(saved.servers[1]).not.toHaveProperty("protocol");
    expect(saved.servers[1]).not.toHaveProperty("password_b64");
    expect(saved.defaults.rdp_options).toEqual(["/sound"]);
    expect(Object.keys(saved.servers[0])).toEqual(["name", "protocol", "hostname", "user", "password_b64", "rdp", "connections"]);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    // reloading gives the same data back
    expect(store.load().config.servers[0]!.password_b64).toBe(B64);
  });
});

describe("command builders", () => {
  test("ssh userpass: password auth only, no key, secret out of band", () => {
    const d: Defaults = { ...defaultDefaults(), identity_file: "~/.ssh/id" };
    const cmd = buildSshCommand(server({ user: "root", auth: "userpass", password_b64: B64 }), d, { home: "/home/me" });
    expect(cmd.argv).toEqual([
      "ssh",
      "-o",
      "PreferredAuthentications=keyboard-interactive,password",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
      "root@box.example.com",
    ]);
    expect(cmd.secret).toBe(PASSWORD);
    expect(cmd.secretVia).toBe("askpass");
    expect(cmd.argv.join(" ")).not.toContain("hunter2");

    const ask = buildSshCommand(server({ auth: "userpass" }), d);
    expect(ask.secret).toBeUndefined();
    expect(ask.argv).not.toContain("NumberOfPasswordPrompts=1");
    // pubkey stays the default and ignores a stray password
    expect(buildSshCommand(server({ password_b64: B64 }), d, { home: "/home/me" }).argv).toEqual(["ssh", "-i", "/home/me/.ssh/id", "box.example.com"]);
    expect(buildSshCommand(server({ password_b64: B64 }), d).secret).toBeUndefined();
  });

  test("telnet: -l user, host, optional port; secret via expect", () => {
    const d = defaultDefaults();
    expect(buildTelnetCommand(server({ protocol: "telnet" }), d).argv).toEqual(["telnet", "box.example.com"]);
    const cmd = buildTelnetCommand(server({ protocol: "telnet", user: "admin", port: 2323, auth: "userpass", password_b64: B64 }), d);
    expect(cmd.argv).toEqual(["telnet", "-l", "admin", "box.example.com", "2323"]);
    expect(cmd).toMatchObject({ kind: "tty", secret: PASSWORD, secretVia: "expect" });
  });

  test("rdp: xfreerdp3 arguments from settings and defaults", () => {
    const d: Defaults = { ...defaultDefaults(), rdp_options: ["/sound"] };
    const basic = buildRdpCommand(server({ protocol: "rdp" }), d);
    expect(basic.argv).toEqual(["xfreerdp3", "/v:box.example.com", "/dynamic-resolution", "/cert:tofu", "+clipboard", "/sound"]);
    expect(basic.kind).toBe("gui");
    const full = buildRdpCommand(
      server({ protocol: "rdp", user: "admin", port: 3390, password_b64: B64, rdp: { domain: "CORP", resolution: "1280x720", cert: "ignore", clipboard: false, drive: "~/share" } }),
      defaultDefaults(),
      { home: "/home/me" },
    );
    expect(full.argv).toEqual(["xfreerdp3", "/v:box.example.com:3390", "/u:admin", "/d:CORP", "/size:1280x720", "/cert:ignore", "-clipboard", "/drive:share,/home/me/share"]);
    expect(full).toMatchObject({ secret: PASSWORD, secretVia: "stdin" });
    expect(buildRdpCommand(server({ protocol: "rdp", rdp: { resolution: "fullscreen" } }), d).argv).toContain("/f");
    expect(() => buildRdpCommand(server({ protocol: "rdp", password_b64: encodePassword("a\nb") }), d)).toThrow(SshTargetError);
  });
});

describe("client detection", () => {
  test("rdp is unavailable without a known client; telnet userpass needs expect", () => {
    const runner = new FakeRunner();
    runner.available = new Set(["ssh", "telnet"]);
    const clients = detectClients(runner);
    expect(clients).toEqual({ ssh: true, telnet: true, expect: false, rdp: null });
    expect(protocolUnavailable("rdp", clients)).toBe("xfreerdp3 not found");
    expect(protocolUnavailable("telnet", clients)).toBeUndefined();
    expect(authUnavailable("telnet", "userpass", clients)).toBe("telnet logins need expect");
    expect(authUnavailable("telnet", "none", clients)).toBeUndefined();
    runner.available.add("xfreerdp3");
    expect(detectClients(runner).rdp).toBe("xfreerdp3");
  });
});

describe("launcher: passwords never reach argv", () => {
  test("ssh inline with a stored password runs through the askpass prelude", async () => {
    const { runner, stager, launcher } = setup();
    const outcome = await launcher.launch(server({ auth: "userpass", password_b64: B64 }), inlineDefaults(), noopHost);
    expect(stager.staged).toEqual([PASSWORD]);
    const argv = runner.inherit[0]!;
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv[2]).toContain("SHH_SECRET=$(cat /run/shh/secret-1); rm -f /run/shh/secret-1;");
    expect(argv[2]).toContain("SSH_ASKPASS=/run/shh/askpass SSH_ASKPASS_REQUIRE=force");
    expect(argv.join(" ")).not.toContain("hunter2");
    expect(outcome.newSession).toBe(true);
  });

  test("ssh inline without a password runs ssh directly", async () => {
    const { runner, stager, launcher } = setup();
    await launcher.launch(server({ auth: "userpass" }), inlineDefaults(), noopHost);
    expect(stager.staged).toEqual([]);
    expect(runner.inherit[0]![0]).toBe("ssh");
  });

  test("tmux: stages the password only when a new session is created", async () => {
    const { runner, stager, launcher } = setup();
    const s = server({ auth: "userpass", password_b64: B64 });
    await launcher.launch(s, defaultDefaults(), noopHost);
    const created = runner.commands.find((c) => c[1] === "new-session")!;
    expect(created.join(" ")).not.toContain("hunter2");
    expect(created.join(" ")).toContain("SSH_ASKPASS_REQUIRE=force");
    expect(created.join(" ")).toContain("[shh] ssh exited");
    await launcher.launch(s, defaultDefaults(), noopHost); // resume
    expect(stager.staged.length).toBe(1);
  });

  test("terminal: resuming an existing tmux session does not stage the password again", async () => {
    const { runner, stager, launcher } = setup(["tmux", "ssh", "xterm"]);
    const d: Defaults = { ...defaultDefaults(), launch: "terminal" };
    const s = server({ auth: "userpass", password_b64: B64 });
    await launcher.launch(s, d, noopHost);
    expect(stager.staged.length).toBe(1);
    runner.sessions.add("ssh-box");
    await launcher.launch(s, d, noopHost);
    expect(stager.staged.length).toBe(1);
    expect(runner.detached[1]!.join(" ")).toContain("attach-session");
  });

  test("telnet with a password wraps the client in the expect helper; refuses without expect", async () => {
    const s = server({ protocol: "telnet", user: "admin", auth: "userpass", password_b64: B64 });
    const without = setup(["ssh", "telnet"]);
    await expect(without.launcher.launch(s, inlineDefaults(), noopHost)).rejects.toThrow(LaunchError);

    const { runner, launcher } = setup(["ssh", "telnet", "expect"]);
    await launcher.launch(s, inlineDefaults(), noopHost);
    expect(runner.inherit[0]![2]).toContain("expect -f /run/shh/telnet-login admin telnet -l admin box.example.com");
    expect(runner.inherit[0]!.join(" ")).not.toContain("hunter2");
  });

  test("telnet without a password runs telnet directly, even in tmux", async () => {
    const { runner, launcher } = setup(["ssh", "telnet", "tmux"]);
    await launcher.launch(server({ protocol: "telnet" }), defaultDefaults(), noopHost);
    const created = runner.commands.find((c) => c[1] === "new-session")!;
    expect(created.join(" ")).toContain("telnet box.example.com");
  });

  test("rdp: stored password → detached client fed over stdin; otherwise inline", async () => {
    const { runner, launcher } = setup(["ssh", "tmux", "xfreerdp3"]);
    const s = server({ protocol: "rdp", user: "admin", password_b64: B64 });
    const outcome = await launcher.launch(s, defaultDefaults(), noopHost);
    expect(outcome).toMatchObject({ mode: "window", action: "spawned", newSession: true });
    expect(runner.detached[0]).toEqual(["xfreerdp3", "/args-from:stdin"]);
    expect(runner.detachedStdin[0]).toBe(["/v:box.example.com", "/u:admin", "/dynamic-resolution", "/cert:tofu", "+clipboard", `/p:${PASSWORD}`].join("\n") + "\n");
    expect(runner.commands.some((c) => c[1] === "new-session")).toBe(false);

    const log: string[] = [];
    await launcher.launch(server({ protocol: "rdp", user: "admin" }), defaultDefaults(), { suspend: async () => void log.push("s"), resume: async () => void log.push("r") });
    expect(runner.inherit[0]![0]).toBe("xfreerdp3");
    expect(log).toEqual(["s", "r"]);
  });

  test("rdp without a client fails clearly; rdp servers never count as tmux sessions", async () => {
    const { runner, launcher } = setup(["ssh", "tmux"]);
    const s = server({ name: "win", protocol: "rdp" });
    await expect(launcher.launch(s, defaultDefaults(), noopHost)).rejects.toThrow("xfreerdp3 not found");
    runner.sessions.add("ssh-win");
    expect(launcher.activeSessions([s], defaultDefaults()).size).toBe(0);
  });
});

describe("FileSecretStager (real files)", () => {
  test("private dir, 0600 secret, askpass hands the password to the client and the file is gone", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "shh-secret-")), "rt");
    const stager = new FileSecretStager(dir);
    // a stand-in for ssh: asks $SSH_ASKPASS like ssh would and prints the answer
    const fakeSsh = join(dir, "..", "fake-ssh");
    writeFileSync(fakeSsh, '#!/bin/sh\n"$SSH_ASKPASS" "(user@box) Password: "\n');
    chmodSync(fakeSsh, 0o755);
    const runner = new FakeRunner();
    const launcher = new Launcher(new Tmux(runner, {}), runner, { env: {}, secrets: stager });
    const command: SessionCommand = { protocol: "ssh", kind: "tty", argv: [fakeSsh], target: "box", host: "box", via: "hostname", secret: PASSWORD, secretVia: "askpass" };

    const script = launcher.sessionScript(command, false);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const staged = script.match(/cat (\S+)\)/)![1]!;
    expect(statSync(staged).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "askpass.sh")).mode & 0o777).toBe(0o700);

    const result = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(result.stdout).toBe(`${PASSWORD}\n`);
    expect(existsSync(staged)).toBe(false);
  });
});
