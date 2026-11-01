/**
 * Provide isolated filesystem fixtures and deterministic external-process doubles
 * for the test suite. Fixtures live under the system temporary directory and are
 * removed by the owning test. Generated WAVs contain a short synthetic tone;
 * process doubles may write only inside their fixture and never install tools.
 */

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ----------------------------------------------------------------- Temporary media and log fixtures

// Create an isolated workspace and register cleanup even when a test assertion fails.
function workspace(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "audio sprite's test-"),
  );
  t.after(
    // Remove all files owned by this test after child processes have completed.
    () => {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  );
  return directory;
}

// Write a valid short 16-bit PCM WAV without depending on an installed media tool.
function writeWav(filename, sampleRate = 44100, channels = 2, frames = 4410) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const bytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF");
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(bytes, 40);

  for (let frame = 0; frame < frames; frame++) {
    const value = Math.round(
      Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 3000,
    );

    for (let channel = 0; channel < channels; channel++) {
      buffer.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
    }
  }

  fs.writeFileSync(filename, buffer);
  return filename;
}

// Capture workflow logs without emitting expected diagnostics into TAP output.
function captureLogs(t) {
  const messages = [];

  // Record each console call while preserving argument boundaries.
  function record(...args) {
    messages.push(args);
  }

  for (const method of ["log", "warn", "error"]) {
    t.mock.method(console, method, record);
  }

  return messages;
}

// ----------------------------------------------------------------- Controlled external process doubles

// Replace ffprobe and FFmpeg with observable deterministic processes scoped to a fixture.
function mockAudioTools(t, directory, options = {}) {
  const calls = [];
  let spawned = 0;
  const defaultMetadata = {
    streams: [
      {
        codec_type: "audio",
        codec_name: "pcm_s16le",
        sample_rate: "44100",
        channels: 2,
        bits_per_sample: 16,
        duration_ts: 4410,
        time_base: "1/44100",
        duration: "0.1",
      },
    ],
  };

  // Return selected metadata or a controlled failure without invoking system executables.
  function execFile(command, args, callback) {
    calls.push({ command, args });

    if (command === "ffmpeg") {
      const names = options.encoders || [
        "libmp3lame",
        "aac",
        "libvorbis",
        "ac3",
      ];
      let listing = "";

      for (const name of names) {
        listing += ` A....D ${name} encoder\n`;
      }

      callback(options.encoderError || null, listing, "");
      return;
    }

    const filename = args.at(-1);
    let metadata = options.metadata || defaultMetadata;

    if (options.responses && options.responses.has(filename)) {
      metadata = options.responses.get(filename);
    }

    const json =
      typeof metadata === "string" ? metadata : JSON.stringify(metadata);
    callback(options.probeError || null, json, options.probeStderr || "");
  }

  // Emulate closure and optional generated files while preventing writes outside the fixture.
  function spawn(command, args, spawnOptions) {
    calls.push({ command, args, options: spawnOptions });
    spawned++;
    const child = new EventEmitter();
    const fail = options.failOn === spawned;

    queueMicrotask(
      // Complete the process asynchronously so event listeners are registered first.
      () => {
        if (options.spawnError) {
          child.emit("error", options.spawnError);
          child.emit("close", -2, null);
          return;
        }

        if (
          !fail &&
          !options.signal &&
          (options.exitCode ?? 0) === 0 &&
          args.includes("-i")
        ) {
          const output = args.at(-1);
          assert(
            output.startsWith(directory + path.sep),
            `Unsafe mock output: ${output}`,
          );

          if (output.endsWith(".wav")) {
            writeWav(output);
          } else {
            fs.writeFileSync(output, "encoded fixture");
          }
        }

        const code = options.signal ? null : fail ? 1 : (options.exitCode ?? 0);
        child.emit("close", code, options.signal || null);
      },
    );
    return child;
  }

  t.mock.method(childProcess, "execFile", execFile);
  t.mock.method(childProcess, "spawn", spawn);
  return calls;
}

module.exports = { workspace, writeWav, captureLogs, mockAudioTools };
