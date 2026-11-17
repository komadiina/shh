/**
 * The application: owns the config in memory, the table state and all screens.
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextRenderable,
  bg,
  bold,
  fg,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import { contractHome } from "../config/paths.ts";
import type { ConfigStore } from "../config/store.ts";
import { newServer, type Config, type ConnectVia, type ServerEntry, type SortColumn } from "../config/types.ts";
import type { LaunchHost, Launcher } from "../session/launcher.ts";
import { detectTerminal } from "../session/terminal.ts";
import type { ProcessRunner } from "../util/shell.ts";
import { CONFIG_FIELDS, defaultsToValues, validateDefaults, valuesToDefaults } from "./configPane.ts";
import { ConfirmModal, MessageModal, helpBody } from "./dialogs.ts";
import { displayWidth, fit, truncate } from "./format.ts";
import { FormModal, Modal, chunk, type FormValues } from "./modal.ts";
import { serverFormFields, serverFormValidator, serverToValues, valuesToServer } from "./serverForm.ts";
import { COLUMN_BY_HOTKEY, ROW_PREFIX_WIDTH, filterServers, layoutColumns, sortIndicator, sortServers, type LaidOutColumn } from "./table.ts";
import { theme } from "./theme.ts";

export interface AppDeps {
  renderer: CliRenderer;
  store: ConfigStore;
  launcher: Launcher;
  runner: ProcessRunner;
  config: Config;
  /** Warnings produced while loading the config; shown once at startup. */
  warnings?: string[];
  /** The config file was just created. */
  created?: boolean;
  now?: () => Date;
  /** Session status refresh interval in ms (0 disables). */
  refreshIntervalMs?: number;
  /** How the terminal is handed to ssh/tmux; defaults to renderer.suspend()/resume(). */
  launchHost?: LaunchHost;
}

type Mode = "table" | "filter" | "modal";
type MessageKind = "info" | "ok" | "warn" | "error";

const BOTTOM_HEIGHT = 2;
const GAP = "  ";

const ACTION_HINTS: Array<[string, string]> = [
  ["↵", "connect/resume"],
  ["I", "via IPv4"],
  ["a", "add"],
  ["e", "edit"],
  ["d", "delete"],
  ["K", "kill session"],
  ["/", "filter"],
  ["c", "settings"],
  ["r", "reload"],
  ["?", "help"],
  ["q", "quit"],
];

export class App {
  readonly renderer: CliRenderer;
  private readonly store: ConfigStore;
  private readonly launcher: Launcher;
  private readonly runner: ProcessRunner;
  private readonly now: () => Date;

  config: Config;
  sortColumn: SortColumn;
  sortDirection: "asc" | "desc";
  filter = "";
  /** Rows currently shown (filtered + sorted). */
  visible: ServerEntry[] = [];
  selected = 0;
  private offset = 0;
  active = new Set<string>();
  mode: Mode = "table";
  private modal: Modal | null = null;
  private message: { text: string; kind: MessageKind; until: number } | null = null;
  private messageTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  // renderables
  private readonly root: BoxRenderable;
  private readonly frame: BoxRenderable;
  private readonly header: TextRenderable;
  private readonly body: TextRenderable;
  private readonly bottom: BoxRenderable;
  private readonly hints: TextRenderable;
  private readonly filterRow: BoxRenderable;
  private readonly filterInput: InputRenderable;
  private readonly sortBar: TextRenderable;

  private readonly onKey = (key: KeyEvent) => this.handleKey(key);
  private readonly onResize = () => this.render();
  private readonly onFocus = () => this.refreshSessions(true);

