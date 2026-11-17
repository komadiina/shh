import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const APP_DIR_NAME = "shh";
export const CONFIG_FILE_NAME = "config.yaml";
export const CONFIG_ENV_VAR = "SHH_CONFIG";

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Shorten an absolute path under $HOME back to `~/...` for display. */
export function contractHome(path: string, home: string = homedir()): string {
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, APP_DIR_NAME);
}

/**
 * Where the config lives, in order of precedence:
 *   1. an explicit path (`--config`)
 *   2. `$SHH_CONFIG`
 *   3. `$XDG_CONFIG_HOME/shh/config.yaml` (default `~/.config/shh/config.yaml`)
 */
export function resolveConfigPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = explicit?.trim() || env[CONFIG_ENV_VAR]?.trim();
  if (candidate) return resolve(expandHome(candidate));
  return join(configDir(env), CONFIG_FILE_NAME);
}
