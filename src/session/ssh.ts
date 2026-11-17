/**
 * Builds the `ssh` command line for a server. Pure function, no side effects.
 */
import { expandHome } from "../config/paths.ts";
import { decodePassword } from "../config/secret.ts";
import { DEFAULT_PORT, authOf, type Defaults, type ServerEntry } from "../config/types.ts";
import { resolveHost, type BuildOptions, type SessionCommand } from "./command.ts";

export { resolveHost, SshTargetError } from "./command.ts";
export type SshCommand = SessionCommand;
export type BuildSshOptions = BuildOptions;

export function buildSshCommand(server: ServerEntry, defaults: Defaults, options: BuildOptions = {}): SessionCommand {
  const via = options.via ?? server.connect_via ?? defaults.connect_via;
  const { host, via: usedVia } = resolveHost(server, via);
  const user = server.user ?? defaults.user;
  const userpass = authOf(server) === "userpass";
  const identityRaw = userpass ? undefined : (server.identity_file ?? defaults.identity_file);
  const identityFile = identityRaw ? expandHome(identityRaw, options.home) : undefined;
  const secret = userpass && server.password_b64 ? decodePassword(server.password_b64) : undefined;

  // Only force a port when the server sets one or the default was changed, so
  // `Port` directives in ~/.ssh/config keep working for everything else.
  let port: number | undefined;
  if (server.port !== undefined) port = server.port;
  else if (defaults.port !== DEFAULT_PORT) port = defaults.port;

  const argv: string[] = ["ssh"];
  if (port !== undefined) argv.push("-p", String(port));
  if (identityFile) argv.push("-i", identityFile);
  if (userpass) {
    argv.push("-o", "PreferredAuthentications=keyboard-interactive,password", "-o", "PubkeyAuthentication=no");
    // a wrong stored password should fail once instead of being replayed by askpass
    if (secret !== undefined) argv.push("-o", "NumberOfPasswordPrompts=1");
  }
  argv.push(...defaults.ssh_options);
  const target = user ? `${user}@${host}` : host;
  argv.push(target);

  return {
    protocol: "ssh",
    kind: "tty",
    argv,
    target,
    host,
    user,
    port,
    identityFile,
    via: usedVia,
    ...(secret !== undefined ? { secret, secretVia: "askpass" as const } : {}),
  };
}
