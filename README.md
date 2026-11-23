# Glasswing

A desktop GUI for [rclone](https://rclone.org/). Run rclone jobs with a live progress dashboard, browse and preview, upload and download files and manage remotes, all in one place. Built with Electron; it wraps the `rclone` CLI you already have installed.


## Download

Grab the latest release from the [Releases page](https://github.com/SSCHRE/rclone-gui-glasswing/releases). Every file has the OS in its name: **Windows-Setup** (installer) or **Windows-Portable** on Windows, an **AppImage** or **.deb** on Linux, and a **.dmg** on macOS (`arm64` for Apple Silicon, `x64` for Intel). The release notes have a little table too if you're not sure which one you need.

### First launch on macOS

The Mac build isn't signed yet (no Apple developer account), so macOS will say the app is damaged or can't be checked for malware. It's not actually damaged. Either right-click the app and pick **Open**, or run this once:

```bash
xattr -dr com.apple.quarantine /Applications/Glasswing.app
```

Self update doesn't work on the Mac build for now, new versions have to be downloaded from the releases page.

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
- **Schedule jobs**: Schedule saved jobs to be run at specific times
- **Run history**: every run is logged, click one to see the details (speed, files, errors, log)
- **Cloud migration**: move a whole cloud to another one. It checks size and free space first, keeps going in the background (or only at night) over as many days as it needs, handles stuff like Google Drive's 750 GB/day limit, checks every file at the end and can delete the originals once they're verified

### Browse
- **Remote browser**: navigate folders on any remote, sort by column, reload or cancel slow listings
- **Previews**: images (`.jpg`, `.png`), text, PDF, streamed audio/video (`.mp3`, `.mp4`) and archive contents (`.zip`, `.7z`), with previous/next navigation
- **Upload**: pick files or drag them onto the list, with progress, cancel, and a confirmation before replacing existing files
- **Download, new folder, rename and delete** directly on the remote
- **Multi select**: ctrl/shift click or just drag a box around files like in Explorer
- **Split screen**: two remotes side by side (`Ctrl+\`), copy or move stuff between them with the buttons, right click menu or drag and drop (hold Shift to move)
- **Use as source / destination**: send the current path straight to the job form
- **Listing cache**: recently visited folders open instantly
- **Searching**: Search for files or folders in your rclone remote

### Remotes
- **Remote manager**: add remotes (including browser sign-in for OAuth providers), reconnect expired tokens, view a redacted config, and delete remotes
- **Expired sign-in check**: a quiet background check a few seconds after startup flags OAuth remotes that need a new sign-in, with a one click Reconnect (toggle it in the Appearance menu)
- **Quick insert remote**: drop `remote:path` into source or destination
- **Refresh remotes**: reload your rclone config with clear success/error feedback
- **rclone config wizard**: open the classic interactive `rclone config` in a terminal
- **Remote mounting**: mount a remote as a drive on Windows (needs WinFsp) or as a folder on Linux (needs FUSE) and macOS (no extra install with the official rclone, otherwise macFUSE)
- **Serve a remote**: share a remote (or a folder in it) over HTTP, WebDAV, FTP or SFTP, just on your pc or to other devices on your network
- **Storage overview**: Monitor your remote space/usage in 1 simple view
- **Vault wizard**: Create an rclone crypt vault in the Remote manager

### Other
- **Rclone self update**: a dot shows up next to the rclone version when a newer one is out, click it to update rclone without leaving the app
- **Self update**: Glasswing can update itself from inside the app (installer, portable exe, AppImage and .deb). On Linux the .deb asks for your password to install.
- **Bandwidth limit**: Set a bandwidth limit. Permanently or between specific hours.
- **Themes**: the default glass theme, Bootstrap, Pico or Catppuccin (follows your system's light/dark mode)
- **Custom title bar** on Windows, can be turned off under Appearance if you prefer the normal one

Glasswing does **not** store or collect ANY credentials. It uses your existing rclone installation and config on the machine.

## Prerequisites

1. **[rclone](https://rclone.org/install/)** installed and available on your `PATH`
2. At least one remote configured (`rclone config` or the in-app remote manager), or local paths only
3. Only if you want to mount remotes: **WinFsp** on Windows, **fuse3** on Linux (`sudo apt install fuse3`). On macOS the official rclone from rclone.org mounts without anything extra; the Homebrew one can't mount, so use the official one or install **macFUSE**
4. For development: **[Node.js](https://nodejs.org/)** 18+ and npm

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

## Build (macOS)

On a Mac:

```bash
npm install
npm run build:mac
```

You get a `.dmg` and a `.zip` for both Apple Silicon (`arm64`) and Intel (`x64`) in `dist/`. They're ad-hoc signed only, not notarized.

### Releasing

For maintainers:

1. Bump `version` in `package.json`
2. Merge/push to `main`
3. CI builds Windows, Linux + macOS and makes a new release `vX.Y.Z` with everything attached (notes get generated from the PRs, edit them after if you want)

If that version already has a release, CI just builds and skips the release, so pushes without a version bump don't do anything weird.

The update files (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`) get attached too, that's what the in-app updater reads. Download counts on the release show installs + updates per version.

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
- [x] Scheduled jobs
- [x] Linux build (AppImage / `.deb`)
- [x] Sync preview
- [x] Run/job history
- [x] Rclone serve
- [x] Search remote
- [x] Cloud migration wizard
- [x] Rclone self update
- [x] Self updater
- [x] Split screen browse
- [x] macOS build (`.dmg` / `.app`)
## Screenshots
![App Screenshot](https://sschre.github.io/rclone-gui-glasswing/assets/screenshots/jobs.jpg)
![App Screenshot2](https://sschre.github.io/rclone-gui-glasswing/assets/screenshots/browse.jpg)
![App Screenshot3](https://sschre.github.io/rclone-gui-glasswing/assets/screenshots/storage.jpg)
![App Screenshot4](https://sschre.github.io/rclone-gui-glasswing/assets/screenshots/vault.jpg)

## License

MIT

## Acknowledgements

- [rclone](https://rclone.org/): the engine behind the transfers
- [Electron](https://www.electronjs.org/): desktop shell
