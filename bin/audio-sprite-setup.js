#!/usr/bin/env node
/**
 * Expose explicit FFmpeg setup for npm-installed users. Show read-only help when
 * requested and otherwise delegate to the existing platform installer. No setup
 * runs during npm installation; users must invoke this command themselves.
 */

const { setup } = require("../scripts/setup-ffmpeg.js");

// ----------------------------------------------------------------- Installed setup command

const args = process.argv.slice(2);

if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log("Usage: audio-sprite-setup\n\nExplicitly install or update FFmpeg and ffprobe on macOS or Windows. Follow the printed PATH instructions after setup.");
} else {
  try {

    if (args.length > 0) {
      throw new Error("Unknown setup arguments. Use audio-sprite-setup --help.");
    }

    setup();
  } catch (error) {
    console.error(`FFmpeg setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
