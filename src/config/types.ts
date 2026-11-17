/**
 * Config data model.
 *
 * Everything the app knows about servers and defaults lives in one YAML file
 * (see `store.ts` for its location). The app never reads private keys; it only
 * stores *paths* to them (`identity_file`) and hands those paths to `ssh -i`.
 */

/** How the SSH session is started once a server is selected. */
export type LaunchMode =
  /** tmux when it is installed, otherwise `inline`. */
  | "auto"
  /** Always use tmux (resumable sessions). Falls back to `inline` with a warning if tmux is missing. */
  | "tmux"
  /** Run ssh in the terminal the app is running in; no persistence. */
  | "inline"
  /** Open a new window of the user's terminal emulator (tmux-backed when tmux is available). */
  | "terminal";

/** Which address of a server is used as the ssh target. */
export type ConnectVia = "hostname" | "ipv4";

/** How a server is reached. Missing in the config means `ssh`. */
export type Protocol = "ssh" | "telnet" | "rdp";

/**
 * How the user logs in.
 *   pubkey   – ssh key (`identity_file`) or whatever ssh decides. ssh only.
 *   userpass – user + password; the password is optional and may be stored base64-encoded.
 *   none     – no automated login (telnet only; the remote login prompt is answered by hand).
 */
export type AuthMethod = "pubkey" | "userpass" | "none";

/** RDP certificate policy, passed as `/cert:<value>`. */
export type RdpCert = "tofu" | "ignore" | "deny";

export type SortColumn =
  | "name"
  | "protocol"
  | "hostname"
  | "ipv4"
  | "user"
  | "identity_file"
  | "port"
  | "connections"
  | "description"
  | "last_connected";

export type SortDirection = "asc" | "desc";

export const LAUNCH_MODES: readonly LaunchMode[] = ["auto", "tmux", "inline", "terminal"];
export const CONNECT_VIA: readonly ConnectVia[] = ["hostname", "ipv4"];
export const PROTOCOLS: readonly Protocol[] = ["ssh", "telnet", "rdp"];
export const AUTH_METHODS: readonly AuthMethod[] = ["pubkey", "userpass", "none"];
export const RDP_CERTS: readonly RdpCert[] = ["tofu", "ignore", "deny"];
export const SORT_COLUMNS: readonly SortColumn[] = [
  "name",
  "protocol",
  "hostname",
  "ipv4",
  "user",
  "identity_file",
  "port",
  "connections",
  "description",
  "last_connected",
];
export const SORT_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

/** Auth methods each protocol supports, in the order the form shows them. The first one is the default. */
export const PROTOCOL_AUTH: Record<Protocol, readonly AuthMethod[]> = {
  ssh: ["pubkey", "userpass"],
  telnet: ["none", "userpass"],
  rdp: ["userpass"],
};

/** Well-known port per protocol (used when a server sets none). */
export const PROTOCOL_PORT: Record<Protocol, number> = { ssh: 22, telnet: 23, rdp: 3389 };

export interface RdpSettings {
  domain?: string;
  /** `auto` (dynamic resolution), `fullscreen`, or `<width>x<height>`. */
  resolution?: string;
  cert?: RdpCert;
  /** Share the clipboard (`+clipboard`). */
  clipboard?: boolean;
  /** Local directory shared with the remote as a drive. */
  drive?: string;
}

export interface ServerEntry {
  /** Unique, human readable identifier. Also used to derive the tmux session name. */
  name: string;
  /** Missing means ssh. */
  protocol?: Protocol;
  hostname?: string;
  ipv4?: string;
  /** Login user. Falls back to `defaults.user`, then to ssh's own default. */
  user?: string;
  /** Path to the private key (never read by the app, only passed to `ssh -i`). */
  identity_file?: string;
  /** Missing means the protocol's first auth method (`PROTOCOL_AUTH`). */
  auth?: AuthMethod;
  /**
   * Base64-encoded password for `auth: userpass`. Base64 is an encoding, not
   * encryption: anyone who can read the config file can read the password.
   */
  password_b64?: string;
  port?: number;
  /** Only used when `protocol: rdp`. */
  rdp?: RdpSettings;
  description?: string;
  tags: string[];
  /** How many times a *new* ssh session has been started for this server. */
  connections: number;
  /** ISO-8601 timestamp of the last new session. */
  last_connected?: string;
  /** Per-server override of `defaults.connect_via`. */
  connect_via?: ConnectVia;
}

export interface TmuxDefaults {
  /** Prefix for tmux session names, e.g. `ssh-` → `ssh-web-01`. */
  session_prefix: string;
  /**
   * Keep the tmux window open (waiting for Enter) when ssh exits with a non-zero
   * status, so connection errors can be read instead of vanishing.
   */
  hold_on_error: boolean;
}

export interface SortDefaults {
  column: SortColumn;
  direction: SortDirection;
}

export interface Defaults {
  /** Default login user for servers that do not set one. */
  user?: string;
  /** Default private key path for servers that do not set one. */
  identity_file?: string;
  /** Default port. `-p` is only passed to ssh when a server sets a port or this is not 22. */
  port: number;
  connect_via: ConnectVia;
  launch: LaunchMode;
  /**
   * Shell command template used by `launch: terminal`. `{cmd}` is replaced with the
   * (shell-quoted) command to run, e.g. `alacritty -e {cmd}`. Empty → auto-detect.
   */
  terminal_command?: string;
  /** Extra arguments appended to every ssh invocation, e.g. `["-o", "ServerAliveInterval=30"]`. */
  ssh_options: string[];
  /** Extra arguments appended to every RDP client invocation, e.g. `["/sound"]`. */
  rdp_options: string[];
  tmux: TmuxDefaults;
  sort: SortDefaults;
}

export interface Config {
  version: 1;
  defaults: Defaults;
  servers: ServerEntry[];
}

export const DEFAULT_PORT = 22;

export function defaultDefaults(): Defaults {
  return {
    user: undefined,
    identity_file: undefined,
    port: DEFAULT_PORT,
    connect_via: "hostname",
    launch: "auto",
    terminal_command: undefined,
    ssh_options: [],
    rdp_options: [],
    tmux: { session_prefix: "ssh-", hold_on_error: true },
    sort: { column: "name", direction: "asc" },
  };
}

export function emptyConfig(): Config {
  return { version: 1, defaults: defaultDefaults(), servers: [] };
}

export function newServer(name = ""): ServerEntry {
  return { name, tags: [], connections: 0 };
}

/** Deep-clone a config (plain data, so structured clone is enough). */
export function cloneConfig(config: Config): Config {
  return structuredClone(config);
}

export function protocolOf(server: ServerEntry): Protocol {
  return server.protocol ?? "ssh";
}

/** The effective auth method: the configured one when the protocol supports it, else the protocol default. */
export function authOf(server: ServerEntry): AuthMethod {
  const allowed = PROTOCOL_AUTH[protocolOf(server)];
  return server.auth && allowed.includes(server.auth) ? server.auth : allowed[0]!;
}
