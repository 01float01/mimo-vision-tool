/**
 * mimo-vision-tool — browser half (DSH Web).
 *
 * Every `mimo_vision` call expands the right sidebar and shows the image that was
 * sent to the model.
 *
 * How it hangs together — all through public extension points, and this file never
 * requires a Harness client package (one version skew there and the slot entry
 * blanks out):
 *
 * 1. Trigger: `tool.call.toolview`, keyed `mimo_vision`. It is the only slot the
 *    harness dispatches by wire tool name, so it is the one deterministic place to
 *    observe a specific call. `phase` is preparing | start | result; start and
 *    result carry the dispatched `{ image_path, prompt }` in `argsRaw`.
 * 2. Open: the slot owner hands the view `openFile(path)`, which is
 *    `ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, path))`. That
 *    expands the column in the same step and lands in the shipped document
 *    preview's image renderer (png/jpg/jpeg/gif/webp/bmp/ico/svg). Addresses may
 *    carry absolute paths outside the workspace, so images need no copying. This
 *    plugin registers no tab type and reads no bytes itself: one layer less to keep
 *    in step with the host.
 * 3. Card: a compact disclosure row matching the host's `DisclosureRow` geometry,
 *    styled with theme tokens only.
 *
 * Auto-open rules — must not miss a call, and must not reopen on replay:
 * - `phase === 'start'` opens. A result younger than 30 s opens too, covering calls
 *   that return before the start phase is ever rendered.
 * - Calls replayed after a page reload are older than that window and stay quiet,
 *   so refreshing never bashes the sidebar open again.
 * - At most one auto-open per `callId` (module-level Set, survives card remounts).
 * - The filename in the row reopens on demand; it is the same content id, so it
 *   reveals the existing tab instead of creating a second one.
 *
 * 下面是中文推导，保留当初为什么这么选、踩过什么坑。
 */
/**
 * mimo-vision-tool —— 浏览器半区（DSH Web）
 *
 * 目标：mimo_vision 每被调用一次，DSH Web 右侧侧边栏就主动展开并显示这次被识别的图片。
 *
 * 全部走官方扩展点，不 require 任何 Harness Client 包（`@deepseek-ai/dsh-client-ui-primitives`
 * 之类一旦被 require，宿主一改版本就会把整个 slot entry 打崩，控制台只剩
 * `slot entry crashed in '...'`）。
 *
 * 三个部件：
 *
 * 1) 触发点 —— `tool.call.toolview`（keyed by wire tool name）。
 *    这是本仓库里**唯一**按工具名分发的 hook：注册 key = "mimo_vision" 之后，聊天流里
 *    这次调用的卡片就由本插件渲染，于是"调用发生了"这件事有了一个确定的挂钩位置。
 *    卡片拿到的 owner 里带 `phase`（preparing | start | result）和该阶段的 `block`，
 *    start/result 两阶段的 `argsRaw` 就是模型传进来的 `{ image_path, prompt }`。
 *
 * 2) 打开动作 —— owner 里的 `openFile(path, options?)`。
 *    宿主的实现就是 `ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, path))`；
 *    `openResource` 会**在同一步展开右栏**（框架的原话是"内容看不见就等于没打开"），
 *    地址落到 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 的 image 渲染器
 *    （png/jpg/jpeg/gif/webp/bmp/ico/svg），而该地址里的路径允许是**工作区外的绝对路径**。
 *    也就是说"右栏弹出来 + 图片显示出来"两件事宿主已经做好，本插件只负责在对的时候喊一声。
 *    这里不自己注册 tab 类型、也不自己读字节：少一层就少一处跟版本走的代码。
 *
 * 3) 卡片外观 —— 自绘的紧凑 disclosure row，几何对齐宿主 `DisclosureRow`
 *    （24px 行高 / 16px leading / 13px 标题 / 12px 路径 / 2px 圆点分隔），
 *    点行展开 MiMo 的回答，点文件名再看一次图。样式只用主题 token。
 *
 * 自动弹出的判定（关键：既不能漏，也不能被"回放"反复顶开右栏）：
 *   - phase === 'start'（已派发、结果未回）→ 弹；这是正常路径。
 *   - phase === 'result' 且 tool/result 时间戳距今 ≤ AUTO_OPEN_RECENT_MS → 弹。
 *     覆盖"返回太快、start 一帧都没渲染"的情形；同时天然排除了页面刷新后回放的
 *     历史调用（它们的时间戳早已过期），所以刷新页面不会把右栏顶开。
 *   - 同一个 callId 只自动弹一次（模块级 Set，跨重挂载仍有效），避免虚拟列表滚动
 *     导致卡片重挂载时又弹一次。
 *   - 用户想再看一次：点卡片里的文件名即可（同一个 contentId，只会把已有 tab 揭示出来，
 *     不会开出第二个）。
 */

