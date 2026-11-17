/**
 * Centered overlay windows: a base `Modal` plus a generic `FormModal` used by the
 * add/edit server dialog and the settings pane.
 */
import {
  BoxRenderable,
  InputRenderable,
  StyledText,
  TextRenderable,
  bold,
  fg,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import { theme } from "./theme.ts";
import { displayWidth, fit, truncate } from "./format.ts";

let modalCounter = 0;

export function chunk(text: string, color: string = theme.fg, opts: { bold?: boolean } = {}): TextChunk {
  const c = fg(color)(text);
  return opts.bold ? bold(c) : c;
}

export function lines(...chunksPerLine: TextChunk[][]): StyledText {
  const all: TextChunk[] = [];
  chunksPerLine.forEach((row, i) => {
    all.push(...row);
    if (i < chunksPerLine.length - 1) all.push(chunk("\n"));
  });
  return new StyledText(all);
}

export interface ModalOptions {
  title: string;
  width: number;
  height: number;
}

export abstract class Modal {
  readonly box: BoxRenderable;
  protected mounted = false;
  private readonly onResize = () => this.center();

  constructor(
    protected readonly renderer: CliRenderer,
    protected readonly options: ModalOptions,
  ) {
    this.box = new BoxRenderable(renderer, {
      id: `modal-${++modalCounter}`,
      position: "absolute",
      zIndex: 100,
      width: options.width,
      height: options.height,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.borderFocused,
      title: ` ${options.title} `,
      titleColor: theme.headerFg,
      backgroundColor: theme.modalBg,
      flexDirection: "column",
      paddingX: 1,
      paddingY: 0,
    });
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.center();
    this.renderer.root.add(this.box);
    this.renderer.on("resize", this.onResize);
    this.onMounted();
    this.renderer.requestRender();
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.renderer.off("resize", this.onResize);
    this.onUnmount();
    this.renderer.root.remove(this.box);
    this.box.destroy();
    this.renderer.requestRender();
  }

  protected onMounted(): void {}
  protected onUnmount(): void {}

  center(): void {
    const tw = this.renderer.terminalWidth;
    const th = this.renderer.terminalHeight;
    const width = Math.min(this.options.width, Math.max(10, tw - 2));
    const height = Math.min(this.options.height, Math.max(3, th - 1));
    this.box.width = width;
    this.box.height = height;
    this.box.left = Math.max(0, Math.floor((tw - width) / 2));
    this.box.top = Math.max(0, Math.floor((th - height) / 2));
  }

  /** Return true when the key was handled (the modal calls preventDefault itself). */
  abstract handleKey(key: KeyEvent): boolean;
}

// ---------------------------------------------------------------------------
// Form modal
// ---------------------------------------------------------------------------

export type FieldSpec =
  | { kind: "text"; key: string; label: string; placeholder?: string; help?: string }
  | { kind: "number"; key: string; label: string; placeholder?: string; help?: string }
  | { kind: "choice"; key: string; label: string; options: readonly string[]; help?: string }
  | { kind: "toggle"; key: string; label: string; help?: string };

export type FormValues = Record<string, string | boolean>;

export interface FormOptions {
  title: string;
  fields: FieldSpec[];
  values: FormValues;
  /** Read-only lines shown above the fields. */
  info?: string[];
  validate?: (values: FormValues) => Record<string, string>;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
  width?: number;
}

interface FieldRow {
  spec: FieldSpec;
  row: BoxRenderable;
  label: TextRenderable;
  input?: InputRenderable;
  valueText?: TextRenderable;
}

const HINT = "Tab/↑↓ move · Enter next · Space/←→ change · Ctrl+S save · Esc cancel";

export class FormModal extends Modal {
  private readonly rows: FieldRow[] = [];
  private readonly values: FormValues;
  private index = 0;
  private readonly status: TextRenderable;
  private errors: Record<string, string> = {};
  private readonly labelWidth: number;

  constructor(
    renderer: CliRenderer,
    private readonly form: FormOptions,
  ) {
    const info = form.info ?? [];
    const width = form.width ?? 74;
    const height = 2 + (info.length > 0 ? info.length + 1 : 0) + form.fields.length + 3;
    super(renderer, { title: form.title, width, height });
    this.values = { ...form.values };
    this.labelWidth = Math.max(...form.fields.map((f) => displayWidth(f.label))) + 3;

    if (info.length > 0) {
      this.box.add(new TextRenderable(renderer, { content: lines(...info.map((l) => [chunk(l, theme.dim)])), height: info.length }));
      this.box.add(new TextRenderable(renderer, { content: "", height: 1 }));
    }

    for (const spec of form.fields) {
      const row = new BoxRenderable(renderer, { flexDirection: "row", height: 1, width: "100%" });
      const label = new TextRenderable(renderer, { content: "", width: this.labelWidth, height: 1 });
      row.add(label);
      const fieldRow: FieldRow = { spec, row, label };
      if (spec.kind === "text" || spec.kind === "number") {
        const input = new InputRenderable(renderer, {
          value: String(this.values[spec.key] ?? ""),
          placeholder: spec.placeholder ?? "",
          placeholderColor: theme.placeholder,
          backgroundColor: theme.inputBg,
          focusedBackgroundColor: theme.inputFocusedBg,
          textColor: theme.fg,
          focusedTextColor: theme.headerFg,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 8,
        });
        row.add(input);
        fieldRow.input = input;
      } else {
        const valueText = new TextRenderable(renderer, { content: "", flexGrow: 1, height: 1 });
        row.add(valueText);
        fieldRow.valueText = valueText;
      }
      this.rows.push(fieldRow);
      this.box.add(row);
    }

    this.box.add(new TextRenderable(renderer, { content: "", height: 1 }));
    this.status = new TextRenderable(renderer, { content: "", height: 1, width: "100%" });
    this.box.add(this.status);
    this.box.add(new TextRenderable(renderer, { content: new StyledText([chunk(truncate(HINT, width - 4), theme.dim)]), height: 1, width: "100%" }));
    this.refresh();
  }

  protected override onMounted(): void {
    this.focusField(0);
  }

  protected override onUnmount(): void {
    for (const row of this.rows) row.input?.blur();
  }

  private get current(): FieldRow {
    return this.rows[this.index]!;
  }

  private collect(): FormValues {
    for (const row of this.rows) {
      if (row.input) this.values[row.spec.key] = row.input.value;
    }
    return { ...this.values };
  }

  private focusField(index: number): void {
    const count = this.rows.length;
    this.index = ((index % count) + count) % count;
    for (const row of this.rows) {
      if (row === this.current) {
        if (row.input) row.input.focus();
      } else {
        row.input?.blur();
      }
    }
    if (!this.current.input) {
      // nothing focused: the modal handles keys for choice/toggle fields itself
      for (const row of this.rows) row.input?.blur();
    }
    this.refresh();
  }

  private refresh(): void {
    this.rows.forEach((row, i) => {
      const focused = i === this.index;
      const error = this.errors[row.spec.key];
      const marker = focused ? "▸ " : "  ";
      const color = error ? theme.error : focused ? theme.accent : theme.fg;
      row.label.content = new StyledText([chunk(fit(marker + row.spec.label, this.labelWidth - 1), color, { bold: focused }), chunk(" ")]);
      if (row.valueText) {
        const value = this.values[row.spec.key];
        let text: string;
        if (row.spec.kind === "toggle") text = value === true ? "[x] yes" : "[ ] no";
        else text = `◂ ${String(value ?? "")} ▸`;
        row.valueText.content = new StyledText([chunk(text, focused ? theme.headerFg : theme.fg, { bold: focused })]);
      }
    });
    const current = this.current;
    const error = this.errors[current.spec.key] ?? Object.values(this.errors)[0];
    const width = this.options.width - 4;
    if (error) this.status.content = new StyledText([chunk(truncate(`✗ ${error}`, width), theme.error)]);
    else if (current.spec.help) this.status.content = new StyledText([chunk(truncate(current.spec.help, width), theme.dim)]);
    else this.status.content = "";
  }

  private cycle(delta: number): void {
    const row = this.current;
    if (row.spec.kind === "toggle") {
      this.values[row.spec.key] = !(this.values[row.spec.key] === true);
    } else if (row.spec.kind === "choice") {
      const options = row.spec.options;
      const currentIndex = Math.max(0, options.indexOf(String(this.values[row.spec.key] ?? "")));
      const next = (((currentIndex + delta) % options.length) + options.length) % options.length;
      this.values[row.spec.key] = options[next]!;
    }
    this.refresh();
  }

  submit(): void {
    const values = this.collect();
    this.errors = this.form.validate?.(values) ?? {};
    if (Object.keys(this.errors).length > 0) {
      const firstBad = this.rows.findIndex((r) => this.errors[r.spec.key]);
      if (firstBad >= 0) this.focusField(firstBad);
      else this.refresh();
      return;
    }
    this.form.onSubmit(values);
  }

  handleKey(key: KeyEvent): boolean {
    const row = this.current;
    const isText = row.spec.kind === "text" || row.spec.kind === "number";
    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
      return true;
    };

    if (key.name === "escape") {
      this.form.onCancel();
      return consume();
    }
    if ((key.ctrl && key.name === "s") || (key.ctrl && key.name === "return")) {
      this.submit();
      return consume();
    }
    if (key.name === "tab" || key.name === "down") {
      this.collect();
      this.focusField(this.index + (key.shift && key.name === "tab" ? -1 : 1));
      return consume();
    }
    if (key.name === "up") {
      this.collect();
      this.focusField(this.index - 1);
      return consume();
    }
    if (key.name === "return" || key.name === "linefeed") {
      if (isText) {
        this.collect();
        if (this.index === this.rows.length - 1) this.submit();
        else this.focusField(this.index + 1);
      } else {
        this.cycle(1);
      }
      return consume();
    }
    if (!isText) {
      if (key.name === "left") {
        this.cycle(-1);
        return consume();
      }
      if (key.name === "right" || key.name === "space") {
        this.cycle(1);
        return consume();
      }
      // swallow everything else so stray characters do not reach the table
      return consume();
    }
    if (row.spec.kind === "number" && key.sequence && /^[^\d\x00-\x1f\x7f]$/.test(key.sequence) && !key.ctrl && !key.meta) {
      // only digits in number fields (control keys such as backspace still pass)
      return consume();
    }
    // Clear a field error as soon as the user edits it.
    if (this.errors[row.spec.key]) {
      delete this.errors[row.spec.key];
      this.refresh();
    }
    return false; // let the InputRenderable handle typing/editing keys
  }
}
