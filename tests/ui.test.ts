/**
 * Headless end-to-end tests: the whole App rendered through OpenTUI's test
 * renderer, driven with the mock keyboard, against a real temp config file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigStore } from "../src/config/store.ts";
import { Launcher } from "../src/session/launcher.ts";
import { Tmux } from "../src/session/tmux.ts";
import { App } from "../src/ui/app.ts";
import { FakeRunner } from "./helpers.ts";

const CONFIG = `version: 1
defaults:
  user: ops
  launch: auto
servers:
  - name: web-01
    hostname: web-01.example.com
    ipv4: 203.0.113.10
    user: deploy
    description: Production web
    connections: 12
  - name: db-01
    ipv4: 10.0.0.5
    user: pg
    identity_file: ~/.ssh/pg_key
    port: 5432
    description: Postgres primary
    tags: [db, prod]
    connections: 3
  - name: bastion
    hostname: bastion.example.com
    description: Jump host
    connections: 40
`;

let setup: TestRendererSetup;
let app: App;
let runner: FakeRunner;
let store: ConfigStore;

async function frame(): Promise<string> {
  await setup.renderOnce();
  return setup.captureCharFrame();
}

/** A lone ESC is only delivered after the parser's escape-sequence timeout. */
async function pressEscape(): Promise<void> {
  setup.mockInput.pressEscape();
  await Bun.sleep(150);
}

function rowOrder(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^\s*│[ ▸●]+(web-01|db-01|bastion|new-box|edge)/.test(l))
    .map((l) => l.match(/(web-01|db-01|bastion|new-box|edge)/)![1]!);
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sshtui-ui-"));
  store = new ConfigStore(join(dir, "config.yaml"));
  writeFileSync(store.path, CONFIG);
  const loaded = store.load();
  runner = new FakeRunner();
  const tmux = new Tmux(runner, {});
  const launcher = new Launcher(tmux, runner, { env: {}, platform: "linux", home: "/home/me" });
  setup = await createTestRenderer({ width: 110, height: 24 });
  app = new App({
    renderer: setup.renderer,
    store,
    launcher,
    runner,
    config: loaded.config,
    warnings: loaded.warnings,
    refreshIntervalMs: 0,
    now: () => new Date("2026-11-16T20:00:00Z"),
    // the headless renderer cannot suspend a terminal it never set up
    launchHost: { suspend: async () => {}, resume: async () => {} },
  });
  app.start();
});

afterEach(async () => {
  await setup.dispose();
});

describe("table screen", () => {
  test("renders header, rows, defaults in title and hotkey bars", async () => {
    const text = await frame();
    expect(text).toContain("sshtui · 3 servers");
    expect(text).toContain("Name ▲"); // default sort indicator
    expect(text).toContain("web-01.example.com");
    expect(text).toContain("Postgres primary");
    expect(text).toContain("connect/resume");
    expect(text).toContain("1 Name▲");
    expect(text).toContain("8 Description");
    expect(rowOrder(text)).toEqual(["bastion", "db-01", "web-01"]);
    // selection marker on the first row
    expect(text).toMatch(/▸\s+bastion/);
  });

  test("digit hotkeys sort, repeating reverses, S flips", async () => {
    setup.mockInput.pressKey("7"); // connections asc
    let text = await frame();
    expect(rowOrder(text)).toEqual(["db-01", "web-01", "bastion"]);
    expect(text).toContain("Conn ▲");
    setup.mockInput.pressKey("7"); // desc
    text = await frame();
    expect(rowOrder(text)).toEqual(["bastion", "web-01", "db-01"]);
    expect(text).toContain("Conn ▼");
    setup.mockInput.pressKey("S", { shift: true });
    text = await frame();
    expect(rowOrder(text)).toEqual(["db-01", "web-01", "bastion"]);
  });

  test("arrow/vim keys move the selection and connect counts a new session", async () => {
    setup.mockInput.pressKey("ARROW_DOWN");
    setup.mockInput.pressKey("j");
    let text = await frame();
    expect(text).toMatch(/▸\s+web-01/);
    setup.mockInput.pressKey("k");
    text = await frame();
    expect(text).toMatch(/▸\s+db-01/);

    setup.mockInput.pressEnter();
    await setup.waitFor(() => runner.inherit.length > 0);
    text = await frame();
    // tmux available + outside tmux → detached session created, then attach via inherited stdio
    const created = runner.commands.find((c) => c[1] === "new-session")!;
    expect(created[4]).toBe("ssh-db-01");
    expect(created[7]).toContain("-p 5432");
    expect(created[7]).toContain("-i /home/me/.ssh/pg_key");
    expect(created[7]).toContain("pg@10.0.0.5");
    expect(runner.inherit[0]).toEqual(["tmux", "attach-session", "-t", "=ssh-db-01"]);
    // counter persisted
    const saved = parse(readFileSync(store.path, "utf8"));
    expect(saved.servers.find((s: { name: string }) => s.name === "db-01").connections).toBe(4);
    expect(saved.servers.find((s: { name: string }) => s.name === "db-01").last_connected).toBe("2026-11-16T20:00:00.000Z");
    // live session indicator + message
    expect(text).toContain("1 live session");
    expect(text).toMatch(/●\s+db-01/);
    expect(text).toContain("Detached from ssh-db-01; the session keeps running");
  });

  test("I connects via IPv4 inline when tmux is missing", async () => {
    runner.available.delete("tmux");
    app["launcher"].tmux.recheck();
    app.render();
    setup.mockInput.pressKey("ARROW_DOWN");
    setup.mockInput.pressKey("ARROW_DOWN"); // web-01
    setup.mockInput.pressKey("I", { shift: true });
    await setup.waitFor(() => runner.inherit.length > 0);
    expect(runner.inherit[0]).toEqual(["ssh", "deploy@203.0.113.10"]);
    const text = await frame();
    expect(text).toContain("inline (no persistence)");
  });

  test("filter narrows rows live, Enter keeps it, Esc clears it", async () => {
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("prod");
    let text = await frame();
    expect(rowOrder(text)).toEqual(["db-01", "web-01"]);
    expect(text).toContain('filter "prod" → 2');
    setup.mockInput.pressEnter();
    text = await frame();
    expect(rowOrder(text)).toEqual(["db-01", "web-01"]);
    expect(text).toContain("connect/resume"); // hints are back
    await pressEscape();
    text = await frame();
    expect(rowOrder(text)).toEqual(["bastion", "db-01", "web-01"]);

    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("zzz");
    text = await frame();
    expect(text).toContain('No servers match "zzz"');
    await pressEscape();
  });

  test("? opens help and any key closes it", async () => {
    setup.mockInput.pressKey("?");
    let text = await frame();
    expect(text).toContain("Keys");
    expect(text).toContain("kill the server's tmux session");
    setup.mockInput.pressKey("x");
    text = await frame();
    expect(text).not.toContain("press any key to close");
  });
});

