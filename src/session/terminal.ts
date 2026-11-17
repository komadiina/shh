/**
 * Opening a command in a *new window* of the user's terminal emulator
 * (`launch: terminal`).
 *
 * A template is a shell command line in which `{cmd}` is replaced by the
 * (already shell-quoted) command to run, e.g. `alacritty -e {cmd}`.
 */
import type { ProcessRunner } from "../util/shell.ts";

export interface ExternalTerminal {
  /** Human readable name for messages. */
  label: string;
  /** Build the argv that opens the terminal and runs `command` (a `sh -c ...` command line). */
  argv(command: string): string[];
}

const LINUX_CANDIDATES: Array<{ bin: string; template: string }> = [
  { bin: "x-terminal-emulator", template: "x-terminal-emulator -e {cmd}" },
  { bin: "gnome-terminal", template: "gnome-terminal -- {cmd}" },
  { bin: "konsole", template: "konsole -e {cmd}" },
  { bin: "alacritty", template: "alacritty -e {cmd}" },
  { bin: "kitty", template: "kitty {cmd}" },
  { bin: "wezterm", template: "wezterm start -- {cmd}" },
  { bin: "foot", template: "foot {cmd}" },
  { bin: "xfce4-terminal", template: "xfce4-terminal -e {cmd}" },
  { bin: "xterm", template: "xterm -e {cmd}" },
];

export function templateTerminal(template: string, label = template): ExternalTerminal {
  return {
    label,
    argv(command) {
      const line = template.includes("{cmd}") ? template.replaceAll("{cmd}", command) : `${template} ${command}`;
      return ["sh", "-c", line];
    },
  };
}

/** macOS Terminal.app via AppleScript; the command is embedded in an AppleScript string. */
export function macTerminal(): ExternalTerminal {
  return {
    label: "Terminal.app",
    argv(command) {
      const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return ["osascript", "-e", `tell application "Terminal" to do script "${escaped}"`, "-e", 'tell application "Terminal" to activate'];
    },
  };
}

/**
 * Pick a terminal: the configured template, then `$TERMINAL`, then well-known
 * emulators found on PATH. Returns null when nothing usable is found.
 */
export function detectTerminal(
  configuredTemplate: string | undefined,
  runner: ProcessRunner,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ExternalTerminal | null {
  const template = configuredTemplate?.trim();
  if (template) return templateTerminal(template, "terminal_command");

  const envTerminal = env.TERMINAL?.trim();
  if (envTerminal) return templateTerminal(`${envTerminal} -e {cmd}`, `$TERMINAL (${envTerminal})`);

  if (platform === "darwin") return macTerminal();

  for (const candidate of LINUX_CANDIDATES) {
    if (runner.commandExists(candidate.bin)) return templateTerminal(candidate.template, candidate.bin);
  }
  return null;
}