  constructor(private readonly deps: AppDeps) {
    this.renderer = deps.renderer;
    this.store = deps.store;
    this.launcher = deps.launcher;
    this.runner = deps.runner;
    this.now = deps.now ?? (() => new Date());
    this.config = deps.config;
    this.sortColumn = this.config.defaults.sort.column;
    this.sortDirection = this.config.defaults.sort.direction;

    const r = this.renderer;
    this.root = new BoxRenderable(r, { id: "app-root", width: "100%", height: "100%", flexDirection: "column" });
    this.frame = new BoxRenderable(r, {
      id: "frame",
      flexGrow: 1,
      flexShrink: 1,
      width: "100%",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      titleColor: theme.headerFg,
      bottomTitleAlignment: "right",
    });
    this.header = new TextRenderable(r, { id: "header", height: 1, width: "100%", wrapMode: "none", selectable: false });
    this.body = new TextRenderable(r, { id: "body", flexGrow: 1, width: "100%", wrapMode: "none", selectable: false });
    this.frame.add(this.header);
    this.frame.add(this.body);

    this.bottom = new BoxRenderable(r, { id: "bottom", height: BOTTOM_HEIGHT, width: "100%", flexDirection: "column", paddingX: 1 });
    this.hints = new TextRenderable(r, { id: "hints", height: 1, width: "100%", wrapMode: "none", selectable: false });
    this.filterRow = new BoxRenderable(r, { id: "filter-row", height: 1, width: "100%", flexDirection: "row" });
    this.filterRow.add(new TextRenderable(r, { content: new StyledText([chunk("/ ", theme.hotkey, { bold: true }), chunk("filter: ", theme.dim)]), width: 10, height: 1 }));
    this.filterInput = new InputRenderable(r, {
      id: "filter-input",
      placeholder: "name, host, ip, user, tag…  (Enter keep · Esc clear)",
      placeholderColor: theme.placeholder,
      backgroundColor: theme.inputBg,
      focusedBackgroundColor: theme.inputFocusedBg,
      textColor: theme.fg,
      focusedTextColor: theme.headerFg,
      flexGrow: 1,
    });
    this.filterRow.add(this.filterInput);
    this.filterInput.on(InputRenderableEvents.INPUT, (value: string) => {
      if (this.mode !== "filter") return;
      this.filter = value;
      this.recompute();
      this.render();
    });
    this.sortBar = new TextRenderable(r, { id: "sort-bar", height: 1, width: "100%", wrapMode: "none", selectable: false });
    this.bottom.add(this.hints);
    this.bottom.add(this.sortBar);

    this.root.add(this.frame);
    this.root.add(this.bottom);
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    this.renderer.root.add(this.root);
    this.renderer.keyInput.on("keypress", this.onKey);
    this.renderer.on("resize", this.onResize);
    this.renderer.on("focus", this.onFocus);
    this.renderer.once("destroy", () => this.dispose());
    try {
      this.renderer.setTerminalTitle("sshtui");
    } catch {
      // cosmetic; some terminals / the test renderer reject title changes before the first frame
    }

    this.refreshSessions(false);
    this.recompute();
    this.render();

    const interval = this.deps.refreshIntervalMs ?? 5000;
    if (interval > 0) {
      this.refreshTimer = setInterval(() => this.refreshSessions(true), interval);
    }

    if (this.deps.created) this.setMessage(`Created ${contractHome(this.store.path)} with an example server`, "ok", 10000);
    if (this.deps.warnings && this.deps.warnings.length > 0) this.showWarnings(this.deps.warnings);
  }

