/**
 * Turns the raw object parsed from YAML into a validated `Config`.
 *
 * Fatal problems (a server without a name, duplicate names, `servers` not being a
 * list, ...) throw a `ConfigError` with the YAML path of the offending value.
 * Recoverable problems (unknown launch mode, negative counters, ...) are coerced
 * and reported as warnings so the app can still start.
 */
import {
  CONNECT_VIA,
  LAUNCH_MODES,
  SORT_COLUMNS,
  SORT_DIRECTIONS,
  defaultDefaults,
  type Config,
  type ConnectVia,
  type Defaults,
  type LaunchMode,
  type ServerEntry,
  type SortColumn,
  type SortDirection,
} from "./types.ts";

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ConfigError";
  }
}

export interface NormalizeResult {
  config: Config;
  warnings: string[];
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const NAME_RE = /^[^\s/\\:]+$/;

export function isValidIPv4(value: string): boolean {
  return IPV4_RE.test(value);
}

export function isValidServerName(value: string): boolean {
  return NAME_RE.test(value);
}

export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optString(value: unknown, path: string, warnings: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  warnings.push(`${path}: expected a string, ignoring ${JSON.stringify(value)}`);
  return undefined;
}

function optPort(value: unknown, path: string, warnings: string[]): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num === "number" && isValidPort(num)) return num;
  warnings.push(`${path}: invalid port ${JSON.stringify(value)}, ignoring`);
  return undefined;
}

function counter(value: unknown, path: string, warnings: string[]): number {
  if (value === undefined || value === null) return 0;
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num === "number" && Number.isFinite(num) && num >= 0) return Math.floor(num);
  warnings.push(`${path}: invalid counter ${JSON.stringify(value)}, using 0`);
  return 0;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  warnings: string[],
): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  warnings.push(`${path}: expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}; using "${fallback}"`);
  return fallback;
}

function stringList(value: unknown, path: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    value.forEach((item, i) => {
      const s = optString(item, `${path}[${i}]`, warnings);
      if (s !== undefined) out.push(s);
    });
    return out;
  }
  warnings.push(`${path}: expected a list, ignoring`);
  return [];
}

function optBoolean(value: unknown, fallback: boolean, path: string, warnings: string[]): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  warnings.push(`${path}: expected true/false, using ${fallback}`);
  return fallback;
}

function optIsoDate(value: unknown, path: string, warnings: string[]): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    warnings.push(`${path}: invalid timestamp ${JSON.stringify(value)}, ignoring`);
    return undefined;
  }
  return date.toISOString();
}

export function normalizeDefaults(raw: unknown, warnings: string[], path = "defaults"): Defaults {
  const base = defaultDefaults();
  if (raw === undefined || raw === null) return base;
  if (!isRecord(raw)) throw new ConfigError("must be a mapping", path);

  const tmuxRaw = isRecord(raw.tmux) ? raw.tmux : {};
  const sortRaw = isRecord(raw.sort) ? raw.sort : {};

  return {
    user: optString(raw.user, `${path}.user`, warnings),
    identity_file: optString(raw.identity_file, `${path}.identity_file`, warnings),
    port: optPort(raw.port, `${path}.port`, warnings) ?? base.port,
    connect_via: enumValue<ConnectVia>(raw.connect_via, CONNECT_VIA, base.connect_via, `${path}.connect_via`, warnings),
    launch: enumValue<LaunchMode>(raw.launch, LAUNCH_MODES, base.launch, `${path}.launch`, warnings),
    terminal_command: optString(raw.terminal_command, `${path}.terminal_command`, warnings),
    ssh_options: stringList(raw.ssh_options, `${path}.ssh_options`, warnings),
    tmux: {
      session_prefix: optString(tmuxRaw.session_prefix, `${path}.tmux.session_prefix`, warnings) ?? base.tmux.session_prefix,
      hold_on_error: optBoolean(tmuxRaw.hold_on_error, base.tmux.hold_on_error, `${path}.tmux.hold_on_error`, warnings),
    },
    sort: {
      column: enumValue<SortColumn>(sortRaw.column, SORT_COLUMNS, base.sort.column, `${path}.sort.column`, warnings),
      direction: enumValue<SortDirection>(
        sortRaw.direction,
        SORT_DIRECTIONS,
        base.sort.direction,
        `${path}.sort.direction`,
        warnings,
      ),
    },
  };
}

