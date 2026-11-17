import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { contractHome, expandHome, resolveConfigPath } from "../src/config/paths.ts";
import { ConfigError, normalizeConfig, validateServerInput } from "../src/config/schema.ts";
import { ConfigStore } from "../src/config/store.ts";
import { newServer } from "../src/config/types.ts";

describe("normalizeConfig", () => {
  test("empty document yields defaults", () => {
    const { config, warnings } = normalizeConfig(null);
    expect(config.servers).toEqual([]);
    expect(config.defaults.port).toBe(22);
    expect(config.defaults.launch).toBe("auto");
    expect(config.defaults.tmux.session_prefix).toBe("ssh-");
    expect(warnings).toEqual([]);
  });

  test("parses servers and defaults", () => {
    const { config, warnings } = normalizeConfig({
      version: 1,
      defaults: { user: "root", identity_file: "~/.ssh/id_ed25519", launch: "tmux", ssh_options: "-o ServerAliveInterval=30" },
      servers: [
        {
          name: "web-01",
          hostname: "web.example.com",
          ipv4: "203.0.113.10",
          user: "deploy",
          port: "2222",
          description: "Web",
          tags: ["prod", "web"],
          connections: 3,
          last_connected: "2026-11-10T14:03:00Z",
        },
      ],
    });
    expect(warnings).toEqual([]);
    expect(config.defaults.user).toBe("root");
    expect(config.defaults.launch).toBe("tmux");
    expect(config.defaults.ssh_options).toEqual(["-o", "ServerAliveInterval=30"]);
    const s = config.servers[0]!;
    expect(s.port).toBe(2222);
    expect(s.connections).toBe(3);
    expect(s.tags).toEqual(["prod", "web"]);
    expect(s.last_connected).toBe("2026-11-10T14:03:00.000Z");
  });

  test("coerces bad enum values with a warning", () => {
    const { config, warnings } = normalizeConfig({ defaults: { launch: "bogus", connect_via: "ipv6" } });
    expect(config.defaults.launch).toBe("auto");
    expect(config.defaults.connect_via).toBe("hostname");
    expect(warnings.length).toBe(2);
  });

  test("rejects servers without names and duplicates", () => {
    expect(() => normalizeConfig({ servers: [{ hostname: "x" }] })).toThrow(ConfigError);
    expect(() => normalizeConfig({ servers: [{ name: "a", hostname: "x" }, { name: "A", ipv4: "10.0.0.1" }] })).toThrow(
      /duplicate/,
    );
    expect(() => normalizeConfig({ servers: { name: "a" } })).toThrow(/list/);
    expect(() => normalizeConfig({ servers: [{ name: "has space", hostname: "x" }] })).toThrow(/whitespace/);
  });

  test("warns about servers without an address and invalid ipv4", () => {
    const { warnings } = normalizeConfig({ servers: [{ name: "lonely" }, { name: "bad", ipv4: "999.1.1.1" }] });
    expect(warnings.some((w) => w.includes("neither hostname nor ipv4"))).toBe(true);
    expect(warnings.some((w) => w.includes("not a valid IPv4"))).toBe(true);
  });
});

describe("validateServerInput", () => {
  test("requires a name and an address", () => {
    const errors = validateServerInput({ name: "", hostname: "", ipv4: "", port: "" }, []);
    expect(errors.name).toBeDefined();
    expect(errors.hostname).toBeDefined();
  });

  test("rejects duplicate names except the entry being edited", () => {
    expect(validateServerInput({ name: "web", hostname: "h", ipv4: "", port: "" }, ["web"]).name).toMatch(/exists/);
    expect(validateServerInput({ name: "web", hostname: "h", ipv4: "", port: "" }, ["web"], "web")).toEqual({});
  });

  test("validates ipv4 and port", () => {
    const errors = validateServerInput({ name: "x", hostname: "", ipv4: "1.2.3", port: "70000" }, []);
    expect(errors.ipv4).toBeDefined();
    expect(errors.port).toBeDefined();
    expect(validateServerInput({ name: "x", hostname: "", ipv4: "10.0.0.1", port: "22" }, [])).toEqual({});
  });
});

describe("paths", () => {
  test("expands and contracts ~", () => {
    expect(expandHome("~/.ssh/key", "/home/me")).toBe("/home/me/.ssh/key");
    expect(expandHome("/abs", "/home/me")).toBe("/abs");
    expect(contractHome("/home/me/.ssh/key", "/home/me")).toBe("~/.ssh/key");
  });

  test("resolves config path with precedence explicit > env > XDG", () => {
    expect(resolveConfigPath("/tmp/x.yaml", {})).toBe("/tmp/x.yaml");
    expect(resolveConfigPath(undefined, { SHH_CONFIG: "/tmp/env.yaml" })).toBe("/tmp/env.yaml");
    expect(resolveConfigPath(undefined, { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/shh/config.yaml");
  });
});

describe("ConfigStore", () => {
  function tempStore(): ConfigStore {
    const dir = mkdtempSync(join(tmpdir(), "shh-test-"));
    return new ConfigStore(join(dir, "nested", "config.yaml"));
  }

  test("creates a starter config on first load", () => {
    const store = tempStore();
    const { config, created, warnings } = store.load();
    expect(created).toBe(true);
    expect(warnings).toEqual([]);
    expect(config.servers.length).toBe(1);
    expect(config.servers[0]!.name).toBe("example");
    expect(store.exists()).toBe(true);
  });

  test("save preserves comments, updates counters, adds and removes servers", () => {
    const store = tempStore();
    const { config } = store.load();

    // mutate: bump counter on existing, add one, then save
    config.servers[0]!.connections = 7;
    config.servers[0]!.last_connected = "2026-11-16T20:00:00.000Z";
    config.servers.push({ ...newServer("db-01"), ipv4: "10.0.0.5", user: "pg", tags: ["db"] });
    config.defaults.user = "ops";
    store.save(config);

    const text = readFileSync(store.path, "utf8");
    expect(text).toContain("# shh configuration"); // top comment preserved
    expect(text).toContain("# Login user for servers that do not set one"); // nested comment preserved
    const parsed = parse(text);
    expect(parsed.defaults.user).toBe("ops");
    expect(parsed.servers[0].connections).toBe(7);
    expect(parsed.servers[0].last_connected).toBe("2026-11-16T20:00:00.000Z");
    expect(parsed.servers[1]).toMatchObject({ name: "db-01", ipv4: "10.0.0.5", user: "pg", tags: ["db"], connections: 0 });
    expect(parsed.servers[1].hostname).toBeUndefined();

    // reload through a fresh store and remove a server
    const store2 = new ConfigStore(store.path);
    const reloaded = store2.load().config;
    expect(reloaded.servers.map((s) => s.name)).toEqual(["example", "db-01"]);
    reloaded.servers.splice(0, 1);
    store2.save(reloaded);
    const parsed2 = parse(readFileSync(store.path, "utf8"));
    expect(parsed2.servers.map((s: { name: string }) => s.name)).toEqual(["db-01"]);
  });

  test("saving an empty server list writes an empty list, not null", () => {
    const store = tempStore();
    const { config } = store.load();
    config.servers = [];
    store.save(config);
    const parsed = parse(readFileSync(store.path, "utf8"));
    expect(parsed.servers).toEqual([]);
    expect(new ConfigStore(store.path).load().config.servers).toEqual([]);
  });

  test("reports YAML syntax errors with the file path", () => {
    const store = tempStore();
    store.load();
    writeFileSync(store.path, "servers: [\n  - name: broken\n");
    expect(() => new ConfigStore(store.path).load()).toThrow(/YAML syntax error/);
  });
});
