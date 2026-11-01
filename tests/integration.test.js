/**
 * Verify the real CLI pipeline with installed FFmpeg and ffprobe: mixed formats,
 * video audio extraction, content detection, PCM normalization, sample timing,
 * inter-clip silence, output codecs/channels/bitrates, formatted JSON, source
 * preservation, and cleanup. All media is synthetic and all results live in
 * isolated temporary directories. Missing tools or required encoders fail the
 * prerequisites rather than silently skipping media coverage.
 */

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { before, test } = require("node:test");
const { workspace, writeWav } = require("./helpers.js");

const cli = path.resolve(__dirname, "../scripts/audio-convert.js");

// ----------------------------------------------------------------- Real media tools and isolated CLI execution

// Run a real media command and retain diagnostics when fixture generation or inspection fails.
function tool(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command}: ${result.error?.message || result.stderr}`,
  );
  return result;
}

// Require the same four output encoders as the default CLI configuration.
function verifyTools() {
  const listing = tool("ffmpeg", ["-hide_banner", "-encoders"]).stdout;
  tool("ffprobe", ["-version"]);

  for (const encoder of ["libmp3lame", "aac", "libvorbis", "ac3"]) {
    assert(
      new RegExp(`^\\s*A[.A-Z]{5}\\s+${encoder}\\s`, "m").test(listing),
      `Missing encoder ${encoder}. Run setup:ffmpeg and select the installed build in PATH before integration tests.`,
    );
  }
}

// Create synthetic media with differing codecs, sample rates, bit depths, channels, and names.
function mediaFixture(t) {
  const directory = workspace(t);
  const input = path.join(directory, "input");
  const temporary = path.join(directory, "temporary");
  fs.mkdirSync(input);
  fs.mkdirSync(temporary);
  const base = writeWav(path.join(directory, "base.wav"), 22050, 1, 2205);
  const sources = [];
  const specifications = [
    [
      "01 O'Brien.24-bit.wav",
      ["-c:a", "pcm_s24le", "-ar", "48000", "-ac", "1"],
    ],
    ["02 music.mp3", ["-c:a", "libmp3lame", "-ar", "22050", "-ac", "1"]],
    ["03 high-rate.flac", ["-c:a", "flac", "-ar", "96000", "-ac", "2"]],
  ];

  for (const [name, options] of specifications) {
    const filename = path.join(input, name);
    tool("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      base,
      ...options,
      filename,
    ]);
    sources.push(filename);
  }

  const video = path.join(input, "04 video.mp4");
  tool("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=16x16:r=10:d=0.1",
    "-i",
    base,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "mpeg4",
    "-c:a",
    "aac",
    "-shortest",
    video,
  ]);
  sources.push(video);
  const renamed = path.join(input, "05 renamed.data");
  fs.copyFileSync(sources[1], renamed);
  sources.push(renamed);
  return { directory, input, temporary, base, sources };
}

// Execute the public CLI in an isolated working directory and assert workspace cleanup.
function runCli(fixture, args) {
  const result = childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: fixture.directory,
    env: {
      ...process.env,
      TMPDIR: fixture.temporary,
      TMP: fixture.temporary,
      TEMP: fixture.temporary,
    },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);

  for (const name of fs.readdirSync(fixture.temporary)) {
    assert(
      !name.startsWith("audio-sprite-"),
      `Leaked conversion workspace: ${name}`,
    );
  }

  return result;
}

// Measure the decoded PCM sample count independently of compressed-container durations.
function decodedDuration(filename) {
  const result = tool(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filename,
      "-map",
      "0:a:0",
      "-c:a",
      "pcm_s16le",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-f",
      "s16le",
      "-",
    ],
    { encoding: null },
  );
  return result.stdout.length / (44100 * 2 * 2);
}

// Inspect encoded files through ffprobe so assertions describe actual media, not filenames.
function inspect(filename) {
  return JSON.parse(
    tool("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      filename,
    ]).stdout,
  );
}

// Hash original media so preservation checks remain concise even if a fixture is damaged.
function digest(filename) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filename))
    .digest("hex");
}

// ----------------------------------------------------------------- End-to-end media and output contracts

// A heterogeneous batch must produce all four formats and sample-derived sprite timing.
function convertsMixedMedia(t) {
  const fixture = mediaFixture(t);
  const originals = new Map();

  for (const source of fixture.sources) {
    originals.set(source, digest(source));
  }

  const result = runCli(fixture, [
    ...fixture.sources,
    "--output-dir=./dist/audio",
    "--output-name=ui sounds #1",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = path.join(fixture.directory, "dist", "audio");
  const json = fs.readFileSync(path.join(output, "ui sounds #1.json"), "utf8");
  const map = JSON.parse(json);
  assert.equal(json, JSON.stringify(map, null, 2) + "\n");
  assert.equal(map.urls.length, 4);
  let cursor = 0;

  for (const source of fixture.sources) {
    const duration = decodedDuration(source);
    const timing = map.sprite[path.parse(source).name];
    assert(Math.abs(timing[0] / 1000 - cursor) < 1e-6);
    assert(Math.abs(timing[1] / 1000 - duration) < 1e-6);
    assert.equal(digest(source), originals.get(source));
    cursor += duration + 0.5;
  }

  for (const format of ["mp3", "m4a", "ogg", "ac3"]) {
    const metadata = inspect(path.join(output, "ui sounds #1." + format));
    assert.equal(metadata.streams[0].codec_type, "audio");
    assert.equal(metadata.streams[0].sample_rate, "44100");
    assert.equal(metadata.streams[0].channels, 2);
    assert(Math.abs(Number(metadata.format.duration) - (cursor - 0.5)) < 0.15);
    assert(map.urls.includes("./dist/audio/ui%20sounds%20%231." + format));
  }

  assert.equal(
    fs.existsSync(path.join(fixture.directory, "merged.wav")),
    false,
  );
}

// Folder scans recognize renamed media, skip non-audio files, and never descend into subfolders.
function scansMediaDirectory(t) {
  const fixture = mediaFixture(t);
  fs.writeFileSync(path.join(fixture.input, "notes.txt"), "not audio");
  writeWav(path.join(fixture.input, "nested", "ignored.wav"));
  tool("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    fixture.sources[3],
    "-an",
    "-c:v",
    "copy",
    path.join(fixture.input, "silent.mp4"),
  ]);
  const result = runCli(fixture, [fixture.input, "--output=mp3"]);
  assert.equal(result.status, 0, result.stderr);
  const map = JSON.parse(
    fs.readFileSync(path.join(fixture.directory, "merged.json"), "utf8"),
  );
  assert.equal(Object.keys(map.sprite).length, fixture.sources.length);
  assert.equal(map.sprite.ignored, undefined);
  assert.equal(map.sprite.silent, undefined);
  assert(map.sprite["05 renamed"]);
  assert.match(result.stderr, /Skipping/);
}

// Channel and bitrate overrides must be observable in the actual encoded streams.
function appliesOutputOptions(t) {
  const fixture = mediaFixture(t);
  const result = runCli(fixture, [
    fixture.base,
    "--output=mp3:192k:mono,ogg:96k:stereo",
    "--output-dir=results",
    "--output-name=custom",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = path.join(fixture.directory, "results");
  assert.deepEqual(fs.readdirSync(output).sort(), [
    "custom.json",
    "custom.mp3",
    "custom.ogg",
  ]);
  const mp3 = inspect(path.join(output, "custom.mp3")).streams[0];
  const ogg = inspect(path.join(output, "custom.ogg")).streams[0];
  assert.equal(mp3.channels, 1);
  assert.equal(Number(mp3.bit_rate), 192000);
  assert.equal(ogg.channels, 2);
  assert.equal(Number(ogg.bit_rate), 96000);
  const map = JSON.parse(
    fs.readFileSync(path.join(output, "custom.json"), "utf8"),
  );
  assert.deepEqual(map.urls, ["results/custom.mp3", "results/custom.ogg"]);
}

// Real invalid input and duplicate-ID failures must not publish partial results or leak WAVs.
function rejectsBadInputs(t) {
  const fixture = mediaFixture(t);
  const invalid = path.join(fixture.directory, "invalid.mp3");
  fs.writeFileSync(invalid, "not media");
  const duplicate = path.join(fixture.directory, "base.mp3");
  fs.copyFileSync(fixture.sources[1], duplicate);
  const cases = [
    [[], /No input paths/],
    [[invalid], /ffprobe failed/],
    [[path.join(fixture.directory, "missing.wav")], /ENOENT/],
    [[fixture.base, duplicate], /Duplicate sprite ID/],
  ];

  for (const [inputs, pattern] of cases) {
    const result = runCli(fixture, [...inputs, "--output=mp3"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, pattern);
    assert.equal(
      fs.existsSync(path.join(fixture.directory, "merged.json")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.directory, "merged.mp3")),
      false,
    );
  }
}

// Output protection and help must work through the real CLI without damaging a source file.
function protectsOutputsAndShowsHelp(t) {
  const fixture = mediaFixture(t);
  const input = path.join(fixture.directory, "custom.mp3");
  fs.copyFileSync(fixture.sources[1], input);
  const hash = digest(input);
  const failure = runCli(fixture, [
    input,
    "--output=mp3",
    "--output-name=custom",
  ]);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /conflicts with a generated output/);
  assert.equal(digest(input), hash);
  const help = runCli(fixture, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--output-name/);
}

// ----------------------------------------------------------------- Prerequisites and test registration

before(verifyTools);
test(
  "real mixed audio/video becomes four correctly timed sprite formats",
  convertsMixedMedia,
);
test(
  "real directory detection skips non-audio and nested entries",
  scansMediaDirectory,
);
test(
  "real encodings honor selected bitrates, channels, names and directories",
  appliesOutputOptions,
);
test(
  "real input failures publish nothing and clean all intermediates",
  rejectsBadInputs,
);
test(
  "real CLI protects sources and provides read-only help",
  protectsOutputsAndShowsHelp,
);
