/**
 * Centered overlay windows: a base `Modal` plus a generic `FormModal` used by the
 * add/edit server dialog and the settings pane.
 */
import {
  BoxRenderable,
  InputRenderable,
  StyledText,
  TextRenderable,
  bg,
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

/** Decides from the current values whether a field is shown. */
export type FieldVisibility = (values: FormValues) => boolean;

interface FieldBase {
  key: string;
  label: string;
  help?: string;
  /** Hidden fields are skipped by navigation and keep their value. */
  visible?: FieldVisibility;
}

export type FieldSpec =
  | (FieldBase & { kind: "text"; placeholder?: string })
  | (FieldBase & { kind: "number"; placeholder?: string })
  | (FieldBase & { kind: "choice"; options: readonly string[] })
  | (FieldBase & { kind: "toggle" })
  | (FieldBase & {
      /** All options in a row, the selected one boxed: `[PUBKEY]  USERPASS`. */
      kind: "segmented";
      options: readonly string[] | ((values: FormValues) => readonly string[]);
      /** Reason an option cannot be picked right now (shown dimmed and skipped), or undefined. */
      disabled?: (option: string, values: FormValues) => string | undefined;
    })
  | (FieldBase & { kind: "secret"; placeholder?: string });

export type FormValues = Record<string, string | boolean>;

export interface FormOptions {
  title: string;
  fields: FieldSpec[];
  values: FormValues;
  /** Read-only lines shown above the fields. */
  info?: string[];
  validate?: (values: FormValues) => Record<string, string>;
  /** Called after a choice / toggle / segmented field changed; may adjust `values` in place. */
  onChange?: (key: string, values: FormValues) => void;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
  width?: number;
  /** Key of the field focused when the form opens (default: the first visible one). */
  initialFocus?: string;
}

interface FieldRow {
  spec: FieldSpec;
  row: BoxRenderable;
  label: TextRenderable;
  input?: InputRenderable;
  valueText?: TextRenderable;
}

const HINT = "Tab/↑↓ move · Enter next · Space/←→ change · Ctrl+S save · Esc cancel";

function segmentOptions(spec: FieldSpec & { kind: "segmented" }, values: FormValues): readonly string[] {
  return typeof spec.options === "function" ? spec.options(values) : spec.options;
}

export class FormModal extends Modal {
  private readonly rows: FieldRow[] = [];
  private readonly values: FormValues;
  private index = 0;
  private readonly status: TextRenderable;
  private errors: Record<string, string> = {};
  private readonly labelWidth: number;
  private readonly chromeHeight: number;

  constructor(
    renderer: CliRenderer,
    private readonly form: FormOptions,
  ) {
    const info = form.info ?? [];
    const width = form.width ?? 74;
    const chromeHeight = 2 + (info.length > 0 ? info.length + 1 : 0) + 3;
    super(renderer, { title: form.title, width, height: chromeHeight + form.fields.length });
    this.chromeHeight = chromeHeight;
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
    this.normalizeSegments();
    this.layout();
    this.refresh();
  }

  protected override onMounted(): void {
    const initial = this.rows.findIndex((r) => r.spec.key === this.form.initialFocus);
    this.focusField(this.nextVisible(Math.max(0, initial), 1));
  }

  protected override onUnmount(): void {
    for (const row of this.rows) row.input?.blur();
  }

  private get current(): FieldRow {
    return this.rows[this.index]!;
  }

  private isVisible(row: FieldRow): boolean {
    return row.spec.visible?.(this.values) ?? true;
  }

  /** First visible row index starting at `from` and stepping by `step` (wrapping). */
  private nextVisible(from: number, step: 1 | -1): number {
    const count = this.rows.length;
    for (let i = 0; i < count; i++) {
      const idx = (((from + i * step) % count) + count) % count;
      if (this.isVisible(this.rows[idx]!)) return idx;
    }
    return 0;
  }

  /** Show/hide rows for the current values and resize the modal to fit. */
  private layout(): void {
    let shown = 0;
    for (const row of this.rows) {
      const visible = this.isVisible(row);
      row.row.visible = visible;
      if (visible) shown++;
    }
    this.options.height = this.chromeHeight + shown;
    if (this.mounted) this.center();
  }

  /**
   * Keep segmented values on an existing option. After a change (`changedKey`)
   * the other segmented fields also move off disabled options; initially a
   * disabled value is kept so editing e.g. an RDP server without an RDP client
   * does not silently turn it into something else.
   */
  private normalizeSegments(changedKey?: string): void {
    for (const { spec } of this.rows) {
      if (spec.kind !== "segmented") continue;
      const options = segmentOptions(spec, this.values);
      const value = String(this.values[spec.key] ?? "");
      const usable = (o: string) => !spec.disabled?.(o, this.values);
      const strict = changedKey !== undefined && changedKey !== spec.key;
      if (options.includes(value) && (!strict || usable(value))) continue;
      const fallback = options.find(usable) ?? options[0];
      if (fallback !== undefined) this.values[spec.key] = fallback;
    }
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
      if (row.valueText) row.valueText.content = this.renderValue(row, focused);
    });
    const current = this.current;
    const error = this.errors[current.spec.key] ?? Object.values(this.errors)[0];
    const width = this.options.width - 4;
    const help = this.helpFor(current);
    if (error) this.status.content = new StyledText([chunk(truncate(`✗ ${error}`, width), theme.error)]);
    else if (help) this.status.content = new StyledText([chunk(truncate(help, width), theme.dim)]);
    else this.status.content = "";
  }

  private helpFor(row: FieldRow): string | undefined {
    const spec = row.spec;
    if (spec.kind !== "segmented" || !spec.disabled) return spec.help;
    const reasons = segmentOptions(spec, this.values)
      .map((o) => spec.disabled!(o, this.values))
      .filter((r): r is string => r !== undefined);
    // why options are greyed out matters more than the generic help, so it comes first
    return [...reasons, spec.help].filter(Boolean).join(" · ") || undefined;
  }

  private renderValue(row: FieldRow, focused: boolean): StyledText {
    const spec = row.spec;
    const value = this.values[spec.key];
    const color = focused ? theme.headerFg : theme.fg;
    switch (spec.kind) {
      case "toggle":
        return new StyledText([chunk(value === true ? "[x] yes" : "[ ] no", color, { bold: focused })]);
      case "segmented": {
        const out: TextChunk[] = [];
        for (const option of segmentOptions(spec, this.values)) {
          const label = option.toUpperCase();
          if (option === value) out.push(chunk(`[${label}]`, focused ? theme.accent : theme.headerFg, { bold: true }));
          else if (spec.disabled?.(option, this.values)) out.push(chunk(` ${label}✗`, theme.placeholder));
          else out.push(chunk(` ${label} `, theme.dim));
          out.push(chunk(" "));
        }
        return new StyledText(out);
      }
      case "secret": {
        const text = String(value ?? "");
        const bgColor = focused ? theme.inputFocusedBg : theme.inputBg;
        const shown = text ? "•".repeat(text.length) : (spec.placeholder ?? "");
        const pad = " ".repeat(Math.max(0, this.options.width - this.labelWidth - 4 - displayWidth(shown) - (focused ? 1 : 0)));
        const chunks: TextChunk[] = [bg(bgColor)(chunk(shown, text ? color : theme.placeholder))];
        if (focused) chunks.push(bg(theme.headerFg)(chunk(" ", theme.inputFocusedBg)));
        chunks.push(bg(bgColor)(chunk(pad)));
        return new StyledText(chunks);
      }
      default:
        return new StyledText([chunk(`◂ ${String(value ?? "")} ▸`, color, { bold: focused })]);
    }
  }

  private changed(key: string): void {
    this.collect();
    this.form.onChange?.(key, this.values);
    this.normalizeSegments(key);
    this.layout();
    this.refresh();
  }

  private cycle(delta: number): void {
    const row = this.current;
    const spec = row.spec;
    if (spec.kind === "toggle") {
      this.values[spec.key] = !(this.values[spec.key] === true);
    } else if (spec.kind === "choice" || spec.kind === "segmented") {
      const options = spec.kind === "segmented" ? segmentOptions(spec, this.values) : spec.options;
      const usable = (o: string) => spec.kind !== "segmented" || !spec.disabled?.(o, this.values);
      let idx = Math.max(0, options.indexOf(String(this.values[spec.key] ?? "")));
      for (let i = 0; i < options.length; i++) {
        idx = (((idx + delta) % options.length) + options.length) % options.length;
        if (usable(options[idx]!)) break;
      }
      if (!usable(options[idx]!)) return;
      this.values[spec.key] = options[idx]!;
    } else {
      return;
    }
    this.changed(spec.key);
  }

  submit(): void {
    const values = this.collect();
    this.errors = this.form.validate?.(values) ?? {};
    if (Object.keys(this.errors).length > 0) {
      const firstBad = this.rows.findIndex((r) => this.errors[r.spec.key] && this.isVisible(r));
      if (firstBad >= 0) this.focusField(firstBad);
      else this.refresh();
      return;
    }
    this.form.onSubmit(values);
  }

  /** Typing into a masked field; the value never reaches an InputRenderable. */
  private editSecret(key: KeyEvent): boolean {
    const field = this.current.spec.key;
    const value = String(this.values[field] ?? "");
    let next = value;
    if (key.name === "backspace") next = value.slice(0, -1);
    else if (key.ctrl && key.name === "u") next = "";
    else if (!key.ctrl && !key.meta && key.sequence && /^[^\x00-\x1f\x7f]$/u.test(key.sequence)) next = value + key.sequence;
    else return false;
    this.values[field] = next;
    delete this.errors[field];
    this.refresh();
    return true;
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
      const step = key.shift && key.name === "tab" ? -1 : 1;
      this.focusField(this.nextVisible(this.index + step, step));
      return consume();
    }
    if (key.name === "up") {
      this.collect();
      this.focusField(this.nextVisible(this.index - 1, -1));
      return consume();
    }
    const isLast = this.nextVisible(this.index + 1, 1) <= this.index;
    if (key.name === "return" || key.name === "linefeed") {
      if (isText || row.spec.kind === "secret") {
        this.collect();
        if (isLast) this.submit();
        else this.focusField(this.nextVisible(this.index + 1, 1));
      } else {
        this.cycle(1);
      }
      return consume();
    }
    if (row.spec.kind === "secret") {
      this.editSecret(key);
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
