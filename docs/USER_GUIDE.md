# shh – user guide

shh is a keyboard-driven terminal ui for your ssh servers. you keep them all in
one yaml file, browse and sort them in a table, and hit **enter** to connect.
easy. if tmux is installed, every connection gets its own tmux session. leave
the app or close the terminal and the connection keeps humming along; hit enter
on that server again and you **pick up right where you left off**.

---

## 1. what you need

| what | needed? | notes |
|---|---|---|
| **bun ≥ 1.3.14** | yep, to run from source | `curl -fsSL https://bun.sh/install \| bash`, or `brew install oven-sh/bun/bun`. skip it if you're using a compiled binary. |
| **openssh client** (`ssh`) | yep | you almost certainly have it already; macos and pretty much every linux distro ship it. |
| **tmux** | recommended | gets you resumable sessions. `brew install tmux` / `sudo apt install tmux` / `sudo dnf install tmux`. byobu folks already have it, since byobu runs on tmux. |
| a terminal emulator | only for `launch: terminal` | auto-detected (see §6.3). |
| **telnet** | only for telnet servers | the TELNET option in the form is greyed out if it's missing. |
| **expect** | only for telnet with a stored password | telnet works fine without it; you just type the login yourself. |
| **xfreerdp3** (freerdp 3) | only for rdp servers | the RDP option in the form is greyed out if it's missing. |

runs on macos (intel and apple silicon) and linux (x64 and arm64, glibc or
musl). windows isn't supported since tmux and the session model are posix-only;
wsl works great though.

---

## 2. installing

### 2.1 run from source (easiest)

```sh
tar xzf shh-0.1.0.tar.gz        # or: git clone shh.bundle shh
cd shh
bun install
bun run start                       # launches the UI
```

### 2.2 put `shh` on your PATH

option a: link the source launcher. needs bun on the machine.

```sh
bun link                 # inside the project folder
shh                   # now works from anywhere
```

option b: build a standalone binary. no bun needed at runtime.

```sh
bun run build            # → dist/shh (~120 MB, contains the Bun runtime)
sudo install -m 755 dist/shh /usr/local/bin/shh     # or: cp dist/shh ~/.local/bin/
```

build the binary **on the same kind of machine it'll run on**. each os and cpu
needs its own build since the binary bundles a native renderer library. on
alpine or other musl systems, use `bun run build:musl`.

> macos heads-up: a binary you **downloaded or copied** from somewhere else might
> get blocked by gatekeeper. run `xattr -d com.apple.quarantine shh` once and
> you're good. binaries you built yourself on the mac are fine.

---

## 3. first start

```sh
shh
```

the first time around, shh drops a starter config at

- `$XDG_CONFIG_HOME/shh/config.yaml`, which is usually
  **`~/.config/shh/config.yaml`** (on macos too).

it comes with one `example` server. edit it with **e** or toss it with **d**,
then add your own with **a**. you can also just open the yaml in your editor
and hit **r** in the app to reload.

wanna know which config file it's using? `shh --config-path`.

---

## 4. the screen

```
╭ shh · 4 servers · 1 live session · tmux ───────────────────────────────────────────╮
│    Name ▲     Host                 IPv4          User    Key       Conn  Description │
│ ▸ ● bastion   bastion.example.com                ops     jump_ed   40    Jump host   │
│     db-01                          10.0.0.5      pg      pg_key     3    Postgres    │
│     web-01    web-01.example.com   203.0.113.10  deploy            12    Prod web    │
╰─────────────────────────────────────────── ✓ Detached from ssh-bastion; … ─────────╯
 ↵ connect/resume   I via IPv4   a add   e edit   d delete   K kill session   / filter …
 sort 1 Name▲  2 Host  3 IPv4  4 User  5 Key  6 Port  7 Conn  8 Description  9 Last  S reverse
```

- **title bar**: how many servers you've got, the active filter, how many live
  sessions there are, and the launch mode in play (`tmux`, `tmux (inside)`,
  `inline (no persistence)` or `new terminal window`).
- **▸** is the selected row. a green **●** means that server has a live tmux
  session waiting for you.
