# sshtui – User Guide

sshtui is a keyboard-driven terminal UI for your SSH servers. You keep your
servers in one YAML file, browse and sort them in a table, and press **Enter**
to connect. When tmux is installed, every connection runs in its own tmux
session. If you leave the app or close the terminal, the connection keeps
running, and pressing Enter on that server again **resumes** it.

---

## 1. Requirements

| What | Needed? | Notes |
|---|---|---|
| **Bun ≥ 1.3.14** | Yes, to run from source | `curl -fsSL https://bun.sh/install \| bash`, or `brew install oven-sh/bun/bun`. Not needed if you use a compiled binary. |
| **OpenSSH client** (`ssh`) | Yes | Already installed on macOS and almost every Linux distribution. |
| **tmux** | Recommended | Gives you resumable sessions. `brew install tmux` / `sudo apt install tmux` / `sudo dnf install tmux`. Byobu users already have it, because byobu runs on tmux. |
| A terminal emulator | Only for `launch: terminal` | Auto-detected (see §6.3). |
| **telnet** | Only for telnet servers | The TELNET option in the form is greyed out when it is missing. |
| **expect** | Only for telnet with a stored password | Without it telnet works, but you type the login yourself. |
| **xfreerdp3** (FreeRDP 3) | Only for RDP servers | The RDP option in the form is greyed out when it is missing. |

Supported platforms: macOS (Intel and Apple Silicon) and Linux (x64 and arm64,
glibc or musl). Windows is not supported, because tmux and the session model
are POSIX-only. Use WSL instead.

---

## 2. Installation

### 2.1 Run from source (simplest)

```sh
tar xzf ssh-tui-0.1.0.tar.gz        # or: git clone ssh-tui.bundle ssh-tui
cd ssh-tui
bun install
bun run start                       # launches the UI
```

### 2.2 Put `sshtui` on your PATH

Option A: link the source launcher. This needs Bun on the machine.

```sh
bun link                 # inside the project folder
sshtui                   # now works from anywhere
```

Option B: build a standalone binary. Bun is not needed at runtime.

```sh
bun run build            # → dist/sshtui (~120 MB, contains the Bun runtime)
sudo install -m 755 dist/sshtui /usr/local/bin/sshtui     # or: cp dist/sshtui ~/.local/bin/
```

Build the binary **on the machine type it will run on**. Each OS and CPU needs
its own build, because the binary embeds a native renderer library. On Alpine
or other musl systems, use `bun run build:musl`.

> macOS: a binary you **downloaded or copied** from elsewhere may be blocked by
> Gatekeeper. Run `xattr -d com.apple.quarantine sshtui` once. A binary you built
> yourself on the Mac is not affected.

---

## 3. First start

```sh
sshtui
```

The first time, sshtui creates a starter config at

- `$XDG_CONFIG_HOME/sshtui/config.yaml`, which is normally
  **`~/.config/sshtui/config.yaml`** (on macOS too).

The starter config contains one `example` server. Edit it with **e** or delete
it with **d**, then add your own servers with **a**. You can also open the
YAML file in your editor and press **r** in the app to reload it.

To print the config path in use: `sshtui --config-path`.

---

## 4. The screen

```
╭ sshtui · 4 servers · 1 live session · tmux ────────────────────────────────────────╮
│    Name ▲     Host                 IPv4          User    Key       Conn  Description │
│ ▸ ● bastion   bastion.example.com                ops     jump_ed   40    Jump host   │
│     db-01                          10.0.0.5      pg      pg_key     3    Postgres    │
│     web-01    web-01.example.com   203.0.113.10  deploy            12    Prod web    │
╰─────────────────────────────────────────── ✓ Detached from ssh-bastion; … ─────────╯
 ↵ connect/resume   I via IPv4   a add   e edit   d delete   K kill session   / filter …
 sort 1 Name▲  2 Host  3 IPv4  4 User  5 Key  6 Port  7 Conn  8 Description  9 Last  S reverse
```

- **Title bar**: number of servers, the active filter, the number of live
  sessions, and the launch mode in effect (`tmux`, `tmux (inside)`,
  `inline (no persistence)` or `new terminal window`).
- **▸** marks the selected row. **●** (green) means the server has a live tmux
  session that you can resume.
- **Columns**: Name, Host, IPv4, User, Key (the file name of the key path),
  Port, Conn (how many sessions you have started), Description, Last (time since
  the last new session). On narrow terminals the least important columns are
  hidden first. Name is always shown.
- **Bottom border**: status messages (✓ success, ! warning, ✗ error).
- **Bottom two lines**: the hotkeys. The second line is the sort bar, and the
  active sort column is highlighted with ▲ or ▼.

