/**
 * Protocol dispatch and client detection: which clients are installed, and
 * which protocols / auth methods can therefore be offered.
 */
import { protocolOf, type AuthMethod, type Defaults, type Protocol, type ServerEntry } from "../config/types.ts";
import type { ProcessRunner } from "../util/shell.ts";
import type { BuildOptions, SessionCommand } from "./command.ts";
import { RDP_CLIENTS, buildRdpCommand } from "./rdp.ts";
import { buildSshCommand } from "./ssh.ts";
import { buildTelnetCommand } from "./telnet.ts";

export interface ClientStatus {
  ssh: boolean;
  telnet: boolean;
  /** Needed to log in to telnet with a stored password. */
  expect: boolean;
  /** First installed client from `RDP_CLIENTS`, or null. */
  rdp: string | null;
}

export function detectClients(runner: ProcessRunner): ClientStatus {
  return {
    ssh: runner.commandExists("ssh"),
    telnet: runner.commandExists("telnet"),
    expect: runner.commandExists("expect"),
    rdp: RDP_CLIENTS.find((bin) => runner.commandExists(bin)) ?? null,
  };
}

/** Why `protocol` cannot be used on this machine, or undefined when it can. */
export function protocolUnavailable(protocol: Protocol, clients: ClientStatus): string | undefined {
  switch (protocol) {
    case "ssh":
      return clients.ssh ? undefined : "ssh not found";
    case "telnet":
      return clients.telnet ? undefined : "telnet not found";
    case "rdp":
      return clients.rdp ? undefined : `${RDP_CLIENTS.join("/")} not found`;
  }
}

/** Why `auth` cannot be used with `protocol` on this machine, or undefined when it can. */
export function authUnavailable(protocol: Protocol, auth: AuthMethod, clients: ClientStatus): string | undefined {
  if (protocol === "telnet" && auth === "userpass" && !clients.expect) return "telnet logins need expect";
  return undefined;
}

export function buildSessionCommand(
  server: ServerEntry,
  defaults: Defaults,
  clients: ClientStatus,
  options: BuildOptions = {},
): SessionCommand {
  switch (protocolOf(server)) {
    case "telnet":
      return buildTelnetCommand(server, defaults, options);
    case "rdp":
      return buildRdpCommand(server, defaults, { ...options, client: clients.rdp ?? undefined });
    case "ssh":
    default:
      return buildSshCommand(server, defaults, options);
  }
}
