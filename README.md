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

Install Node.js 24 or later, then install the published CLI:

```sh
npm install --global audio-sprite
```

For development from a repository checkout, install dependencies with `npm ci`.

On macOS or Windows, install or update FFmpeg and ffprobe:

```sh
audio-sprite-setup
```

Setup runs only when requested; npm installation never installs system packages.
From a repository checkout, use `npm run setup:ffmpeg` instead.

### macOS

```sh
audio-sprite-setup
export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
```

Setup installs [Homebrew](https://brew.sh/) if needed and installs or updates
`ffmpeg-full`. Run the `export PATH` command in the same terminal as conversion;
add it to your shell profile to retain the setting in new terminals.

### Windows

```powershell
audio-sprite-setup
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

Run from the directory containing your inputs, or pass absolute paths:

```sh
audio-sprite "./input/intro.mp3" "./input/click.flac" "./input/video.mp4"
```

Select a directory:

```sh
audio-sprite "./input"
```

Or combine files and directories:

```sh
audio-sprite "./input/intro.mp3" "./effects"
```

From a repository checkout, use `npm start -- <paths> [options]`, or invoke
Node.js directly:

```sh
node scripts/audio-convert.js "./input"
```

### Options

```sh
audio-sprite "./input" --output "mp3:192k:stereo,ogg:96k:mono" --output-dir "./dist/audio" --output-name "ui-sounds"
```

| Option          | Default           | Behavior                                                      |
| --------------- | ----------------- | ------------------------------------------------------------- |
| `--output`      | `mp3,m4a,ogg,ac3` | Select comma-separated `format:bitrate:channels` entries.     |
| `--output-dir`  | `./`              | Create the results directory, including missing parents.      |
| `--output-name` | `merged`          | Set the shared audio and JSON basename, without an extension. |

`--output` replaces the format list; omitted bitrate and channels default to
`128k` and `stereo`. Use `mono` for one channel, for example `mp3::mono`.
Bitrates are positive integers followed by `k`, subject to encoder limits.
Options accept both `--option value` and `--option=value`, before or after inputs.

The example creates `ui-sounds.mp3`, `ui-sounds.ogg`, and `ui-sounds.json` in
`dist/audio`. JSON URLs use the supplied directory prefix relative to the working
directory, not the JSON file's location. Matching output files are replaced;
unselected formats are left untouched.

## Testing

```sh
npm test
npm run test:unit
npm run test:integration
npm run test:coverage
```

Tests use Node.js's built-in test runner. The full suite and coverage report
require FFmpeg and ffprobe on `PATH`, with encoders for all supported output
formats. Unit tests run without media tools; installer tests use controlled
commands and never change system packages. Integration tests generate synthetic
media in temporary directories and verify the complete conversion pipeline.

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
