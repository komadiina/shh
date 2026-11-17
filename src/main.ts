/**
 * sshtui entry point.
 */
import { createCliRenderer } from "@opentui/core";
import { CliError, parseArgs, USAGE } from "./cli.ts";
import { contractHome, resolveConfigPath } from "./config/paths.ts";
import { ConfigError } from "./config/schema.ts";
import { ConfigStore } from "./config/store.ts";
import type { Config } from "./config/types.ts";
import { Launcher, LaunchError } from "./session/launcher.ts";
import { SshTargetError } from "./session/ssh.ts";
import { Tmux } from "./session/tmux.ts";
import { App } from "./ui/app.ts";
import { fit, formatTimestamp } from "./ui/format.ts";
import { realRunner } from "./util/shell.ts";

export const VERSION = "0.1.0";

function printTable(config: Config, active: Set<string>): void {
  const rows = config.servers.map((s) => ({
    live: active.has(s.name) ? "●" : " ",
    name: s.name,
    host: s.hostname ?? "",
    ipv4: s.ipv4 ?? "",
    user: s.user ?? config.defaults.user ?? "",
    port: String(s.port ?? ""),
    conn: String(s.connections),
    last: formatTimestamp(s.last_connected),
    desc: s.description ?? "",
  }));
  const cols: Array<[keyof (typeof rows)[number], string]> = [
    ["live", " "],
    ["name", "NAME"],
    ["host", "HOST"],
    ["ipv4", "IPV4"],
    ["user", "USER"],
    ["port", "PORT"],
    ["conn", "CONN"],
    ["last", "LAST CONNECTED"],
    ["desc", "DESCRIPTION"],
  ];
  const widths = cols.map(([key, title]) => Math.max(title.length, ...rows.map((r) => r[key].length)));
  const line = (values: string[]) => values.map((v, i) => fit(v, widths[i]!)).join("  ").trimEnd();
  console.log(line(cols.map(([, title]) => title)));
  for (const r of rows) console.log(line(cols.map(([key]) => r[key])));
  if (rows.length === 0) console.log("(no servers configured)");
}

async function main(): Promise<number> {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.version) {
    console.log(`sshtui ${VERSION}`);
    return 0;
  }

  const configPath = resolveConfigPath(options.configPath);
  if (options.printConfigPath) {
    console.log(configPath);
    return 0;
  }

  const store = new ConfigStore(configPath);
  let loaded;
  try {
    loaded = store.load();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Could not load ${contractHome(configPath)}:\n  ${err.message}`);
      return 1;
    }
    throw err;
  }

  const tmux = new Tmux(realRunner);
  const launcher = new Launcher(tmux, realRunner);

  if (options.list) {
    for (const w of loaded.warnings) console.error(`warning: ${w}`);
    printTable(loaded.config, launcher.activeSessions(loaded.config.servers, loaded.config.defaults));
    return 0;
  }

  if (options.connect) {
    const server = loaded.config.servers.find((s) => s.name.toLowerCase() === options.connect!.toLowerCase());
    if (!server) {
      console.error(`No server named "${options.connect}". Known: ${loaded.config.servers.map((s) => s.name).join(", ") || "(none)"}`);
      return 1;
    }
    const needsTty = launcher.resolveMode(loaded.config.defaults).mode !== "terminal";
    if (needsTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      console.error("--connect needs an interactive terminal (or launch: terminal to open a new window).");
      return 1;
    }
    try {
      const outcome = await launcher.launch(server, loaded.config.defaults, { suspend: async () => {}, resume: async () => {} }, { via: options.via });
      if (outcome.newSession) {
        server.connections += 1;
        server.last_connected = new Date().toISOString();
        store.save(loaded.config);
      }
      for (const w of outcome.warnings) console.error(`warning: ${w}`);
      console.error(outcome.message);
      return outcome.exitCode ?? 0;
    } catch (err) {
      if (err instanceof LaunchError || err instanceof SshTargetError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("sshtui needs an interactive terminal. Try --list or --connect <name> for non-interactive use.");
    return 1;
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: false,
    targetFps: 30,
  });
  try {
    const app = new App({
      renderer,
      store,
      launcher,
      runner: realRunner,
      config: loaded.config,
      warnings: loaded.warnings,
      created: loaded.created,
    });
    app.start();
    await new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
  } finally {
    renderer.destroy();
  }
  await renderer.closed;
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  },
);