  private dispose(): void {
    this.renderer.keyInput.off("keypress", this.onKey);
    this.renderer.off("resize", this.onResize);
    this.renderer.off("focus", this.onFocus);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.messageTimer) clearTimeout(this.messageTimer);
  }

  quit(): void {
    this.renderer.destroy();
  }

  // ------------------------------------------------------------------ state

  get currentServer(): ServerEntry | undefined {
    return this.visible[this.selected];
  }

  private get visibleRows(): number {
    return Math.max(1, this.renderer.terminalHeight - 2 - 1 - BOTTOM_HEIGHT);
  }

  private get tableWidth(): number {
    return Math.max(10, this.renderer.terminalWidth - 2);
  }

  recompute(keepName?: string): void {
    const name = keepName ?? this.currentServer?.name;
    this.visible = sortServers(filterServers(this.config.servers, this.filter), this.sortColumn, this.sortDirection);
    const idx = name ? this.visible.findIndex((s) => s.name === name) : -1;
    this.selected = idx >= 0 ? idx : Math.min(this.selected, Math.max(0, this.visible.length - 1));
    this.clampViewport();
  }

  private clampViewport(): void {
    const rows = this.visibleRows;
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + rows) this.offset = this.selected - rows + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.visible.length - rows)));
  }

  move(delta: number): void {
    if (this.visible.length === 0) return;
    this.selected = Math.max(0, Math.min(this.visible.length - 1, this.selected + delta));
    this.clampViewport();
    this.render();
  }

  setSort(column: SortColumn): void {
    if (this.sortColumn === column) this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
    else {
      this.sortColumn = column;
      this.sortDirection = "asc";
    }
    this.recompute();
    this.render();
  }

  refreshSessions(renderIfChanged: boolean): void {
    const next = this.launcher.activeSessions(this.config.servers, this.config.defaults);
    const changed = next.size !== this.active.size || [...next].some((n) => !this.active.has(n));
    this.active = next;
    if (changed && renderIfChanged) this.render();
  }

  setMessage(text: string, kind: MessageKind = "info", ttlMs = 6000): void {
    this.message = { text, kind, until: Date.now() + ttlMs };
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.message = null;
      this.render();
    }, ttlMs);
    this.render();
  }

  private persist(): boolean {
    try {
      this.store.save(this.config);
      return true;
    } catch (err) {
      this.setMessage(`Could not save config: ${errorText(err)}`, "error", 10000);
      return false;
    }
  }

  reload(): void {
    try {
      const { config, warnings } = this.store.load();
      const name = this.currentServer?.name;
      this.config = config;
      this.recompute(name);
      this.refreshSessions(false);
      this.render();
      this.setMessage(`Reloaded ${contractHome(this.store.path)} (${config.servers.length} servers)`, "ok");
      if (warnings.length > 0) this.showWarnings(warnings);
    } catch (err) {
      this.setMessage(`Reload failed: ${errorText(err)}`, "error", 10000);
    }
  }

  // ------------------------------------------------------------------ actions

  async connect(via?: ConnectVia): Promise<void> {
    if (this.busy) return;
    const server = this.currentServer;
    if (!server) {
      this.setMessage("No server selected – press a to add one", "warn");
      return;
    }
    this.busy = true;
    const host: LaunchHost = this.deps.launchHost ?? {
      suspend: () => this.renderer.suspend(),
      resume: () => this.renderer.resume(),
    };
    try {
      const outcome = await this.launcher.launch(server, this.config.defaults, host, { via });
      if (outcome.newSession) {
        server.connections += 1;
        server.last_connected = this.now().toISOString();
        this.persist();
      }
      this.refreshSessions(false);
      const failed = outcome.exitCode !== undefined && outcome.exitCode !== 0;
      const text = [...outcome.warnings, outcome.message].join(" · ");
      this.setMessage(text, failed ? "warn" : outcome.warnings.length > 0 ? "warn" : "ok", 8000);
    } catch (err) {
      this.setMessage(errorText(err), "error", 10000);
    } finally {
      this.busy = false;
      this.recompute();
      this.render();
    }
  }

  startFilter(): void {
    this.mode = "filter";
    this.bottom.remove(this.hints);
    this.bottom.insertBefore(this.filterRow, this.sortBar);
    this.filterInput.value = this.filter;
    this.filterInput.focus();
    this.render();
  }

  endFilter(keep: boolean): void {
    if (this.mode !== "filter") return;
    this.mode = "table";
    this.filterInput.blur();
    this.bottom.remove(this.filterRow);
    this.bottom.insertBefore(this.hints, this.sortBar);
    if (!keep) {
      this.filter = "";
      this.filterInput.value = "";
    }
    this.recompute();
    this.render();
  }

  clearFilter(): void {
    this.filter = "";
    this.filterInput.value = "";
    this.recompute();
    this.render();
  }

  /** `draft` re-opens the form with values the user already typed (e.g. after backing out of a warning). */
  openServerForm(existing?: ServerEntry, draft?: FormValues): void {
    const names = this.config.servers.map((s) => s.name);
    const modal = new FormModal(this.renderer, {
      title: existing ? `Edit server: ${existing.name}` : "Add server",
      fields: serverFormFields(this.config.defaults, this.launcher.clients()),
      values: draft ?? serverToValues(existing ?? newServer()),
      initialFocus: "name",
      validate: serverFormValidator(names, existing?.name, this.config.defaults.user),
      onSubmit: (values) => {
        const saved = valuesToServer(values, existing);
        const newPassword = saved.password_b64 !== undefined && saved.password_b64 !== existing?.password_b64;
        if (newPassword) this.confirmStorePassword(saved, existing, values);
        else this.saveServer(saved, existing);
      },
      onCancel: () => this.closeModal(),
    });
    this.showModal(modal);
  }

  /** Storing a password is opt-in every time it is set or changed: base64 is not encryption. */
  private confirmStorePassword(saved: ServerEntry, existing: ServerEntry | undefined, draft: FormValues): void {
    const modal = new ConfirmModal(this.renderer, {
      title: "Unsafe: store password?",
      message: [
        `The password for "${saved.name}" would be stored base64-encoded in`,
        `${contractHome(this.store.path)}. Base64 is NOT encryption: anyone who can`,
        "read the file (backups, dotfile repos, screen shares) can read the password.",
        "Prefer key-based auth where you can.",
      ],
      confirmLabel: "store anyway",
      cancelLabel: "back",
      danger: true,
      alternative: { key: "w", label: "save without password (ask on connect)", onSelect: () => this.saveServer({ ...saved, password_b64: undefined }, existing) },
      onConfirm: () => this.saveServer(saved, existing),
      onCancel: () => this.openServerForm(existing, draft),
    });
    this.showModal(modal);
  }

  private saveServer(saved: ServerEntry, existing?: ServerEntry): void {
    if (existing) {
      const idx = this.config.servers.indexOf(existing);
      if (idx >= 0) this.config.servers[idx] = saved;
      else this.config.servers.push(saved);
    } else {
      this.config.servers.push(saved);
    }
    this.closeModal();
    if (this.persist()) this.setMessage(`${existing ? "Updated" : "Added"} ${saved.name}`, saved.password_b64 ? "warn" : "ok");
    this.refreshSessions(false);
    this.recompute(saved.name);
    this.render();
  }

  confirmDelete(): void {
    const server = this.currentServer;
    if (!server) return;
    const sessionNote = this.active.has(server.name) ? "Its tmux session keeps running; press K first to kill it." : "";
    const modal = new ConfirmModal(this.renderer, {
      title: "Delete server",
      message: [`Remove "${server.name}" (${server.hostname ?? server.ipv4 ?? "no address"}) from the config?`, ...(sessionNote ? [sessionNote] : [])],
      confirmLabel: "delete",
      danger: true,
      onConfirm: () => {
        this.config.servers = this.config.servers.filter((s) => s !== server);
        this.closeModal();
        if (this.persist()) this.setMessage(`Deleted ${server.name}`, "ok");
        this.recompute();
        this.render();
      },
      onCancel: () => this.closeModal(),
    });
    this.showModal(modal);
  }

  confirmKill(): void {
    const server = this.currentServer;
    if (!server) return;
    if (this.launcher.isWindowed(server)) {
      this.setMessage(`${server.name} is an RDP server; close its window to end the session`, "info");
      return;
    }
    if (!this.active.has(server.name)) {
      this.setMessage(`No tmux session for ${server.name}`, "info");
      return;
    }
    const name = this.launcher.sessionNameFor(server, this.config.defaults);
    const modal = new ConfirmModal(this.renderer, {
      title: "Kill session",
      message: [`Kill tmux session "${name}"?`, "The ssh connection inside it will be closed."],
      confirmLabel: "kill",
      danger: true,
      onConfirm: () => {
        const ok = this.launcher.killSession(server, this.config.defaults);
        this.closeModal();
        this.refreshSessions(false);
        this.setMessage(ok ? `Killed ${name}` : `Could not kill ${name}`, ok ? "ok" : "error");
        this.render();
      },
      onCancel: () => this.closeModal(),
    });
    this.showModal(modal);
  }

  openSettings(): void {
    const tmux = this.launcher.tmux;
    const tmuxStatus = tmux.isAvailable()
      ? `tmux ${tmux.version() ?? "?"} found${tmux.isInside() ? " · running inside tmux (sessions open via switch-client)" : ""}`
      : "tmux not found: sessions run inline and cannot be resumed";
    const terminal = detectTerminal(this.config.defaults.terminal_command, this.runner);
    this.launcher.recheckClients();
    const clients = this.launcher.clients();
    const mark = (ok: boolean) => (ok ? "✓" : "✗");
    const info = [
      `Config: ${contractHome(this.store.path)}`,
      `Sessions: ${tmuxStatus}`,
      `Terminal: ${terminal ? terminal.label : "none detected – set Terminal cmd for launch: terminal"}`,
      `Clients: ssh ${mark(clients.ssh)} · telnet ${mark(clients.telnet)} (expect ${mark(clients.expect)}) · rdp ${clients.rdp ?? "✗ (xfreerdp3 not found)"}`,
    ];
    const modal = new FormModal(this.renderer, {
      title: "Settings · defaults",
      info,
      fields: CONFIG_FIELDS,
      values: defaultsToValues(this.config.defaults),
      validate: validateDefaults,
      width: 78,
      onSubmit: (values) => {
        this.config.defaults = valuesToDefaults(values, this.config.defaults);
        this.sortColumn = this.config.defaults.sort.column;
        this.sortDirection = this.config.defaults.sort.direction;
        this.closeModal();
        if (this.persist()) this.setMessage("Settings saved", "ok");
        this.refreshSessions(false);
        this.recompute();
        this.render();
      },
      onCancel: () => this.closeModal(),
    });
    this.showModal(modal);
  }

  openHelp(): void {
    this.showModal(new MessageModal(this.renderer, { title: "Keys", body: helpBody(), onClose: () => this.closeModal(), width: 70 }));
  }

  private showWarnings(warnings: string[]): void {
    const shown = warnings.slice(0, 12).map((w) => truncate(w, 100));
    if (warnings.length > 12) shown.push(`… and ${warnings.length - 12} more`);
    this.showModal(
      new MessageModal(this.renderer, {
        title: `Config warnings (${warnings.length})`,
        body: [`${contractHome(this.store.path)}`, "", ...shown],
        onClose: () => this.closeModal(),
      }),
    );
  }

  private showModal(modal: Modal): void {
    if (this.mode === "filter") this.endFilter(true);
    if (this.modal) this.closeModal();
    this.modal = modal;
    this.mode = "modal";
    modal.mount();
  }

  closeModal(): void {
    if (!this.modal) return;
    const modal = this.modal;
    this.modal = null;
    this.mode = "table";
    modal.unmount();
    this.render();
  }

  // ------------------------------------------------------------------ keys

  handleKey(key: KeyEvent): void {
    if (this.busy) return;
    if (this.mode === "modal" && this.modal) {
      this.modal.handleKey(key);
      return;
    }
    if (this.mode === "filter") {
      this.handleFilterKey(key);
      return;
    }
    this.handleTableKey(key);
  }

  private handleFilterKey(key: KeyEvent): void {
    switch (key.name) {
      case "escape":
        key.preventDefault();
        this.endFilter(false);
        return;
      case "return":
      case "linefeed":
      case "tab":
        key.preventDefault();
        this.endFilter(true);
        return;
      case "up":
        key.preventDefault();
        this.move(-1);
        return;
      case "down":
        key.preventDefault();
        this.move(1);
        return;
      default:
        return; // the input handles typing
    }
  }

  private handleTableKey(key: KeyEvent): void {
    const name = key.name;
    const upper = key.shift || (name.length === 1 && name !== name.toLowerCase());
    const lower = name.toLowerCase();
    if (key.ctrl || key.meta) return; // leave ctrl combos (incl. ctrl+c) to the renderer
    // Nothing is focused in table mode; make sure the hotkey itself never reaches an
    // input that the action below focuses (e.g. "a" opening the add form).
    key.preventDefault();

    if (lower.length === 1 && lower >= "0" && lower <= "9") {
      const column = COLUMN_BY_HOTKEY.get(lower);
      if (column) this.setSort(column.key);
      return;
    }

    switch (name) {
      case "up":
        return this.move(-1);
      case "down":
        return this.move(1);
      case "pageup":
        return this.move(-this.visibleRows);
      case "pagedown":
        return this.move(this.visibleRows);
      case "home":
        return this.move(-this.visible.length);
      case "end":
        return this.move(this.visible.length);
      case "return":
      case "linefeed":
        void this.connect();
        return;
      case "escape":
        if (this.filter) this.clearFilter();
        return;
      case "/":
        return this.startFilter();
      case "?":
        return this.openHelp();
      default:
        break;
    }

    switch (lower) {
      case "k":
        return upper ? this.confirmKill() : this.move(-1);
      case "j":
        return this.move(1);
      case "g":
        return this.move(upper ? this.visible.length : -this.visible.length);
      case "i":
        if (upper) void this.connect("ipv4");
        return;
      case "s":
        if (upper) {
          this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
          this.recompute();
          this.render();
        }
        return;
      case "a":
        return this.openServerForm();
      case "e":
        return this.currentServer ? this.openServerForm(this.currentServer) : this.setMessage("Nothing to edit", "warn");
      case "d":
        return this.confirmDelete();
      case "c":
        return this.openSettings();
      case "r":
        return this.reload();
      case "q":
        return this.quit();
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ rendering

  render(): void {
    const width = this.tableWidth;
    const now = this.now();
    const columns = layoutColumns(this.visible.length > 0 ? this.visible : this.config.servers, width, now, this.sortColumn);
    this.renderTitle();
    this.header.content = this.renderHeader(columns, width);
    this.body.content = this.renderBody(columns, width, now);
    this.hints.content = this.renderHints(width);
    this.sortBar.content = this.renderSortBar(width);
    this.renderer.requestRender();
  }

  private renderTitle(): void {
    const tmux = this.launcher.tmux;
    const parts = [`${this.config.servers.length} server${this.config.servers.length === 1 ? "" : "s"}`];
    if (this.filter) parts.push(`filter "${this.filter}" → ${this.visible.length}`);
    if (this.visible.length > this.visibleRows) {
      const end = Math.min(this.visible.length, this.offset + this.visibleRows);
      parts.push(`rows ${this.offset + 1}-${end} of ${this.visible.length}`);
    }
    if (this.active.size > 0) parts.push(`${this.active.size} live session${this.active.size === 1 ? "" : "s"}`);
    const mode = this.launcher.resolveMode(this.config.defaults).mode;
    const modeText = mode === "tmux" ? `tmux${tmux.isInside() ? " (inside)" : ""}` : mode === "terminal" ? "new terminal window" : "inline (no persistence)";
    parts.push(modeText);
    this.frame.title = ` sshtui · ${parts.join(" · ")} `;
    const msg = this.message && this.message.until > Date.now() ? this.message : null;
    if (msg) {
      const icon = msg.kind === "error" ? "✗ " : msg.kind === "warn" ? "! " : msg.kind === "ok" ? "✓ " : "";
      this.frame.bottomTitle = ` ${truncate(icon + msg.text, Math.max(10, this.tableWidth - 6))} `;
      this.frame.borderColor = msg.kind === "error" ? theme.error : msg.kind === "warn" ? theme.warn : theme.border;
    } else {
      this.frame.bottomTitle = undefined;
      this.frame.borderColor = theme.border;
    }
  }

  private renderHeader(columns: LaidOutColumn[], width: number): StyledText {
    const chunks: TextChunk[] = [chunk(" ".repeat(ROW_PREFIX_WIDTH))];
    columns.forEach((col, i) => {
      const indicator = sortIndicator(col.def.key, this.sortColumn, this.sortDirection);
      const title = indicator ? `${col.def.title} ${indicator}` : col.def.title;
      const sorted = col.def.key === this.sortColumn;
      chunks.push(chunk(fit(title, col.width, col.def.align), sorted ? theme.accent : theme.headerFg, { bold: true }));
      if (i < columns.length - 1) chunks.push(chunk(GAP));
    });
    const text = chunks.map((c) => c.text).join("");
    const pad = width - displayWidth(text);
    if (pad > 0) chunks.push(chunk(" ".repeat(pad)));
    return new StyledText(chunks);
  }

  private renderBody(columns: LaidOutColumn[], width: number, now: Date): StyledText {
    const rows = this.visibleRows;
    const chunks: TextChunk[] = [];
    if (this.visible.length === 0) {
      const text = this.config.servers.length === 0 ? "No servers yet — press a to add one, or edit the config file." : `No servers match "${this.filter}" — Esc clears the filter.`;
      chunks.push(chunk(""));
      chunks.push(chunk("\n"));
      chunks.push(chunk("  " + truncate(text, width - 2), theme.dim));
      return new StyledText(chunks);
    }
    const end = Math.min(this.visible.length, this.offset + rows);
    for (let i = this.offset; i < end; i++) {
      const server = this.visible[i]!;
      const selected = i === this.selected;
      const live = this.active.has(server.name);
      const line: TextChunk[] = [];
      line.push(chunk(selected ? "▸ " : "  ", theme.accent, { bold: true }));
      line.push(chunk(live ? "● " : "  ", theme.sessionActive, { bold: true }));
      columns.forEach((col, ci) => {
        const value = col.def.value(server, now);
        let color: string = theme.fg;
        if (col.def.key === "description" || col.def.key === "last_connected" || col.def.key === "identity_file") color = theme.dim;
        if (col.def.key === "name") color = theme.headerFg;
        if (col.def.key === "hostname" || col.def.key === "ipv4") color = theme.accent;
        if (col.def.key === "identity_file" && server.password_b64) color = theme.warn;
        line.push(chunk(fit(value, col.width, col.def.align), selected ? theme.selectedFg : color, { bold: selected && col.def.key === "name" }));
        if (ci < columns.length - 1) line.push(chunk(GAP));
      });
      const text = line.map((c) => c.text).join("");
      const pad = width - displayWidth(text);
      if (pad > 0) line.push(chunk(" ".repeat(pad)));
      const styled = selected ? line.map((c) => bg(theme.selectedBg)(c)) : line;
      chunks.push(...styled);
      if (i < end - 1) chunks.push(chunk("\n"));
    }
    return new StyledText(chunks);
  }

  private renderHints(width: number): StyledText {
    const chunks: TextChunk[] = [];
    let used = 0;
    for (const [key, label] of ACTION_HINTS) {
      const piece = `${key} ${label}   `;
      if (used + displayWidth(piece) > width) break;
      chunks.push(fg(theme.hotkey)(bold(key)), chunk(` ${label}   `, theme.dim));
      used += displayWidth(piece);
    }
    return new StyledText(chunks);
  }

  private renderSortBar(width: number): StyledText {
    const chunks: TextChunk[] = [chunk("sort ", theme.dim)];
    let used = 5;
    for (const col of COLUMN_BY_HOTKEY.values()) {
      const activeCol = col.key === this.sortColumn;
      const label = activeCol ? `${col.title}${this.sortDirection === "asc" ? "▲" : "▼"}` : col.title;
      const piece = `${col.hotkey} ${label}  `;
      if (used + displayWidth(piece) > width) break;
      chunks.push(fg(theme.hotkey)(bold(col.hotkey)));
      chunks.push(chunk(` ${label}  `, activeCol ? theme.accent : theme.dim, { bold: activeCol }));
      used += displayWidth(piece);
    }
    const tail = "S reverse";
    if (used + displayWidth(tail) + 2 <= width) chunks.push(fg(theme.hotkey)(bold("S")), chunk(" reverse", theme.dim));
    return new StyledText(chunks);
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
