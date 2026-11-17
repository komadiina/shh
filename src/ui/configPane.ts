/** Field definitions + conversions for the settings (defaults) pane. */
import { isValidPort } from "../config/schema.ts";
import {
  CONNECT_VIA,
  LAUNCH_MODES,
  SORT_COLUMNS,
  SORT_DIRECTIONS,
  type ConnectVia,
  type Defaults,
  type LaunchMode,
  type SortColumn,
  type SortDirection,
} from "../config/types.ts";
import { shellJoin, shellSplit } from "../util/shell.ts";
import type { FieldSpec, FormValues } from "./modal.ts";

export const CONFIG_FIELDS: FieldSpec[] = [
  { kind: "text", key: "user", label: "Default user", placeholder: "(ssh decides)", help: "Used for servers without a user" },
  { kind: "text", key: "identity_file", label: "Default key", placeholder: "~/.ssh/id_ed25519", help: "Path only; passed as ssh -i, never read" },
  { kind: "number", key: "port", label: "Default port", placeholder: "22", help: "-p is passed only when a server sets a port or this is not 22" },
  { kind: "choice", key: "connect_via", label: "Connect via", options: CONNECT_VIA, help: "Prefer hostname or IPv4 when both are set" },
  { kind: "choice", key: "launch", label: "Launch mode", options: LAUNCH_MODES, help: "auto: tmux if installed else inline · terminal: new emulator window" },
  { kind: "text", key: "terminal_command", label: "Terminal cmd", placeholder: "alacritty -e {cmd}  (auto-detect when empty)", help: "Template for launch: terminal; {cmd} = the command to run" },
  { kind: "text", key: "ssh_options", label: "ssh options", placeholder: "-o ServerAliveInterval=30", help: "Extra arguments for every ssh call (shell quoting allowed)" },
  { kind: "text", key: "session_prefix", label: "tmux prefix", placeholder: "ssh-", help: "tmux session name = prefix + server name" },
  { kind: "toggle", key: "hold_on_error", label: "Hold on error", help: "Keep the tmux window open when ssh fails, so the error can be read" },
  { kind: "choice", key: "sort_column", label: "Sort column", options: SORT_COLUMNS, help: "Sort applied when the app starts" },
  { kind: "choice", key: "sort_direction", label: "Sort dir", options: SORT_DIRECTIONS, help: "asc or desc" },
];

export function defaultsToValues(d: Defaults): FormValues {
  return {
    user: d.user ?? "",
    identity_file: d.identity_file ?? "",
    port: String(d.port),
    connect_via: d.connect_via,
    launch: d.launch,
    terminal_command: d.terminal_command ?? "",
    ssh_options: shellJoin(d.ssh_options),
    session_prefix: d.tmux.session_prefix,
    hold_on_error: d.tmux.hold_on_error,
    sort_column: d.sort.column,
    sort_direction: d.sort.direction,
  };
}

function str(values: FormValues, key: string): string {
  const v = values[key];
  return typeof v === "string" ? v.trim() : "";
}

export function valuesToDefaults(values: FormValues, base: Defaults): Defaults {
  const port = str(values, "port");
  return {
    ...base,
    user: str(values, "user") || undefined,
    identity_file: str(values, "identity_file") || undefined,
    port: port ? Number(port) : 22,
    connect_via: str(values, "connect_via") as ConnectVia,
    launch: str(values, "launch") as LaunchMode,
    terminal_command: str(values, "terminal_command") || undefined,
    ssh_options: shellSplit(str(values, "ssh_options")),
    tmux: {
      session_prefix: str(values, "session_prefix"),
      hold_on_error: values.hold_on_error === true,
    },
    sort: {
      column: str(values, "sort_column") as SortColumn,
      direction: str(values, "sort_direction") as SortDirection,
    },
  };
}

export function validateDefaults(values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const port = str(values, "port");
  if (port && !isValidPort(Number(port))) errors.port = "Port must be 1-65535";
  const prefix = str(values, "session_prefix");
  if (/[.:\s]/.test(prefix)) errors.session_prefix = "Prefix may not contain '.', ':' or spaces (tmux limitation)";
  return errors;
}
