#!/usr/bin/env node
/**
 * Repository self-check.
 *
 * Runs the checks that must never regress before code leaves this machine:
 * committed secrets, leaked absolute paths, stray backup or key files, broken
 * JSON, broken JavaScript/Python syntax, and a manifest whose browser-module id
 * no longer matches the package name.
 *
 * No dependencies, so `node scripts/check.mjs` works in a bare checkout and in CI.
 *
 * Usage: node scripts/check.mjs [--strict]
 *   --strict  treat warnings as failures (used by prepublishOnly and CI)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const STRICT = process.argv.includes('--strict')

/** Directories that are never part of the repository. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'out'])

/** Files that are large or binary; never text-scanned. */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.woff', '.woff2'])

const problems = []
const warnings = []
const fail = (check, message) => problems.push(`[${check}] ${message}`)
const warn = (check, message) => warnings.push(`[${check}] ${message}`)

/** Walk the tree, returning repository-relative POSIX paths. */
function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.gitignore') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      found.push(...walk(full))
    } else if (entry.isFile()) {
      found.push(relative(ROOT, full).split('\\').join('/'))
    }
  }
  return found
}

const files = walk(ROOT)

// 1. Artifacts and secrets that must not be committed at all.
for (const file of files) {
  const base = file.split('/').pop()
  if (/\.bak($|-)/.test(base)) fail('artifact', `backup file would be committed: ${file}`)
  if (base === 'mimo_api_key.txt' || base === '.env') fail('secret', `secret file would be committed: ${file}`)
  if (/^\.env\./.test(base) && base !== '.env.example') fail('secret', `env file would be committed: ${file}`)
}

// 2. Text scans: API keys and machine-specific absolute paths.
/** A MiMo key is `sk-` and 40-ish alphanumerics; short placeholders never match. */
const KEY_PATTERN = /sk-[A-Za-z0-9]{20,}/
/** This project's authoring machine root; any hit means a path was hardcoded. */
const LOCAL_ROOT_PATTERN = /[A-Za-z]:[\\/]Deepseek[_-][Hh]arness/i
/** A concrete POSIX home directory (a placeholder such as `~/` or `...` is fine). */
const POSIX_HOME_PATTERN = /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//
for (const file of files) {
  if (BINARY_EXT.has(extname(file).toLowerCase())) continue
  if (file.endsWith('.example')) continue
  let text
  try {
    text = readFileSync(join(ROOT, file), 'utf8')
  } catch {
    continue
  }
  if (KEY_PATTERN.test(text)) fail('secret', `API key found in ${file}`)
  const local = text.match(LOCAL_ROOT_PATTERN)
  if (local !== null) fail('path', `machine-specific root "${local[0]}" in ${file}`)
  const home = text.match(POSIX_HOME_PATTERN)
  if (home !== null) warn('path', `concrete home directory "${home[0]}" in ${file}`)
}

// 3. JSON validity.
for (const file of files) {
  if (extname(file).toLowerCase() !== '.json') continue
  try {
    JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
  } catch (error) {
    fail('json', `${file}: ${error.message}`)
  }
}

// 4. JavaScript syntax, checked by the interpreter already running this script.
for (const file of files) {
  if (!['.js', '.mjs'].includes(extname(file).toLowerCase())) continue
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' })
  } catch (error) {
    fail('js', `${file}: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`)
  }
}

// 5. Python syntax, when an interpreter is available.
const python = ['python3', 'python'].find((candidate) => {
  try {
    execFileSync(candidate, ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})
if (python === undefined) {
  warn('python', 'no Python interpreter on PATH; skipped python/mimo_vision.py compile check')
} else {
  try {
    execFileSync(python, ['-m', 'py_compile', join(ROOT, 'python', 'mimo_vision.py')], { stdio: 'pipe' })
  } catch (error) {
    fail('python', `python/mimo_vision.py: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`)
  }
}

// 6. Manifest consistency, including the browser-module id that must equal the package name.
const manifestPath = join(ROOT, 'package.json')
if (!existsSync(manifestPath)) {
  fail('manifest', 'package.json is missing')
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const field of ['name', 'version', 'license', 'description']) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') fail('manifest', `package.json is missing "${field}"`)
  }
  if (manifest.private === true) warn('manifest', 'package.json is private; npm publish would be refused')
  if (manifest.dsh?.client?.platform !== 'web') warn('manifest', 'dsh.client.platform is not "web"; the sidebar view would not load')
  if (manifest.exports?.['./client'] === undefined) fail('manifest', 'package.json exports no "./client" bundle')

  const clientPath = join(ROOT, 'client.js')
  if (!existsSync(clientPath)) {
    fail('manifest', 'client.js is missing although dsh.client is declared')
  } else {
    const match = readFileSync(clientPath, 'utf8').match(/id:\s*'([^']+)'/)
    const id = match === null ? '' : match[1]
    if (id !== manifest.name) {
      fail(
        'manifest',
        `client.js registers module id "${id}" but the package name is "${manifest.name}"; ` +
          'the browser module id must equal the package name',
      )
    }
  }
}

// 7. The ignore rules that keep secrets out must survive edits.
if (!existsSync(join(ROOT, '.gitignore'))) {
  fail('gitignore', '.gitignore is missing')
} else if (!/^mimo_api_key\.txt$/m.test(readFileSync(join(ROOT, '.gitignore'), 'utf8'))) {
  fail('gitignore', '.gitignore does not ignore mimo_api_key.txt')
}

// Report.
for (const line of warnings) process.stdout.write(`warn  ${line}\n`)
for (const line of problems) process.stdout.write(`error ${line}\n`)
const failed = problems.length > 0 || (STRICT && warnings.length > 0)
process.stdout.write(
  `\n${failed ? 'FAILED' : 'OK'}: ${problems.length} error(s), ${warnings.length} warning(s) across ${files.length} files\n`,
)
process.exit(failed ? 1 : 0)
