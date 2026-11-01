/**
 * Validate GitHub Release metadata before any npm publication. Require a v-prefixed
 * tag matching the checked-out manifest, an equivalent lockfile identity/version,
 * matching stable/prerelease classification, and a versioned changelog entry
 * containing change bullets. Emit only a controlled npm
 * distribution tag to GitHub step outputs. This module never authenticates or
 * publishes; importing exposes validation helpers without running the CLI.
 */

const fs = require("node:fs");
const path = require("node:path");

// ----------------------------------------------------------------- Release identity and channel validation

// Validate a release against package metadata and choose its npm distribution channel.
function validateRelease(manifest, lock, release) {

  if (!release || release.draft) {
    throw new Error("A published GitHub Release is required.");
  }

  if (release.tag_name !== `v${manifest.version}`) {
    throw new Error(`Release tag must equal v${manifest.version}; received ${release.tag_name}.`);
  }

  if (lock.name !== manifest.name || lock.version !== manifest.version ||
      lock.packages?.[""]?.name !== manifest.name || lock.packages?.[""]?.version !== manifest.version) {
    throw new Error("package.json and package-lock.json must have matching names and versions.");
  }

  const prerelease = manifest.version.includes("-");

  if (Boolean(release.prerelease) !== prerelease) {
    throw new Error("The GitHub prerelease flag must match the package version's prerelease suffix.");
  }

  return prerelease ? "next" : "latest";
}

// ----------------------------------------------------------------- Versioned change documentation

// Require change bullets in this version's section, excluding other versions and HTML comments.
function validateChangelog(changelog, version) {
  const sections = changelog.replace(/<!--[\s\S]*?-->/g, "").split(/^## /m).slice(1);

  for (const section of sections) {
    const [heading, ...body] = section.split(/\r?\n/);

    if (heading.trim().split(" - ")[0] !== `[${version}]`) {
      continue;
    }

    if (!/^[-*] \S/m.test(body.join("\n"))) {
      throw new Error(`CHANGELOG.md entry for ${version} must contain change bullets.`);
    }

    return;
  }

  throw new Error(`CHANGELOG.md must contain a ## [${version}] entry.`);
}

// ----------------------------------------------------------------- GitHub Actions entry point

// Read the event, manifests, and changelog, then emit the channel after all release checks pass.
function main() {
  const root = path.resolve(__dirname, "..");

  if (!process.env.GITHUB_EVENT_PATH) {
    throw new Error("GITHUB_EVENT_PATH is required; run this check from the release workflow.");
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const tag = validateRelease(manifest, lock, event.release);
  validateChangelog(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), manifest.version);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `dist-tag=${tag}\n`);
  }

  console.log(`Validated ${manifest.name}@${manifest.version}; npm dist-tag: ${tag}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateRelease, validateChangelog, main };
