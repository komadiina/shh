/** Field definitions + conversions for the add/edit server dialog. */
import { isValidResolution, validateServerInput } from "../config/schema.ts";
import { decodePassword, encodePassword } from "../config/secret.ts";
import {
  PROTOCOLS,
  PROTOCOL_AUTH,
  RDP_CERTS,
  authOf,
  newServer,
  protocolOf,
  type AuthMethod,
  type Defaults,
  type Protocol,
  type RdpCert,
  type ServerEntry,
} from "../config/types.ts";
import { contractHome } from "../config/paths.ts";
import { authUnavailable, protocolUnavailable, type ClientStatus } from "../session/protocols.ts";
import type { FieldSpec, FormValues } from "./modal.ts";

function protocolValue(values: FormValues): Protocol {
  const p = values.protocol;
  return typeof p === "string" && (PROTOCOLS as readonly string[]).includes(p) ? (p as Protocol) : "ssh";
}

const isProtocol = (protocol: Protocol) => (values: FormValues) => protocolValue(values) === protocol;
const isUserpass = (values: FormValues) => values.auth === "userpass";

export function serverFormFields(defaults: Defaults, clients: ClientStatus): FieldSpec[] {
  const userHint = defaults.user ? `default: ${defaults.user}` : "default: ssh decides";
  const keyHint = defaults.identity_file ? `default: ${contractHome(defaults.identity_file)}` : "default: ssh decides";
  return [
    {
      kind: "segmented",
      key: "protocol",
      label: "Protocol",
      options: PROTOCOLS,
      disabled: (option) => protocolUnavailable(option as Protocol, clients),
      help: "←/→ to switch; the fields below change with the protocol",
    },
    { kind: "text", key: "name", label: "Name", placeholder: "web-01", help: "Unique id; also used for the tmux session name" },
    { kind: "text", key: "hostname", label: "Hostname", placeholder: "web-01.example.com", help: "DNS name or ~/.ssh/config alias" },
    { kind: "text", key: "ipv4", label: "IPv4", placeholder: "203.0.113.10", help: "Used when hostname is empty, or with I / connect_via: ipv4" },
    { kind: "text", key: "user", label: "User", placeholder: userHint, help: "Login user; leave empty to use the default" },
    {
      kind: "segmented",
      key: "auth",
      label: "Auth",
      options: (values) => PROTOCOL_AUTH[protocolValue(values)],
      disabled: (option, values) => authUnavailable(protocolValue(values), option as AuthMethod, clients),
      help: "How to log in",
    },
    {
      kind: "text",
      key: "identity_file",
      label: "Private key",
      placeholder: keyHint,
      help: "Path only; the app never opens the key",
      visible: (values) => isProtocol("ssh")(values) && values.auth === "pubkey",
    },
    {
      kind: "secret",
      key: "password",
      label: "Password",
      placeholder: "empty: ask when connecting",
      help: "Stored base64-encoded, NOT encrypted · Ctrl+U clears",
      visible: isUserpass,
    },
    { kind: "number", key: "port", label: "Port", placeholder: `default: ssh ${defaults.port} · telnet 23 · rdp 3389`, help: "Leave empty to use the protocol default / ~/.ssh/config" },
    { kind: "text", key: "rdp_domain", label: "Domain", placeholder: "CORP", help: "Windows domain (/d:)", visible: isProtocol("rdp") },
    {
      kind: "text",
      key: "rdp_resolution",
      label: "Resolution",
      placeholder: "auto",
      help: "auto (follows the window) · fullscreen · <width>x<height>",
      visible: isProtocol("rdp"),
    },
    { kind: "choice", key: "rdp_cert", label: "Certificate", options: RDP_CERTS, help: "tofu: trust on first use · ignore: accept any · deny: reject unknown", visible: isProtocol("rdp") },
    { kind: "toggle", key: "rdp_clipboard", label: "Clipboard", help: "Share the clipboard with the remote desktop", visible: isProtocol("rdp") },
    { kind: "text", key: "rdp_drive", label: "Shared dir", placeholder: "~/share", help: "Local directory shown as a drive on the remote", visible: isProtocol("rdp") },
    { kind: "text", key: "description", label: "Description", placeholder: "What runs here", help: "Free text shown in the table" },
    { kind: "text", key: "tags", label: "Tags", placeholder: "prod web", help: "Space or comma separated; searchable with /" },
    { kind: "choice", key: "connect_via", label: "Connect via", options: ["default", "hostname", "ipv4"], help: "Which address Enter uses for this server" },
  ];
}

