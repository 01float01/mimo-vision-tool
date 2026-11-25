# mimo-vision-tool

一个 **DSH** 插件：给 agent 一个 `mimo_vision` 工具，用小米 MiMo 视觉模型理解本地图片；
在 Web 界面上，它还会在**调用发生的那一刻**把这张图打开到右侧边栏。

[English](README.md) | 中文

```
mimo_vision(image_path, prompt?) -> 文本
```

## 你得到什么

- **工具本体。** 图片在本地 base64 编码后发给 MiMo API，返回模型对图片的描述或对
  `prompt` 的回答。除 MiMo 端点外不向任何第三方上传。
- **侧边栏预览（仅 DSH Web）。** 每次调用都会展开右栏，用 DSH 自带的文件预览显示这张图。
  它不注册新的 tab 类型、也不自己读字节，所以没有额外 UI 需要跟着宿主版本维护。

## 环境要求

| | |
| --- | --- |
| DSH | 需要 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`（声明为 peer 依赖） |
| Node | ≥ 20 |
| Python | ≥ 3.10，需要 `openai` 与 `httpx`；`pillow` 可选，仅在图片大于 8 MB 时用于等比缩小 |
| MiMo API Key | 到 <https://platform.xiaomimimo.com/> 申请 |

## 装进 DSH profile

```bash
git clone https://github.com/CHANGE-ME/mimo-vision-tool.git
```

然后二选一：

**A. 交给插件管理器。** 让 DSH 用 `plugin_manager` 的 `install_bundle` 安装这个 clone 的绝对路径。

**B. 手工接线。** 在 profile 的 `package.json` 里登记包……

```json
"dependencies": {
  "mimo-vision-tool": "link:../path/to/mimo-vision-tool"
}
```

……再在 profile 的 `cordis.patch.yml` 里插入一行：

```yaml
- insert:
    - id: mimo-vision-tool
      name: mimo-vision-tool
      config:
        pythonExe: /path/to/venv/bin/python   # 装了 openai + httpx 的解释器
```

重载插件（设置 → 插件）或重启 DSH。该行会以"已启用"状态出现在插件列表，之后每个新会话
都能直接调用 `mimo_vision`。

## 配置 API Key

Key **绝不**内置在仓库里，也**绝不**通过命令行参数传递。两个来源，环境变量优先：

1. 运行 DSH 的那个进程的环境变量 `MIMO_API_KEY`。插件通过子进程环境转发给 Python 客户端，
   因此不会出现在 `argv` 或进程列表里。
2. `python/mimo_api_key.txt` —— 一行，不要引号。从
   [`python/mimo_api_key.txt.example`](python/mimo_api_key.txt.example) 复制。真实文件已在
   `.gitignore` 里。

两者都没有时，客户端立刻退出，并给出指明"它找的是哪个文件"的结构化错误。

> 不要提交任何 key。只要 key 进过一次仓库，就当作已泄漏并**轮换**——洗历史比重发一把 key 麻烦得多。

## 配置项

全部可选，写在 loader 行的 `config` 上。路径类留空时会退回本包自带的文件，所以刚 clone
下来**不需要任何配置**。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `pythonExe` | `python`（POSIX 上 `python3`） | 运行客户端的解释器。也可用 `DSH_MIMO_VISION_PYTHON`。 |
| `scriptPath` | 包内 `python/mimo_vision.py` | 要运行的客户端。也可用 `DSH_MIMO_VISION_SCRIPT`。 |
| `scriptDir` | `scriptPath` 所在目录 | 子进程工作目录，也是查找 `mimo_api_key.txt` 的地方。 |
| `model` | `mimo-v2.6-flash` | 视觉模型 id，经 `--model` 传入。 |
| `thinking` | `disabled` | `disabled` \| `enabled` \| `auto`，见下。 |
| `readTimeoutSec` | `0`（用客户端的 240 s） | 单次读超时。调大会把客户端的硬超时与本插件的墙钟一起抬高。 |
| `useProxy` | `false` | `false` 时直连，并忽略环境里继承来的代理变量。 |
| `proxyUrl` | `http://127.0.0.1:7891` | `useProxy` 为真时尝试的代理；探测不可达会自动降级直连。 |