---

## 5. Keys

### Navigation
| Key | Action |
|---|---|
| `↑` `↓` / `k` `j` | Move the selection |
| `PgUp` `PgDn` | Move one page |
| `g` / `Home`, `G` / `End` | First / last server |
| `/` | Filter. Type to narrow the list live; **Enter** keeps the filter, **Esc** clears it. The filter matches name, host, IP, user, description and tags. All words must match. |
| `Esc` (in the table) | Clear an active filter |

### Sorting
| Key | Action |
|---|---|
| `1`–`9` | Sort by Name, Host, IPv4, User, Key, Port, Conn, Description, Last. Press the same digit again to reverse the order. |
| `S` | Reverse the current sort |

Names sort naturally (`web-2` comes before `web-10`) and IPs sort octet by
octet. Empty values always go to the bottom. To change the sort used at
startup, go to Settings (`c`).

### Sessions
| Key | Action |
|---|---|
| `Enter` | **Connect, or resume** the server's session |
| `I` | Connect using the server's **IPv4** address instead of its hostname |
| `K` | **Kill** the server's tmux session (asks for confirmation) |
| `r` | Reload the config file from disk and refresh the session status |

### Editing
| Key | Action |
|---|---|
| `a` | Add a server |
| `e` | Edit the selected server |
| `d` | Delete the selected server (asks for confirmation) |
| `c` | Settings pane (defaults) |
| `?` | Help |
| `q` / `Ctrl+C` | Quit. Live tmux sessions keep running. |

### Inside forms (add / edit / settings)
| Key | Action |
|---|---|
| `Tab` / `↓`, `Shift+Tab` / `↑` | Next / previous field |
| `Enter` | Next field. On the last field, it saves. |
| `Space` / `←` `→` | Change a choice field (◂ value ▸), a toggle ([x]) or a box selector (`[SSH]  TELNET  RDP`) |
| `Ctrl+U` | Clear the password field |
| `Ctrl+S` | Save |
| `Esc` | Cancel without saving |

Invalid input, such as a duplicate name, a bad IPv4 address or a port outside
1–65535, is shown in red and the form is not saved.

---

## 6. Sessions: how connecting works

The **launch mode** setting decides what Enter does. Change it in Settings
(`c`) or set `defaults.launch` in the config file.

| `launch` | What happens | Resumable? |
|---|---|---|
| `auto` *(default)* | `tmux` if tmux is installed, otherwise `inline` | Only with tmux |
| `tmux` | Always tmux. If tmux is missing, sshtui falls back to `inline` and shows a warning. | Yes |
| `inline` | ssh runs in the same terminal. The UI comes back when ssh exits. | No |
| `terminal` | Opens a **new terminal window** for the session (tmux-backed if tmux is installed) | Yes, with tmux |

### 6.1 tmux mode, started outside tmux (the usual case)

1. **Enter**: sshtui creates a detached tmux session named
   `<prefix><server>` (default `ssh-web-01`). ssh runs inside it, and your
   terminal attaches to it.
2. To get back to sshtui **without disconnecting**, detach with the tmux
   prefix, then `d` (default **`Ctrl+b d`**). The table returns, and the server
   shows **●**.
3. **Enter** on that server again **re-attaches** to the same session. Nothing
   was lost, and the connection counter is **not** increased.
4. Type `exit` (or log out) in the remote shell. The ssh session ends, the tmux
   session closes, and you are back in sshtui.

The session also survives if you quit sshtui or close the terminal window. The
next time you open sshtui, the ● is still there and Enter resumes it.

### 6.2 tmux mode, started inside tmux

If sshtui itself runs inside tmux, it does not nest tmux. It **switches your
tmux client** to the server's session, and sshtui keeps running in its own
session. To come back, use `Ctrl+b (` / `Ctrl+b )` (previous / next session),
`Ctrl+b L` (last session), or `Ctrl+b s` (session picker).

### 6.3 terminal mode

Each connection opens in a new terminal window. sshtui picks the terminal
program in this order:

1. `defaults.terminal_command` (Settings → *Terminal cmd*), a template in
   which `{cmd}` is replaced by the command to run:
   - `alacritty -e {cmd}`
   - `kitty {cmd}`
   - `wezterm start -- {cmd}`
   - `gnome-terminal -- {cmd}`
   - On macOS, leave it empty to use Terminal.app, or point it at any
     terminal that accepts a command on its command line (e.g. `alacritty -e {cmd}`).
2. `$TERMINAL`, used as `$TERMINAL -e {cmd}`.
3. **macOS**: Terminal.app (through AppleScript). The first time, macOS asks
   you to allow sshtui or your terminal to control Terminal.app. Allow it.