export function serverToValues(server: ServerEntry): FormValues {
  const rdp = server.rdp ?? {};
  return {
    protocol: protocolOf(server),
    name: server.name,
    hostname: server.hostname ?? "",
    ipv4: server.ipv4 ?? "",
    auth: authOf(server),
    user: server.user ?? "",
    identity_file: server.identity_file ?? "",
    password: server.password_b64 ? (decodePassword(server.password_b64) ?? "") : "",
    port: server.port === undefined ? "" : String(server.port),
    rdp_domain: rdp.domain ?? "",
    rdp_resolution: rdp.resolution ?? "",
    rdp_cert: rdp.cert ?? "tofu",
    rdp_clipboard: rdp.clipboard ?? true,
    rdp_drive: rdp.drive ?? "",
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
  const protocol = protocolValue(values);
  server.protocol = protocol === "ssh" ? undefined : protocol;
  server.name = str(values, "name");
  server.hostname = str(values, "hostname") || undefined;
  server.ipv4 = str(values, "ipv4") || undefined;
  server.user = str(values, "user") || undefined;
  server.identity_file = str(values, "identity_file") || undefined;

  const allowed = PROTOCOL_AUTH[protocol];
  const auth = allowed.includes(values.auth as AuthMethod) ? (values.auth as AuthMethod) : allowed[0]!;
  server.auth = auth === allowed[0] ? undefined : auth;
  // passwords are not trimmed: leading/trailing spaces may be part of them
  const password = typeof values.password === "string" ? values.password : "";
  server.password_b64 = auth === "userpass" && password ? encodePassword(password) : undefined;

  const port = str(values, "port");
  server.port = port ? Number(port) : undefined;

  if (protocol === "rdp") {
    const resolution = str(values, "rdp_resolution");
    const rdp = {
      domain: str(values, "rdp_domain") || undefined,
      resolution: resolution && resolution !== "auto" ? resolution : undefined,
      cert: str(values, "rdp_cert") && str(values, "rdp_cert") !== "tofu" ? (str(values, "rdp_cert") as RdpCert) : undefined,
      clipboard: values.rdp_clipboard === false ? false : undefined,
      drive: str(values, "rdp_drive") || undefined,
    };
    server.rdp = Object.values(rdp).some((v) => v !== undefined) ? rdp : undefined;
  } else {
    server.rdp = undefined;
  }

  server.description = str(values, "description") || undefined;
  server.tags = str(values, "tags")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const via = str(values, "connect_via");
  server.connect_via = via === "hostname" || via === "ipv4" ? via : undefined;
  return server;
}

export function serverFormValidator(existingNames: string[], originalName?: string, defaultUser?: string) {
  return (values: FormValues): Record<string, string> => {
    const errors = validateServerInput(
      { name: str(values, "name"), hostname: str(values, "hostname"), ipv4: str(values, "ipv4"), port: str(values, "port") },
      existingNames,
      originalName,
    );
    if (protocolValue(values) === "rdp") {
      const resolution = str(values, "rdp_resolution");
      if (resolution && !isValidResolution(resolution)) errors.rdp_resolution = "Use auto, fullscreen or <width>x<height>";
      if (values.auth === "userpass" && values.password && !str(values, "user") && !defaultUser) {
        errors.user = "RDP needs a user when a password is stored";
      }
    }
    return errors;
  };
}
