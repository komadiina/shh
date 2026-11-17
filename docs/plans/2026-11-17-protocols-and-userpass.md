# plan: userpass auth, telnet and rdp

status: implemented · 2026-11-17 (the telnet + expect path hasn't been run against a live server yet; expect isn't installed here. no rush.)

## decisions

| question | what we picked |
| --- | --- |
| how ssh gets a stored password | `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` with a generated helper script. no `sshpass` dependency needed. |
| telnet userpass | uses `expect` if it's installed; otherwise the userpass option is just disabled (none still works, you type the login yourself). |
| unsafe-storage warning | pops up whenever a save would store a new or changed password. choices: store anyway / save without the password / back to the form. |
| rdp client | `xfreerdp3` only for now (the list is easy to extend). rdp is disabled in the form when no known client is on PATH. |
| tmux session names | unchanged (`prefix + name`); names are unique across protocols, so they can't collide. |

## security rules

- passwords get stored as `password_b64` (base64, **not encryption**). the config file is already written `0600`.
- a password never shows up in argv (`ps`), the tmux environment or any long-lived file:
  - ssh / telnet: the password is staged in a `0600` file inside a private `0700` runtime dir. the session's shell
    reads it into an env var and deletes the file before the client starts. the askpass / expect helper reads
    the env var.
  - the askpass helper only answers prompts that look like password prompts; anything else (like host key
    confirmation) gets asked on `/dev/tty`.
  - rdp: arguments (incl. `/p:`) are piped to `xfreerdp3 /args-from:stdin`; nothing touches disk.

## phases

1. **userpass for ssh**: `auth` + `password_b64` on servers; segmented `[PUBKEY]/[USERPASS]` field; masked
   password field; askpass staging in the launcher; warning dialog on save.
2. **protocol abstraction**: `protocol: ssh | telnet | rdp`; per-protocol command builders returning a
   `SessionCommand` (`kind: tty | gui`); client detection; segmented `[SSH]/[TELNET]/[RDP]` selector that swaps the
   visible form fields; proto table column (hotkey 0).
3. **telnet**: `telnet [-l user] host [port]`; `expect` wrapper for stored passwords.
4. **rdp**: `xfreerdp3 /v: /u: /d: /size:|/f|/dynamic-resolution /cert: +clipboard /drive:` + `defaults.rdp_options`.
   stored password → detached window, args over stdin. no stored password → runs inline (tui suspended) so
   xfreerdp3 can ask in the terminal.

## config shape

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
