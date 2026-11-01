#!/usr/bin/env node
/**
 * Expose the installed audio-sprite command through npm's cross-platform bin
 * shims. Delegate conversion to the shared workflow and report failed runs with
 * a nonzero exit code. Installation and package release handling are separate.
 */

const { main } = require("../scripts/audio-convert.js");

// ----------------------------------------------------------------- Installed conversion command

main().catch(

  // Preserve the same CLI diagnostics as direct execution from the repository.
  (error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  },

);
