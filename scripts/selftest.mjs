#!/usr/bin/env node
/**
 * Wrapper self-test.
 *
 * Exercises the Host half without a DSH process, an API key, or a network call: `apply`
 * runs against a fake context whose subprocess is a stub, so the assertions cover exactly
 * the wiring that is easy to break silently — resolved script path, argv shape, environment
 * scrubbing, key forwarding, and the three result-mapping branches.
 *
 * The Host half imports its DSH peer dependencies, so this script needs them installed.
 * In a bare checkout (or a CI job that does not install them) it reports a skip and exits
 * 0 rather than failing: absence of a dependency is not a defect in this package.
 *
 * Usage: node scripts/selftest.mjs
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Import the Host half, or skip the whole run when its peer dependencies are absent. */
async function loadHostHalf() {
  try {
    return { apply: (await import(pathToFileURL(join(ROOT, 'index.js')).href)).apply }
  } catch (error) {
    const message = String(error?.message ?? error)
    const missingPeer = error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('@deepseek-ai/')
    if (!missingPeer) throw error
    process.stdout.write(
      `skip: index.js needs its peer dependencies installed (${message.split('\n')[0]})\n` +
        '      run `npm install`, or install @deepseek-ai/dsh-tools and @deepseek-ai/schemastery, to run these checks\n',
    )
    process.exit(0)
  }
}

const { apply } = await loadHostHalf()

/** One recorded spawn plus a handle that reports the given outcome. */
function harness(outcome) {
  const spawns = []
  const tools = []
  const handle = {
    done: Promise.resolve({ exitCode: outcome.exitCode }),
    collected: {
      stdout: { readFrom: () => ({ text: outcome.stdout ?? '', lossy: outcome.lossy === true }) },
      stderr: { readFrom: () => ({ text: outcome.stderr ?? '', lossy: false }) },
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    subprocess: {
      spawn(spec) {
        spawns.push(spec)
        return handle
      },
    },
  }
  return { ctx, spawns, tools }
}

/** Register the tool against a stub context and return it. */
function load(config) {
  const env = harness(config.__outcome ?? { exitCode: 0, stdout: JSON.stringify({ ok: true, answer: 'a cat', model: 'm' }) })
  apply(env.ctx, config)
  assert.equal(env.tools.length, 1, 'apply must register exactly one tool')
  const tool = env.tools[0]
  assert.equal(tool.name, 'mimo_vision', 'tool must be named mimo_vision')
  return { tool, spawns: env.spawns }
}

let passed = 0
/** Run one labelled case and report it. */
async function test(label, body) {
  await body()
  passed += 1
  process.stdout.write(`ok  ${label}\n`)
}

await test('successful call maps the JSON answer and wires the subprocess', async () => {
  const { tool, spawns } = load({})
  const result = await tool.execute({ image_path: '/tmp/cat.png', prompt: 'what is this?' }, {})
  assert.deepEqual(result, { ok: true, answer: 'a cat', model: 'm' })
  assert.equal(spawns.length, 1, 'exactly one spawn')

  const spec = spawns[0]
  // Paths must resolve inside the package, never to an authoring machine.
  assert.ok(spec.argv[1].endsWith(join('python', 'mimo_vision.py')), `unexpected script path: ${spec.argv[1]}`)
  assert.equal(spec.cwd, join(ROOT, 'python'), 'cwd defaults to the script directory')
  assert.deepEqual(spec.argv.slice(2), [
    '/tmp/cat.png',
    'what is this?',
    '--model',
    'mimo-v2.6-flash',
    '--thinking',
    'disabled',
  ])

  // Inherited proxy variables must be cleared; key forwarding stays opt-in.
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy']) {
    assert.equal(spec.env[name], undefined, `${name} must be cleared`)
  }
  assert.equal(spec.env.PYTHONUTF8, '1')
  assert.equal(spec.env.MIMO_API_KEY, process.env.MIMO_API_KEY?.trim() || undefined, 'key is forwarded only when set')
})

await test('configuration overrides the model, thinking mode and read timeout', async () => {
  const { tool, spawns } = load({ model: 'mimo-v2.5', thinking: 'enabled', readTimeoutSec: 300 })
  await tool.execute({ image_path: '/tmp/cat.png' }, {})
  assert.deepEqual(spawns[0].argv.slice(2), [
    '/tmp/cat.png',
    '--model',
    'mimo-v2.5',
    '--thinking',
    'enabled',
    '--read-timeout',
    '300',
  ])
})

await test('a missing client is reported before any spawn happens', async () => {
  const { tool, spawns } = load({ scriptPath: join(ROOT, 'python', 'does-not-exist.py') })
  const result = await tool.execute({ image_path: '/tmp/cat.png' }, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /mimo_vision\.py not found/)
  assert.equal(spawns.length, 0, 'must not spawn a missing script')
})

await test('an empty image path is rejected without a spawn', async () => {
  const { tool, spawns } = load({})
  const result = await tool.execute({ image_path: '   ' }, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /image_path/)
  assert.equal(spawns.length, 0)
})

await test('a non-zero exit surfaces the client stderr', async () => {
  const { tool } = load({
    __outcome: { exitCode: 1, stdout: '', stderr: 'boom: no key' },
  })
  const result = await tool.execute({ image_path: '/tmp/cat.png' }, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /exited with code 1/)
  assert.match(result.detail, /boom: no key/)
})

await test('a structured client failure keeps its error and detail', async () => {
  const { tool } = load({
    __outcome: { exitCode: 0, stdout: JSON.stringify({ ok: false, error: 'missing key', detail: 'set MIMO_API_KEY' }) },
  })
  const result = await tool.execute({ image_path: '/tmp/cat.png' }, {})
  assert.deepEqual(result, { ok: false, error: 'missing key', detail: 'set MIMO_API_KEY' })
})

await test('unparseable output is reported rather than thrown', async () => {
  const { tool } = load({ __outcome: { exitCode: 0, stdout: 'not json' } })
  const result = await tool.execute({ image_path: '/tmp/cat.png' }, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /could not parse/)
})

process.stdout.write(`\nOK: ${passed} self-test case(s)\n`)
