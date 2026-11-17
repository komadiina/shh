/**
 * Server table model: columns, sorting, filtering and width layout.
 * Pure functions – the renderable glue lives in app.ts.
 */
import type { ServerEntry, SortColumn, SortDirection } from "../config/types.ts";
import { basename, displayWidth, relativeTime } from "./format.ts";

export interface ColumnDef {
  key: SortColumn;
  title: string;
  /** Digit hotkey shown in the bottom bar. */
  hotkey: string;
  min: number;
  /** Upper bound for the natural width; `Infinity` = may take all slack. */
  max: number;
  /** Lower priority columns are hidden first on narrow terminals. `name` is never hidden. */
  priority: number;
  align: "left" | "right";
  /** Can give up width (down to `min`) when space is tight. */
  flexible: boolean;
  value: (server: ServerEntry, now: Date) => string;
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: "name", title: "Name", hotkey: "1", min: 6, max: 28, priority: 100, align: "left", flexible: false, value: (s) => s.name },
  { key: "hostname", title: "Host", hotkey: "2", min: 8, max: 40, priority: 80, align: "left", flexible: true, value: (s) => s.hostname ?? "" },
  { key: "ipv4", title: "IPv4", hotkey: "3", min: 7, max: 15, priority: 50, align: "left", flexible: false, value: (s) => s.ipv4 ?? "" },
  { key: "user", title: "User", hotkey: "4", min: 4, max: 16, priority: 60, align: "left", flexible: false, value: (s) => s.user ?? "" },
  { key: "identity_file", title: "Key", hotkey: "5", min: 3, max: 24, priority: 30, align: "left", flexible: true, value: (s) => basename(s.identity_file) },
  { key: "port", title: "Port", hotkey: "6", min: 4, max: 5, priority: 20, align: "right", flexible: false, value: (s) => (s.port === undefined ? "" : String(s.port)) },
  { key: "connections", title: "Conn", hotkey: "7", min: 4, max: 6, priority: 70, align: "right", flexible: false, value: (s) => String(s.connections) },
  { key: "description", title: "Description", hotkey: "8", min: 8, max: Infinity, priority: 40, align: "left", flexible: true, value: (s) => s.description ?? "" },
  { key: "last_connected", title: "Last", hotkey: "9", min: 5, max: 10, priority: 10, align: "right", flexible: false, value: (s, now) => relativeTime(s.last_connected, now) },
];

export const COLUMN_BY_HOTKEY: ReadonlyMap<string, ColumnDef> = new Map(COLUMNS.map((c) => [c.hotkey, c]));
export const COLUMN_BY_KEY: ReadonlyMap<SortColumn, ColumnDef> = new Map(COLUMNS.map((c) => [c.key, c]));

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortValue(server: ServerEntry, column: SortColumn): string | number | undefined {
  switch (column) {
    case "port":
      return server.port;
    case "connections":
      return server.connections;
    case "last_connected":
      return server.last_connected ? new Date(server.last_connected).getTime() : undefined;
    case "identity_file":
      return server.identity_file ? basename(server.identity_file) : undefined;
    case "name":
      return server.name;
    case "hostname":
      return server.hostname;
    case "ipv4":
      return server.ipv4 ? ipv4SortKey(server.ipv4) : undefined;
    case "user":
      return server.user;
    case "description":
      return server.description;
    default:
      return undefined;
  }
}

/** Zero-pad octets so IPs sort numerically with the string collator. */
function ipv4SortKey(ip: string): string {
  return ip
    .split(".")
    .map((o) => o.padStart(3, "0"))
    .join(".");
}

export function sortServers(servers: readonly ServerEntry[], column: SortColumn, direction: SortDirection): ServerEntry[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...servers].sort((a, b) => {
    const av = sortValue(a, column);
    const bv = sortValue(b, column);
    // missing values always sink to the bottom regardless of direction
    if (av === undefined && bv === undefined) return collator.compare(a.name, b.name);
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = collator.compare(String(av), String(bv));
    if (cmp === 0) cmp = collator.compare(a.name, b.name);
    return cmp * dir;
  });
}