- **columns**: name, host, ipv4, user, key (just the file name of the key path),
  port, conn (how many sessions you've started), description, last (time since
  the last new session). on narrow terminals the less important columns hide
  first; name always sticks around.
- **bottom border**: status messages (✓ success, ! warning, ✗ error).
- **bottom two lines**: the hotkeys. the second line is the sort bar; the
  active sort column gets a ▲ or ▼.

---

## 5. keys

### getting around
| key | what it does |
|---|---|
| `↑` `↓` / `k` `j` | move the selection |
| `PgUp` `PgDn` | jump a page |
| `g` / `Home`, `G` / `End` | first / last server |
| `/` | filter. type to narrow things down live; **enter** keeps the filter, **esc** clears it. it matches name, host, ip, user, description and tags. every word has to match. |
| `Esc` (in the table) | clear an active filter |

### sorting
| key | what it does |
|---|---|
| `1`–`9` | sort by name, host, ipv4, user, key, port, conn, description, last. hit the same digit again to flip it. |
| `S` | flip the current sort |

names sort naturally (`web-2` comes before `web-10`) and ips sort octet by
octet. empty values always sink to the bottom. if you want a different sort on
startup, head to settings (`c`).

### sessions
| key | what it does |
|---|---|
| `Enter` | **connect, or resume** the server's session |
| `I` | connect using the server's **ipv4** instead of its hostname |
| `K` | **kill** the server's tmux session (asks first) |
| `r` | reload the config from disk and refresh session status |

### editing
| key | what it does |
|---|---|
| `a` | add a server |
| `e` | edit the selected server |
| `d` | delete the selected server (asks first) |
| `c` | settings pane (defaults) |
| `?` | help |
| `q` / `Ctrl+C` | quit. live tmux sessions keep running, don't worry. |

### inside forms (add / edit / settings)
| key | what it does |
|---|---|
| `Tab` / `↓`, `Shift+Tab` / `↑` | next / previous field |
| `Enter` | next field; on the last one, it saves |
| `Space` / `←` `→` | change a choice field (◂ value ▸), a toggle ([x]) or a box selector (`[SSH]  TELNET  RDP`) |
| `Ctrl+U` | clear the password field |
| `Ctrl+S` | save |
| `Esc` | bail out without saving |

bad input, like a duplicate name, a wonky ipv4 or a port outside 1–65535,
shows up in red and the form won't save until it's sorted.

---

## 6. sessions: how connecting works

the **launch mode** setting decides what enter does. change it in settings
(`c`) or set `defaults.launch` in the config file.

| `launch` | what happens | resumable? |
|---|---|---|
| `auto` *(default)* | `tmux` if tmux is installed, otherwise `inline` | only with tmux |
| `tmux` | always tmux. if tmux is missing, shh falls back to `inline` and gives you a heads-up. | yep |
| `inline` | ssh runs in the same terminal; the ui comes back when ssh exits. | nope |
| `terminal` | opens a **new terminal window** for the session (tmux-backed if tmux is around) | yep, with tmux |

### 6.1 tmux mode, started outside tmux (the usual case)

1. **enter**: shh spins up a detached tmux session called
   `<prefix><server>` (default `ssh-web-01`). ssh runs inside it and your
   terminal attaches.
2. to hop back to shh **without disconnecting**, detach with the tmux prefix
   then `d` (default **`Ctrl+b d`**). the table comes back and the server
   shows a **●**.
3. **enter** on that server again **re-attaches** to the same session. nothing
   lost; the connection counter **doesn't** go up either.
4. type `exit` (or log out) in the remote shell. ssh ends, the tmux session
   closes, and you land back in shh.

the session even survives quitting shh or closing the terminal window. next
time you open shh the ● is still there and enter resumes it.

### 6.2 tmux mode, started inside tmux

if shh itself is running inside tmux, it won't nest tmux. it just **switches
your tmux client** over to the server's session; shh keeps running in its own.
to get back, use `Ctrl+b (` / `Ctrl+b )` (previous / next session),
`Ctrl+b L` (last session) or `Ctrl+b s` (session picker).

### 6.3 terminal mode

each connection opens in a fresh terminal window. shh picks the terminal
program in this order:

