# sshtui

A keyboard-driven terminal UI for your SSH servers, built with
[OpenTUI](https://opentui.com) and Bun.

- **One YAML file** for all servers: name, hostname, IPv4, user, key *path*,
  port, description, tags, and a connection counter.
- **Sortable table**: digits `1`–`9` sort by column (press again to reverse),
  `/` filters live, and the hotkeys are always visible at the bottom.
- **Resumable sessions**: with tmux, each server gets its own tmux session.
  Detach, quit, or close the terminal, and Enter resumes it later. Live sessions
  are marked ●. Without tmux, ssh runs inline.
- **New-window mode**: open sessions in your terminal emulator instead
  (tmux-backed when available).
- **Settings pane** for defaults: user, key, port, launch mode, ssh options and more.
- **Keys are never read**: only their paths are stored and passed to `ssh -i`.
- Edits from the app **keep your YAML comments**.

![Main table](docs/screenshots/01-main-table.png)

More: [filter & sort](docs/screenshots/02-sorted-filtered.png) ·
[edit form](docs/screenshots/03-edit-server.png) ·
[validation](docs/screenshots/04-add-validation.png) ·
[settings](docs/screenshots/05-settings.png) ·
[help](docs/screenshots/06-help.png) ·
[kill session](docs/screenshots/07-kill-confirm.png) ·
[narrow / inline](docs/screenshots/08-narrow-inline.png)

## Quick start

```sh
# needs Bun ≥ 1.3.14 (https://bun.sh) and ssh; tmux recommended
bun install
bun run start            # first run creates ~/.config/sshtui/config.yaml
```

Press `?` in the app for the keys. Full documentation:
**[docs/USER_GUIDE.md](docs/USER_GUIDE.md)**. Design decisions (why tmux and not
lockfiles): [docs/DESIGN.md](docs/DESIGN.md).

## Install as a command

```sh
bun link                 # runs from source; needs Bun
# or a standalone binary (build on the target OS/CPU):
bun run build && install -m 755 dist/sshtui ~/.local/bin/sshtui
```

## Development

```sh
bun run dev        # watch mode
bun test           # unit + headless UI tests
bun run typecheck
bun run check      # both
```

See `config.example.yaml` for every config option.

License: MIT