### 为什么默认 `thinking: disabled`

MiMo 平台默认**开启**思考。在同一种负载上实测：同一句短 prompt，开思考要 **65–82 s**，
关掉只要 **约 1.5 s**；长思考还会把视觉请求拖过预算。图像理解不需要它。
个别任务确实需要时把它设成 `enabled` 即可。

### 超时预算

三层，顺序是刻意排的：客户端读超时 **240 s** < 客户端硬超时 **250 s** < 插件墙钟 **330 s**。
慢的尝试**不重试**（重试等于把等待翻倍，必然撞墙钟），墙钟只兜"客户端整块卡死"这种情况，
且此时回报的是它的 stderr，而不是一句没有信息量的 "timeout"。

## 也可以直接当命令行用

自带的客户端可以脱离 DSH 单独跑：

```bash
python python/mimo_vision.py /path/to/image.jpg "这张图在讲什么？" \
  --model mimo-v2.6-flash --thinking disabled
```

成功时 stdout 输出一行 JSON：`{"ok": true, "answer": "...", "model": "..."}`；失败时输出
`{"ok": false, "error": "...", "detail": "..."}` 且退出码为 1。`--raw` 只打印回答。
其它参数：`--api-key`、`--base-url`、`--max-tokens`、`--no-resize`、`--proxy`、`--read-timeout`。

## 侧边栏预览是怎么实现的

全在 [`client.js`](client.js)，文件头有完整推导：

1. **触发点** —— 注册 `tool.call.toolview`，key = `mimo_vision`。这是宿主里唯一按 wire
   工具名分发的 slot。
2. **打开动作** —— slot owner 给出 `openFile(path)`，即
   `ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, path))`：同一步展开右栏，
   并交给 DSH 自带的文件预览渲染（png/jpg/jpeg/gif/webp/bmp/ico/svg）。工作区外的绝对路径
   也支持。
3. **克制** —— 在 `start` 阶段打开；结果距今 30 s 以内也打开（覆盖"返回太快、`start`
   一帧都没渲染"）。刷新页面后回放的历史调用早于这个窗口，因此**不会**被反复顶开。
   同一个 call 只自动打开一次。

该视图需要 Web 组合里包含文件预览（`ui-sidebar-documentpreview`），标准 DSH Web 都有。
没有它时卡片照常渲染，并把原因显示出来。

## 开发

```bash
npm run check                     # 仓库自检 + 包装层自测
node scripts/check.mjs --strict   # 密钥、杂物文件、JSON/JS/Python 语法、清单一致性
node scripts/selftest.mjs         # 用桩子进程验证包装层接线，不需要 API Key
python -m py_compile python/mimo_vision.py
```

`scripts/check.mjs` 会在以下情况直接失败：提交了 key、提交了备份文件、写死了作者本机的路径、
或 `client.js` 的模块 id 与包名不再一致。
`scripts/selftest.mjs` 用桩子进程替代真实调用，因此可以在不联网、不花额度的前提下断言
脚本路径解析、argv 形状、代理变量清除与 key 转发。

两者都在 CI 的 Linux / Windows 上跑（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。

## 注意与限制

- `client.js` 用它自己的**包名**注册浏览器模块；如果你要发到 scope 下（如
  `@you/mimo-vision-tool`），必须同时把该文件里的 `id` 改成完整包名，否则模块永远不加载。
- 在 `@deepseek-ai/dsh-tools` `0.2.0-rc.2` 上开发与验证。公开 npm 上的版本可能更旧，
  所以 peer 依赖保持宽松；真要发 npm 请自己钉版本。
- 当时可用的模型 id：`mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.6-pro-ultraspeed`、
  `mimo-v2.5`、`mimo-v2.5-pro`。只要能接受 `image_url` 内容块都能用，`--model` 给什么就用什么。
- 大于 8 MB 的图片会先等比缩到长边 1920 px 再转 JPEG 上传；没装 `pillow` 时跳过。
  `--no-resize` 可完全关闭。

## 许可证

[MIT](LICENSE)
