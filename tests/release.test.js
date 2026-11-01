/**
 * Verify release metadata and channel selection without contacting npm or GitHub.
 * Test stable and prerelease tags, lockfile consistency, versioned changelog entries, GitHub event parsing,
 * controlled step outputs, and CLI failure reporting. All event/output files are
 * temporary, and no test authenticates, creates a release, or publishes a package.
 */

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateRelease, validateChangelog } = require("../scripts/release-check.js");
const { workspace } = require("./helpers.js");

// ----------------------------------------------------------------- Manifest fixtures and release invariants

// Produce matching package identities for testing release versions independently of the repository.
function manifests(version = "1.0.6") {
  const manifest = { name: "@d-velopment/audio-sprite", version };
  return { manifest, lock: { ...manifest, packages: { "": { ...manifest } } } };
}

// Stable releases publish to latest and prereleases publish to next only when flags match.
function selectsReleaseChannel() {
  const stable = manifests();
  assert.equal(validateRelease(stable.manifest, stable.lock, { tag_name: "v1.0.6", prerelease: false }), "latest");
  const beta = manifests("2.0.0-beta.1");
  assert.equal(validateRelease(beta.manifest, beta.lock, { tag_name: "v2.0.0-beta.1", prerelease: true }), "next");
}

// Drafts, inconsistent tags, mismatched lockfiles, and incorrect channel flags must block publishing.
function rejectsInvalidReleases() {
  const { manifest, lock } = manifests();
  const cases = [
    [lock, undefined, /published GitHub Release/],
    [lock, { draft: true, tag_name: "v1.0.6" }, /published GitHub Release/],
    [lock, { tag_name: "v9.0.0" }, /Release tag must equal/],
    [lock, { tag_name: "1.0.6" }, /Release tag must equal/],
    [{ ...lock, version: "0.0.0" }, { tag_name: "v1.0.6" }, /matching names and versions/],
    [{ ...lock, name: "other" }, { tag_name: "v1.0.6" }, /matching names and versions/],
    [{ ...lock, packages: {} }, { tag_name: "v1.0.6" }, /matching names and versions/],
    [lock, { tag_name: "v1.0.6", prerelease: true }, /prerelease flag/]
  ];

  for (const [candidateLock, release, pattern] of cases) {
    assert.throws(

      // Validation must fail without performing a registry request.
      () => validateRelease(manifest, candidateLock, release),

      pattern
    );
  }
}

// ----------------------------------------------------------------- Changelog requirements

// Accept documented stable and prerelease versions, including dated entries and Windows line endings.
function acceptsVersionedChanges() {
  validateChangelog("# Changelog\n\n## [Unreleased]\n\n## [1.0.6]\n\n### Added\n\n- CLI commands.\n", "1.0.6");
  validateChangelog("## [2.0.0-beta.1] - 2026-11-01\r\n\r\n* New output format.\r\n", "2.0.0-beta.1");
}

// Other versions, placeholders, and comments must not satisfy the current version's release notes.
function rejectsMissingChanges() {
  const cases = [
    ["## [Unreleased]\n- Pending changes.\n", /must contain a ##/],
    ["## [1.0.60]\n- Different version.\n", /must contain a ##/],
    ["<!--\n## [1.0.6]\n- Hidden entry.\n-->\n", /must contain a ##/],
    ["## [1.0.6]\n\n### Added\n", /must contain change bullets/],
    ["## [1.0.6]\n<!-- - Placeholder. -->\n", /must contain change bullets/],
    ["## [1.0.6]\n\n## [1.0.5]\n- Earlier changes.\n", /must contain change bullets/]
  ];

  for (const [changelog, pattern] of cases) {
    assert.throws(

      // Validate only this version's visible changes, without modifying release files.
      () => validateChangelog(changelog, "1.0.6"),

      pattern
    );
  }
}

// ----------------------------------------------------------------- GitHub event and CLI contracts

// The release check consumes event JSON and writes only the validated npm channel.
function checksGithubEvent(t) {
  const directory = workspace(t);
  const event = path.join(directory, "event.json");
  const output = path.join(directory, "output.txt");
  const manifest = require("../package.json");
  fs.writeFileSync(event, JSON.stringify({ release: { tag_name: `v${manifest.version}`, prerelease: false } }));
  const env = { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output };
  const result = childProcess.spawnSync(process.execPath, [require.resolve("../scripts/release-check.js")], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, "utf8"), "dist-tag=latest\n");
  delete env.GITHUB_OUTPUT;
  const withoutOutput = childProcess.spawnSync(process.execPath, [require.resolve("../scripts/release-check.js")], { env, encoding: "utf8" });
  assert.equal(withoutOutput.status, 0, withoutOutput.stderr);
  assert.match(withoutOutput.stdout, /Validated @d-velopment\/audio-sprite@/);
  delete env.GITHUB_EVENT_PATH;
  const missingEvent = childProcess.spawnSync(process.execPath, [require.resolve("../scripts/release-check.js")], { env, encoding: "utf8" });
  assert.equal(missingEvent.status, 1);
  assert.match(missingEvent.stderr, /GITHUB_EVENT_PATH is required/);
}

// ----------------------------------------------------------------- Test registration

test("release versions select latest or next consistently", selectsReleaseChannel);
test("release validation rejects mismatches before publication", rejectsInvalidReleases);
test("release changelog accepts versioned change entries", acceptsVersionedChanges);
test("release changelog rejects missing or empty version entries", rejectsMissingChanges);
test("release CLI validates event metadata and writes step outputs", checksGithubEvent);
