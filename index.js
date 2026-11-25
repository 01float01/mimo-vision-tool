/**
 * mimo-vision-tool — Host half.
 *
 * Registers the `mimo_vision` Tool: base64-encodes a local image and asks the
 * Xiaomi MiMo vision model (`mimo-v2.6-flash` by default, passed with `--model`)
 * through the bundled `python/mimo_vision.py` client, then returns the model's
 * answer as text.
 *
 * Everything is resolved relative to this package, so a fresh clone works with no
 * absolute paths: `pythonExe` defaults to the interpreter on PATH, and
 * `scriptPath` defaults to the client shipped inside the package. Both, plus the
 * model / thinking mode / timeout / proxy policy, are overridable through the
 * loader row `config` (see the README) or, for the two path settings, through
 * `DSH_MIMO_VISION_PYTHON` / `DSH_MIMO_VISION_SCRIPT`.
 *
 * API keys are never embedded here and never passed on the command line: the
 * wrapper forwards `MIMO_API_KEY` from its own environment when set, and
 * otherwise the Python client reads `python/mimo_api_key.txt` next to itself.
 * The client refuses to run without one.
 *
 * Design notes worth keeping before changing anything:
 * - The wall-clock budget (`budgetMs`) is the LAST resort only. The Python client
 *   has its own budget (read timeout 240 s < hard timeout 250 s, no retry for slow
 *   attempts). Keep the plugin budget strictly larger, or a request that would
 *   have succeeded gets killed with an uninformative "timeout" message.
 * - Proxy environment variables inherited from the launcher are cleared, then a
 *   single explicit `MIMO_PROXY_URL` is supplied only when a proxy is actually
 *   reachable. The China endpoint usually needs no proxy.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveProxyUrl } from './lib/net-router.js'

export const name = 'mimo-vision-tool'

/** Host-plane hard dependencies: the tool registry and the subprocess service. */
export const inject = ['tools', 'subprocess']

/** This package's directory, used to resolve the bundled Python client. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** The Python client shipped with the package. */
const BUNDLED_SCRIPT = join(PACKAGE_DIR, 'python', 'mimo_vision.py')

/** Read an optional string setting, treating blank input as "not set". */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Loader-row configuration. Every field has a working default. */
export const Config = z.object({
  /**
   * Python interpreter used to run the client. Empty (default) means `python` on
   * Windows and `python3` elsewhere. Point this at a virtualenv when the client's
   * dependencies (`openai`, `httpx`) live in one.
   */
  pythonExe: z.string().default(''),
  /**
   * Path to `mimo_vision.py`. Empty (default) means the copy bundled under
   * `python/`. Set it only to run a different client (for example a patched or
   * shared one).
   */
  scriptPath: z.string().default(''),
  /**
   * Working directory for the subprocess (and therefore where `mimo_api_key.txt`
   * is looked up when `MIMO_API_KEY` is unset). Empty (default) means the
   * directory holding `scriptPath`.
   */
  scriptDir: z.string().default(''),
  /**
   * Vision model id, passed with `--model`. Kept in config so switching models
   * never needs a code change.
   */
  model: z.string().default('mimo-v2.6-flash'),
  /**
   * Thinking mode, passed with `--thinking`: `disabled` (default) | `enabled` |
   * `auto`. The platform default is *enabled*, which is roughly 50x slower on
   * short prompts and easily overruns a vision request's budget; image
   * understanding does not need it.
   */
  thinking: z.string().default('disabled'),
  /**
   * Per-request read timeout in seconds; 0 (default) keeps the client's 240 s.
   * Raising it also raises the client's hard timeout and this plugin's
   * wall-clock budget, so the whole chain scales together.
   */
  readTimeoutSec: z.number().default(0),
  /**
   * Whether to route the request through a proxy. `false` (default) connects
   * directly and ignores inherited proxy variables.
   */
  useProxy: z.boolean().default(false),
  /** Proxy URL tried when `useProxy` is true. */
  proxyUrl: z.string().default('http://127.0.0.1:7891'),
})

/**
 * Resolve interpreter, script and working directory for one invocation.
 * @param config - the loader row's configuration.
 * @returns absolute-ish runtime paths plus the reason they could not be resolved.
 */
function resolveRuntime(config) {
  const scriptPath =
    text(config.scriptPath) || text(process.env.DSH_MIMO_VISION_SCRIPT) || BUNDLED_SCRIPT
  const pythonExe =
    text(config.pythonExe) ||
    text(process.env.DSH_MIMO_VISION_PYTHON) ||
    (process.platform === 'win32' ? 'python' : 'python3')
  const scriptDir = text(config.scriptDir) || dirname(scriptPath)
  return { pythonExe, scriptPath, scriptDir }
}

