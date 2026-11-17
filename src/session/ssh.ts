/**
 * Builds the `ssh` command line for a server. Pure function, no side effects.
 */
import { expandHome } from "../config/paths.ts";
import { DEFAULT_PORT, type ConnectVia, type Defaults, type ServerEntry } from "../config/types.ts";

export interface SshCommand {
  /** Full argv, e.g. `["ssh", "-p", "2222", "-i", "/home/me/.ssh/key", "deploy@web.example.com"]`. */
  argv: string[];
  /** `user@host` (or just `host`). */
  target: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  via: ConnectVia;
}

export class SshTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshTargetError";
  }
}

export interface BuildSshOptions {
  /** Override which address to use for this one connection. */
  via?: ConnectVia;
  home?: string;
}

export function resolveHost(server: ServerEntry, via: ConnectVia): { host: string; via: ConnectVia } {
  const preferIp = via === "ipv4";
  const primary = preferIp ? server.ipv4 : server.hostname;
  const secondary = preferIp ? server.hostname : server.ipv4;
  if (primary) return { host: primary, via };
  if (secondary) return { host: secondary, via: preferIp ? "hostname" : "ipv4" };
  throw new SshTargetError(`"${server.name}" has neither a hostname nor an IPv4 address`);
}

export function buildSshCommand(server: ServerEntry, defaults: Defaults, options: BuildSshOptions = {}): SshCommand {
  const via = options.via ?? server.connect_via ?? defaults.connect_via;
  const { host, via: usedVia } = resolveHost(server, via);
  const user = server.user ?? defaults.user;
  const identityRaw = server.identity_file ?? defaults.identity_file;
  const identityFile = identityRaw ? expandHome(identityRaw, options.home) : undefined;

  // Only force a port when the server sets one or the default was changed, so
  // `Port` directives in ~/.ssh/config keep working for everything else.
  let port: number | undefined;
  if (server.port !== undefined) port = server.port;
  else if (defaults.port !== DEFAULT_PORT) port = defaults.port;

  const argv: string[] = ["ssh"];
  if (port !== undefined) argv.push("-p", String(port));
  if (identityFile) argv.push("-i", identityFile);
  argv.push(...defaults.ssh_options);
  const target = user ? `${user}@${host}` : host;
  argv.push(target);

  return { argv, target, host, user, port, identityFile, via: usedVia };
}
