/** Confirm / message / help overlays. */
import { TextRenderable, type CliRenderer, type KeyEvent, type TextChunk } from "@opentui/core";
import { displayWidth, truncate } from "./format.ts";
import { Modal, chunk, lines } from "./modal.ts";
import { theme } from "./theme.ts";

export interface ConfirmOptions {
  title: string;
  message: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** A third choice next to confirm / cancel, picked with its own key. */
  alternative?: { key: string; label: string; onSelect: () => void };
  onConfirm: () => void;
  onCancel: () => void;
}

export class ConfirmModal extends Modal {
  constructor(
    renderer: CliRenderer,
    private readonly opts: ConfirmOptions,
  ) {
    const width = Math.min(90, Math.max(40, ...opts.message.map((m) => displayWidth(m) + 6)));
    super(renderer, { title: opts.title, width, height: opts.message.length + 4 });
    const body = opts.message.map((m) => [chunk(truncate(m, width - 4))]);
    const hint = [
      chunk("y", theme.hotkey, { bold: true }),
      chunk("/Enter ", theme.dim),
      chunk(opts.confirmLabel ?? "confirm", opts.danger ? theme.error : theme.ok),
      chunk("   "),
      ...(opts.alternative
        ? [chunk(opts.alternative.key, theme.hotkey, { bold: true }), chunk(" "), chunk(opts.alternative.label, theme.fg), chunk("   ")]
        : []),
      chunk("n", theme.hotkey, { bold: true }),
      chunk("/Esc ", theme.dim),
      chunk(opts.cancelLabel ?? "cancel", theme.fg),
    ];
    this.box.add(new TextRenderable(renderer, { content: lines(...body), height: opts.message.length, wrapMode: "none" }));
    this.box.add(new TextRenderable(renderer, { content: "", height: 1 }));
    this.box.add(new TextRenderable(renderer, { content: lines(hint), height: 1 }));
  }

  handleKey(key: KeyEvent): boolean {
    key.preventDefault();
    key.stopPropagation();
    if (this.opts.alternative && key.name === this.opts.alternative.key) this.opts.alternative.onSelect();
    else if (key.name === "y" || key.name === "return" || key.name === "linefeed") this.opts.onConfirm();
    else if (key.name === "n" || key.name === "escape" || key.name === "q") this.opts.onCancel();
    return true;
  }
}

export interface MessageOptions {
  title: string;
  /** Pre-styled lines; plain strings are rendered in the default colour. */
  body: Array<string | TextChunk[]>;
  onClose: () => void;
  width?: number;
}

export class MessageModal extends Modal {
  constructor(
    renderer: CliRenderer,
    private readonly opts: MessageOptions,
  ) {
    const width = opts.width ?? Math.min(78, Math.max(40, ...opts.body.map((l) => (typeof l === "string" ? displayWidth(l) : l.reduce((n, c) => n + displayWidth(c.text), 0)) + 6)));
    super(renderer, { title: opts.title, width, height: opts.body.length + 4 });
    const rows = opts.body.map((line) => (typeof line === "string" ? [chunk(truncate(line, width - 4))] : line));
    this.box.add(new TextRenderable(renderer, { content: lines(...rows), height: opts.body.length, wrapMode: "none" }));
    this.box.add(new TextRenderable(renderer, { content: "", height: 1 }));
    this.box.add(new TextRenderable(renderer, { content: lines([chunk("press any key to close", theme.dim)]), height: 1 }));
  }

  handleKey(key: KeyEvent): boolean {
    key.preventDefault();
    key.stopPropagation();
    this.opts.onClose();
    return true;
  }
}

/** The `?` help screen. */
export function helpBody(): Array<string | TextChunk[]> {
  const row = (keys: string, what: string): TextChunk[] => [chunk(keys.padEnd(16), theme.hotkey, { bold: true }), chunk(what)];
  return [
    [chunk("Navigation", theme.accent, { bold: true })],
    row("↑/k  ↓/j", "move selection"),
    row("PgUp/PgDn", "move a page"),
    row("g / G", "first / last server"),
    row("/", "filter (Enter keeps it, Esc clears it)"),
    "",
    [chunk("Sessions", theme.accent, { bold: true })],
    row("Enter", "connect, or resume the existing tmux session (RDP opens a window)"),
    row("I", "connect via IPv4 instead of the hostname"),
    row("K", "kill the server's tmux session"),
    row("r", "reload the config file and refresh session status"),
    "",
    [chunk("Servers & settings", theme.accent, { bold: true })],
    row("a / e / d", "add / edit / delete the selected server (ssh, telnet, rdp)"),
    row("0-9", "sort by column (press again to reverse)"),
    row("S", "reverse the sort direction"),
    row("c", "settings: default user, key, port, launch mode…"),
    row("q / Ctrl+C", "quit"),
  ];
}
