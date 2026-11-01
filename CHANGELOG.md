# Changelog

Changes are recorded by version, newest first. Each entry describes changes since
the previous release.

## [1.0.7]

### Maintenance

- Release through GitHub Actions to validate npm Trusted Publishing. Runtime
  behavior is unchanged from version 1.0.6.

### Fixed

- Package installation tests now verify setup behavior for macOS, Windows, and
  Linux independently of the host platform. Linux correctly rejects automatic
  FFmpeg setup without running installer commands, allowing release checks to
  complete on the Ubuntu runner.

## [1.0.6]

First version documented in this changelog; no earlier release history is recorded.

### Added

- Audio sprite generation from individual files or folders, including audio streams
  from video files supported by FFmpeg.
- WAV normalization, silence between clips, and a readable JSON timing map.
- Configurable output formats, bitrates, mono/stereo channels, output directory,
  and file name. Supported output formats are MP3, M4A, OGG, and AC3.
- Explicit FFmpeg setup commands for macOS and Windows.
- Installable `audio-sprite` and `audio-sprite-setup` CLI commands.
- Unit, integration, and package installation tests, with coverage reporting.
- Automated npm publication when a GitHub Release is published, with version,
  changelog, package, and test checks before publication.

### Changed

- The npm package uses the scoped name `@d-velopment/audio-sprite`.
- Removed the unused `fs` dependency; runtime code uses Node.js built-in modules.

### Fixed

- Input validation and metadata errors now fail with actionable messages before
  sprite generation.
- Encoder availability is checked before conversion, and temporary files are
  cleaned up after successful or failed processing.