4. **Linux**: the first of x-terminal-emulator, gnome-terminal, konsole,
   alacritty, kitty, wezterm, foot, xfce4-terminal or xterm found on PATH.

With tmux installed, the window runs `tmux new-session -A -s ssh-<name>`. That
command attaches to the session if it already exists, or creates it if not, so
closing the window does not drop the connection.

### 6.4 When ssh fails

With `hold_on_error: true` (the default), a failed connection, for example
"connection refused" or a wrong key, keeps the tmux window open and shows:

```
[sshtui] ssh exited with status 255. Press Enter to close.
```

so you can read the error. In inline mode the status appears in sshtui's
status line.

### 6.5 What the connection counter counts

`connections` goes up by one, and `last_connected` is set, every time a **new**
ssh session is started. Resuming an existing tmux session does not count. Both
values are written to the YAML file right away.

### 6.6 What "IPv4 vs hostname" means

Each server can have a `hostname`, an `ipv4`, or both. Enter uses
`defaults.connect_via` (default `hostname`). A server-level `connect_via`
overrides it. **I** always uses the IPv4 address for that one connection. If
the preferred address is empty, sshtui uses the other one.

---

## 7. The config file

Location, in order of precedence:

1. `sshtui --config /path/to/file.yaml`
2. `$SSHTUI_CONFIG`
3. `$XDG_CONFIG_HOME/sshtui/config.yaml` (default `~/.config/sshtui/config.yaml`)

Changes you make in the app are written back **without removing your comments**
or changing the key order. Writes are atomic, and the file is created with
mode `0600`. You can edit the file by hand at any time and press **r** in the
app to reload it.

### 7.1 Full example

```yaml
version: 1

defaults:
  user: ops                         # used when a server has no user
  identity_file: ~/.ssh/id_ed25519  # used when a server has no key (path only!)
  port: 22                          # -p is only added when a server sets a port or this is not 22
  connect_via: hostname             # hostname | ipv4
  launch: auto                      # auto | tmux | inline | terminal
  terminal_command: ""              # e.g. "alacritty -e {cmd}"; empty = auto-detect
  ssh_options: ["-o", "ServerAliveInterval=30"]   # added to every ssh call
  tmux:
    session_prefix: "ssh-"          # tmux session = prefix + server name
    hold_on_error: true             # keep the window open when ssh fails
  sort:
    column: name                    # name|hostname|ipv4|user|identity_file|port|connections|description|last_connected
    direction: asc                  # asc | desc

servers:
  - name: web-01                    # required, unique (case-insensitive), no spaces / : \
    hostname: web-01.example.com    # hostname and/or ipv4 is required
    ipv4: 203.0.113.10
    user: deploy                    # optional, overrides defaults.user
    identity_file: ~/.ssh/deploy_ed25519   # optional, overrides defaults.identity_file
    port: 2222                      # optional
    description: Production web
    tags: [prod, web]               # searchable with /
    connect_via: ipv4               # optional per-server override
    connections: 12                 # maintained by sshtui
    last_connected: 2026-11-10T14:03:00.000Z   # maintained by sshtui
```

### 7.2 Protocols and logins

Each server has a **protocol** (`[SSH]` / `[TELNET]` / `[RDP]` at the top of the
add/edit form) and an **auth** method (`[PUBKEY]` / `[USERPASS]`, or `[NONE]` for
telnet). The form only shows the fields that apply: the key path for ssh +
PUBKEY, the password for USERPASS, and domain / resolution / certificate /
clipboard / shared directory for RDP. Options whose client is not installed are
greyed out with a ✗, and the hint line says why.

| Protocol | Runs | Default port | Notes |
|---|---|---|---|
| ssh | `ssh` in tmux / inline / a new terminal | 22 (or `~/.ssh/config`) | PUBKEY or USERPASS |
| telnet | `telnet [-l user] host [port]`, same session modes as ssh | 23 | USERPASS with a stored password needs `expect` |
| rdp | `xfreerdp3` in its own window | 3389 | Always USERPASS; RDP windows are not tmux sessions, so `K` does not apply |

**Stored passwords are not encrypted.** With USERPASS you can leave the password
empty (you are asked when connecting) or store it. A stored password is written
to the config file as `password_b64`, base64-encoded. Base64 only hides it from a
casual glance: anyone who can read the file can decode it. sshtui asks for
confirmation every time a new or changed password would be stored. In that dialog,
`y` stores it, `w` saves the server without it, and `Esc` goes back to the form.

How a stored password reaches the client (it is never put on a command line, so
it does not show up in `ps`):

