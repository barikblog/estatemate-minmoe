#!/usr/bin/env node
/**
 * Compiles the EstateMate ESP32 gate sketch for the host with g++ and runs its
 * host tests (esp32-gate/host-test/test_main.cpp).
 *
 * The sketch needs ArduinoJson 7. It is found, in order, at $ARDUINOJSON_DIR,
 * then in node_modules/.cache/arduinojson-<version>, and otherwise shallow-cloned
 * there from GitHub at a pinned tag (MIT licensed, header only, never committed).
 *
 * Without g++ or network access the script says so and exits 0 locally, but in
 * CI (CI=true) a missing prerequisite is a failure: the check must not silently
 * stop running.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARDUINOJSON_VERSION = 'v7.4.2';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.env.CI === 'true' || process.env.ESP32_HOST_TEST_STRICT === '1';

function unavailable(reason) {
  const message = `ESP32 gate host test skipped: ${reason}`;
  if (strict) {
    console.error(`::error::${message}`);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

const compiler = process.env.CXX || 'g++';
if (spawnSync(compiler, ['--version'], { stdio: 'ignore' }).status !== 0) unavailable(`${compiler} is not installed`);

let arduinoJson = process.env.ARDUINOJSON_DIR;
if (!arduinoJson) {
  arduinoJson = join(root, 'node_modules', '.cache', `arduinojson-${ARDUINOJSON_VERSION}`);
  if (!existsSync(join(arduinoJson, 'src', 'ArduinoJson.h'))) {
    mkdirSync(dirname(arduinoJson), { recursive: true });
    const clone = spawnSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', ARDUINOJSON_VERSION, 'https://github.com/bblanchon/ArduinoJson.git', arduinoJson], { stdio: 'inherit' });
    if (clone.status !== 0) unavailable('ArduinoJson could not be downloaded (set ARDUINOJSON_DIR to a local checkout)');
  }
}
const include = existsSync(join(arduinoJson, 'src', 'ArduinoJson.h')) ? join(arduinoJson, 'src') : arduinoJson;

const hostTest = join(root, 'esp32-gate', 'host-test');
const scratch = mkdtempSync(join(tmpdir(), 'esp32-gate-'));
const binary = join(scratch, 'esp32-gate-host-test');
try {
  execFileSync(compiler, [
    '-std=gnu++17', '-O1', '-g', '-Wall', '-Wextra', '-Wno-unused-parameter', '-Wno-unused-function', '-Wno-maybe-uninitialized', '-Werror',
    '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-I', join(hostTest, 'stubs'), '-I', hostTest, '-isystem', include,
    join(hostTest, 'test_main.cpp'), '-o', binary,
  ], { stdio: 'inherit' });
  const fsRoot = join(scratch, 'flash');
  mkdirSync(fsRoot);
  execFileSync(binary, [fsRoot, join(hostTest, 'fixtures')], { stdio: 'inherit' });
} catch (error) {
  console.error('ESP32 gate host test failed.');
  process.exit(typeof error?.status === 'number' && error.status ? error.status : 1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
