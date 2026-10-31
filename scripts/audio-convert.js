/**
 * Build an audio sprite from local media files or directories passed as positional
 * arguments. Probe contents rather than extensions,
 * select the first audio stream, and decode every accepted input to temporary PCM WAV (16-bit,
 * 44.1 kHz, stereo). Normalize the bundled assets/silence.wav the same way,
 * concatenate the normalized clips, and encode the configured output formats.
 *
 * Preserve argument order and scan directories nonrecursively in filename
 * order. Skip unsupported directory entries, reject invalid explicit inputs
 * and duplicate sprite IDs, and preserve original media files.
 * Check the selected FFmpeg build for all configured output encoders before decoding.
 *
 * Derive sprite timing from decoded WAV samples. Stage all encoded files in
 * an isolated temporary directory and publish the JSON map only after encoding
 * succeeds.
 *
 * Accept optional output format, bitrate, channel, and destination
 * overrides, plus a shared output basename. Create the destination recursively
 * and place audio and the formatted JSON map together there; default to the
 * current working directory. Input paths and relative destination paths use the
 * working directory, and JSON URLs retain the supplied destination prefix.
 *
 * Remove intermediates on success or failure
 * and report CLI failures with a nonzero exit status. The bundled silence asset
 * uses the project root.
 *
 * Tool installation belongs to setup scripts;
 * importing or running this CommonJS entry point starts the workflow immediately.
 */

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ----------------------------------------------------------------- Output formats and normalization settings

const projectRoot = path.resolve(__dirname, '..');
const supportedFormats = new Map([
  ['mp3', 'libmp3lame'],
  ['m4a', 'aac'],
  ['ogg', 'libvorbis'],
  ['ac3', 'ac3']
]);
const defaultOutputSpec = 'mp3,m4a,ogg,ac3';
const defaultOutputFilePath = './';
const defaultOutputFileName = 'merged';
const silencePath = path.join(projectRoot, 'assets', 'silence.wav');
const wavSampleRate = 44100;
const wavChannels = 2;

// ----------------------------------------------------------------- Output specification and CLI option parsing

// Parse format:bitrate:channels entries into distinct validated encoder settings.
const __parseOutputFormats = (value) => {
  const formats = [];
  const seen = new Set();

  for (const entry of value.split(',')) {
    const fields = entry.split(':');
    const format = fields[0].trim().toLowerCase();
    const bitrate = (fields[1]?.trim() || '128k').toLowerCase();
    const channels = (fields[2]?.trim() || 'stereo').toLowerCase();

    if (fields.length > 3 || !supportedFormats.has(format)) {
      throw new Error(`Invalid output specification "${entry}". Use format:bitrate:channels with mp3, m4a, ogg, or ac3.`);
    }

    if (!/^[1-9]\d*k$/.test(bitrate) || !Number.isSafeInteger(Number(bitrate.slice(0, -1)))) {
      throw new Error(`Invalid bitrate "${bitrate}". Use a positive integer followed by k, such as 128k.`);
    }

    if (channels !== 'mono' && channels !== 'stereo') {
      throw new Error(`Invalid channels "${channels}". Use mono or stereo.`);
    }

    if (seen.has(format)) {
      throw new Error(`Output format "${format}" was specified more than once.`);
    }

    seen.add(format);
    formats.push({
      format,
      bitrate,
      channels,
      options: ['-c:a', supportedFormats.get(format), '-b:a', bitrate, '-ac', channels === 'mono' ? '1' : '2']
    });
  }

  return formats;
}

// Validate a portable basename so generated files remain inside the chosen directory.
const __validateOutputName = (value) => {

  if (!value.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)) {
    throw new Error('Invalid output name. Use a base filename without directory separators, reserved characters, or trailing dots/spaces.');
  }

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error(`Output name "${value}" is reserved on Windows. Choose another base filename.`);
  }

  return value;
}

