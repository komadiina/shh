# design notes

## session persistence: tmux registry, not lockfiles

**the question from the brief:** should resumable sessions use lockfiles, or
should we just drop persistence when tmux isn't around?

**what we went with:** tmux's own session list is the only source of truth.
we keep no lockfiles and no state of our own. no tmux? ssh runs inline and
**persistence just isn't a thing**. that's fine.

why lockfiles can't really do "resume":

- an interactive ssh session is a process hooked up to a **pseudo-terminal
  owned by whatever terminal started it**. when that terminal or the tui goes
  away, the kernel sends SIGHUP and ssh dies. a lockfile can remember *that* a
  session existed; there's just nothing left to reattach to. "resume" needs a
  process that owns the pty on its own, separate from any terminal window.
  that's literally what a terminal multiplexer is (tmux, screen, dtach/abduco).
- lockfiles also go stale (crash, reboot, `kill -9`). then you need pid checks,
  a cleanup policy and race handling between two shh instances. tmux already
  answers "is session X alive?" atomically (`tmux has-session -t =X`), so why bother.

so here's how it plays out:

| tmux available | behaviour |
|---|---|
| yes | one `ssh-<name>` tmux session per server. enter = `has-session` → attach/switch, or `new-session -d` + attach. live sessions get a ● (from `tmux list-sessions`, polled every 5 s and on terminal focus). |
| no | ssh runs inline in the tui's terminal (tui gets suspended). nothing to resume; the ui says `inline (no persistence)`. |

byobu runs on tmux, so it's covered too. gnu screen and dtach aren't supported
yet. if someone wants another backend, the `Tmux` adapter is the one spot it'd plug into.

little details worth knowing:

- exact-match targets (`-t =name`) dodge tmux's prefix matching;
  `ssh-web` shouldn't accidentally match `ssh-web-01`.
- session names get sanitised to `[A-Za-z0-9_-]`; tmux treats `.` and `:` as
  target separators.
- inside tmux, the app uses `switch-client` instead of nesting an attach.
- `hold_on_error` wraps ssh in `sh -c '…; read'` so a failed connection sticks
  around long enough to read, instead of the window just vanishing.

## terminal hand-off

opentui's `renderer.suspend()` / `resume()` hand the real terminal over to a
child process (`ssh` or `tmux attach`) with inherited stdio. afterwards they
bring back the alternate screen, raw mode and the render loop.

## config file

- yaml gets edited through the `yaml` package's `Document` model, so your
  comments and key order survive app edits. servers are matched by name;
  comments on entries you didn't touch stay put.
- writes are atomic (temp file + rename) with mode 0600.
- validation comes in two flavours: fatal errors (with the yaml path) and
  warnings (value gets coerced, app keeps going).
- key files: only paths are stored and passed to `ssh -i`. the app never opens
  them.

## code layout

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

every process call goes through `ProcessRunner`. that means the launcher and
the whole ui get tested with a fake runner that pretends to be tmux.

## testing

- `bun test`: 55 tests (config, ssh/tmux/launcher, table model, plus a full
  headless ui driven by fake key presses against a real temp config file).
- `bun run typecheck`: strict typescript.
- checked by hand on linux in a real pty: start/quit, the starter config
  getting created, the inline and tmux connect flows, the hold-on-error prompt,
  and the compiled single binary. all good.
