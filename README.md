# Glasswing (`rclone-gui-glasswing`)

A desktop Rclone GUI for **copy**, **sync**, and **move** jobs — with a live progress dashboard, dry-run support, and a clean glass-style UI. Built with Electron; wraps the `rclone` CLI you already have configured.

> **Status:** v1.0.0 — Windows portable builds are supported today. macOS and Linux builds are planned.

## Features

- **Copy / sync / move** — run common rclone operations from a simple form
- **Remote picker** — load configured remotes and insert them into source or destination
- **Dry run** — preview changes without writing anything
- **Delete excluded** — optional `--delete-excluded` flag for sync jobs
- **Live progress dashboard** — percent complete, ETA, speed, transferred bytes, checks, and errors
- **Activity feed** — recent file events parsed from rclone output
- **Raw log toggle** — switch to verbose output when you need the details
- **Stop job** — cancel a running transfer
- **Refresh remotes** — reload your rclone config with clear success/error feedback
- **Save jobs** - Save a job for quick re-use later on

Glasswing does **not** store cloud credentials. It uses your existing rclone installation and config on the machine.

## Prerequisites

1. **[rclone](https://rclone.org/install/)** installed and available on your `PATH`
2. At least one remote configured (`rclone config`) — or local paths only
3. For development: **[Node.js](https://nodejs.org/)** 18+ and npm

Verify rclone works in a terminal:

```bash
rclone version
rclone listremotes
```

## Install & run (development)

```bash
git clone https://github.com/YOUR_USERNAME/rclone-gui-glasswing.git
cd rclone-gui-glasswing
npm install
npm start
```

### npm 11+ / Electron postinstall

If `npm install` blocks Electron’s postinstall script, approve it once:

```bash
npm approve-scripts electron
npm install
```

## Build (Windows portable)

```bash
npm run build
```

The portable executable is written to `dist/`.

## Usage

1. Launch the app (`npm start` or the built executable).
2. Choose an **operation** — copy, sync, or move.
3. Set **source** and **destination** — local paths (`C:\folder`, `/home/user/folder`) or remotes (`myremote:path`).
4. Optionally use **Quick insert remote** to pick a configured remote and path.
5. Enable **Dry run** to test first; for sync, **Delete excluded** maps to rclone’s `--delete-excluded`.
6. Click **Run job** and watch the progress panel.
7. Use **Stop** to cancel, or **Show raw log** for full verbose output.

### Path examples

| Type | Example |
|------|---------|
| Local (Windows) | `C:\Users\you\Documents\backup` |
| Local (macOS/Linux) | `/home/you/Documents/backup` |
| Remote | `gdrive:Photos/2024` |
| Remote + path | Pick `gdrive` + `Photos/2024` via quick insert |

**Browse** opens a folder picker for local directories only. Remote paths must be typed or inserted from the remote picker.

## How it works

Glasswing spawns `rclone` as a child process with:

- `--stats 1s --stats-one-line --stats-one-line-date --verbose`

Job output is parsed into the dashboard (progress bar, stat cards, activity feed). Your rclone config is read the same way the CLI does — typically:

| OS | Config location |
|----|-----------------|
| Windows | `%APPDATA%\rclone\rclone.conf` |
| macOS | `~/.config/rclone/rclone.conf` |
| Linux | `~/.config/rclone/rclone.conf` |

Never commit `rclone.conf` or copy it into this repository; it may contain OAuth tokens and storage keys.

## Project structure

```
rclone-gui-glasswing/
├── electron/
│   ├── main.js       # Window, IPC, rclone process management
│   └── preload.js    # Secure bridge to renderer
├── src/
│   ├── index.html    # UI layout
│   ├── styles.css    # Theme and layout
│   ├── renderer.js   # Form, job controls, remotes
│   └── job-output.js # Stats parsing and progress dashboard
├── package.json
└── README.md
```

## Roadmap
- [x] Job history
- [ ] Remote management UI
- [ ] macOS build (`.dmg` / `.app`)
- [ ] Linux build (AppImage / `.deb`)



# Screenshots
![App Screenshot](https://i.ibb.co/tPwg0PsH/Screenshot-2026-07-20-032851.png)
![App Screenshot2](https://i.ibb.co/gbSwX4RH/electron-lt-Ori2-HGPQ.png)

# Troubleshooting

**“Checking rclone…” never resolves**

- Ensure `rclone` is on your `PATH` in the same environment the app runs from.
- Run `rclone version` in a terminal to confirm.

**No remotes in the picker**

- Configure remotes with `rclone config`, then click **Refresh remotes**.

**Job fails immediately**

- Check source/destination syntax (`remote:path` with no leading slash on the remote name).
- Try the same paths with `rclone copy source dest --dry-run -v` in a terminal.

**npm install issues on Windows**

- Use `npm approve-scripts electron` if postinstall is blocked (npm 11+).

## License

MIT

## Acknowledgements

- [rclone](https://rclone.org/) — the engine behind the transfers
- [Electron](https://www.electronjs.org/) — desktop shell