// Accept positional input paths and output options, plus a literal-path separator.
const __parseArguments = (args) => {
  const settings = {
    inputPaths: [],
    outputFormats: __parseOutputFormats(defaultOutputSpec),
    outputFilePath: defaultOutputFilePath,
    outputDirectory: path.resolve(defaultOutputFilePath),
    outputFileName: defaultOutputFileName,
    help: false
  };
  const seenOptions = new Set();
  let literalPaths = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (literalPaths) {
      settings.inputPaths.push(argument);
      continue;
    }

    if (argument === '--') {
      literalPaths = true;
      continue;
    }

    if (argument === '--help' || argument === '-h') {
      settings.help = true;
      continue;
    }

    const separator = argument.indexOf('=');
    const option = separator === -1 ? argument : argument.slice(0, separator);

    if (option === '--output' || option === '--output-dir' || option === '--output-name') {

      if (seenOptions.has(option)) {
        throw new Error(`Option ${option} was specified more than once.`);
      }

      seenOptions.add(option);
      const value = separator === -1 ? args[++index] : argument.slice(separator + 1);

      if (!value || (separator === -1 && value.startsWith('--'))) {
        throw new Error(`Option ${option} requires a value.`);
      }

      if (option === '--output') {
        settings.outputFormats = __parseOutputFormats(value);
      } else if (option === '--output-dir') {
        settings.outputFilePath = value;
        settings.outputDirectory = path.resolve(value);
      } else {
        settings.outputFileName = __validateOutputName(value);
      }

      continue;
    }

    if (argument.startsWith('-')) {
      throw new Error(`Unknown option "${argument}". Use --help or write dash-prefixed paths as "./filename".`);
    }

    settings.inputPaths.push(argument);
  }

  return settings;
}

// ----------------------------------------------------------------- CLI input discovery and output protection

// Identify generated destinations and their aliases so source media cannot be overwritten.
const __isOutputFile = (filePath, settings) => {
  const destinations = [path.join(settings.outputDirectory, `${settings.outputFileName}.json`)];

  for (const format of supportedFormats.keys()) {
    destinations.push(path.join(settings.outputDirectory, `${settings.outputFileName}.${format}`));
  }

  const realPath = fs.realpathSync(filePath);

  for (const destination of destinations) {

    if (filePath === destination || (fs.existsSync(destination) && realPath === fs.realpathSync(destination))) {
      return true;
    }

  }

  return false;
}

// Deduplicate paths while retaining whether a file was explicitly requested.
const __addInputFile = (filePath, explicit, selection, settings) => {

  if (__isOutputFile(filePath, settings)) {

    if (explicit) {
      throw new Error(`Input "${filePath}" conflicts with a generated output file.`);
    }

    return;
  }

  const realPath = fs.realpathSync(filePath);
  const existing = selection.get(realPath);

  if (existing) {
    existing.explicit = existing.explicit || explicit;
    return;
  }

  selection.set(realPath, { name: filePath, explicit });
}

// Collect regular files without extension filtering, preserving argument and folder order.
const __collectInputFiles = (inputPaths, settings) => {

  if (inputPaths.length === 0) {
    throw new Error('No input paths supplied. Usage: npm start -- <media-file ... | folder>. Use --help for examples.');
  }

  const selection = new Map();

  for (const inputPath of inputPaths) {
    const absolutePath = path.resolve(inputPath);
    const details = fs.statSync(absolutePath);

    if (details.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        const filePath = path.join(absolutePath, name);

        if (fs.statSync(filePath).isFile()) {
          __addInputFile(filePath, false, selection, settings);
        }

      }
    } else if (details.isFile()) {
      __addInputFile(absolutePath, true, selection, settings);
    } else {
      throw new Error(`Input must be a file or directory: "${absolutePath}".`);
    }

  }

  return [...selection.values()];
}

// ----------------------------------------------------------------- Content detection and external process execution

// Verify all selected output encoders with consistent diagnostics before creating intermediates.
const __checkOutputEncoders = async (outputFormats) => {
  await new Promise(

    // Inspect the encoder list from the same executable used for conversion.
    (resolve, reject) => {
      execFile('ffmpeg', ['-hide_banner', '-encoders'],

        // Collect every missing selected encoder and provide the same platform-specific remedy.
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`Cannot inspect FFmpeg encoders: ${stderr.trim() || error.message}. Run npm run setup:ffmpeg and check PATH.`));
            return;
          }

          const available = new Set();

          for (const line of stdout.split(/\r?\n/)) {
            const match = line.match(/^\s*A[.A-Z]{5}\s+(\S+)\s/);

            if (match) {
              available.add(match[1]);
            }

          }

          const missing = [];

          for (const format of outputFormats) {
            const encoder = supportedFormats.get(format.format);

            if (!available.has(encoder)) {
              missing.push(`${encoder} (${format.format})`);
            }

          }

          if (missing.length > 0) {
            const remedy = process.platform === 'darwin'
              ? 'Run npm run setup:ffmpeg if needed, then in the same terminal:\nexport PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"'
              : process.platform === 'win32'
                ? 'Run npm run setup:ffmpeg, then reopen your terminal so the full FFmpeg build is on PATH.'
                : 'Install an FFmpeg build with the required audio encoders using your system package manager and put it on PATH.';
            reject(new Error(`The FFmpeg selected by PATH is missing required audio encoders: ${missing.join(', ')}.\n${remedy}`));
            return;
          }

          resolve();
        },

      );
    },

  );
}

