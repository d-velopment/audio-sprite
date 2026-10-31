# Audio-Sprite

[![npm version](https://img.shields.io/npm/v/audio-sprite?style=flat-square&color=2563eb)](https://www.npmjs.com/package/audio-sprite)
[![Node.js](https://img.shields.io/badge/Node.js-CLI-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-powered-007808?style=flat-square&logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![JSON sprite map](https://img.shields.io/badge/JSON-sprite%20map-0f766e?style=flat-square&logo=json&logoColor=white)](#usage)
[![License](https://img.shields.io/badge/license-MIT-f59e0b?style=flat-square)](./LICENSE)

**Audio-Sprite** is a <code>Node.js</code> command-line tool that combines audio
from multiple media files into a single **audio sprite** with a <code>JSON</code>
map of clip names, start times, and durations. It uses <code>FFmpeg</code> and
<code>ffprobe</code> to detect and decode supported audio and video formats,
normalize their audio streams, and join clips with silence between them.

Inputs can be individual **files**, **directories**, or a combination of both, while
<code>--output</code> controls formats, bitrates, and <code>mono</code> or
<code>stereo</code> channels; <code>--output-dir</code> and
<code>--output-name</code> set the destination directory and shared output
filename. The script preserves original files, cleans up temporary intermediates,
and produces formatted <code>JSON</code> alongside the encoded audio files for use
in applications and games.

## Installation

Install Node.js and npm, then install project dependencies:

```sh
npm ci
```

On macOS or Windows, install or update FFmpeg and ffprobe:

```sh
npm run setup:ffmpeg
```

Setup runs only when requested; `npm ci` and `npm start` do not install system packages.

### macOS

```sh
npm run setup:ffmpeg
export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
```

Setup installs [Homebrew](https://brew.sh/) if needed and installs or updates
`ffmpeg-full`. Run the `export PATH` command in the same terminal as conversion;
add it to your shell profile to retain the setting in new terminals.

### Windows

```powershell
npm run setup:ffmpeg
```

Setup uses [WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/)
to install or update `Gyan.FFmpeg`. If WinGet is unavailable, install or update
Microsoft's App Installer first. Reopen PowerShell or Command Prompt after setup
to receive the updated `PATH`.

### Verification and other platforms

```sh
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -encoders
```

Both tools must be available on `PATH`, and the selected FFmpeg build must provide
the encoders needed for your output formats. Conversion checks them before
processing inputs. On Linux and other platforms, install both tools through your
package manager or the [FFmpeg downloads page](https://ffmpeg.org/download.html).

## Usage

Run from the project root with one or more media files:

```sh
npm start -- "./input/intro.mp3" "./input/click.flac" "./input/video.mp4"
```

Select a directory:

```sh
npm start -- "./input"
```

Or combine files and directories:

```sh
npm start -- "./input/intro.mp3" "./effects"
```

The `--` after `npm start` forwards arguments to the script. Direct Node.js
invocation needs no separator.

```sh
node scripts/audio-convert.js "./input"
```

### Options

```sh
npm start -- "./input" --output "mp3:192k:stereo,ogg:96k:mono" --output-dir "./dist/audio" --output-name "ui-sounds"
```

| Option | Default | Behavior |
| --- | --- | --- |
| `--output` | `mp3,m4a,ogg,ac3` | Select comma-separated `format:bitrate:channels` entries. |
| `--output-dir` | `./` | Create the results directory, including missing parents. |
| `--output-name` | `merged` | Set the shared audio and JSON basename, without an extension. |

`--output` replaces the format list; omitted bitrate and channels default to
`128k` and `stereo`. Use `mono` for one channel, for example `mp3::mono`.
Bitrates are positive integers followed by `k`, subject to encoder limits.
Options accept both `--option value` and `--option=value`, before or after inputs.

The example creates `ui-sounds.mp3`, `ui-sounds.ogg`, and `ui-sounds.json` in
`dist/audio`. JSON URLs use the supplied directory prefix relative to the working
directory, not the JSON file's location. Matching output files are replaced;
unselected formats are left untouched.

## License

Audio-Sprite is released under the [MIT License](./LICENSE).

---

<p align="center">
  <sub>
    Maintained by <a href="https://github.com/d-velopment">D-Velopment</a>
    · <a href="https://github.com/d-velopment/audio-sprite">GitHub</a>
    · <a href="#audio-sprite">Back to top</a>
  </sub>
</p>
