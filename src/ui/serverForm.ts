/** Field definitions + conversions for the add/edit server dialog. */
import { validateServerInput } from "../config/schema.ts";
import { newServer, type Defaults, type ServerEntry } from "../config/types.ts";
import { contractHome } from "../config/paths.ts";
import type { FieldSpec, FormValues } from "./modal.ts";

export function serverFormFields(defaults: Defaults): FieldSpec[] {
  const userHint = defaults.user ? `default: ${defaults.user}` : "default: ssh decides";
  const keyHint = defaults.identity_file ? `default: ${contractHome(defaults.identity_file)}` : "default: ssh decides";
  return [
    { kind: "text", key: "name", label: "Name", placeholder: "web-01", help: "Unique id; also used for the tmux session name" },
    { kind: "text", key: "hostname", label: "Hostname", placeholder: "web-01.example.com", help: "DNS name or ~/.ssh/config alias" },
    { kind: "text", key: "ipv4", label: "IPv4", placeholder: "203.0.113.10", help: "Used when hostname is empty, or with I / connect_via: ipv4" },
    { kind: "text", key: "user", label: "User", placeholder: userHint, help: "Login user; leave empty to use the default" },
    { kind: "text", key: "identity_file", label: "Private key", placeholder: keyHint, help: "Path only; the app never opens the key" },
    { kind: "number", key: "port", label: "Port", placeholder: `default: ${defaults.port}`, help: "Leave empty to use the default / ~/.ssh/config" },
    { kind: "text", key: "description", label: "Description", placeholder: "What runs here", help: "Free text shown in the table" },
    { kind: "text", key: "tags", label: "Tags", placeholder: "prod web", help: "Space or comma separated; searchable with /" },
    { kind: "choice", key: "connect_via", label: "Connect via", options: ["default", "hostname", "ipv4"], help: "Which address Enter uses for this server" },
  ];
}

export function serverToValues(server: ServerEntry): FormValues {
  return {
    name: server.name,
    hostname: server.hostname ?? "",
    ipv4: server.ipv4 ?? "",
    user: server.user ?? "",
    identity_file: server.identity_file ?? "",
    port: server.port === undefined ? "" : String(server.port),
    description: server.description ?? "",
    tags: server.tags.join(" "),
    connect_via: server.connect_via ?? "default",
  };
}

function str(values: FormValues, key: string): string {
  const v = values[key];
  return typeof v === "string" ? v.trim() : "";
}

export function valuesToServer(values: FormValues, base?: ServerEntry): ServerEntry {
  const server: ServerEntry = base ? { ...base } : newServer();
  server.name = str(values, "name");
  server.hostname = str(values, "hostname") || undefined;
  server.ipv4 = str(values, "ipv4") || undefined;
  server.user = str(values, "user") || undefined;
  server.identity_file = str(values, "identity_file") || undefined;
  const port = str(values, "port");
  server.port = port ? Number(port) : undefined;
  server.description = str(values, "description") || undefined;
  server.tags = str(values, "tags")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const via = str(values, "connect_via");
  server.connect_via = via === "hostname" || via === "ipv4" ? via : undefined;
  return server;
}

export function serverFormValidator(existingNames: string[], originalName?: string) {
  return (values: FormValues): Record<string, string> =>
    validateServerInput(
      { name: str(values, "name"), hostname: str(values, "hostname"), ipv4: str(values, "ipv4"), port: str(values, "port") },
      existingNames,
      originalName,
    );
}
