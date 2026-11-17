/**
 * Loads and saves the YAML config file.
 *
 * Saving goes through the parsed YAML `Document` instead of re-serialising a plain
 * object, so comments and key order that the user put in the file survive edits
 * made from the TUI. Writes are atomic (temp file + rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Document, YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from "yaml";
import { ConfigError, normalizeConfig } from "./schema.ts";
import { defaultDefaults, type Config, type Defaults, type ServerEntry } from "./types.ts";

export const INITIAL_CONFIG_TEMPLATE = `# sshtui configuration
# Docs: see docs/USER_GUIDE.md in the project. Edit freely; comments are preserved.
version: 1

defaults:
  # Login user for servers that do not set one. Leave empty to let ssh decide.
  user: ""
  # Private key for servers that do not set one. Only the *path* is stored; the app never reads it.
  identity_file: ""
  # -p is only passed to ssh when a server sets a port, or this is not 22.
  port: 22
  # Which address to connect to by default: hostname | ipv4
  connect_via: hostname
  # auto (tmux if installed, else inline) | tmux | inline | terminal
  launch: auto
  # Used by "launch: terminal". {cmd} is replaced with the command to run.
  # Examples: "alacritty -e {cmd}", "gnome-terminal -- {cmd}", "kitty {cmd}"
  terminal_command: ""
  # Extra arguments for every ssh call.
  ssh_options: []
  # Extra arguments for every RDP (xfreerdp3) call, e.g. ["/sound"].
  rdp_options: []
  tmux:
    session_prefix: "ssh-"
    hold_on_error: true
  sort:
    column: name
    direction: asc

servers:
  - name: example
    hostname: example.com
    ipv4: 93.184.216.34
    user: admin
    identity_file: ~/.ssh/id_ed25519
    port: 22
    description: Example entry - edit or delete me (press e / d)
    tags: [example]
    connections: 0
`;

/** Order in which server keys are written for new entries. */
const SERVER_KEY_ORDER: (keyof ServerEntry)[] = [
  "name",
  "protocol",
  "hostname",
  "ipv4",
  "user",
  "identity_file",
  "auth",
  "password_b64",
  "port",
  "rdp",
  "description",
  "tags",
  "connect_via",
  "connections",
  "last_connected",
];

export interface LoadResult {
  config: Config;
  warnings: string[];
  /** True when the file did not exist and a starter config was written. */
  created: boolean;
}

export class ConfigStore {
  private doc: Document | null = null;

  constructor(readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /** Load the config, creating a starter file when none exists. */
  load(): LoadResult {
    let created = false;
    if (!this.exists()) {
      this.writeAtomic(INITIAL_CONFIG_TEMPLATE);
      created = true;
    }
    const text = readFileSync(this.path, "utf8");
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
      const first = doc.errors[0]!;
      throw new ConfigError(`YAML syntax error: ${first.message.split("\n")[0]}`, this.path);
    }
    const { config, warnings } = normalizeConfig(doc.toJS());
    this.doc = doc;
    return { config, warnings, created };
  }

  /** Persist the config, keeping comments from the file on disk where possible. */
  save(config: Config): void {
    const doc = this.doc ?? new Document({});
    if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
    const root = doc.contents as YAMLMap;

    root.set("version", 1);
    this.applyDefaults(doc, root, config.defaults);
    this.applyServers(doc, root, config.servers);

    this.doc = doc;
    this.writeAtomic(doc.toString({ lineWidth: 0 }));
  }

  private applyDefaults(doc: Document, root: YAMLMap, defaults: Defaults): void {
    let node = root.get("defaults");
    if (!isMap(node)) {
      node = doc.createNode({}) as YAMLMap;
      root.set("defaults", node);
    }
    const map = node as YAMLMap;
    const base = defaultDefaults();

    setOrDelete(map, "user", defaults.user ?? "");
    setOrDelete(map, "identity_file", defaults.identity_file ?? "");
    map.set("port", defaults.port);
    map.set("connect_via", defaults.connect_via);
    map.set("launch", defaults.launch);
    setOrDelete(map, "terminal_command", defaults.terminal_command ?? "");
    map.set("ssh_options", doc.createNode(defaults.ssh_options, { flow: true }));
    if (defaults.rdp_options.length > 0 || map.has("rdp_options")) {
      map.set("rdp_options", doc.createNode(defaults.rdp_options, { flow: true }));
    }

    let tmux = map.get("tmux");
    if (!isMap(tmux)) {
      tmux = doc.createNode({}) as YAMLMap;
      map.set("tmux", tmux);
    }
    (tmux as YAMLMap).set("session_prefix", defaults.tmux.session_prefix ?? base.tmux.session_prefix);
    (tmux as YAMLMap).set("hold_on_error", defaults.tmux.hold_on_error);

    let sort = map.get("sort");
    if (!isMap(sort)) {
      sort = doc.createNode({}) as YAMLMap;
      map.set("sort", sort);
    }
    (sort as YAMLMap).set("column", defaults.sort.column);
    (sort as YAMLMap).set("direction", defaults.sort.direction);
  }

  private applyServers(doc: Document, root: YAMLMap, servers: ServerEntry[]): void {
    let seqNode = root.get("servers");
    if (!isSeq(seqNode)) {
      seqNode = doc.createNode([]) as YAMLSeq;
      root.set("servers", seqNode);
    }
    const seq = seqNode as YAMLSeq;

    // Index existing entries by name so comments on untouched servers survive.
    const existing = new Map<string, YAMLMap>();
    for (const item of seq.items) {
      if (isMap(item)) {
        const name = item.get("name", true);
        const key = name && typeof name.value === "string" ? name.value.toLowerCase() : null;
        if (key && !existing.has(key)) existing.set(key, item);
      }
    }

    const items: YAMLMap[] = [];
    for (const server of servers) {
      const prev = existing.get(server.name.toLowerCase());
      const map = prev ?? (doc.createNode({}) as YAMLMap);
      for (const key of SERVER_KEY_ORDER) {
        const value = server[key];
        if (key === "tags") {
          if (server.tags.length === 0) map.delete("tags");
          else map.set("tags", doc.createNode(server.tags, { flow: true }));
          continue;
        }
        if (key === "rdp") {
          const rdp = Object.fromEntries(Object.entries(server.rdp ?? {}).filter(([, v]) => v !== undefined && v !== ""));
          if (Object.keys(rdp).length === 0) map.delete("rdp");
          else map.set("rdp", doc.createNode(rdp));
          continue;
        }
        if (key === "connections") {
          map.set("connections", server.connections);
          continue;
        }
        if (value === undefined || value === null || value === "") {
          map.delete(key);
        } else {
          map.set(key, value);
        }
      }
      items.push(map);
    }
    seq.items = items;
    // Write `servers: []` (not `servers:` → null) when the list is empty.
    if (items.length === 0) seq.flow = true;
    else seq.flow = false;
  }

  private writeAtomic(text: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

function setOrDelete(map: YAMLMap, key: string, value: string): void {
  if (value === "") {
    // Keep the key visible (with an empty value) if the user had it; otherwise leave it out.
    if (map.has(key)) map.set(key, "");
  } else {
    map.set(key, value);
  }
}
