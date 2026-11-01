/**
 * Verify platform routing, WinGet installation and update behavior, refreshed
 * Windows PATH handling, and installer failures without changing system packages.
 * macOS shell scenarios run with fixture-only brew, curl, uname, and installer
 * commands. Native shell scenarios are skipped on Windows, where Bash is not a
 * prerequisite. The JavaScript Windows branch is exercised on every platform.
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setup } = require('../scripts/setup-ffmpeg.js');
const { workspace, captureLogs } = require('./helpers.js');

// ----------------------------------------------------------------- Platform process doubles

// Replace every installer subprocess with controlled metadata and retain calls for assertions.
function mockSetup(t, options = {}) {
  const calls = [];

  // Supply version, installation, PATH, and verification results without running executables.
  function spawnSync(command, args, spawnOptions) {
    calls.push({ command, args, options: spawnOptions });

    if (command === '/bin/bash') {
      return options.macResult || { status: 0 };
    }

    if (command === 'winget.exe') {

      if (args[0] === '--version') {
        return options.versionResult || { status: 0 };
      }

      return options.installResult || { status: 0 };
    }

    if (command === 'powershell.exe') {
      return options.pathResult || { status: 0, stdout: 'C:\\Program Files\\FFmpeg;C:\\Users\\Тест\\WinGet\\Links\r\n' };
    }

    if (command === 'ffmpeg.exe' || command === 'ffprobe.exe') {
      return options.toolResult || { status: 0, stdout: command + ' version fixture\r\n' };
    }

    assert.fail('Unexpected setup command: ' + command);
  }

  t.mock.method(childProcess, 'spawnSync', spawnSync);
  return calls;
}

// Assert that a selected setup path rejects failures with an actionable message.
function expectSetupFailure(platform, pattern) {
  assert.throws(

    // Invoke only through the currently installed subprocess double.
    () => setup(platform),

    pattern
  );
}

// ----------------------------------------------------------------- JavaScript routing and Windows behavior

// macOS must delegate to its shell script, while unsupported systems make no changes.
function routesPlatforms(t) {
  captureLogs(t);
  const calls = mockSetup(t);
  setup('darwin');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/bash');
  assert(calls[0].args[0].endsWith('setup-ffmpeg.sh'));
  expectSetupFailure('linux', /supports macOS and Windows/);
  assert.equal(calls.length, 1);
}

// Windows selects the exact package and verifies tools using persisted user and machine PATH.
function provisionsWindows(t) {
  captureLogs(t);
  const calls = mockSetup(t);
  setup('win32');
  assert.deepEqual(calls[1].args, ['install', '--id', 'Gyan.FFmpeg', '--exact', '--source', 'winget']);
  assert.equal(calls[2].command, 'powershell.exe');
  assert(calls[2].args.at(-1).includes("'Machine'"));
  assert(calls[2].args.at(-1).includes("'User'"));
  assert.equal(calls[3].command, 'ffmpeg.exe');
  assert.equal(calls[4].command, 'ffprobe.exe');
  assert(calls[3].options.env.PATH.startsWith('C:\\Program Files\\FFmpeg;C:\\Users\\Тест\\WinGet\\Links;'));
  let pathCount = 0;

  for (const key of Object.keys(calls[3].options.env)) {

    if (key.toLowerCase() === 'path') {
      pathCount++;
    }

  }

  assert.equal(pathCount, 1);
}

// Both signed and unsigned representations of WinGet's current-version status are successful.
function acceptsCurrentVersion(t) {
  for (const status of [0x8a15002b, -1978335189]) {
    t.mock.reset();
    captureLogs(t);
    const calls = mockSetup(t, { installResult: { status } });
    setup('win32');
    assert.equal(calls.at(-1).command, 'ffprobe.exe');
  }
}

// Launch, cancellation, package, PATH, and tool failures must prevent a success report.
function rejectsSetupFailures(t) {
  const cases = [
    ['darwin', { macResult: { error: new Error('not found') } }, /Cannot run/],
    ['darwin', { macResult: { status: null, signal: 'SIGTERM' } }, /interrupted/],
    ['darwin', { macResult: { status: 5 } }, /exit code 5/],
    ['win32', { versionResult: { error: new Error('missing') } }, /App Installer/],
    ['win32', { installResult: { status: 10 } }, /exit code 10/],
    ['win32', { pathResult: { status: 1 } }, /powershell.exe failed/],
    ['win32', { toolResult: { error: new Error('not found') } }, /could not verify/]
  ];

  for (const [platform, options, pattern] of cases) {
    t.mock.reset();
    const logs = captureLogs(t);
    mockSetup(t, options);
    expectSetupFailure(platform, pattern);

    for (const args of logs) {
      assert(!String(args[0]).includes('are ready'));
    }
  }
}

// Direct CLI failures must exit nonzero; preload interception prevents any real installation.
function reportsSetupCliErrors(t) {
  const directory = workspace(t);
  const preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(preload, "// Prevent installer execution in this fixture.\nrequire('node:child_process').spawnSync = function () { return { status: 9 }; };\n");
  const result = childProcess.spawnSync(process.execPath, ['--require', preload, require.resolve('../scripts/setup-ffmpeg.js')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FFmpeg setup failed/);
}

// ----------------------------------------------------------------- Isolated macOS shell scenarios

// Write an executable fixture command; only test-owned files receive executable permissions.
function executable(filename, content) {
  fs.writeFileSync(filename, '#!/bin/bash\n' + content);
  fs.chmodSync(filename, 0o755);
}

// Run the Homebrew script against inert commands, including its missing-manager bootstrap path.
function exercisesShellSetup(t) {
  const script = path.resolve(__dirname, '../scripts/setup-ffmpeg.sh');

  for (const scenario of ['install', 'upgrade', 'bootstrap', 'update-failure', 'download-failure', 'installer-failure', 'missing-probe', 'unsupported-platform']) {
    const directory = workspace(t);
    const bin = path.join(directory, 'bin');
    const prefix = path.join(directory, 'FFmpeg prefix');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    const log = path.join(directory, 'commands.log');
    const template = path.join(directory, 'brew-template');
    const installer = path.join(directory, 'installer');
    const brew = `set -eu
printf '%s\\n' "$*" >> "$SETUP_TEST_LOG"
case "$1" in
  update) exit "$SETUP_TEST_UPDATE_STATUS" ;;
  list) [[ "$SETUP_TEST_INSTALLED" == 1 ]] ;;
  install|upgrade) exit 0 ;;
  --prefix) printf '%s\\n' "$SETUP_TEST_PREFIX" ;;
  *) exit 99 ;;
esac
`;
    executable(template, brew);

    if (!['bootstrap', 'download-failure', 'installer-failure'].includes(scenario)) {
      executable(path.join(bin, 'brew'), brew);
    }

    executable(path.join(bin, 'uname'), 'printf "%s\\n" "$SETUP_TEST_PLATFORM"\n');
    executable(path.join(prefix, 'bin', 'ffmpeg'), 'printf "ffmpeg version fixture\\n"\n');

    if (scenario !== 'missing-probe') {
      executable(path.join(prefix, 'bin', 'ffprobe'), 'printf "ffprobe version fixture\\n"\n');
    }

    executable(installer, `printf 'installer\\n' >> "$SETUP_TEST_LOG"
[[ "$SETUP_TEST_INSTALLER_STATUS" == 0 ]] || exit "$SETUP_TEST_INSTALLER_STATUS"
cp "$SETUP_TEST_TEMPLATE" "$SETUP_TEST_BIN/brew"
chmod +x "$SETUP_TEST_BIN/brew"
`);
    executable(path.join(bin, 'curl'), `set -eu
[[ "$SETUP_TEST_DOWNLOAD_STATUS" == 0 ]] || exit "$SETUP_TEST_DOWNLOAD_STATUS"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output ]]; then cp "$SETUP_TEST_INSTALLER" "$2"; exit 0; fi
  shift
done
exit 99
`);
    const env = {
      ...process.env,
      PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: directory,
      SETUP_TEST_LOG: log,
      SETUP_TEST_PREFIX: prefix,
      SETUP_TEST_BIN: bin,
      SETUP_TEST_TEMPLATE: template,
      SETUP_TEST_INSTALLER: installer,
      SETUP_TEST_PLATFORM: scenario === 'unsupported-platform' ? 'Linux' : 'Darwin',
      SETUP_TEST_INSTALLED: scenario === 'upgrade' ? '1' : '0',
      SETUP_TEST_UPDATE_STATUS: scenario === 'update-failure' ? '7' : '0',
      SETUP_TEST_DOWNLOAD_STATUS: scenario === 'download-failure' ? '22' : '0',
      SETUP_TEST_INSTALLER_STATUS: scenario === 'installer-failure' ? '5' : '0'
    };
    const harness = 'source "$1"; find_homebrew() { command -v brew || true; }; trap cleanup_installer EXIT; main';
    const result = childProcess.spawnSync('/bin/bash', ['-c', harness, 'setup-test', script], { env, encoding: 'utf8' });
    const successful = ['install', 'upgrade', 'bootstrap'].includes(scenario);
    assert.equal(result.status === 0, successful, `${scenario}: ${result.stderr}`);
    const commands = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';

    if (successful) {
      assert(commands.includes(scenario === 'upgrade' ? 'upgrade ffmpeg-full' : 'install ffmpeg-full'));
      assert.match(result.stdout, /export PATH=/);
    }

    if (scenario === 'update-failure') {
      assert.equal(commands, 'update\n');
    }

    for (const name of fs.readdirSync(directory)) {
      assert(!name.startsWith('audio-sprite-homebrew.'), `Leaked installer: ${scenario}`);
    }
  }
}

// ----------------------------------------------------------------- Test registration

test('setup routes platforms without invoking unsupported installers', routesPlatforms);
test('Windows installs the exact package and refreshes PATH', provisionsWindows);
test('Windows accepts an already current version', acceptsCurrentVersion);
test('setup rejects launch, install, PATH and tool failures', rejectsSetupFailures);
test('setup CLI reports a nonzero error without installing software', reportsSetupCliErrors);
test('Homebrew bootstrap, install, upgrade and failure paths use only fixture commands', {
  skip: process.platform === 'win32' ? 'Native Bash scenarios run on macOS and Linux.' : false
}, exercisesShellSetup);