describe("server form", () => {
  test("adds a server through the form and persists it", async () => {
    setup.mockInput.pressKey("a");
    let text = await frame();
    expect(text).toContain("Add server");
    await setup.mockInput.typeText("new-box");
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("new.example.com");
    setup.mockInput.pressTab(); // ipv4
    setup.mockInput.pressTab(); // user
    await setup.mockInput.typeText("root");
    setup.mockInput.pressTab(); // key
    setup.mockInput.pressTab(); // port
    await setup.mockInput.typeText("2x2"); // letters are ignored in number fields
    setup.mockInput.pressTab(); // description
    await setup.mockInput.typeText("Fresh box");
    setup.mockInput.pressTab(); // tags
    await setup.mockInput.typeText("staging, web");
    setup.mockInput.pressTab(); // connect via (choice)
    setup.mockInput.pressKey("ARROW_RIGHT"); // default → hostname
    setup.mockInput.pressKey("s", { ctrl: true });
    text = await frame();
    expect(text).not.toContain("Add server");
    expect(text).toContain("Added new-box");
    expect(rowOrder(text)).toEqual(["bastion", "db-01", "new-box", "web-01"]);
    expect(text).toMatch(/▸\s+new-box/);
    const saved = parse(readFileSync(store.path, "utf8"));
    const entry = saved.servers.find((s: { name: string }) => s.name === "new-box");
    expect(entry).toMatchObject({ hostname: "new.example.com", user: "root", port: 22, description: "Fresh box", tags: ["staging", "web"], connect_via: "hostname", connections: 0 });
  });

  test("validation blocks duplicate names and shows the error", async () => {
    setup.mockInput.pressKey("a");
    await setup.mockInput.typeText("WEB-01");
    setup.mockInput.pressKey("s", { ctrl: true });
    let text = await frame();
    expect(text).toContain("Add server");
    expect(text).toContain('A server named "WEB-01" already exists');
    await pressEscape();
    text = await frame();
    expect(text).not.toContain("Add server");
    expect(parse(readFileSync(store.path, "utf8")).servers.length).toBe(3);
  });

  test("edits the selected server and keeps its counters", async () => {
    setup.mockInput.pressKey("e"); // bastion
    let text = await frame();
    expect(text).toContain("Edit server: bastion");
    // name field is focused with existing value; append a suffix
    setup.mockInput.pressKey("END");
    await setup.mockInput.typeText("-2");
    setup.mockInput.pressKey("s", { ctrl: true });
    text = await frame();
    expect(text).toContain("Updated bastion-2");
    const saved = parse(readFileSync(store.path, "utf8"));
    const entry = saved.servers.find((s: { name: string }) => s.name === "bastion-2");
    expect(entry.connections).toBe(40);
    expect(entry.hostname).toBe("bastion.example.com");
  });

  test("delete asks for confirmation", async () => {
    setup.mockInput.pressKey("d");
    let text = await frame();
    expect(text).toContain('Remove "bastion"');
    setup.mockInput.pressKey("n");
    text = await frame();
    expect(rowOrder(text)).toEqual(["bastion", "db-01", "web-01"]);
    setup.mockInput.pressKey("d");
    setup.mockInput.pressKey("y");
    text = await frame();
    expect(rowOrder(text)).toEqual(["db-01", "web-01"]);
    expect(text).toContain("Deleted bastion");
    expect(parse(readFileSync(store.path, "utf8")).servers.map((s: { name: string }) => s.name)).toEqual(["web-01", "db-01"]);
  });
});