// Probe the first audio stream; mark unrecognized media as skippable for folder scans.
const __probeAudio = (filePath) => {
  fs.accessSync(filePath, fs.constants.R_OK);

  return new Promise(

    // Distinguish unsupported media from missing tools and malformed probe responses.
    (resolve, reject) => {
      execFile('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0', '-show_entries',
        'stream=index,codec_type,codec_name,sample_rate,channels,bits_per_sample,duration,duration_ts,time_base:format=format_name,duration',
        '-of', 'json', filePath
      ],

        // Parse content metadata without requiring source durations or a particular bit depth.
        (error, json, stderr) => {

          if (error) {
            const failure = new Error(`ffprobe failed for "${filePath}": ${stderr.trim() || error.message}`);
            failure.invalidMedia = typeof error.code === 'number';
            reject(failure);
            return;
          }

          try {
            const metadata = JSON.parse(json);
            const details = metadata.streams?.find(

              // Use the selected audio stream, ignoring any video or attachment streams.
              (stream) => stream.codec_type === 'audio',

            );

            if (!details) {
              const failure = new Error(`No audio stream was found in "${filePath}".`);
              failure.invalidMedia = true;
              reject(failure);
              return;
            }

            resolve(details);
          } catch (error) {
            reject(new Error(`Invalid ffprobe metadata for "${filePath}": ${error.message}`));
          }
        },

      );
    },

  );
}

// Run FFmpeg without a shell, forwarding diagnostics and rejecting any failed process.
const __runFfmpeg = (args) => {
  return new Promise(

    // Wait for process closure so temporary files are no longer in use on Windows.
    (resolve, reject) => {
      const encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
        stdio: ['ignore', 'ignore', 'inherit']
      });

      encoder.once('error',

        // Report launch failures such as FFmpeg missing from PATH.
        (error) => {
          reject(new Error(`Cannot start FFmpeg: ${error.message}`));
        },

      );

      encoder.once('close',

        // Treat termination by a signal or a nonzero exit status as a failed command.
        (code, signal) => {

          if (code !== 0) {
            reject(new Error(`FFmpeg failed (${signal || `exit code ${code}`}). See its diagnostic above.`));
            return;
          }

          resolve();
        },

      );
    },

  );
}

// ----------------------------------------------------------------- Temporary WAV normalization and sample timing

// Decode the first audio stream to a common WAV format and measure the decoded result.
const __normalizeAudio = async (sourcePath, wavPath) => {
  await __runFfmpeg([
    '-i', sourcePath, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le',
    '-ar', String(wavSampleRate), '-ac', String(wavChannels), '-map_metadata', '-1', wavPath
  ]);
  const details = await __probeAudio(wavPath);
  const sampleDuration = details.time_base === `1/${wavSampleRate}`
    ? Number(details.duration_ts) / wavSampleRate
    : Number.NaN;
  const duration = Number.isFinite(sampleDuration)
    ? sampleDuration
    : Number.parseFloat(details.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Decoded audio has no positive duration: "${sourcePath}".`);
  }

  return { name: sourcePath, wavPath, duration };
}

// Detect eligible inputs, reject ambiguous IDs, and normalize supported media sequentially.
const __prepareInputs = async (inputs, workspace) => {
  const prepared = [];
  const soundIds = new Set();

  for (const input of inputs) {
    let details;

    try {
      details = await __probeAudio(input.name);
    } catch (error) {

      if (!input.explicit && error.invalidMedia) {
        console.warn(`Skipping "${input.name}": ${error.message}`);
        continue;
      }

      throw error;
    }

    const soundId = path.parse(input.name).name;

    if (soundIds.has(soundId)) {
      throw new Error(`Duplicate sprite ID "${soundId}". Give input files distinct names.`);
    }

    soundIds.add(soundId);
    console.log(`Preparing "${input.name}" (${details.codec_name || 'audio'}) as PCM WAV.`);
    const wavPath = path.join(workspace, `input-${prepared.length}.wav`);
    prepared.push(await __normalizeAudio(input.name, wavPath));
  }

  if (prepared.length === 0) {
    throw new Error('No supported files with audio streams were found in the supplied paths.');
  }

  return prepared;
}

// ----------------------------------------------------------------- Concatenation and sprite map generation

// Quote absolute paths for FFmpeg concat syntax, including Windows separators and apostrophes.
const __formatConcatEntry = (filePath) => {
  const absolutePath = path.resolve(filePath);
  const concatPath = path.sep === '\\'
    ? absolutePath.split(path.sep).join('/')
    : absolutePath;
  return `file '${concatPath.replace(/'/g, "'\\''")}'`;
}

