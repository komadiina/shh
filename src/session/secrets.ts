/**
 * Hands stored passwords to ssh / telnet without putting them in argv, the tmux
 * environment or a long-lived file.
 *
 * The launcher stages the password in a 0600 file inside a private 0700 runtime
 * directory. The session's shell reads it into `$SSHTUI_SECRET` and deletes the
 * file before the client starts; the helper scripts below read the variable.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type HelperName = "askpass" | "telnet-login";

export interface SecretStager {
  /** Write `secret` to a fresh 0600 file and return its path. */
  stage(secret: string): string;
  /** Path of a helper script, written on first use. */
  helper(name: HelperName): string;
}

/**
 * `SSH_ASKPASS` helper. Answers password prompts from `$SSHTUI_SECRET`; anything
 * else (e.g. host key confirmation) is asked on the terminal.
 */
export const ASKPASS_SCRIPT = `#!/bin/sh
# sshtui askpass helper (generated)
case "$1" in
  *[Pp]assword*)
    printf '%s\\n' "$SSHTUI_SECRET"
    ;;
  *)
    printf '%s ' "$1" >/dev/tty
    IFS= read -r answer </dev/tty
    printf '%s\\n' "$answer"
    ;;
esac
`;

/**
 * expect script for telnet. Usage: `expect -f telnet-login <user> telnet args...`.
 * Answers the first login and password prompts, then hands the session to the user.
 */
export const TELNET_LOGIN_SCRIPT = `# sshtui telnet login helper (generated)
set secret ""
if {[info exists ::env(SSHTUI_SECRET)]} { set secret $::env(SSHTUI_SECRET); unset ::env(SSHTUI_SECRET) }
set user [lindex $argv 0]
set timeout 30
spawn -noecho {*}[lrange $argv 1 end]
expect {
  -nocase -re {(login|username)[^\\n]*: *$} {
    if {$user ne ""} { send -- "$user\\r"; exp_continue }
  }
  -nocase -re {password[^\\n]*: *$} { send -- "$secret\\r" }
  timeout {}
  eof { catch wait result; exit [lindex $result 3] }
}
interact
catch wait result
exit [lindex $result 3]
`;

const HELPERS: Record<HelperName, { file: string; content: string; mode: number }> = {
  askpass: { file: "askpass.sh", content: ASKPASS_SCRIPT, mode: 0o700 },
  "telnet-login": { file: "telnet-login.exp", content: TELNET_LOGIN_SCRIPT, mode: 0o600 },
};

export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR?.trim();
  if (base) return join(base, "sshtui");
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `sshtui-${uid}`);
}

export class FileSecretStager implements SecretStager {
  private ready = false;

  constructor(readonly dir: string = runtimeDir()) {}

  private ensureDir(): void {
    if (this.ready) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
    // refuse a directory someone else created or can read (e.g. a pre-planted /tmp path)
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
      throw new Error(`${this.dir} is not a private directory owned by you; refusing to store a password there`);
    }
    if ((st.mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
    this.ready = true;
  }

  stage(secret: string): string {
    this.ensureDir();
    const path = join(this.dir, `secret-${randomBytes(8).toString("hex")}`);
    writeFileSync(path, secret, { mode: 0o600, flag: "wx" });
    return path;
  }

  helper(name: HelperName): string {
    this.ensureDir();
    const { file, content, mode } = HELPERS[name];
    const path = join(this.dir, file);
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  }
}
