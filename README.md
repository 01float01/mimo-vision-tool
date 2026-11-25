# mimo-vision-tool

A **DSH** plugin that gives the agent a `mimo_vision` Tool for local images, using Xiaomi's
MiMo vision model — and, on the web UI, opens the image it was called with in the right
sidebar at the moment of the call.

English | [中文](README.zh.md)

```
mimo_vision(image_path, prompt?) -> text
```

## What you get

- **The tool.** The image is base64-encoded locally and sent to the MiMo API; the model's
  description or its answer to `prompt` is returned as a Tool result. Nothing is uploaded
  to any third party other than the MiMo endpoint.
- **The sidebar view (DSH Web only).** Every call expands the right column and shows that
  image through the document preview already shipped with DSH. It registers no new tab type
  and reads no bytes itself, so there is no extra UI to keep in step with the host.

## Requirements

| | |
| --- | --- |
| DSH | with `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` (declared as peer dependencies) |
| Node | ≥ 20 |
| Python | ≥ 3.10, with `openai` and `httpx`; `pillow` is optional and only used to downscale images larger than 8 MB |
| MiMo API key | from <https://platform.xiaomimimo.com/> |

## Install into a DSH profile

```bash
git clone https://github.com/CHANGE-ME/mimo-vision-tool.git
```

Then pick one:

**A. Let the plugin manager install it.** Ask DSH to install the bundle from the absolute
path of the clone (`plugin_manager` → `install_bundle`).

**B. Wire the profile by hand.** Register the package in the profile's `package.json`…

```json
"dependencies": {
  "mimo-vision-tool": "link:../path/to/mimo-vision-tool"
}
```

…and insert the loader row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: mimo-vision-tool
      name: mimo-vision-tool
      config:
        pythonExe: /path/to/venv/bin/python   # interpreter holding openai + httpx
```

Reload the plugin (Settings → Plugins) or restart DSH. The row appears as an enabled plugin,
and every new session can call `mimo_vision`.

## Configure the API key

The key is **never** embedded in this repository and never passed on a command line. Two
supported sources, the environment variable winning:

1. `MIMO_API_KEY` in the environment of the process running DSH. The plugin forwards it to
   the Python client through the child environment, so it stays out of argv.
2. `python/mimo_api_key.txt` — one line, no quotes. Copy
   [`python/mimo_api_key.txt.example`](python/mimo_api_key.txt.example). The real file is
   listed in `.gitignore`.

Without either, the client exits immediately with a structured error naming the file it
looked for.

> Never commit a key. If one ever reaches a repository, treat it as leaked and rotate it —
> rewriting history is more work than reissuing.

## Configuration

Every field is optional and settable on the loader row's `config`. Blank path values fall
back to this package's own files, so a fresh clone needs no configuration at all.

| Key | Default | Meaning |
| --- | --- | --- |
| `pythonExe` | `python` (`python3` on POSIX) | Interpreter running the client. Also `DSH_MIMO_VISION_PYTHON`. |
| `scriptPath` | `python/mimo_vision.py` inside this package | Client to run. Also `DSH_MIMO_VISION_SCRIPT`. |
| `scriptDir` | the directory of `scriptPath` | Subprocess working directory, and where `mimo_api_key.txt` is looked up. |
| `model` | `mimo-v2.6-flash` | Vision model id, passed with `--model`. |
| `thinking` | `disabled` | `disabled` \| `enabled` \| `auto`. See below. |
| `readTimeoutSec` | `0` (client's 240 s) | Per-attempt read timeout. Raising it scales the client's hard timeout and this plugin's wall clock together. |
| `useProxy` | `false` | `false` connects directly and ignores inherited proxy variables. |
| `proxyUrl` | `http://127.0.0.1:7891` | Proxy tried when `useProxy` is true; falls back to a direct connection when unreachable. |

### Why `thinking: disabled`

The MiMo platform enables thinking by default. Measured on this workload, the same short
prompt takes **65–82 s** with thinking on and **~1.5 s** with it off, and a long thinking
pass pushes a vision request past its budget. Image understanding does not need it. Set
`thinking: enabled` if a particular task does.

### Timeout budget

Three layers, deliberately ordered: client read timeout **240 s** < client hard timeout
**250 s** < plugin wall clock **330 s**. A slow attempt is never retried (retrying doubles
the wait and is guaranteed to hit the wall clock), and the wall clock only catches a client
that hangs outright — in which case its stderr is reported instead of a bare "timeout".

## Use it from the command line

The bundled client is usable on its own:

```bash
python python/mimo_vision.py /path/to/image.jpg "what does this chart show?" \
  --model mimo-v2.6-flash --thinking disabled
```

It prints one line of JSON: `{"ok": true, "answer": "...", "model": "..."}` on success, or
`{"ok": false, "error": "...", "detail": "..."}` with exit code 1. `--raw` prints just the
answer. Other flags: `--api-key`, `--base-url`, `--max-tokens`, `--no-resize`, `--proxy`,
`--read-timeout`.

## How the sidebar view works

All in [`client.js`](client.js), whose header documents the reasoning in full:

1. **Trigger** — the plugin registers `tool.call.toolview` with key `mimo_vision`, the one
   slot the harness dispatches by wire tool name.
2. **Open** — the slot owner hands the view `openFile(path)`, which is
   `ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, path))`. That expands the
   column in the same step and renders the image with the shipped document preview
   (png/jpg/jpeg/gif/webp/bmp/ico/svg). Absolute paths outside the workspace are fine.
3. **Restraint** — it opens on the `start` phase, or for a result younger than 30 s (calls
   too fast to ever render `start`). Calls replayed after a page reload are older than that
   and stay quiet, so refreshing never reopens the column. At most one auto-open per call.

The view needs the web composition to include the document preview (`ui-sidebar-documentpreview`),
which stock DSH Web does. Without it the card still renders and shows the reason.

## Development

```bash
npm run check                     # repository checks + wrapper self-test
node scripts/check.mjs --strict   # secrets, stray files, JSON/JS/Python syntax, manifest
node scripts/selftest.mjs         # wrapper wiring against a stub subprocess, no API key needed
python -m py_compile python/mimo_vision.py
```

`scripts/check.mjs` fails on a committed key, a backup file, a hardcoded authoring-machine
path, or a `client.js` module id that no longer matches the package name.
`scripts/selftest.mjs` stubs the subprocess, so it asserts the resolved script path, the
argv shape, proxy-variable scrubbing and key forwarding without touching the network.

Both run in CI on Linux and Windows (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Notes and limitations

- `client.js` registers its browser module under the **package name**; if you publish under
  a scope, change the `id` in that file to the full scoped name or the module never loads.
- Develops and verified against `@deepseek-ai/dsh-tools` `0.2.0-rc.2`. The public npm release
  may lag, so keep the peer dependency loose and pin deliberately if you ship to npm.
- The model ids that worked when this was written: `mimo-v2.6-flash`, `mimo-v2.6-pro`,
  `mimo-v2.6-pro-ultraspeed`, `mimo-v2.5`, `mimo-v2.5-pro`. Any model that accepts an
  `image_url` content part should work; `--model` takes whatever you give it.
- Images larger than 8 MB are downscaled to a 1920 px long edge and re-encoded as JPEG
  before upload, unless `pillow` is missing (`--no-resize` disables it entirely).

## License

[MIT](LICENSE)