- ssh: through an `SSH_ASKPASS` helper. The password is staged in a `0600` file
  in a private runtime directory (`$XDG_RUNTIME_DIR/sshtui`), read into the
  session's environment and deleted before ssh starts. Prompts that are not
  password prompts, such as host key confirmation, are still asked in the terminal.
  Needs OpenSSH 8.4 or newer.
- telnet: an `expect` script answers the first login and password prompts, then
  hands the session to you.
- rdp: all arguments, including the password, are piped to
  `xfreerdp3 /args-from:stdin`. Without a stored password, xfreerdp3 runs in the
  app's terminal so it can ask for the password, and sshtui waits until the RDP
  window closes.

### 7.3 What sshtui does with your keys

Nothing beyond storing the path. sshtui **never opens, reads or copies**
private key files. It saves the *path* in the YAML file and passes it to
`ssh -i <path>`. A leading `~` is expanded to your home directory. Leave the key
empty to let ssh use its normal mechanisms: `ssh-agent`, `~/.ssh/config`
`IdentityFile`, or the default keys.

### 7.4 Working with `~/.ssh/config`

sshtui calls the system `ssh`, so everything in `~/.ssh/config` still applies:
`ProxyJump`, `IdentityFile`, `User`, `Port`, `ControlMaster` and so on.

- You can use a `Host` alias from `~/.ssh/config` as the `hostname`.
- sshtui only passes `-p` when you set a port explicitly, so `Port` lines in
  `~/.ssh/config` keep working.
- Options set on the command line (`-i`, `-p`, `user@`) **override**
  `~/.ssh/config`. Leave those fields empty if you want the ssh config to decide.

### 7.5 Validation

- **Errors** (the app refuses to start, with a message that names the field):
  a server without a name, duplicate names, `servers` not being a list, or
  invalid YAML syntax.
- **Warnings** (shown in a dialog at startup, then the app continues): an
  unknown `launch` or `connect_via` value (the default is used), an invalid
  port or IPv4 address, or a server with neither a hostname nor an IPv4 address.

---

## 8. Settings pane (`c`)

The pane shows where the config file lives, whether tmux was found (and
whether you are inside it), and which terminal `launch: terminal` would use.
It edits everything under `defaults:`:

| Field | Meaning |
|---|---|
| Default user / Default key / Default port | Used for servers that leave these fields empty |
| Connect via | `hostname` or `ipv4` |
| Launch mode | `auto`, `tmux`, `inline`, `terminal` (see §6) |
| Terminal cmd | Template for terminal mode, with `{cmd}` |
| ssh options | Extra ssh arguments, shell-quoted, e.g. `-o ServerAliveInterval=30 -o ConnectTimeout=5` |
| tmux prefix | Session name prefix. No `.`, `:` or spaces. |
| Hold on error | Keep the window open after a failed ssh |
| Sort column / dir | Startup sort |

If you change the tmux prefix, live sessions created under the old prefix are
no longer recognised. Kill them first, or detach and use `tmux ls` to manage
them by hand.

---

## 9. Command-line use

```sh
sshtui                         # the UI
sshtui --list                  # print the server table (● = live session) and exit
sshtui --connect web-01        # connect/resume without the UI (counts like Enter)
sshtui --connect web-01 --ipv4 # same, via the IPv4 address
sshtui --config ~/work.yaml    # use another config file
sshtui --config-path           # print which config file is used
sshtui --help | --version
```

To keep separate server lists, for example work and personal, use separate
files: `alias work-ssh='sshtui --config ~/.config/sshtui/work.yaml'`.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Title says `inline (no persistence)` | tmux was not found. Install it, then restart sshtui. |
| Status: *"tmux session … ended before it could be attached"* | ssh exited immediately. Turn on *Hold on error* to see why, or test with `ssh -v <target>` in a shell. |
| Enter opens a session but you can't get back | Detach with `Ctrl+b d` (or your own tmux prefix + `d`). |
| ● is missing for a session you know exists | Press `r`. Also check that the session name matches `<prefix><name>` (`tmux ls`). Characters other than `A-Z a-z 0-9 _ -` in the name become `_`. |
| *"No terminal emulator found"* | Set *Terminal cmd* in Settings, e.g. `alacritty -e {cmd}`. |
| Terminal mode does nothing on macOS | Allow automation in System Settings → Privacy & Security → Automation (your terminal → Terminal). |
| `Could not load …: YAML syntax error` | Fix the file. The message gives the line. Your comments are not touched by the app. |
| Ctrl+S does nothing in a form | Some terminal setups use Ctrl+S for flow control. Press Enter on the last field instead. |
| Garbled screen after a crash | Run `reset` in the terminal. |
| Colours look odd | Use a terminal with true-colour support and `TERM=xterm-256color` (or similar). |
