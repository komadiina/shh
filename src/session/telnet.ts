/**
 * Builds the `telnet` command line for a server. Pure function, no side effects.
 *
 * telnet has no way to take a password on the command line; a stored password is
 * typed into the remote login prompt by an expect script (see `secrets.ts`).
 */
import { decodePassword } from "../config/secret.ts";
import { authOf, type Defaults, type ServerEntry } from "../config/types.ts";
import { resolveHost, type BuildOptions, type SessionCommand } from "./command.ts";

export function buildTelnetCommand(server: ServerEntry, defaults: Defaults, options: BuildOptions = {}): SessionCommand {
  const via = options.via ?? server.connect_via ?? defaults.connect_via;
  const { host, via: usedVia } = resolveHost(server, via);
  const user = server.user ?? defaults.user;
  const userpass = authOf(server) === "userpass";
  const secret = userpass && server.password_b64 ? decodePassword(server.password_b64) : undefined;
  const port = server.port;

  const argv = ["telnet"];
  if (user) argv.push("-l", user);
  argv.push(host);
  if (port !== undefined) argv.push(String(port));

  return {
    protocol: "telnet",
    kind: "tty",
    argv,
    target: user ? `${user}@${host}` : host,
    host,
    user,
    port,
    via: usedVia,
    ...(secret !== undefined ? { secret, secretVia: "expect" as const } : {}),
  };
}