// Join identically formatted WAV files with the normalized silence between clips.
const __mergeWavFiles = async (inputs, silence, workspace) => {
  const files = [];

  for (const input of inputs) {

    if (files.length > 0) {
      files.push(silence.wavPath);
    }

    files.push(input.wavPath);
  }

  const fileListPath = path.join(workspace, 'concat.txt');
  fs.writeFileSync(fileListPath, files.map(__formatConcatEntry).join('\n'));
  const mergedPath = path.join(workspace, 'merged.wav');
  await __runFfmpeg(['-f', 'concat', '-safe', '0', '-i', fileListPath, '-c:a', 'copy', mergedPath]);
  return mergedPath;
}

// Compute sprite offsets from decoded durations, retaining IDs from original filenames.
const __buildSpriteMap = (inputs, silenceDuration, settings) => {
  const outputMap = { urls: [], sprite: Object.create(null) };
  const normalizedPrefix = settings.outputFilePath.split(path.sep).join('/');
  const urlPrefix = normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`;
  const urlName = encodeURIComponent(settings.outputFileName);

  for (const format of settings.outputFormats) {
    outputMap.urls.push(`${urlPrefix}${urlName}.${format.format}`);
  }

  let cursor = 0;

  for (const input of inputs) {
    const duration = input.duration * 1000;
    outputMap.sprite[path.parse(input.name).name] = [cursor, duration];
    cursor += duration + silenceDuration * 1000;
  }

  return outputMap;
}

// ----------------------------------------------------------------- CLI workflow and temporary workspace lifecycle

// Normalize, merge, stage all encodings, and publish outputs while always cleaning intermediates.
const __main = async () => {
  const settings = __parseArguments(process.argv.slice(2));

  if (settings.help) {
    console.log([
      'Usage:',
      '  npm start -- <media-file> [more-files ...] [options]',
      '  node scripts/audio-convert.js <folder> [options]',
      '',
      'Options:',
      '  --output "mp3:192k:stereo,ogg:96k:mono"',
      '    Replace output formats; omitted bitrate/channels default to 128k/stereo.',
      '  --output-dir "./dist/audio"',
      '    Create the results directory; defaults to ./ (current directory).',
      '  --output-name "ui-sounds"',
      '    Set the shared base filename without an extension; defaults to merged.',
      '  --help, -h',
      '    Show this help.',
      '',
      'With npm start, the first -- forwards options to the script; direct node invocation needs no separator.',
      'Folders are scanned nonrecursively in filename order. Formats are detected with ffprobe;',
      'the first audio stream is normalized to WAV before merging.'
    ].join('\n'));
    return;
  }

  const inputs = __collectInputFiles(settings.inputPaths, settings);
  await __checkOutputEncoders(settings.outputFormats);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-sprite-'));

  try {
    const prepared = await __prepareInputs(inputs, workspace);
    let silence = null;

    if (prepared.length > 1) {
      silence = await __normalizeAudio(silencePath, path.join(workspace, 'silence.wav'));
    }

    const mergedPath = await __mergeWavFiles(prepared, silence, workspace);

    for (const format of settings.outputFormats) {
      const encodedPath = path.join(workspace, `${settings.outputFileName}.${format.format}`);
      await __runFfmpeg(['-i', mergedPath, ...format.options, '-map_metadata', '-1', encodedPath]);
      console.log(`${format.format} (${format.bitrate}, ${format.channels}) file converted successfully.`);
    }

    fs.mkdirSync(settings.outputDirectory, { recursive: true });

    for (const format of settings.outputFormats) {
      const filename = `${settings.outputFileName}.${format.format}`;
      fs.copyFileSync(path.join(workspace, filename), path.join(settings.outputDirectory, filename));
    }

    const outputMap = __buildSpriteMap(prepared, silence?.duration || 0, settings);
    fs.writeFileSync(path.join(settings.outputDirectory, `${settings.outputFileName}.json`), `${JSON.stringify(outputMap, null, 2)}\n`);
    console.log(outputMap);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

__main().catch(

  // Report failures after workspace cleanup and return a nonzero CLI exit status.
  (error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  },

);