export function normalizeServer(raw: unknown, index: number, warnings: string[]): ServerEntry {
  const path = `servers[${index}]`;
  if (!isRecord(raw)) throw new ConfigError("each server must be a mapping", path);

  const name = optString(raw.name, `${path}.name`, warnings);
  if (!name) throw new ConfigError("server needs a name", `${path}.name`);
  if (!isValidServerName(name)) {
    throw new ConfigError(`name "${name}" may not contain whitespace, '/', '\\' or ':'`, `${path}.name`);
  }

  const ipv4 = optString(raw.ipv4, `${path}.ipv4`, warnings);
  if (ipv4 !== undefined && !isValidIPv4(ipv4)) {
    warnings.push(`${path}.ipv4: "${ipv4}" is not a valid IPv4 address (kept as-is)`);
  }

  const server: ServerEntry = {
    name,
    hostname: optString(raw.hostname, `${path}.hostname`, warnings),
    ipv4,
    user: optString(raw.user, `${path}.user`, warnings),
    identity_file: optString(raw.identity_file, `${path}.identity_file`, warnings),
    port: optPort(raw.port, `${path}.port`, warnings),
    description: optString(raw.description, `${path}.description`, warnings),
    tags: stringList(raw.tags, `${path}.tags`, warnings),
    connections: counter(raw.connections, `${path}.connections`, warnings),
    last_connected: optIsoDate(raw.last_connected, `${path}.last_connected`, warnings),
    connect_via:
      raw.connect_via === undefined || raw.connect_via === null
        ? undefined
        : enumValue<ConnectVia>(raw.connect_via, CONNECT_VIA, "hostname", `${path}.connect_via`, warnings),
  };

  if (!server.hostname && !server.ipv4) {
    warnings.push(`${path}: "${name}" has neither hostname nor ipv4 and cannot be connected to`);
  }
  return server;
}

export function normalizeConfig(raw: unknown): NormalizeResult {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) {
    return { config: { version: 1, defaults: defaultDefaults(), servers: [] }, warnings };
  }
  if (!isRecord(raw)) throw new ConfigError("top level must be a mapping", "$");

  if (raw.version !== undefined && raw.version !== null && Number(raw.version) !== 1) {
    warnings.push(`version: unknown config version ${JSON.stringify(raw.version)}, reading it as version 1`);
  }

  const defaults = normalizeDefaults(raw.defaults, warnings);

  let servers: ServerEntry[] = [];
  if (raw.servers !== undefined && raw.servers !== null) {
    if (!Array.isArray(raw.servers)) throw new ConfigError("must be a list of servers", "servers");
    servers = raw.servers.map((item, i) => normalizeServer(item, i, warnings));
  }

  const seen = new Map<string, number>();
  servers.forEach((server, i) => {
    const key = server.name.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      throw new ConfigError(`duplicate server name "${server.name}" (also at servers[${first}])`, `servers[${i}].name`);
    }
    seen.set(key, i);
  });

  return { config: { version: 1, defaults, servers }, warnings };
}

/** Validation used by the add/edit form. Returns a map of field → error message. */
export function validateServerInput(
  input: {
    name: string;
    hostname: string;
    ipv4: string;
    port: string;
  },
  existingNames: string[],
  originalName?: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (!name) errors.name = "Name is required";
  else if (!isValidServerName(name)) errors.name = "No spaces, '/', '\\' or ':' in names";
  else if (
    existingNames.some((n) => n.toLowerCase() === name.toLowerCase() && n.toLowerCase() !== originalName?.toLowerCase())
  ) {
    errors.name = `A server named "${name}" already exists`;
  }

  if (!input.hostname.trim() && !input.ipv4.trim()) {
    errors.hostname = "Hostname or IPv4 is required";
  }
  const ipv4 = input.ipv4.trim();
  if (ipv4 && !isValidIPv4(ipv4)) errors.ipv4 = "Not a valid IPv4 address";

  const port = input.port.trim();
  if (port && !isValidPort(Number(port))) errors.port = "Port must be 1-65535";

  return errors;
}
