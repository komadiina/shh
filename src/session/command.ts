/**
 * What every protocol builder produces: the client argv plus how a stored
 * password (if any) reaches the client. Pure data, no side effects.
 */
import type { ConnectVia, Protocol, ServerEntry } from "../config/types.ts";

export interface SessionCommand {
  protocol: Protocol;
  /** `tty` clients run in a terminal (tmux/inline/new window); `gui` clients open their own window. */
  kind: "tty" | "gui";
  /** Client argv. Never contains the password. */
  argv: string[];
  /** `user@host` (or just `host`), for messages. */
  target: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  via: ConnectVia;
  /** Decoded stored password, handed over out of band (see `secretVia`). */
  secret?: string;
  /**
   * How `secret` reaches the client:
   *   askpass – ssh asks a helper script that reads it from the environment.
   *   expect  – an expect script answers the remote login/password prompts.
   *   stdin   – the arguments, including the password, are piped to the client.
   */
  secretVia?: "askpass" | "expect" | "stdin";
}

export class SshTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshTargetError";
  }
}

export interface BuildOptions {
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