window.__ModuleLoader__.load({
  id: 'mimo-vision-tool',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement

    /** 与宿主一致：行高 / leading 跟随"内容字号"偏好（Settings 里的字号档位）。 */
    const CSS = [
      '.mvt-root{display:flex;flex-direction:column;width:100%;min-width:0}',
      '.mvt-row{position:relative;display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta, 0px));min-width:0;color:var(--dsw-alias-label-tertiary);transition:color .1s ease}',
      '.mvt-row[data-expandable]{cursor:pointer}',
      '.mvt-row:hover{color:var(--dsw-alias-label-secondary)}',
      '.mvt-row:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:4px}',
      '.mvt-leading{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:calc(16px + var(--dsh-content-font-delta, 0px));height:calc(16px + var(--dsh-content-font-delta, 0px));margin-right:6px;color:inherit}',
      '.mvt-leading svg{width:calc(14px + var(--dsh-content-font-delta, 0px));height:calc(14px + var(--dsh-content-font-delta, 0px))}',
      '.mvt-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta, 0px));color:inherit}',
      '.mvt-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}',
      '.mvt-file{flex:0 auto;min-width:0;max-width:min(60%,28em);margin:0;padding:0;border:none;background:0 0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta, 0px));color:inherit;text-decoration:underline 1px dotted;text-underline-offset:3px;cursor:pointer}',
      '.mvt-file:hover{color:var(--dsw-alias-label-primary)}',
      '.mvt-file:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:3px}',
      '.mvt-state{flex:none;margin-left:8px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta, 0px));white-space:nowrap}',
      '.mvt-root[data-state="error"] .mvt-state{color:var(--dsw-alias-state-error-primary)}',
      '.mvt-root[data-state="ok"] .mvt-state{color:var(--dsw-alias-label-tertiary)}',
      '.mvt-dot{display:inline-block;width:5px;height:5px;margin-right:6px;border-radius:50%;background:currentColor;vertical-align:middle;opacity:.8;animation:mvt-pulse 1.4s ease-in-out infinite}',
      '@keyframes mvt-pulse{0%,100%{opacity:.25}50%{opacity:.9}}',
      '.mvt-body{display:flex;flex-direction:column;gap:4px;margin:4px 0 6px 4px;padding:0;min-width:0}',
      '.mvt-ioCard{display:flex;flex-direction:column;min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small)}',
      '.mvt-ioSection{display:flex;flex-direction:column;min-width:0;padding:6px 10px}',
      '.mvt-ioSection+.mvt-ioSection{border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.mvt-ioLabel{flex:none;margin-bottom:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
      '.mvt-ioText{margin:0;min-width:0;max-height:16em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}',
      '.mvt-ioText[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.mvt-inspect{align-self:flex-start;margin:0;padding:0 2px;border:none;background:0 0;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-decoration:underline 1px dotted;text-underline-offset:2px;cursor:pointer}',
      '.mvt-inspect:hover{color:var(--dsw-alias-label-secondary)}',
      '.mvt-inspect:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:3px}',
      '.mvt-note{margin:0 0 4px 4px;font-size:11px;line-height:16px;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary)}',
      '.mvt-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '@media (prefers-reduced-motion: reduce){.mvt-row{transition:none}.mvt-dot{animation:none}}',
    ].join('\n')

    const NS = 'mimoVisionTool'

    const ZH = {
      title: 'MiMo 视觉',
      basenameFallback: '（未提供路径）',
      'state.preparing': '准备中',
      'state.running': '识别中',
      'state.ok': '已显示在右栏',
      'state.error': '失败',
      'body.prompt': '提问',
      'body.answer': '回答',
      'body.error': '错误',
      'body.inspect': '在轨迹中查看',
      'body.pending': '等待 MiMo 返回…',
      openFailed: '无法在右栏显示图片',
      aria: 'MiMo 视觉调用：{name}，{state}。点击展开回答，点击文件名在右侧显示图片。',
      ariaOpen: '在右侧显示图片 {name}',
    }
    const EN = {
      title: 'MiMo vision',
      basenameFallback: '(no path)',
      'state.preparing': 'preparing',
      'state.running': 'analyzing',
      'state.ok': 'shown in sidebar',
      'state.error': 'failed',
      'body.prompt': 'Prompt',
      'body.answer': 'Answer',
      'body.error': 'Error',
      'body.inspect': 'Inspect in trajectory',
      'body.pending': 'Waiting for MiMo…',
      openFailed: 'Could not show the image in the sidebar',
      aria: 'MiMo vision call: {name}, {state}. Activate to expand the answer, or activate the file name to show the image on the right.',
      ariaOpen: 'Show image {name} on the right',
    }

    /** 自动弹出的“刚结束”时间窗：超出的历史调用不再抢焦点。 */
    const AUTO_OPEN_RECENT_MS = 30000
    /** 自动弹出过的 callId，跨卡片重挂载去重（页面内缓存，刷新即清空）。 */
    const autoOpened = new Set()

    /**
     * 取出这次调用声明的参数。preparing 阶段没有派发参数，返回空。
     * @param phase - 'preparing' | 'start' | 'result'
     * @param block - 该阶段的 Tool 调用块
     * @returns 归一化后的 image_path 与 prompt（缺失为空串）
     */
    function readArgs(phase, block) {
      let raw = ''
      if (phase === 'start') raw = block && typeof block.argsRaw === 'string' ? block.argsRaw : ''
      else if (phase === 'result') raw = block && block.call && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : ''
      if (raw === '') return { path: '', prompt: '' }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { path: '', prompt: '' }
      }
      if (parsed === null || typeof parsed !== 'object') return { path: '', prompt: '' }
      return {
        path: typeof parsed.image_path === 'string' ? parsed.image_path.trim() : '',
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '',
      }
    }

    /**
     * 结算结果里的文本部分（本工具只产出一段文本）。
     * @param block - ToolResultNode
     * @returns 拼接后的文本
     */
    function readText(block) {
      if (block === null || typeof block !== 'object' || !Array.isArray(block.content)) return ''
      return block.content
        .map((item) => (item && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
        .filter((text) => text !== '')
        .join('\n')
        .trim()
    }

    /**
     * 结算结果里的结构化错误（工具抛出/被中断时才有）。
     * @param block - ToolResultNode
     * @returns 错误摘要，没有则为空串
     */
    function readError(block) {
      if (block === null || typeof block !== 'object') return ''
      const error = block.error
      if (error && typeof error === 'object') {
        const parts = [error.name, error.code, error.reason].filter((part) => typeof part === 'string' && part !== '')
        if (parts.length > 0) return parts.join(' · ')
      }
      return ''
    }

    /**
     * 取路径的文件名部分，两种分隔符都认。
     * @param path - 绝对或相对路径
     * @returns 文件名（路径为空时为空串）
     */
    function basename(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    /**
     * 让右栏显示这张图。openFile 内部就是 sidebarRight.openResource，会同一步展开右栏；
     * 没有在屏会话、或该 composition 没有文件预览类型时它会失败——这里不吞掉结果，
     * 而是把原因交给 onFailure 显示在卡片上（静默失败等于没实现）。
     * @param openFile - owner 提供的打开器
     * @param path - 图片路径
     * @param onFailure - 失败回调，收到一句可读的原因
     */
    function revealImage(openFile, path, onFailure) {
      const report = (error) => {
        if (typeof onFailure !== 'function') return
        const detail = error && typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
        onFailure(detail)
      }
      if (typeof openFile !== 'function' || path === '') return
      try {
        const result = openFile(path)
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') result.then(() => {}, report)
      } catch (error) {
        report(error)
      }
    }

    /** 16px 视框里的 14px 图片图标。 */
    function ImageGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('rect', {
          x: 1.9,
          y: 2.9,
          width: 12.2,
          height: 10.2,
          rx: 2.1,
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('circle', { cx: 5.5, cy: 6.3, r: 1.05, fill: 'currentColor' }),
        h('path', {
          d: 'M2.8 12.1 6.05 9.15a1.2 1.2 0 0 1 1.6 0l1.85 1.7 1.3-1.13a1.2 1.2 0 0 1 1.6 0l1.05.92',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * 一行紧凑的调用卡片。
     * @param props - tool.call.toolview 的 owner：phase / block / callId / openFile / inspect / t
     */
    function MimoVisionRow(props) {
      const phase = props && props.phase ? props.phase : 'preparing'
      const block = props ? props.block : undefined
      const callId = props && typeof props.callId === 'string' ? props.callId : ''
      const settled = phase === 'result'
      // 宿主给的 t 绑在本插件的 locale 命名空间上；万一命名空间没注册上，t 会原样返回 key
      // （形如 "state.ok"），这时退回内置中文词典，绝不把 key 露给用户。
      const translate = (key) => {
        const fromHost = typeof props?.t === 'function' ? props.t(key) : undefined
        if (typeof fromHost === 'string' && fromHost !== '' && fromHost !== key) return fromHost
        return ZH[key] !== undefined ? ZH[key] : key
      }

      const [expanded, setExpanded] = React.useState(false)
      // 右栏打开失败时的可见提示：openFile 是个 async 函数，openResource 抛错只会变成
      // rejected promise，不把它记下来就完全是静默失败了。
      const [openError, setOpenError] = React.useState('')

      const args = readArgs(phase, block)
      const answer = settled ? readText(block) : ''
      const errorText = settled ? readError(block) : ''
      const failed = settled && (errorText !== '' || (block && block.isError === true))
      const name = basename(args.path) || translate('basenameFallback')
      const state = phase === 'preparing' ? 'preparing' : !settled ? 'running' : failed ? 'error' : 'ok'
      const stateLabel = translate(
        state === 'preparing' ? 'state.preparing' : state === 'running' ? 'state.running' : state === 'error' ? 'state.error' : 'state.ok',
      )

      // 只有"这次调用正在眼前发生"才自动弹出（见文件头注释）。
      const recentlySettled =
        settled && block && typeof block.time === 'number' && Math.abs(Date.now() - block.time) <= AUTO_OPEN_RECENT_MS
      const autoOpen = args.path !== '' && callId !== '' && !autoOpened.has(callId) && (phase === 'start' || recentlySettled)

      React.useEffect(() => {
        if (!autoOpen) return
        autoOpened.add(callId)
        if (autoOpened.size > 512) autoOpened.clear()
        revealImage(props?.openFile, args.path, setOpenError)
      }, [autoOpen, callId, args.path, props])

      const bodyText = failed ? (errorText !== '' ? errorText : answer) : answer
      const canExpand = phase === 'preparing' || bodyText !== '' || args.prompt !== ''

      const onToggle = () => setExpanded((value) => !value)
      const onKeyDown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onToggle()
      }
      const onFile = (event) => {
        event.stopPropagation()
        revealImage(props?.openFile, args.path, setOpenError)
      }

      return h(
        'div',
        { className: 'mvt-root', 'data-tool': 'mimo_vision', 'data-state': state },
        h(
          'div',
          {
            className: 'mvt-row',
            'data-expandable': canExpand ? '' : undefined,
            role: canExpand ? 'button' : undefined,
            tabIndex: canExpand ? 0 : undefined,
            'aria-expanded': canExpand ? expanded : undefined,
            'aria-label': translate('aria').replace('{name}', name).replace('{state}', stateLabel),
            onClick: canExpand ? onToggle : undefined,
            onKeyDown: canExpand ? onKeyDown : undefined,
          },
          h('span', { className: 'mvt-leading' }, h(ImageGlyph)),
          h('span', { className: 'mvt-title' }, translate('title')),
          h('span', { className: 'mvt-sep', 'aria-hidden': 'true' }),
          args.path !== ''
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'mvt-file',
                  title: args.path,
                  'aria-label': translate('ariaOpen').replace('{name}', name),
                  onClick: onFile,
                },
                name,
              )
            : h('span', { className: 'mvt-file', style: { textDecoration: 'none', cursor: 'default' } }, name),
          h(
            'span',
            { className: 'mvt-state' },
            state === 'running' || state === 'preparing'
              ? h('span', { className: 'mvt-dot', 'aria-hidden': 'true' })
              : null,
            stateLabel,
          ),
        ),
        expanded
          ? h(
              'div',
              { className: 'mvt-body' },
              h(
                'div',
                { className: 'mvt-ioCard' },
                args.prompt !== ''
                  ? h(
                      'div',
                      { className: 'mvt-ioSection' },
                      h('div', { className: 'mvt-ioLabel' }, translate('body.prompt')),
                      h('div', { className: 'mvt-ioText' }, args.prompt),
                    )
                  : null,
                h(
                  'div',
                  { className: 'mvt-ioSection' },
                  h(
                    'div',
                    { className: 'mvt-ioLabel' },
                    translate(failed ? 'body.error' : 'body.answer'),
                  ),
                  h(
                    'div',
                    { className: 'mvt-ioText', 'data-tone': failed ? 'error' : undefined },
                    bodyText !== '' ? bodyText : phase === 'result' ? '—' : translate('body.pending'),
                  ),
                ),
              ),
              typeof props?.inspect === 'function'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'mvt-inspect',
                      onClick: (event) => {
                        event.stopPropagation()
                        props.inspect()
                      },
                    },
                    translate('body.inspect'),
                  )
                : null,
            )
          : null,
        // 右栏打开失败时的一行可见提示（正常路径上不渲染）。
        openError !== ''
          ? h('div', { className: 'mvt-note', 'data-tone': 'error' }, translate('openFailed') + '：' + openError)
          : null,
      )
    }

    return {
      name: 'mimo-vision-tool',
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 样式表随插件卸载回收：一个 source 一张 style，用 data-plugin 标记。
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'mimo-vision-tool'
          tag.dataset.pluginCss = 'mimo-vision-tool/client.css'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'mimo-vision-tool: stylesheet')

        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'mimo-vision-tool: locale dictionaries')

        // keyed by wire tool name：这一条就是"每次调用"的挂钩点。
        ctx.effect(
          () =>
            ctx.slots.inject('tool.call.toolview', () =>
              ctx.slots.register({ name: 'tool.call.toolview', key: 'mimo_vision', locale: NS }, MimoVisionRow),
            ),
          'mimo-vision-tool: tool.call.toolview',
        )
      },
    }
  },
})