1. `defaults.terminal_command` (settings → *terminal cmd*), a template where
   `{cmd}` gets swapped for the command to run:
   - `alacritty -e {cmd}`
   - `kitty {cmd}`
   - `wezterm start -- {cmd}`
   - `gnome-terminal -- {cmd}`
   - on macos, leave it empty to use terminal.app, or point it at any terminal
     that takes a command on its command line (e.g. `alacritty -e {cmd}`).
2. `$TERMINAL`, used as `$TERMINAL -e {cmd}`.
3. **macos**: terminal.app (via applescript). the first time, macos asks if
   shh or your terminal can control terminal.app; just allow it.
4. **linux**: the first of x-terminal-emulator, gnome-terminal, konsole,
   alacritty, kitty, wezterm, foot, xfce4-terminal or xterm found on PATH.

with tmux installed, the window runs `tmux new-session -A -s ssh-<name>`. that
attaches to the session if it already exists or creates it if not; closing the
window won't drop the connection.

### 6.4 when ssh fails

with `hold_on_error: true` (the default), a failed connection, say
"connection refused" or a wrong key, keeps the tmux window open and shows:

```
[shh] ssh exited with status 255. Press Enter to close.
```

so you actually get to read the error. in inline mode the status lands in shh's
status line instead.

### 6.5 what the connection counter counts

`connections` goes up by one and `last_connected` gets set every time a **new**
ssh session starts. resuming an existing tmux session doesn't count. both get
written to the yaml right away.

### 6.6 ipv4 vs hostname

each server can have a `hostname`, an `ipv4`, or both. enter uses
`defaults.connect_via` (default `hostname`); a server-level `connect_via`
overrides that. **I** always uses the ipv4 for that one connection. if the
preferred address is empty, shh just uses the other one.

---

## 7. the config file

where it lives, in order of precedence:

1. `shh --config /path/to/file.yaml`
2. `$SHH_CONFIG`
3. `$XDG_CONFIG_HOME/shh/config.yaml` (default `~/.config/shh/config.yaml`)

changes made in the app get written back **without nuking your comments** or
shuffling the key order. writes are atomic and the file is created with mode
`0600`. feel free to edit it by hand whenever; hit **r** in the app to reload.

### 7.1 full example

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
    connections: 12                 # maintained by shh
    last_connected: 2026-11-10T14:03:00.000Z   # maintained by shh
