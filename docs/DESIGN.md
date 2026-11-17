# Design notes

## Session persistence: tmux registry, not lockfiles

**Question from the brief:** should resumable sessions use lockfiles, or should
persistence be dropped when tmux isn't available?

**Decision:** use tmux's own session list as the only source of truth. Keep no
lockfiles or state of our own. Without tmux, run ssh inline and **drop
persistence**.

Why lockfiles cannot provide "resume":

- An interactive ssh session is a process attached to a **pseudo-terminal
  owned by the terminal that started it**. When that terminal or the TUI exits,
  the kernel sends SIGHUP and ssh dies. A lockfile can record *that* a
  session existed, but nothing remains to reattach to. "Resume" requires a
  process that owns the pty independently of any terminal window. That is
  exactly what a terminal multiplexer (tmux, screen, dtach/abduco) is.
- Lockfiles also go stale (crash, reboot, `kill -9`) and need PID checks, a
  cleanup policy and handling for races between two shh instances. tmux
  already answers "is session X alive?" atomically (`tmux has-session -t =X`).

So:

| tmux available | Behaviour |
|---|---|
| yes | `ssh-<name>` tmux session per server. Enter = `has-session` → attach/switch, or `new-session -d` + attach. Live sessions show ● (from `tmux list-sessions`, polled every 5 s and on terminal focus). |
| no | ssh runs inline in the TUI's terminal (TUI suspended). Nothing to resume, and the UI says `inline (no persistence)`. |

Byobu runs on tmux, so it is covered. GNU screen / dtach are not supported
yet. The `Tmux` adapter is the single place where another backend would plug in.

Details worth knowing:

- Exact-match targets (`-t =name`) avoid tmux's prefix matching
  (`ssh-web` must not match `ssh-web-01`).
- Session names are sanitised to `[A-Za-z0-9_-]`, because tmux treats `.` and `:` as
  target separators.
- Inside tmux, the app uses `switch-client` instead of nesting an attach.
- `hold_on_error` wraps ssh in `sh -c '…; read'` so a failed connection stays
  readable instead of the window disappearing.

## Terminal hand-off

OpenTUI's `renderer.suspend()` / `resume()` give the real terminal to a child
process (`ssh` or `tmux attach`) with inherited stdio, then restore the
alternate screen, raw mode and the render loop afterwards.

## Config file

- YAML is edited through the `yaml` package's `Document` model, so user
  comments and key order survive app edits. Servers are matched by name, so
  comments attached to untouched entries stay in place.
- Writes are atomic (temp file + rename) with mode 0600.
- Validation is split into fatal errors (with the YAML path) and warnings
  (value coerced, app continues).
- Key files: only paths are stored and passed to `ssh -i`. The app never opens
  them.

## Code layout

```
src/
  main.ts            entry: CLI flags, config load, renderer + App
  cli.ts             argument parsing
  config/            types, schema (validation), paths (XDG), store (YAML I/O)
  session/           per-protocol argv builders (ssh, telnet, rdp), client detection,
                     password staging (secrets.ts), tmux adapter, terminal detection, launcher
  ui/                App (state, keys, rendering), table model, modal/form, dialogs, panes
  util/shell.ts      quoting/splitting + ProcessRunner (injectable for tests)
tests/               unit tests + headless UI tests (@opentui/core/testing)
```

All process execution goes through `ProcessRunner`, so the launcher and the
whole UI are tested with a fake runner that simulates tmux.

## Testing

- `bun test`: 55 tests (config, ssh/tmux/launcher, table model, and a full
  headless UI driven by mock key presses against a real temp config file).
- `bun run typecheck`: strict TypeScript.
- Manually verified on Linux in a real pty: start/quit, the starter config
  being created, the inline and tmux connect flows, the hold-on-error prompt,
  and the compiled single binary.
