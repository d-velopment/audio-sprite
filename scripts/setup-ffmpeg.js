/**
 * Provide the explicit npm setup entry point for FFmpeg and ffprobe on macOS
 * and Windows. Delegate macOS provisioning to the Homebrew shell script and
 * install or update the exact Gyan.FFmpeg package through WinGet on Windows.
 * Preserve installer prompts, reject failed commands, and verify both Windows
 * executables after refreshing the child process PATH from persisted settings.
 * Use only Node.js built-ins; importing this module performs no installation.
 * Shell profiles, the parent terminal environment, and npm dependencies are
 * outside this module's responsibilities. Linux requires manual provisioning.
 */

const childProcess = require("node:child_process");
const path = require("node:path");

const WINGET_UPDATE_NOT_APPLICABLE = 0x8a15002b;

// ----------------------------------------------------------------- External command execution

// Run an executable without a shell, preserving prompts unless output is captured.
function runCommand(command, args, options = {}, acceptedStatuses = [0]) {
  const result = childProcess.spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw new Error(`Cannot run ${command}: ${result.error.message}`);
  }

  if (result.signal || result.status === null) {
    throw new Error(
      `${command} was interrupted${result.signal ? ` (${result.signal})` : ""}.`,
    );
  }

  if (!acceptedStatuses.includes(result.status >>> 0)) {
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }

  return result;
}

// ----------------------------------------------------------------- Windows environment and provisioning

// Build a child-only PATH using current registry settings after WinGet changes them.
function getWindowsEnvironment() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'))",
  ].join("; ");
  const result = runCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", command],
    {
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  const env = { ...process.env };
  let previousPath = "";

  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") {
      previousPath = env[key];
      delete env[key];
    }
  }

  env.PATH = `${result.stdout.trim()};${previousPath}`;
  return env;
}

// Install or update FFmpeg through WinGet and verify both tools in the refreshed PATH.
function setupWindows() {
  try {
    runCommand("winget.exe", ["--version"]);
  } catch (error) {
    throw new Error(
      `WinGet is unavailable. Install or update Microsoft's App Installer, reopen your terminal, and rerun npm run setup:ffmpeg.\nhttps://learn.microsoft.com/en-us/windows/package-manager/winget/\n${error.message}`,
    );
  }

  console.log("Installing or updating FFmpeg and ffprobe through WinGet.");

  // WinGet install upgrades existing packages unless --no-upgrade is specified.
  runCommand(
    "winget.exe",
    ["install", "--id", "Gyan.FFmpeg", "--exact", "--source", "winget"],
    {},
    [0, WINGET_UPDATE_NOT_APPLICABLE],
  );

  const env = getWindowsEnvironment();

  for (const tool of ["ffmpeg.exe", "ffprobe.exe"]) {
    let result;

    try {
      result = runCommand(tool, ["-version"], {
        env,
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (error) {
      throw new Error(
        `FFmpeg setup could not verify ${tool}. Reopen your terminal and rerun npm run setup:ffmpeg. Check that the FFmpeg executable directory is on PATH.\n${error.message}`,
      );
    }

    console.log(result.stdout.split(/\r?\n/)[0]);
  }

  console.log(
    "FFmpeg and ffprobe are ready. Reopen your terminal before running npm start so it receives the updated PATH.",
  );
}

// ----------------------------------------------------------------- Platform routing and CLI errors

// Select the platform installer and stop unsupported systems before changing packages.
function setup(platform = process.platform) {
  if (platform === "darwin") {
    runCommand("/bin/bash", [path.join(__dirname, "setup-ffmpeg.sh")]);
    return;
  }

  if (platform === "win32") {
    setupWindows();
    return;
  }

  throw new Error(
    `Automatic FFmpeg setup supports macOS and Windows; detected ${platform}. Install ffmpeg and ffprobe using your system package manager.`,
  );
}

if (require.main === module) {
  try {
    setup();
  } catch (error) {
    console.error(`FFmpeg setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { setup };