```

### 7.2 protocols and logins

each server has a **protocol** (`[SSH]` / `[TELNET]` / `[RDP]` at the top of the
add/edit form) and an **auth** method (`[PUBKEY]` / `[USERPASS]`, or `[NONE]` for
telnet). the form only shows what's relevant: the key path for ssh + pubkey,
the password for userpass, and domain / resolution / certificate / clipboard /
shared directory for rdp. options whose client isn't installed get greyed out
with a ✗, and the hint line tells you why.

| protocol | runs | default port | notes |
|---|---|---|---|
| ssh | `ssh` in tmux / inline / a new terminal | 22 (or `~/.ssh/config`) | pubkey or userpass |
| telnet | `telnet [-l user] host [port]`, same session modes as ssh | 23 | userpass with a stored password needs `expect` |
| rdp | `xfreerdp3` in its own window | 3389 | always userpass; rdp windows aren't tmux sessions, so `K` doesn't apply |

**stored passwords aren't encrypted.** just so you know. with userpass you can
leave the password empty (you'll get asked when connecting) or store it. a
stored password goes into the config as `password_b64`, base64-encoded. base64
only hides it from a quick glance; anyone who can read the file can decode it.
shh asks you every time a new or changed password would be stored. in that
dialog, `y` stores it, `w` saves the server without it, and `Esc` takes you
back to the form.

how a stored password gets to the client (it never lands on a command line, so
it won't show up in `ps`):

- ssh: through an `SSH_ASKPASS` helper. the password is staged in a `0600` file
  in a private runtime directory (`$XDG_RUNTIME_DIR/shh`), read into the
  session's environment and deleted before ssh starts. prompts that aren't
  password prompts, like host key confirmation, still get asked in the terminal.
  needs openssh 8.4 or newer.
- telnet: an `expect` script answers the first login and password prompts, then
  hands the session over to you.
- rdp: all the arguments, password included, get piped to
  `xfreerdp3 /args-from:stdin`. without a stored password, xfreerdp3 runs in the
  app's terminal so it can ask you, and shh hangs tight until the rdp window
  closes.

### 7.3 what shh does with your keys

nothing besides storing the path, promise. shh **never opens, reads or copies**
private key files. it saves the *path* in the yaml and passes it to
`ssh -i <path>`. a leading `~` gets expanded to your home dir. leave the key
empty and ssh does its usual thing: `ssh-agent`, `~/.ssh/config`
`IdentityFile`, or the default keys.

### 7.4 playing nice with `~/.ssh/config`

shh calls the system `ssh`, so everything in `~/.ssh/config` still works:
`ProxyJump`, `IdentityFile`, `User`, `Port`, `ControlMaster` and friends.

- you can use a `Host` alias from `~/.ssh/config` as the `hostname`.
- shh only passes `-p` when you set a port explicitly; `Port` lines in
  `~/.ssh/config` keep working.
- stuff set on the command line (`-i`, `-p`, `user@`) **wins over**
  `~/.ssh/config`. leave those fields empty if you'd rather let the ssh config decide.

### 7.5 validation

- **errors** (the app won't start and tells you which field is off):
  a server without a name, duplicate names, `servers` not being a list, or
  broken yaml syntax.
- **warnings** (shown in a dialog at startup, then the app carries on): an
  unknown `launch` or `connect_via` value (falls back to the default), a bad
  port or ipv4, or a server with neither a hostname nor an ipv4.

---

## 8. settings pane (`c`)

the pane shows where your config lives, whether tmux was found (and whether
you're inside it), and which terminal `launch: terminal` would use. it edits
everything under `defaults:`:

| field | what it means |
|---|---|
| default user / default key / default port | used for servers that leave these empty |
| connect via | `hostname` or `ipv4` |
| launch mode | `auto`, `tmux`, `inline`, `terminal` (see §6) |
| terminal cmd | template for terminal mode, with `{cmd}` |
| ssh options | extra ssh args, shell-quoted, e.g. `-o ServerAliveInterval=30 -o ConnectTimeout=5` |
| tmux prefix | session name prefix. no `.`, `:` or spaces. |
| hold on error | keep the window open after a failed ssh |
| sort column / dir | startup sort |

if you change the tmux prefix, live sessions made under the old prefix won't
get recognised anymore. kill them first, or detach and sort them out by hand
with `tmux ls`.

---

## 9. command-line use

```sh
shh                         # the UI
shh --list                  # print the server table (● = live session) and exit
shh --connect web-01        # connect/resume without the UI (counts like Enter)
shh --connect web-01 --ipv4 # same, via the IPv4 address
shh --config ~/work.yaml    # use another config file
shh --config-path           # print which config file is used
shh --help | --version
```

want separate server lists, like work and personal? just use separate files:
`alias work-ssh='shh --config ~/.config/shh/work.yaml'`.

---

## 10. troubleshooting

nothing here's scary; most of it's a quick fix.

| symptom | fix |
|---|---|
| title says `inline (no persistence)` | tmux wasn't found. install it and restart shh. |
| status: *"tmux session … ended before it could be attached"* | ssh exited right away. turn on *hold on error* to see why, or try `ssh -v <target>` in a shell. |
| enter opens a session but you can't get back | detach with `Ctrl+b d` (or your own tmux prefix + `d`). |
| ● is missing for a session you know exists | hit `r`. also check the session name matches `<prefix><name>` (`tmux ls`); anything other than `A-Z a-z 0-9 _ -` in the name turns into `_`. |
| *"No terminal emulator found"* | set *terminal cmd* in settings, e.g. `alacritty -e {cmd}`. |
| terminal mode does nothing on macos | allow automation in system settings → privacy & security → automation (your terminal → terminal). |
| `Could not load …: YAML syntax error` | fix the file; the message tells you the line. the app never touches your comments. |
| `Ctrl+S` does nothing in a form | some terminal setups grab `Ctrl+S` for flow control. just hit enter on the last field instead. |
| garbled screen after a crash | run `reset` in the terminal. |
| colours look off | use a terminal with true-colour support and `TERM=xterm-256color` (or similar). |
