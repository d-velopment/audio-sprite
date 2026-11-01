/**
 * Exercise every conversion phase without installed media tools: CLI validation,
 * source discovery, encoder verification, probing, process failures, PCM settings,
 * decoded timing, concatenation, map generation, publication, and cleanup. Real
 * filesystem fixtures are isolated, and child processes are controlled doubles.
 * Separate integration tests verify the actual media transformations.
 */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const converter = require('../scripts/audio-convert.js');
const { workspace, writeWav, captureLogs, mockAudioTools } = require('./helpers.js');

// ----------------------------------------------------------------- Reusable assertion helpers

// Assert that an invalid CLI invocation fails before any workflow can start.
function invalidArguments(args, pattern = /Invalid|requires|Unknown|more than once/) {
  assert.throws(

    // Parse only; invalid options must not depend on tools or source files.
    () => converter.parseArguments(args),

    pattern
  );
}

// Create settings with all destinations confined to the current test fixture.
function settingsFor(directory, extra = []) {
  return converter.parseArguments(['--output-dir', path.join(directory, 'results'), ...extra]);
}

// Redirect main's temporary workspace into the test fixture for observable cleanup.
function redirectTemporaryFiles(t, directory) {
  t.mock.method(os, 'tmpdir',

    // Keep temporary workspaces independent from other tests and user files.
    () => directory,

  );
}

// ----------------------------------------------------------------- Import boundaries and CLI parsing