export function apply(ctx, config = {}) {
  const model = text(config.model) || 'mimo-v2.6-flash'
  const thinking = text(config.thinking) || 'disabled'
  const configuredTimeout = Number(config.readTimeoutSec)
  const readTimeoutSec = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 0
  // Wall clock = client budget (read timeout + hard-timeout slack) + 80 s, floored
  // at 330 s. Deliberately generous: see the design note at the top of the file.
  const budgetMs = Math.max(330000, readTimeoutSec > 0 ? readTimeoutSec * 1000 + 90000 : 0)
  const useProxy = config.useProxy === true
  const proxyUrl = text(config.proxyUrl) || 'http://127.0.0.1:7891'

  ctx.tools.register(
    defineTool({
      name: 'mimo_vision',
      description:
        'Understand a local image with the Xiaomi MiMo vision model. ' +
        'Pass the absolute path of a local image (for example C:\\Users\\me\\Desktop\\12.jpg); ' +
        'the image is base64-encoded locally and sent to the MiMo API (model=' +
        model +
        ', thinking=' +
        thinking +
        '). Returns the model description or its answer to `prompt`. ' +
        'In the DSH web UI the called image is also opened in the right sidebar.',
      parameters: {
        image_path: {
          type: 'string',
          required: true,
          description: 'Absolute path of a local image file.',
        },
        prompt: {
          type: 'string',
          description: 'Optional question or instruction about the image. Defaults to a description request.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            answer: { type: 'string', description: 'The model answer' },
            model: { type: 'string' },
            error: { type: 'string' },
            detail: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok === true) return [{ type: 'text', text: String(value.answer ?? '') }]
          const message =
            'MiMo vision call failed: ' +
            String(value.error ?? 'unknown error') +
            (value.detail ? '\ndetail: ' + String(value.detail) : '')
          return [{ type: 'text', text: message }]
        },
      },
      async execute(args, exec) {
        const imagePath = typeof args.image_path === 'string' ? args.image_path.trim() : ''
        if (imagePath === '') {
          return {
            ok: false,
            error: 'missing required parameter: image_path',
            detail: 'Pass the absolute path of a local image file.',
          }
        }

        const { pythonExe, scriptPath, scriptDir } = resolveRuntime(config)
        if (!existsSync(scriptPath)) {
          return {
            ok: false,
            error: 'mimo_vision.py not found: ' + scriptPath,
            detail:
              'Point the loader row\'s config.scriptPath at your copy of the client, or set ' +
              'DSH_MIMO_VISION_SCRIPT. The bundled client lives at ' +
              BUNDLED_SCRIPT +
              '.',
          }
        }

        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        const argv = [pythonExe, scriptPath, imagePath]
        if (prompt !== '') argv.push(prompt)
        // Explicit model and thinking mode: never depend on the client's defaults.
        // argparse accepts options after the positional arguments.
        argv.push('--model', model, '--thinking', thinking)
        if (readTimeoutSec > 0) argv.push('--read-timeout', String(readTimeoutSec))

        let handle
        let budget
        const startedAt = Date.now()
        try {
          const effProxy = await resolveProxyUrl({ useProxy, proxyUrl })
          const env = {
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
            // Clear launcher leftovers (including NO_PROXY) so the client applies
            // its own network policy; only a reachable proxy is passed through.
            HTTP_PROXY: undefined,
            HTTPS_PROXY: undefined,
            ALL_PROXY: undefined,
            NO_PROXY: undefined,
            http_proxy: undefined,
            https_proxy: undefined,
            all_proxy: undefined,
            no_proxy: undefined,
            // Forward the key through the environment when the host has one, so it
            // never appears in argv or in process listings.
            ...(text(process.env.MIMO_API_KEY) ? { MIMO_API_KEY: text(process.env.MIMO_API_KEY) } : {}),
            ...(effProxy ? { MIMO_PROXY_URL: effProxy } : {}),
          }
          budget = AbortSignal.timeout(budgetMs)
          const signal = exec.signal ? AbortSignal.any([exec.signal, budget]) : budget
          handle = ctx.subprocess.spawn({
            argv,
            cwd: scriptDir,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 2000000, spill: { maxBytes: 16000000 } },
              stderr: { maxBytes: 262144 },
            },
            graceMs: 15000,
            signal,
            env,
          })
        } catch (error) {
          return { ok: false, error: 'could not start the Python subprocess', detail: String(error?.message ?? error) }
        }

        let outcome
        try {
          outcome = await handle.done
        } catch (error) {
          return { ok: false, error: 'Python subprocess failed to start', detail: String(error?.message ?? error) }
        }

        // Collect output before branching: the timeout path needs the diagnostics
        // the client writes to stderr ("[mimo_vision] attempt N ...").
        const outRead = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : { text: '', lossy: false }
        const errRead = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : { text: '', lossy: false }

        if (budget.aborted && !(exec.signal && exec.signal.aborted)) {
          const secs = Math.round((Date.now() - startedAt) / 1000)
          const stderrTail = String(errRead.text || '').trim().slice(-1500)
          const stdoutTail = String(outRead.text || '').trim().slice(-500)
          return {
            ok: false,
            error: 'MiMo call timed out after ' + secs + 's; subprocess killed',
            detail:
              'This plugin\'s wall clock fired, which the client\'s own budget should normally prevent. ' +
              'Direct connection (useProxy=' + String(useProxy) + '), so this is not a proxy issue.' +
              (stderrTail ? '\nclient diagnostics:\n' + stderrTail : '') +
              (stdoutTail ? '\nsubprocess output:\n' + stdoutTail : ''),
          }
        }

        if (outcome.exitCode !== 0) {
          return {
            ok: false,
            error: 'Python program exited with code ' + String(outcome.exitCode),
            detail: String(errRead.text || outRead.text || '').trim(),
          }
        }

        const text_ = String(outRead.text || '').trim()
        if (outRead.lossy) return { ok: false, error: 'Python output was truncated', detail: text_ }

        try {
          const parsed = JSON.parse(text_)
          if (parsed.ok !== true) {
            return { ok: false, error: String(parsed.error || 'MiMo API returned an error'), detail: String(parsed.detail || '') }
          }
          return { ok: true, answer: String(parsed.answer || ''), model: String(parsed.model || '') }
        } catch {
          return { ok: false, error: 'could not parse the JSON printed by the Python client', detail: text_ }
        }
      },
    }),
  )
}
