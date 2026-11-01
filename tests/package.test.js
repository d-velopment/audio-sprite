/**
 * Build the actual npm tarball, verify its publication allowlist, and install it
 * offline into a clean consumer without development or runtime dependencies.
 * Exercise installed CLI wrappers, npm bin shims, packaged assets, and import
 * boundaries. Simulate macOS, Windows, and Linux in isolated setup subprocesses:
 * supported installers use inert command doubles, while Linux must fail before
 * launching commands. No registry authentication, installation hook, system
 * installation, or publication is performed. Run via npm test so npm_execpath
 * identifies the npm CLI portably.
 */

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { workspace } = require("./helpers.js");

const root = path.resolve(__dirname, "..");

// ----------------------------------------------------------------- Offline npm and installed CLI checks

// Run npm's JavaScript entry point without shell quoting or Windows batch-file execution.
function npm(args, cwd, cache) {
  assert(process.env.npm_execpath, "Run packaging tests with npm test or npm run test:unit.");
  const result = childProcess.spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    env: { ...process.env, npm_config_cache: cache },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result;
}

// Execute a packaged bin file through Node, including on Windows where npm uses cmd shims.
function runBin(filename, args, cwd) {
  return childProcess.spawnSync(process.execPath, [filename, ...args], { cwd, encoding: "utf8", timeout: 10000 });
}

// Verify each setup CLI's platform routing and subprocess calls without executing any installers.
function checkSetupPlatforms(filename, preload, cwd, directory) {
  const log = path.join(directory, "setup-commands.log");

  for (const platform of ["darwin", "win32", "linux"]) {
    fs.writeFileSync(log, "");
    const result = childProcess.spawnSync(process.execPath, ["--require", preload, filename], {
      cwd,
      env: { ...process.env, AUDIO_SPRITE_TEST_PLATFORM: platform, AUDIO_SPRITE_TEST_COMMANDS: log },
      encoding: "utf8",
      timeout: 10000
    });
    const commands = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);

    if (platform === "linux") {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Automatic FFmpeg setup supports macOS and Windows; detected linux/);
      assert.match(result.stderr, /Install ffmpeg and ffprobe using your system package manager/);
      assert.deepEqual(commands, []);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(commands, platform === "darwin"
        ? ["/bin/bash"]
        : ["winget.exe", "winget.exe", "powershell.exe", "ffmpeg.exe", "ffprobe.exe"]);
    }

  }
}

// A real packed-and-installed package must expose only distributable files and working commands.
function installsPackedPackage(t) {
  const directory = workspace(t);
  const cache = path.join(directory, "npm-cache");
  const packed = npm(["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", directory], root, cache);
  const artifact = JSON.parse(packed.stdout)[0];
  assert.equal(artifact.name, "@d-velopment/audio-sprite");
  assert.equal(artifact.filename, `d-velopment-audio-sprite-${require("../package.json").version}.tgz`);
  const actual = [];

  for (const file of artifact.files) {
    actual.push(file.path);
  }

  assert.deepEqual(actual.sort(), [
    "CHANGELOG.md", "LICENSE", "README.md", "assets/silence.wav", "bin/audio-sprite-setup.js", "bin/audio-sprite.js",
    "package.json", "scripts/audio-convert.js", "scripts/setup-ffmpeg.js", "scripts/setup-ffmpeg.sh"
  ].sort());
  const consumer = path.join(directory, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "package-consumer-test", private: true }));
  npm(["install", path.join(directory, artifact.filename), "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], consumer, cache);
  const installed = path.join(consumer, "node_modules", "@d-velopment", "audio-sprite");
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  assert.equal(Object.keys(manifest.dependencies || {}).length, 0);
  assert.equal(fs.existsSync(path.join(installed, "node_modules")), false);
  assert(fs.readFileSync(path.join(installed, "assets", "silence.wav")).includes(Buffer.from("WAVE")));
  const command = path.join(installed, manifest.bin["audio-sprite"]);
  const setup = path.join(installed, manifest.bin["audio-sprite-setup"]);
  assert(fs.readFileSync(command, "utf8").startsWith("#!/usr/bin/env node\n"));
  const help = runBin(command, ["--help"], consumer);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--output-name/);
  const invalid = runBin(command, [], consumer);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /No input paths supplied/);
  const setupHelp = runBin(setup, ["--help"], consumer);
  assert.equal(setupHelp.status, 0, setupHelp.stderr);
  assert.match(setupHelp.stdout, /Usage: audio-sprite-setup/);
  const invalidSetup = runBin(setup, ["--invalid"], consumer);
  assert.equal(invalidSetup.status, 1);
  assert.match(invalidSetup.stderr, /Unknown setup arguments/);
  const preload = path.join(directory, "setup-preload.cjs");
  fs.writeFileSync(preload, `/**
 * Simulate setup platforms only in this test child and record inert installer calls.
 * No system command is executed and the parent process platform remains unchanged.
 */
const fs = require("node:fs");
Object.defineProperty(process, "platform", { value: process.env.AUDIO_SPRITE_TEST_PLATFORM });

// Record each attempted installer or tool check and return controlled version output.
require("node:child_process").spawnSync = function simulateCommand(command) {
  fs.appendFileSync(process.env.AUDIO_SPRITE_TEST_COMMANDS, command + "\\n");
  return { status: 0, stdout: "fixture version" };
};

`);
  checkSetupPlatforms(setup, preload, consumer, directory);
  const shimSuffix = process.platform === "win32" ? ".cmd" : "";
  assert(fs.existsSync(path.join(consumer, "node_modules", ".bin", "audio-sprite" + shimSuffix)));
  assert(fs.existsSync(path.join(consumer, "node_modules", ".bin", "audio-sprite-setup" + shimSuffix)));
  const imported = childProcess.spawnSync(process.execPath, ["-e", `require(${JSON.stringify(installed)})`], { cwd: consumer, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");

  for (const [filename, args, expected] of [
    ["audio-sprite.js", ["--help"], 0],
    ["audio-sprite.js", [], 1],
    ["audio-sprite-setup.js", ["--help"], 0],
    ["audio-sprite-setup.js", ["--invalid"], 1]
  ]) {
    const result = runBin(path.join(root, "bin", filename), args, consumer);
    assert.equal(result.status, expected, result.stderr);
  }

  checkSetupPlatforms(path.join(root, "bin", "audio-sprite-setup.js"), preload, consumer, directory);
}

// ----------------------------------------------------------------- Test registration

test("npm tarball installs offline with working CLI commands and no runtime dependencies", installsPackedPackage);