// Importing the entry point must not run conversion, print errors, or create files.
function importIsInert(t) {
  const directory = workspace(t);
  const filename = require.resolve('../scripts/audio-convert.js');
  const result = childProcess.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(filename)})`], {
    cwd: directory, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(fs.readdirSync(directory), []);
}

// Defaults and partial output specifications preserve the documented CLI contract.
function parsesOutputSettings() {
  const defaults = converter.parseArguments(['one.wav']);
  assert.deepEqual(defaults.inputPaths, ['one.wav']);
  assert.equal(defaults.outputFilePath, './');
  assert.equal(defaults.outputDirectory, process.cwd());
  assert.equal(defaults.outputFileName, 'merged');
  assert.equal(defaults.outputFormats.length, 4);
  const custom = converter.parseArguments(['--output=MP3::MONO,ogg:96K', 'one.wav', '--output-name', 'ui sounds', '--output-dir=dist/audio']);
  assert.deepEqual(custom.outputFormats[0], {
    format: 'mp3', bitrate: '128k', channels: 'mono',
    options: ['-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '1']
  });
  assert.equal(custom.outputFormats[1].bitrate, '96k');
  assert.equal(custom.outputFormats[1].channels, 'stereo');
  assert.equal(custom.outputFileName, 'ui sounds');
  assert.equal(custom.outputDirectory, path.resolve('dist/audio'));
  assert.deepEqual(converter.parseArguments(['--', '-clip.wav', '--help']).inputPaths, ['-clip.wav', '--help']);
  assert.equal(converter.parseArguments(['-h']).help, true);
}

// Invalid flags, formats, quality fields, and duplicate options fail deterministically.
function rejectsInvalidOptions() {
  for (const args of [
    ['--output'], ['--output='], ['--output-dir'], ['--output-name'], ['--unknown'], ['--input=x'],
    ['--output=wav'], ['--output=mp3:0k'], ['--output=mp3:128'], ['--output=mp3:128k:quad'],
    ['--output=mp3,mp3'], ['--output=mp3:128k:mono:extra'], ['--output=mp3:9007199254740992k'],
    ['--output=mp3', '--output=ogg'], ['--output-dir=a', '--output-dir=b'],
    ['--output-name=a', '--output-name=b'], ['--output', '--help']
  ]) {
    invalidArguments(args);
  }
}

// Output basenames cannot escape their directory or use reserved device names.
function validatesOutputNames() {
  assert.equal(converter.validateOutputName('Звуки игры #1'), 'Звуки игры #1');
  assert.equal(converter.validateOutputName('ui.sounds'), 'ui.sounds');

  for (const name of ['', ' ', '../escape', 'a/b', 'a\\b', '.', '..', 'trailing.', 'trailing ', 'NUL', 'CON.mp3', 'LPT1', 'bad:name', 'bad\nname']) {
    invalidArguments(['--output-name=' + name], /Invalid|requires|reserved/);
  }
}

// ----------------------------------------------------------------- Input selection and source protection

// File order, sorted folder expansion, deduplication, and explicit-source flags survive discovery.
function discoversInputs(t) {
  const directory = workspace(t);
  const folder = path.join(directory, 'input');
  const a = writeWav(path.join(folder, 'a.wav'));
  const b = writeWav(path.join(folder, 'b.wav'));
  writeWav(path.join(folder, 'nested', 'ignored.wav'));
  const text = path.join(folder, 'readme.txt');
  fs.writeFileSync(text, 'not media');
  const selected = converter.collectInputFiles([b, folder, a], settingsFor(directory));
  assert.deepEqual(selected, [{ name: b, explicit: true }, { name: a, explicit: true }, { name: text, explicit: false }]);
  assert.throws(

    // An empty selection must explain how to invoke the CLI.
    () => converter.collectInputFiles([], settingsFor(directory)),

    /No input paths/
  );
  assert.throws(

    // Missing paths must fail before encoder execution.
    () => converter.collectInputFiles([path.join(directory, 'missing')], settingsFor(directory)),

    /ENOENT/
  );
}

// Discovery rejects explicitly selected output files and skips them during scans.
function protectsSourceFiles(t) {
  const directory = workspace(t);
  const settings = settingsFor(directory, ['--output-name=custom']);
  const output = writeWav(path.join(settings.outputDirectory, 'custom.mp3'));
  const input = writeWav(path.join(settings.outputDirectory, 'tone.wav'));
  assert.throws(

    // Output protection must run before any source file can be overwritten.
    () => converter.collectInputFiles([output], settings),

    /conflicts with a generated output/
  );
  assert.deepEqual(converter.collectInputFiles([settings.outputDirectory], settings), [{ name: input, explicit: false }]);
}

// ----------------------------------------------------------------- Encoder checks and audio probing

// Every configured encoder is checked uniformly, while unselected encoders are irrelevant.
async function verifiesEncoders(t) {
  const directory = workspace(t);
  const encoders = ['libmp3lame', 'aac', 'libvorbis', 'ac3'];
  const formats = ['mp3', 'm4a', 'ogg', 'ac3'];
  mockAudioTools(t, directory);
  await converter.checkOutputEncoders(converter.parseOutputFormats(formats.join(',')));

  for (let index = 0; index < formats.length; index++) {
    t.mock.reset();
    const available = encoders.slice();
    available.splice(index, 1);
    mockAudioTools(t, directory, { encoders: available });
    await assert.rejects(converter.checkOutputEncoders(converter.parseOutputFormats(formats[index])), /missing required audio encoders/);
    await converter.checkOutputEncoders(converter.parseOutputFormats(formats[(index + 1) % formats.length]));
  }

  t.mock.reset();
  mockAudioTools(t, directory, { encoderError: new Error('tool unavailable') });
  await assert.rejects(converter.checkOutputEncoders(converter.parseOutputFormats('mp3')), /Cannot inspect FFmpeg encoders/);

  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  try {
    for (const platform of ['win32', 'linux']) {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      t.mock.reset();
      mockAudioTools(t, directory, { encoders: ['unrelated_encoder'] });
      const pattern = platform === 'win32' ? /reopen your terminal/ : /system package manager/;
      await assert.rejects(converter.checkOutputEncoders(converter.parseOutputFormats('mp3')), pattern);
    }
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

// Probing returns usable audio metadata without demanding a source duration or bit depth.
async function probesAudio(t) {
  const directory = workspace(t);
  const input = writeWav(path.join(directory, 'source.data'));
  const metadata = { streams: [{ codec_type: 'video' }, { codec_type: 'audio', codec_name: 'aac' }] };
  const calls = mockAudioTools(t, directory, { metadata });
  assert.deepEqual(await converter.probeAudio(input), metadata.streams[1]);
  assert(calls[0].args.includes('a:0'));
  assert.equal(calls[0].args.at(-1), input);
}

// Unsupported content, invalid responses, and missing executables remain distinguishable.
async function rejectsProbeFailures(t) {
  const directory = workspace(t);
  const input = writeWav(path.join(directory, 'source.wav'));

  for (const metadata of ['invalid JSON', { streams: [] }, { streams: [{ codec_type: 'video' }] }]) {
    t.mock.reset();
    mockAudioTools(t, directory, { metadata });
    await assert.rejects(converter.probeAudio(input), /Invalid ffprobe metadata|No audio stream/);
  }

  for (const code of [1, 'ENOENT']) {
    t.mock.reset();
    const error = Object.assign(new Error('probe failed'), { code });
    mockAudioTools(t, directory, { probeError: error, probeStderr: 'decoder diagnostic' });

    try {
      await converter.probeAudio(input);
      assert.fail('Expected a rejected probe');
    } catch (failure) {
      assert.equal(failure.invalidMedia, code === 1);
      assert.match(failure.message, /decoder diagnostic/);
    }
  }

  assert.throws(

    // Missing local files must fail before ffprobe starts.
    () => converter.probeAudio(path.join(directory, 'missing.wav')),

    /ENOENT/
  );
}

// Process launch, exit, and signal failures cannot leave conversion promises pending.
async function handlesProcessFailures(t) {
  const directory = workspace(t);
  const calls = mockAudioTools(t, directory);
  await converter.runFfmpeg(['-version']);
  assert.equal(calls[0].command, 'ffmpeg');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'inherit']);
  assert(calls[0].args.includes('-nostdin'));

  for (const options of [{ spawnError: new Error('ENOENT') }, { exitCode: 3 }, { signal: 'SIGTERM' }]) {
    t.mock.reset();
    mockAudioTools(t, directory, options);
    await assert.rejects(converter.runFfmpeg(['-version']), /Cannot start FFmpeg|FFmpeg failed/);
  }
}

// ----------------------------------------------------------------- Normalization, concatenation, and timing

// Normalization enforces shared PCM settings and uses decoded samples for timing.
async function normalizesAudio(t) {
  const directory = workspace(t);
  const source = writeWav(path.join(directory, 'source.wav'));
  const output = path.join(directory, 'normalized.wav');
  const calls = mockAudioTools(t, directory);
  const normalized = await converter.normalizeAudio(source, output);
  assert.deepEqual(normalized, { name: source, wavPath: output, duration: 0.1 });
  const args = calls[0].args;
  assert.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
  assert.equal(args[args.indexOf('-ar') + 1], '44100');
  assert.equal(args[args.indexOf('-ac') + 1], '2');
  assert.equal(args[args.indexOf('-map') + 1], '0:a:0');
  t.mock.reset();
  mockAudioTools(t, directory, { metadata: { streams: [{ codec_type: 'audio', duration: '0.25' }] } });
  assert.equal((await converter.normalizeAudio(source, output)).duration, 0.25);
  t.mock.reset();
  mockAudioTools(t, directory, { metadata: { streams: [{ codec_type: 'audio', duration: '0' }] } });
  await assert.rejects(converter.normalizeAudio(source, output), /no positive duration/);
}

// Folder-only unsupported files are skipped, while explicit invalid files and ID collisions fail.
async function preparesEligibleInputs(t) {
  const directory = workspace(t);
  captureLogs(t);
  const source = writeWav(path.join(directory, 'clip.wav'));
  const text = path.join(directory, 'clip.txt');
  fs.writeFileSync(text, 'text');
  const responses = new Map([[text, { streams: [] }]]);
  mockAudioTools(t, directory, { responses });
  const prepared = await converter.prepareInputs([{ name: text, explicit: false }, { name: source, explicit: true }], directory);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].name, source);
  await assert.rejects(converter.prepareInputs([{ name: text, explicit: true }], directory), /No audio stream/);
  await assert.rejects(converter.prepareInputs([{ name: text, explicit: false }], directory), /No supported files/);
  const duplicate = writeWav(path.join(directory, 'clip.mp3'));
  await assert.rejects(converter.prepareInputs([{ name: source, explicit: true }, { name: duplicate, explicit: true }], directory), /Duplicate sprite ID/);
}

// Concat lists quote unusual paths and place silence strictly between normalized clips.
async function concatenatesClips(t) {
  const directory = workspace(t);
  mockAudioTools(t, directory);
  const first = writeWav(path.join(directory, "O'Brien.wav"));
  const second = writeWav(path.join(directory, 'second.wav'));
  const silence = writeWav(path.join(directory, 'silence.wav'));
  const merged = await converter.mergeWavFiles([{ wavPath: first }, { wavPath: second }], { wavPath: silence }, directory);
  assert.equal(merged, path.join(directory, 'merged.wav'));
  assert.equal(fs.readFileSync(path.join(directory, 'concat.txt'), 'utf8'), [first, silence, second].map(converter.formatConcatEntry).join('\n'));
  assert(converter.formatConcatEntry(first).includes("O'\\''Brien"));
  await converter.mergeWavFiles([{ wavPath: first }], null, directory);
  assert.equal(fs.readFileSync(path.join(directory, 'concat.txt'), 'utf8'), converter.formatConcatEntry(first));
}

// Verify Windows concat quoting even when the suite is running on another platform.
function formatsWindowsPaths() {
  const resolve = path.resolve;
  const separator = path.sep;

  try {
    path.resolve = path.win32.resolve;
    path.sep = '\\';
    assert.equal(converter.formatConcatEntry("C:\\Test User\\O'Brien.wav"), "file 'C:/Test User/O'\\''Brien.wav'");
  } finally {
    path.resolve = resolve;
    path.sep = separator;
  }
}

// Maps retain source identities, exact decoded offsets, selected URLs, and special object keys.
function buildsSpriteMap() {
  const settings = converter.parseArguments(['--output=mp3:192k:mono', '--output-dir=./dist/audio', '--output-name=Звуки #1']);
  const map = converter.buildSpriteMap([
    { name: 'effect.hit.mp3', duration: 0.125 },
    { name: '__proto__.flac', duration: 0.25 }
  ], 0.5, settings);
  assert.deepEqual(map.urls, ['./dist/audio/' + encodeURIComponent('Звуки #1') + '.mp3']);
  assert.deepEqual(map.sprite['effect.hit'], [0, 125]);
  assert.deepEqual(map.sprite.__proto__, [625, 250]);
  assert.equal(Object.getPrototypeOf(map.sprite), null);
}

// ----------------------------------------------------------------- Whole-workflow lifecycle without external tools

// Help is read-only, and successful publication creates only selected formatted results.
async function publishesResults(t) {
  const directory = workspace(t);
  const logs = captureLogs(t);
  const calls = mockAudioTools(t, directory);
  redirectTemporaryFiles(t, directory);
  await converter.main(['--help']);
  assert.equal(calls.length, 0);
  assert.match(logs[0][0], /Usage:/);
  const input = writeWav(path.join(directory, 'clip.wav'));
  const output = path.join(directory, 'results', 'nested');
  await converter.main([input, '--output=mp3:192k:mono', '--output-dir', output, '--output-name=custom']);
  assert.deepEqual(fs.readdirSync(output).sort(), ['custom.json', 'custom.mp3']);
  const json = fs.readFileSync(path.join(output, 'custom.json'), 'utf8');
  assert.equal(json, JSON.stringify(JSON.parse(json), null, 2) + '\n');
  assert.deepEqual(JSON.parse(json).sprite.clip, [0, 100]);
  assert(fs.readFileSync(input).includes(Buffer.from('WAVE')));
  assert(!fs.readdirSync(directory).some(

    // No intermediate workspace may survive a successful run.
    (name) => name.startsWith('audio-sprite-'),

  ));
}

// Decode, merge, and encoding failures remove intermediates and preserve existing results.
async function cleansFailedRuns(t) {
  const directory = workspace(t);
  const input = writeWav(path.join(directory, 'clip.wav'));
  const output = path.join(directory, 'results');
  fs.mkdirSync(output);
  const destination = path.join(output, 'merged.mp3');
  fs.writeFileSync(destination, 'previous result');

  for (const failOn of [1, 2, 3]) {
    t.mock.reset();
    captureLogs(t);
    redirectTemporaryFiles(t, directory);
    mockAudioTools(t, directory, { failOn });
    await assert.rejects(converter.main([input, '--output=mp3', '--output-dir', output]), /FFmpeg failed/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'previous result');
    assert(!fs.existsSync(path.join(output, 'merged.json')));
    assert(!fs.readdirSync(directory).some(

      // Cleanup must happen after every failure phase.
      (name) => name.startsWith('audio-sprite-'),

    ));
  }
}

// ----------------------------------------------------------------- Test registration

test('importing the converter has no side effects', importIsInert);
test('parses defaults and output overrides', parsesOutputSettings);
test('rejects invalid CLI options', rejectsInvalidOptions);
test('validates portable output names', validatesOutputNames);
test('discovers ordered and deduplicated inputs', discoversInputs);
test('protects source files from output collisions', protectsSourceFiles);
test('checks every selected encoder uniformly', verifiesEncoders);
test('probes the first audio stream', probesAudio);
test('classifies probe and filesystem failures', rejectsProbeFailures);
test('handles process launch, exit, and signal errors', handlesProcessFailures);
test('normalizes PCM settings and decoded duration', normalizesAudio);
test('prepares eligible sources and rejects ambiguous IDs', preparesEligibleInputs);
test('concatenates quoted paths with inter-clip silence', concatenatesClips);
test('quotes Windows concat paths consistently on every test host', formatsWindowsPaths);
test('builds sample-based sprite maps and encoded URLs', buildsSpriteMap);
test('publishes selected results and formatted JSON', publishesResults);
test('cleans workspaces after failed workflow phases', cleansFailedRuns);