describe("settings pane", () => {
  test("shows environment info, edits defaults and persists them", async () => {
    setup.mockInput.pressKey("c");
    let text = await frame();
    expect(text).toContain("Settings · defaults");
    expect(text).toContain("tmux 3.4 found");
    // default user field focused with "ops": replace it
    setup.mockInput.pressKey("END");
    for (let i = 0; i < 3; i++) setup.mockInput.pressKey("BACKSPACE");
    await setup.mockInput.typeText("admin");
    setup.mockInput.pressTab(); // key
    await setup.mockInput.typeText("~/.ssh/id_ed25519");
    setup.mockInput.pressTab(); // port
    setup.mockInput.pressTab(); // connect via
    setup.mockInput.pressKey(" "); // hostname → ipv4
    setup.mockInput.pressTab(); // launch mode
    setup.mockInput.pressKey("ARROW_RIGHT"); // auto → tmux
    setup.mockInput.pressTab(); // terminal cmd
    setup.mockInput.pressTab(); // ssh options
    await setup.mockInput.typeText('-o "ServerAliveInterval=30"');
    setup.mockInput.pressTab(); // prefix
    setup.mockInput.pressTab(); // hold on error
    setup.mockInput.pressKey(" "); // true → false
    setup.mockInput.pressKey("s", { ctrl: true });
    text = await frame();
    expect(text).toContain("Settings saved");
    const saved = parse(readFileSync(store.path, "utf8"));
    expect(saved.defaults.user).toBe("admin");
    expect(saved.defaults.identity_file).toBe("~/.ssh/id_ed25519");
    expect(saved.defaults.connect_via).toBe("ipv4");
    expect(saved.defaults.launch).toBe("tmux");
    expect(saved.defaults.ssh_options).toEqual(["-o", "ServerAliveInterval=30"]);
    expect(saved.defaults.tmux.hold_on_error).toBe(false);
    expect(app.config.defaults.user).toBe("admin");
  });

  test("Esc cancels without saving", async () => {
    setup.mockInput.pressKey("c");
    await frame();
    await setup.mockInput.typeText("junk");
    await pressEscape();
    const text = await frame();
    expect(text).not.toContain("Settings · defaults");
    expect(parse(readFileSync(store.path, "utf8")).defaults.user).toBe("ops");
  });
});

describe("sessions", () => {
  test("K kills a live session after confirmation; r reloads from disk", async () => {
    runner.sessions.add("ssh-bastion");
    app.refreshSessions(true);
    let text = await frame();
    expect(text).toMatch(/●\s+bastion/);
    setup.mockInput.pressKey("K", { shift: true });
    text = await frame();
    expect(text).toContain('Kill tmux session "ssh-bastion"');
    setup.mockInput.pressEnter();
    text = await frame();
    expect(text).toContain("Killed ssh-bastion");
    expect(runner.sessions.has("ssh-bastion")).toBe(false);
    expect(text).not.toMatch(/●\s+bastion/);

    // external edit + reload
    writeFileSync(store.path, CONFIG + "  - name: edge\n    hostname: edge.example.com\n");
    setup.mockInput.pressKey("r");
    text = await frame();
    expect(text).toContain("Reloaded");
    expect(rowOrder(text)).toEqual(["bastion", "db-01", "edge", "web-01"]);
  });

  test("Enter on a live session resumes instead of creating", async () => {
    runner.sessions.add("ssh-bastion");
    app.refreshSessions(true);
    setup.mockInput.pressEnter();
    await setup.waitFor(() => runner.inherit.length > 0);
    expect(runner.commands.some((c) => c[1] === "new-session")).toBe(false);
    expect(parse(readFileSync(store.path, "utf8")).servers[2].connections).toBe(40); // unchanged
  });
});

describe("narrow terminal", () => {
  test("drops low priority columns and still renders", async () => {
    setup.resize(50, 12);
    const text = await frame();
    expect(text).toContain("Name ▲");
    expect(text).not.toContain("Description");
    expect(rowOrder(text)).toEqual(["bastion", "db-01", "web-01"]);
  });
});
