# Stream Grabber

[Русская версия](README.ru.md)

A Chrome / Chromium extension that detects the video you are **actually watching** (HLS `.m3u8` and plain MP4/WebM) and downloads it into a per-series folder — with a queue, quality selection and no artificial limits.

## Features

- **Only what is played** – streams are listed when the player really requests segments / starts playback, not when a playlist merely appears on the page. YouTube is ignored by default.
- **Preview, title and episode number** – a frame from the video, the series title (cleaned from the page title) and the episode number taken from the page.
- **History + “Download all”** – every episode you played is kept in the popup, sorted by episode number; tick what you want and download everything in one click. Duplicates of the same episode (new token in the URL, another quality) are merged automatically.
- **Quality choice** – quality variants from the master playlist; for players that expose one playlist per quality (`…/720/index.m3u8`, `720.mp4:hls:…`) the other qualities are discovered automatically. The best one is selected by default (HEVC wins ties).
- **Queue page** – one folder per series (`Series/Series - 05.ts`), episodes in order (first on top), an adaptive thumbnail grid: you choose how many episodes fit in a row (default 12, up to 200), rows are created automatically (48 episodes × 12 = 4 rows) and the thumbnails shrink to fit without horizontal overflow. Click a tile for details, retry, cancel.
- **Reliable episode numbers** – priority: the player itself → the page / episode list → own per-series counter (previous + 1). The result is stored per series *and voice-over*, so reloads and page changes never shift the queue; different series never affect each other.
- **Kodik voice-overs** – every voice-over is a separate stream, so the list shows only the voice-over selected in the player (switchable in the popup). **Collect all episodes** flips the real player through the episodes of *that* voice-over (range selectable), reports missing / failed episodes and never substitutes another voice-over; duplicates are not queued twice.
- **Fast & unlimited** – parallel segment download, AES-128 decryption, data is streamed straight to disk (no huge blobs in memory).
- **Settings** – language (English / Русский), download folder, file-name template, parallelism, ignored sites, short-video threshold.
- **On/off switch** in the popup and a hotkey (`Alt+Shift+D`).

## Install

1. Download the repository (or a release zip) and unpack it.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the **`extension`** folder.
4. Open ⚙️ Settings → choose the download folder (create e.g. `D:\Anime`; Chrome does not allow picking *Downloads* / *Documents* themselves).

## Usage

1. Open an episode and start playback.
2. Click the extension icon. The episode appears with a preview, title, episode number and quality list.
3. Press **Download** (one episode) or **Download all** (all ticked rows).
4. Keep the queue tab open while it downloads.

Popup buttons: 🧲 show everything that was found (not only played) · ⬇️ open the queue · 🗑️ clear the list · ⚙️ settings.

## Output format & HEVC

HLS streams are saved as **`.ts`** (or `.mp4` for fragmented-MP4 streams). That is the original data without re-encoding, so it is fast and lossless.
Re-encoding to HEVC inside a browser is impractical, so the extension drops a small **`Convert-to-HEVC.bat`** into your download folder: it converts every `.ts` to HEVC `.mp4` using `ffmpeg` (NVIDIA GPU if available, otherwise `libx265`). `ffmpeg` must be in your `PATH`. Switch this off in Settings.

## Kodik: how “collect all episodes” works

Kodik signs and obfuscates its stream requests and decodes them with the player's own JavaScript, so the extension does **not** re-implement that API. Instead the content script switches episodes in the real player (episode select → documented `/serial/<id>/<hash>/720p/<N>` URL → “Next” button), and the normal detection captures each stream. The voice-over is read from the player and checked after every switch. If the layout of the player changes, press **Diagnostics** in the popup: it copies what the extension sees (selects, options, top-bar texts) for a bug report.

## Limitations

- DRM-protected streams (Widevine, FairPlay, SAMPLE-AES) are **not supported and are not circumvented**.
- HLS with a separate audio rendition is downloaded without sound (a warning is shown).
- Collecting all episodes needs the Kodik tab to stay open (the player flips through the episodes, muted, ~3–5 s per episode).
- Episode numbers from the page are heuristic — they are always editable.
- The queue page has to stay open while downloading (it does the work); after a browser restart Chrome asks once to re-confirm access to the folder.

## How it works

`webRequest` (observe-only) recognises playlists/media; a content script reports `playing` events and takes a thumbnail; playlists are parsed (master / media, AES-128, fMP4 init segments) and fingerprinted to merge duplicates; the queue page streams segments into files with the File System Access API. No remote code, no external services.

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest` + `<all_urls>` | notice playlists / segments (read-only, nothing is blocked or modified) |
| `declarativeNetRequest` | set the `Referer`/`Origin` of download requests to the page that was playing the video |
| `tabs` | find the active tab and the queue tab |
| `storage` | settings, queue, play history |

See [PRIVACY.md](PRIVACY.md). Use the extension only for content you have the right to save.

## Development

No build step — plain JavaScript (Manifest V3). Edit files in `extension/` and press *Reload* on `chrome://extensions`.
Translations live in `extension/i18n.js`; manifest strings in `extension/_locales/`.

## AI-Assisted Development

This project was developed with the assistance of AI tools, including:

- Anthropic Claude
- OpenAI ChatGPT
- Other AI-powered development tools

AI was used for code generation, debugging, optimization, research, and feature development.

All generated code and suggestions were reviewed, tested, and integrated into the project by the maintainer.

## License

MIT — see [LICENSE](LICENSE).
