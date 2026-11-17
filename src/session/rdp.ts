/**
 * Builds the RDP client command line for a server. Pure function, no side effects.
 *
 * Only FreeRDP 3 (`xfreerdp3`) is supported for now. A stored password is never
 * put in argv: the launcher pipes all arguments, `/p:` included, to the client's
 * `/args-from:stdin`.
 */
import { expandHome } from "../config/paths.ts";
import { decodePassword } from "../config/secret.ts";
import type { Defaults, ServerEntry } from "../config/types.ts";
import { SshTargetError, resolveHost, type BuildOptions, type SessionCommand } from "./command.ts";

/** Known RDP clients, most preferred first. */
export const RDP_CLIENTS: readonly string[] = ["xfreerdp3"];

export interface BuildRdpOptions extends BuildOptions {
  /** The client binary to run (see `RDP_CLIENTS`). */
  client?: string;
}

export function buildRdpCommand(server: ServerEntry, defaults: Defaults, options: BuildRdpOptions = {}): SessionCommand {
  const via = options.via ?? server.connect_via ?? defaults.connect_via;
  const { host, via: usedVia } = resolveHost(server, via);
  const user = server.user ?? defaults.user;
  const rdp = server.rdp ?? {};
  const port = server.port;
  const secret = server.password_b64 ? decodePassword(server.password_b64) : undefined;

  const argv = [options.client ?? RDP_CLIENTS[0]!, port === undefined ? `/v:${host}` : `/v:${host}:${port}`];
  if (user) argv.push(`/u:${user}`);
  if (rdp.domain) argv.push(`/d:${rdp.domain}`);
  const resolution = rdp.resolution ?? "auto";
  if (resolution === "auto") argv.push("/dynamic-resolution");
  else if (resolution === "fullscreen") argv.push("/f");
  else argv.push(`/size:${resolution}`);
  // The client cannot ask about unknown certificates from a detached window, so default to trust-on-first-use.
  argv.push(`/cert:${rdp.cert ?? "tofu"}`);
  argv.push(rdp.clipboard === false ? "-clipboard" : "+clipboard");
  if (rdp.drive) argv.push(`/drive:share,${expandHome(rdp.drive, options.home)}`);
  argv.push(...defaults.rdp_options);

  // /args-from takes one argument per line
  if (argv.some((a) => /[\r\n]/.test(a)) || (secret !== undefined && /[\r\n]/.test(secret))) {
    throw new SshTargetError(`"${server.name}": RDP settings and password may not contain line breaks`);
  }

  return {
    protocol: "rdp",
    kind: "gui",
    argv,
    target: user ? `${user}@${host}` : host,
    host,
    user,
    port,
    via: usedVia,
    ...(secret !== undefined ? { secret, secretVia: "stdin" as const } : {}),
  };
}
