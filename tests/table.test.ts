import { describe, expect, test } from "bun:test";
import { newServer, type ServerEntry } from "../src/config/types.ts";
import { displayWidth, fit, relativeTime, truncate } from "../src/ui/format.ts";
import { COLUMNS, filterServers, layoutColumns, ROW_PREFIX_WIDTH, sortServers } from "../src/ui/table.ts";

function s(name: string, extra: Partial<ServerEntry> = {}): ServerEntry {
  return { ...newServer(name), ...extra };
}

const servers: ServerEntry[] = [
  s("web-10", { hostname: "web-10.example.com", ipv4: "10.0.0.10", user: "deploy", connections: 2, description: "Web", tags: ["prod"] }),
  s("web-2", { hostname: "web-2.example.com", ipv4: "10.0.0.2", user: "deploy", connections: 9, last_connected: "2026-11-01T00:00:00Z" }),
  s("db", { ipv4: "192.168.1.1", user: "pg", port: 5432, connections: 0, description: "Postgres", tags: ["prod", "db"] }),
  s("bastion", { hostname: "bastion.example.com", connections: 4, identity_file: "~/.ssh/bastion", last_connected: "2026-11-15T00:00:00Z" }),
];

describe("format", () => {
  test("widths and truncation", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本")).toBe(4);
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate("hi", 5)).toBe("hi");
    expect(fit("abc", 6)).toBe("abc   ");
    expect(fit("abc", 6, "right")).toBe("   abc");
    expect(fit("abcdefgh", 4)).toBe("abc…");
  });

  test("relative time", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    expect(relativeTime(undefined, now)).toBe("never");
    expect(relativeTime("2026-11-16T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-11-16T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-11-16T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-11-10T12:00:00Z", now)).toBe("6d ago");
    expect(relativeTime("2025-01-01T12:00:00Z", now)).toBe("1y ago");
  });
});

describe("sortServers", () => {
  test("sorts names naturally (web-2 before web-10)", () => {
    expect(sortServers(servers, "name", "asc").map((x) => x.name)).toEqual(["bastion", "db", "web-2", "web-10"]);
    expect(sortServers(servers, "name", "desc").map((x) => x.name)).toEqual(["web-10", "web-2", "db", "bastion"]);
  });

  test("numeric columns sort numerically and missing values sink", () => {
    expect(sortServers(servers, "connections", "desc").map((x) => x.name)).toEqual(["web-2", "bastion", "web-10", "db"]);
    expect(sortServers(servers, "port", "asc").map((x) => x.name)).toEqual(["db", "bastion", "web-2", "web-10"]);
    expect(sortServers(servers, "port", "desc").map((x) => x.name)).toEqual(["db", "bastion", "web-2", "web-10"]);
    expect(sortServers(servers, "hostname", "asc").map((x) => x.name)).toEqual(["bastion", "web-2", "web-10", "db"]);
  });

  test("ipv4 sorts by octet, last_connected by time", () => {
    expect(sortServers(servers, "ipv4", "asc").map((x) => x.name)).toEqual(["web-2", "web-10", "db", "bastion"]);
    expect(sortServers(servers, "last_connected", "desc").map((x) => x.name)).toEqual(["bastion", "web-2", "db", "web-10"]);
  });
});

describe("filterServers", () => {
  test("matches across fields and tags, all words must match", () => {
    expect(filterServers(servers, "").length).toBe(4);
    expect(filterServers(servers, "prod").map((x) => x.name)).toEqual(["web-10", "db"]);
    expect(filterServers(servers, "prod db").map((x) => x.name)).toEqual(["db"]);
    expect(filterServers(servers, "192.168").map((x) => x.name)).toEqual(["db"]);
    expect(filterServers(servers, "DEPLOY").length).toBe(2);
    expect(filterServers(servers, "nothing")).toEqual([]);
  });
});

describe("layoutColumns", () => {
  test("wide terminal shows every column and fills the width", () => {
    const cols = layoutColumns(servers, 160);
    expect(cols.map((c) => c.def.key)).toEqual(COLUMNS.map((c) => c.key));
    const total = cols.reduce((sum, c) => sum + c.width, 0) + 2 * (cols.length - 1);
    expect(total).toBe(160 - ROW_PREFIX_WIDTH);
    expect(cols.find((c) => c.def.key === "description")!.width).toBeGreaterThan(20);
  });

  test("narrow terminal drops low-priority columns first and keeps name", () => {
    const cols = layoutColumns(servers, 60);
    const keys = cols.map((c) => c.def.key);
    expect(keys[0]).toBe("name");
    expect(keys).not.toContain("last_connected");
    expect(keys).not.toContain("port");
    expect(keys).toContain("hostname");
    const total = cols.reduce((sum, c) => sum + c.width, 0) + 2 * (cols.length - 1);
    expect(total).toBeLessThanOrEqual(60 - ROW_PREFIX_WIDTH);
    for (const c of cols) expect(c.width).toBeGreaterThanOrEqual(c.def.min);
  });

  test("non-flexible columns are never truncated when hiding columns would make room", () => {
    const many = [...servers, s("ci-runner-long", { hostname: "ci.internal", ipv4: "10.10.0.31", user: "runner" })];
    for (const width of [72, 80, 90, 100]) {
      const cols = layoutColumns(many, width);
      const name = cols.find((c) => c.def.key === "name")!;
      expect(name.width).toBeGreaterThanOrEqual("ci-runner-long".length);
      const ip = cols.find((c) => c.def.key === "ipv4");
      if (ip) expect(ip.width).toBeGreaterThanOrEqual("192.168.1.1".length);
      const total = cols.reduce((sum, c) => sum + c.width, 0) + 2 * (cols.length - 1);
      expect(total).toBeLessThanOrEqual(width - ROW_PREFIX_WIDTH);
    }
  });

  test("tiny terminal still yields the name column", () => {
    const cols = layoutColumns(servers, 12);
    expect(cols.length).toBeGreaterThanOrEqual(1);
    expect(cols[0]!.def.key).toBe("name");
  });
});

describe("layoutColumns keeps the sort column", () => {
  test("a low-priority sort column stays visible on narrow terminals", () => {
    expect(layoutColumns(servers, 60).map((c) => c.def.key)).not.toContain("last_connected");
    expect(layoutColumns(servers, 60, new Date(), "last_connected").map((c) => c.def.key)).toContain("last_connected");
  });
});
