# Glasswing

A desktop GUI for [rclone](https://rclone.org/). Run rclone jobs with a live progress dashboard, browse and preview, upload and download files and manage remotes, all in one place. Built with Electron; it wraps the `rclone` CLI you already have installed.


## Download

Grab the latest **Glasswing Setup x.exe** (installer) or **Glasswing x.exe** (portable) from the [Releases page](https://github.com/SSCHRE/rclone-gui-glasswing/releases).

## Features

### Jobs
- **Copy / sync / move**: run the common rclone operations from a simple form
- **Live progress dashboard**: percent complete, ETA, speed, transferred bytes, checks and errors
- **Activity feed**: recent file events parsed from rclone output, with a **raw log** toggle for full verbose output
- **Dry run**: preview changes without writing anything
- **Delete excluded**: optional `--delete-excluded` for sync jobs
- **Extra rclone flags**: append your own arguments (e.g. `--transfers 8 --filter "- *.tmp"`)
- **Saved jobs**: save, load, update and remove jobs for quick re-use
- **Stop job**: cancel a running transfer

### Browse
- **Remote browser**: navigate folders on any remote, sort by column, reload or cancel slow listings
- **Previews**: images (`.jpg`, `.png`), text, PDF, streamed audio/video (`.mp3`, `.mp4`) and archive contents (`.zip`, `.7z`), with previous/next navigation
- **Upload**: pick files or drag them onto the list, with progress, cancel, and a confirmation before replacing existing files
- **Download, new folder and delete** directly on the remote
- **Use as source / destination**: send the current path straight to the job form
- **Listing cache**: recently visited folders open instantly

### Remotes
- **Remote manager**: add remotes (including browser sign-in for OAuth providers), reconnect expired tokens, view a redacted config, and delete remotes
- **Quick insert remote**: drop `remote:path` into source or destination
- **Refresh remotes**: reload your rclone config with clear success/error feedback
- **rclone config wizard**: open the classic interactive `rclone config` in a terminal

Glasswing does **not** store or collect ANY credentials. It uses your existing rclone installation and config on the machine.

## Prerequisites

1. **[rclone](https://rclone.org/install/)** installed and available on your `PATH`
2. At least one remote configured (`rclone config` or the in-app remote manager), or local paths only
3. For development: **[Node.js](https://nodejs.org/)** 18+ and npm

Verify rclone works in a terminal:

```bash
rclone version
rclone listremotes
```

## Install & run (development)

```bash
git clone https://github.com/SSCHRE/rclone-gui-glasswing.git
cd rclone-gui-glasswing
npm install
npm start
```

## Build (Windows)

| Command | Output in `dist/` |
|---------|-------------------|
| `npm run build` | Portable `.exe` **and** NSIS installer |
| `npm run build:portable` | Portable `.exe` only |
| `npm run build:installer` | NSIS installer only |
| `npm run build:dir` | Unpacked app (`dist/win-unpacked`) for quick testing |

Icons are regenerated automatically before `npm run build` (`npm run icons`).

CI builds the portable app and installer on every push to `main`; download them from the workflow run’s artifacts.

### Path examples

| Type | Example |
|------|---------|
| Local (Windows) | `C:\Users\you\Documents\backup` |
| Remote | `gdrive:Photos/2024` |
| Remote + path | Pick `gdrive` + `Photos/2024` via quick insert |

The **Browse** buttons next to source/destination open a folder picker for local directories only. Use the **Browse** tab to explore remote contents.

## How it works

Glasswing spawns `rclone` as a child process. Jobs run with:

- `--stats 1s --stats-one-line --stats-one-line-date --verbose`

Job output is parsed into the dashboard. Audio and video previews are streamed through a temporary `rclone serve http` bound to `127.0.0.1`.

Your rclone config is read the same way the CLI does, typically:

| OS | Config location |
|----|-----------------|
| Windows | `%APPDATA%\rclone\rclone.conf` |
| macOS | `~/.config/rclone/rclone.conf` |
| Linux | `~/.config/rclone/rclone.conf` |

Saved jobs are stored in `job-history.json` in the app’s data folder (`%APPDATA%\rclone-glasswing-gui` on Windows).

Never commit `rclone.conf` or copy it into this repository or any forked repositories; it may contain OAuth tokens and storage keys.

## Roadmap
- [x] Saved jobs
- [x] Custom rclone arguments
- [x] Remote management UI
- [x] Browse remotes
- [x] File previews
- [x] Upload to remotes
- [x] Update check
- [x] Mount a remote
- [x] Drag and drop upload
- [ ] Scheduled jobs (in progress)
- [ ] macOS build (`.dmg` / `.app`)
- [ ] Linux build (AppImage / `.deb`)

## Screenshots
![App Screenshot](https://i.ibb.co/tPwg0PsH/Screenshot-2026-07-20-032851.png)
![App Screenshot2](https://i.ibb.co/gbSwX4RH/electron-lt-Ori2-HGPQ.png)

## License

MIT

## Acknowledgements

- [rclone](https://rclone.org/): the engine behind the transfers
- [Electron](https://www.electronjs.org/): desktop shell