export function matchesFilter(server: ServerEntry, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [server.name, server.hostname, server.ipv4, server.user, server.description, ...server.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

export function filterServers(servers: readonly ServerEntry[], filter: string): ServerEntry[] {
  return servers.filter((s) => matchesFilter(s, filter));
}

export interface LaidOutColumn {
  def: ColumnDef;
  width: number;
}

/** Width of the fixed prefix in each row: selection marker + session dot. */
export const ROW_PREFIX_WIDTH = 4;
const GAP = 2;

/**
 * Decide which columns fit into `availableWidth` and how wide each one is.
 * Steps: natural widths → drop low-priority columns → shrink flexible ones → give slack to Description.
 */
export function layoutColumns(
  servers: readonly ServerEntry[],
  availableWidth: number,
  now: Date = new Date(),
  keep?: SortColumn,
): LaidOutColumn[] {
  const usable = availableWidth - ROW_PREFIX_WIDTH;
  const natural = new Map<SortColumn, number>();
  for (const col of COLUMNS) {
    let w = displayWidth(col.title) + 2; // room for the sort arrow
    for (const s of servers) w = Math.max(w, displayWidth(col.value(s, now)));
    natural.set(col.key, Math.max(col.min, Math.min(col.max, w)));
  }

  let visible = [...COLUMNS];
  const total = (cols: ColumnDef[], widths: Map<SortColumn, number>) =>
    cols.reduce((sum, c) => sum + (widths.get(c.key) ?? c.min), 0) + GAP * Math.max(0, cols.length - 1);

  // 1. drop columns, lowest priority first, until they fit with only the flexible
  //    columns shrunk (non-flexible ones such as Name, IPv4 or Conn keep their natural width)
  const minWidths = new Map<SortColumn, number>(COLUMNS.map((c) => [c.key, c.flexible ? c.min : (natural.get(c.key) ?? c.min)]));
  while (visible.length > 1 && total(visible, minWidths) > usable) {
    const droppable = visible.filter((c) => c.key !== "name" && c.key !== keep).sort((a, b) => a.priority - b.priority)[0] ??
      visible.filter((c) => c.key !== "name").sort((a, b) => a.priority - b.priority)[0];
    if (!droppable) break;
    visible = visible.filter((c) => c !== droppable);
  }

  // 2. start from natural widths and shrink flexible columns while too wide
  const widths = new Map<SortColumn, number>(visible.map((c) => [c.key, natural.get(c.key) ?? c.min]));
  let guard = 0;
  while (total(visible, widths) > usable && guard++ < 500) {
    const shrinkable = visible.filter((c) => (widths.get(c.key) ?? 0) > c.min).sort((a, b) => (widths.get(b.key) ?? 0) - (widths.get(a.key) ?? 0));
    // only a terminal too narrow even for the Name column alone gets here with a non-flexible victim
    const victim = shrinkable.find((c) => c.flexible) ?? shrinkable[0];
    if (!victim) break;
    widths.set(victim.key, (widths.get(victim.key) ?? victim.min) - 1);
  }

  // 3. hand leftover space to Description (or the last flexible column)
  const slack = usable - total(visible, widths);
  if (slack > 0) {
    const grow = visible.find((c) => c.key === "description") ?? [...visible].reverse().find((c) => c.flexible);
    if (grow) widths.set(grow.key, (widths.get(grow.key) ?? grow.min) + slack);
  }

  return visible.map((def) => ({ def, width: widths.get(def.key) ?? def.min }));
}

export function sortIndicator(column: SortColumn, sortColumn: SortColumn, direction: SortDirection): string {
  if (column !== sortColumn) return "";
  return direction === "asc" ? "▲" : "▼";
}
