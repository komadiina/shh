# Plan: userpass auth, telnet and RDP

Status: implemented · 2026-11-17 (telnet + expect path not run against a live server; expect is not installed here)

## Decisions

| Question | Decision |
| --- | --- |
| How ssh gets a stored password | `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` with a generated helper script. No `sshpass` dependency. |
| Telnet USERPASS | Uses `expect` when installed; otherwise the USERPASS option is disabled (NONE still works, login typed by hand). |
| Unsafe-storage warning | Shown whenever a save would store a new or changed password. Choices: store anyway / save without the password / back to the form. |
| RDP client | `xfreerdp3` only (list is extensible). RDP is disabled in the form when no known client is on PATH. |
| tmux session names | Unchanged (`prefix + name`); names are unique across protocols so they cannot collide. |

## Security rules

- Passwords are stored as `password_b64` (base64, **not encryption**). The config file is already written `0600`.
- A password never appears in argv (`ps`), in the tmux environment or in a long-lived file:
  - ssh / telnet: the password is staged in a `0600` file in a private `0700` runtime dir. The session's shell
    reads it into an env var and deletes the file before starting the client. The askpass / expect helper reads
    the env var.
  - The askpass helper only answers prompts that look like password prompts; anything else (host key
    confirmation) is asked on `/dev/tty`.
  - rdp: arguments (incl. `/p:`) are piped to `xfreerdp3 /args-from:stdin`; nothing touches disk.

## Phases

1. **userpass for ssh**: `auth` + `password_b64` on servers; segmented `[PUBKEY]/[USERPASS]` field; masked
   password field; askpass staging in the launcher; warning dialog on save.
2. **protocol abstraction**: `protocol: ssh | telnet | rdp`; per-protocol command builders returning a
   `SessionCommand` (`kind: tty | gui`); client detection; segmented `[SSH]/[TELNET]/[RDP]` selector that swaps the
   visible form fields; Proto table column (hotkey 0).
3. **telnet**: `telnet [-l user] host [port]`; `expect` wrapper for stored passwords.
4. **rdp**: `xfreerdp3 /v: /u: /d: /size:|/f|/dynamic-resolution /cert: +clipboard /drive:` + `defaults.rdp_options`.
   Stored password → detached window, args over stdin. No stored password → run inline (TUI suspended) so
   xfreerdp3 can prompt in the terminal.

## Config shape

```yaml
defaults:
  rdp_options: []          # extra xfreerdp3 arguments
servers:
  - name: win-01
    protocol: rdp          # ssh (default) | telnet | rdp
    hostname: win-01.corp
    user: admin
    auth: userpass         # pubkey | userpass | none (telnet)
    password_b64: aHVudGVyMg==   # base64, NOT encrypted
    rdp:
      domain: CORP
      resolution: auto     # auto | fullscreen | <w>x<h>
      cert: tofu           # tofu | ignore | deny
      clipboard: true
      drive: ~/share
```
