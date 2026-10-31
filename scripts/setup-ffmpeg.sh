#!/bin/bash
# Install or update FFmpeg and ffprobe through Homebrew's ffmpeg-full on macOS.
# Install Homebrew from its official installer when missing, preserve its interactive
# prompts, and verify both binaries before reporting success. This script runs
# only when requested and does not edit shell profiles or install npm packages.

set -euo pipefail

installer_path=""

# ----------------------------------------------------------------- Homebrew discovery and temporary files

# Find Homebrew on PATH or in a standard macOS installation directory.
find_homebrew() {
  local brew_path
  brew_path="$(command -v brew || true)"

  if [[ -n "$brew_path" ]]; then
    printf '%s\n' "$brew_path"
    return 0
  fi

  for brew_path in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$brew_path" ]]; then
      printf '%s\n' "$brew_path"
      return 0
    fi
  done

  return 1
}

# Remove the downloaded installer on success, failure, or interruption.
cleanup_installer() {
  if [[ -n "$installer_path" ]]; then
    rm -f "$installer_path"
  fi
}

# ----------------------------------------------------------------- Explicit system dependency setup

# Bootstrap Homebrew if needed, update FFmpeg, and verify its executables.
main() {
  local brew_path ffmpeg_prefix tool tool_version

  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf '%s\n' 'This setup command supports macOS only. Install FFmpeg and ffprobe using your system package manager.' >&2
    return 1
  fi

  brew_path="$(find_homebrew || true)"

  if [[ -z "$brew_path" ]]; then
    printf '%s\n' 'Homebrew was not found. Starting its official installer; it may request confirmation and your administrator password.'
    installer_path="$(mktemp "${TMPDIR:-/tmp}/audio-sprite-homebrew.XXXXXX")"
    curl --fail --show-error --silent --location \
      https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
      --output "$installer_path"
    /bin/bash "$installer_path"
    brew_path="$(find_homebrew || true)"

    if [[ -z "$brew_path" ]]; then
      printf '%s\n' 'Homebrew is still unavailable. Follow the installer instructions, then rerun npm run setup:ffmpeg.' >&2
      return 1
    fi
  fi

  printf 'Updating Homebrew using %s\n' "$brew_path"
  "$brew_path" update

  if "$brew_path" list --formula --versions ffmpeg-full >/dev/null 2>&1; then
    printf '%s\n' 'Updating ffmpeg-full and its required dependencies.'
    "$brew_path" upgrade ffmpeg-full
  else
    printf '%s\n' 'Installing ffmpeg-full with FFmpeg and ffprobe.'
    "$brew_path" install ffmpeg-full
  fi

  ffmpeg_prefix="$("$brew_path" --prefix ffmpeg-full)"

  for tool in ffmpeg ffprobe; do
    if [[ ! -x "$ffmpeg_prefix/bin/$tool" ]]; then
      printf 'Required executable is missing: %s/bin/%s\n' "$ffmpeg_prefix" "$tool" >&2
      return 1
    fi

    tool_version="$("$ffmpeg_prefix/bin/$tool" -version)"
    printf '%s\n' "${tool_version%%$'\n'*}"
  done

  printf '\n%s\n' 'FFmpeg and ffprobe are ready.'
  printf '%s\n' 'Select this FFmpeg build before running npm start:'
  printf '  export PATH=%q:"$PATH"\n' "$ffmpeg_prefix/bin"
  printf '%s\n' 'To keep that PATH setting for new terminals, add it to your shell profile.'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap cleanup_installer EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  main "$@"
fi
