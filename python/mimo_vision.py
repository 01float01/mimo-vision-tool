# -*- coding: utf-8 -*-
"""
MiMo V2.6-Flash (小米) 图像理解客户端
=====================================

将本地图像文件先转为 base64 编码, 再调用小米 MiMo 视觉语言模型
(mimo-v2.6-flash, base_url=https://api.xiaomimimo.com/v1), 返回模型对图像的描述/回答。

思考模式(2026-10-06 修复): MiMo V2.6 三款**默认开启思考**(thinking: enabled), 实测同一个
"hi" 请求: 默认 65-82s, 而 thinking: disabled 仅 1.5s —— 差 50 倍。图像理解这类任务
不需要长思考; 长思考还会让单次请求多花 ~30s(实测同一张图 139s -> 169s)、输出 token 翻 4 倍
(445 -> 1946, 其中 1520 是思考)。
故本客户端默认发送 thinking: {"type": "disabled"}; 需要长思考时用 --thinking enabled
或环境变量 MIMO_THINKING=enabled 恢复, auto 表示不发送该字段(即平台默认=开启)。

模型(2026-10-02 切换): DEFAULT_MODEL 由 mimo-v2.5 改为 mimo-v2.6-flash。
本文件是全部 MiMo 视觉调用方的公共默认值 —— 插件 mimo-vision-tool(config.model)、
figlab 的 MiMo 辅审、docxmd 的 PDF/DOCX 图像描述都由此决定型号;
需要单独换型号时用 CLI 的 --model 覆盖(插件 mimo-vision-tool 即如此)。

本程序提供两层接口, 供后续 DSH 插件直接调用:

1) 模块接口 (供其他 Python 程序 import):
       from mimo_vision import understand_image
       result = understand_image(r"C:\\Users\\iris0\\Desktop\\12.jpg", prompt="图里有什么?")
       # result: {"ok": True, "answer": "...", "model": "...", "usage": {...}, "image": {...}}

2) 命令行接口 (供 DSH 插件通过子进程调用):
       python mimo_vision.py "C:\\Users\\iris0\\Desktop\\12.jpg" [问题文本]
   成功时 stdout 输出一行 JSON ({"ok": true, ...}) 且退出码为 0;
   失败时输出 {"ok": false, "error": ..., "detail": ...} 且退出码为 1。

依赖: openai (>=1.x), httpx (直连/代理传输); pillow (可选, 仅用于超大图像的自动压缩)
API Key 读取顺序: 环境变量 MIMO_API_KEY > 同目录 mimo_api_key.txt (两者都缺则报错); CLI 可用 --api-key 覆盖
网络策略(灵活代理): 默认直连, 忽略环境里的 HTTP(S)_PROXY(不受启动器代理开关影响);
  显式指定代理: 环境变量 MIMO_PROXY_URL 或命令行 --proxy <url>。
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
import os
import sys
import threading
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
# 不提供内置默认密钥: 开源仓库里的默认 key 等于把额度公开, 一旦进过 git 历史就只能作废重发。
# 只认 --api-key 参数 / 环境变量 MIMO_API_KEY / 同目录 mimo_api_key.txt, 见 load_api_key()。
DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1"
DEFAULT_MODEL = "mimo-v2.6-flash"
# 思考模式: auto(不发送 thinking 字段, 平台默认=开启) | enabled | disabled
DEFAULT_THINKING = "disabled"
DEFAULT_PROMPT = "please describe the content of the image"
DEFAULT_SYSTEM_PROMPT = (
    "You are MiMo, an AI assistant developed by Xiaomi. "
    "Today is date: Tuesday, December 16, 2025. Your knowledge cutoff date is December 2024."
)

# 超过该字节数的图像会先等比缩小长边到 MAX_EDGE 并转码 JPEG,
# 避免 base64 后的请求体超出 API 上限; 可用 --no-resize 关闭。
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_EDGE = 1920

# httpx 超时拆分: 连接/读取分开, 读超时小于硬超时, 让"上游卡住"由 httpx 先报出来
# (否则要等守护线程的硬超时才中止, 且无法说明卡在哪一步)。
CONNECT_TIMEOUT = 10.0
WRITE_TIMEOUT = 60.0
# 读超时 = "等一个完整响应"的上限。实测(2026-10-06, 1920x1080 采集图 + 5 问 prompt):
# 视觉请求本身要 139s(thinking 关) / 169s(thinking 开), 而此前设的 100s 会把**本来
# 能成功**的请求判死; 旧的 150s 硬超时同理(2026-10-06 事故的直接原因)。故留足余量。
DEFAULT_READ_TIMEOUT = 240.0
# 守护线程硬超时: 只防 getaddrinfo 黑洞这类"永不返回", 必须略大于读超时。
DEFAULT_HARD_TIMEOUT = 250.0


class MimoVisionError(RuntimeError):
    """带结构化摘要的调用错误: summary 给用户看, detail 给排查用。"""

    def __init__(self, summary: str, detail: str = ""):
        super().__init__(summary + ((": " + detail) if detail else ""))
        self.summary = summary
        self.detail = detail


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def load_api_key(script_dir: Path | None = None) -> str:
    """按 环境变量 > 同目录密钥文件 的顺序返回 API Key; 两者都缺则报错。

    这里**有意不内置任何密钥**: 仓库里的默认密钥等于把额度公开, 一旦进过 git 历史
    就只能作废重发。本地把 key 写进同目录 mimo_api_key.txt(已在 .gitignore 里),
    或设置 MIMO_API_KEY 环境变量; 容器 / CI 一律用环境变量。
    """
    key = os.environ.get("MIMO_API_KEY", "").strip()
    if key:
        return key
    script_dir = script_dir or Path(__file__).resolve().parent
    key_file = script_dir / "mimo_api_key.txt"
    if key_file.is_file():
        saved = key_file.read_text(encoding="utf-8").strip()
        if saved:
            return saved
    raise MimoVisionError(
        "缺少 MiMo API Key",
        f"请设置环境变量 MIMO_API_KEY, 或把 key 写入 {key_file}, 或显式传 --api-key。",
    )


def _downscale_if_large(data: bytes) -> tuple[bytes, bool]:
    """若图像过大, 用 Pillow 等比缩小长边并转码 JPEG, 返回 (新数据, 是否已缩放)。"""
    if len(data) <= MAX_IMAGE_BYTES:
        return data, False
    try:
        from PIL import Image
    except ImportError:
        return data, False
    try:
        image = Image.open(io.BytesIO(data))
        image = image.convert("RGB")
        width, height = image.size
        scale = min(1.0, MAX_EDGE / max(width, height))
        if scale < 1.0:
            image = image.resize(
                (max(1, round(width * scale)), max(1, round(height * scale))),
                Image.LANCZOS,
            )
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=88)
        return buffer.getvalue(), True
    except Exception:
        return data, False


def image_to_base64_data_url(image_path: str | os.PathLike, resize_if_large: bool = True):
    """把本地图像读取为字节, 可选压缩, 再编码为 base64 data URL。

    返回 (data_url, byte_count, resized)。
    """
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(f"image file not found: {image_path}")
    raw = path.read_bytes()
    resized = False
    if resize_if_large:
        raw, resized = _downscale_if_large(raw)
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{encoded}", len(raw), resized


# ---------------------------------------------------------------------------
# 核心接口: 图像理解
# ---------------------------------------------------------------------------
def understand_image(
    image_path,
    prompt: str = DEFAULT_PROMPT,
    model: str = DEFAULT_MODEL,
    api_key: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    max_completion_tokens: int = 4096,
    resize_if_large: bool = True,
    proxy: str | None = None,
    thinking: str | None = None,
    read_timeout: float | None = None,
):
    """图像转 base64 -> 调用 MiMo API -> 返回结构化结果 dict。

    这是供 CLI 与 DSH 插件共同调用的核心接口。
    失败时抛出异常(尽量带 summary/detail, 见 MimoVisionError), 由调用方决定如何呈现。

    thinking: auto / enabled / disabled, 默认 DEFAULT_THINKING(disabled)。
        V2.6 平台默认开启思考, 实测同一请求慢 50 倍(65-82s vs 1.5s), 且容易撞上
        客户端硬超时, 故默认关闭; 传 enabled 或 auto 可恢复平台默认行为。
    read_timeout: 单次请求的读超时秒数, 默认 DEFAULT_READ_TIMEOUT(240s) —— 视觉请求
        本身可能就要 100-170s, 这个值必须覆盖"上游慢但能成功"的情况。
    """
    import httpx
    from openai import OpenAI  # 延迟导入, 使 --help 在未安装依赖时也可用

    data_url, byte_count, resized = image_to_base64_data_url(image_path, resize_if_large)
    # 灵活网络策略: 默认直连(trust_env=False, 无视环境代理变量, 不受 DSH
    # 启动器代理开关状态影响); 仅当显式传入 proxy 参数或设置 MIMO_PROXY_URL
    # 环境变量时才走代理。
    proxy_url = (proxy or "").strip() or os.environ.get("MIMO_PROXY_URL", "").strip() or None
    timeout = httpx.Timeout(
        connect=CONNECT_TIMEOUT,
        read=float(read_timeout if read_timeout else (os.environ.get("MIMO_READ_TIMEOUT") or DEFAULT_READ_TIMEOUT)),
        write=WRITE_TIMEOUT,
        pool=CONNECT_TIMEOUT,
    )
    if proxy_url:
        http_client = httpx.Client(proxy=proxy_url, trust_env=False, timeout=timeout)
    else:
        http_client = httpx.Client(trust_env=False, timeout=timeout)
    client = OpenAI(
        api_key=api_key or load_api_key(),
        base_url=base_url,
        http_client=http_client,
        # 关掉 SDK 自带的 2 次自动重试: 它会在"限流/上游慢"时静默拖长单次调用
        # (SDK 的退避 + 外层守护线程硬超时叠加), 正是 300s 卡死的成因之一。
        # 重试统一由 _understand_image_guarded 负责, 次数与等待都可控。
        max_retries=0,
    )
    mode = (thinking if thinking is not None else os.environ.get("MIMO_THINKING") or DEFAULT_THINKING)
    mode = (mode or "auto").strip().lower()
    if mode not in ("auto", "enabled", "disabled"):
        raise ValueError(f"thinking 只能是 auto/enabled/disabled, 收到 {mode!r}")
    extra_body = {"thinking": {"type": mode}} if mode in ("enabled", "disabled") else None
    started = time.time()
    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url}},
                    {"type": "text", "text": prompt},
                ],
            },
        ],
        max_completion_tokens=max_completion_tokens,
        extra_body=extra_body,
    )
    elapsed_s = round(time.time() - started, 2)
    choice = completion.choices[0]
    answer = (choice.message.content or "").strip()
    usage = getattr(completion, "usage", None)
    return {
        "ok": True,
        "answer": answer,
        "model": getattr(completion, "model", model),
        "finish_reason": getattr(choice, "finish_reason", None),
        "thinking": mode,
        "elapsed_s": elapsed_s,
        "usage": (
            {
                "prompt_tokens": getattr(usage, "prompt_tokens", None),
                "completion_tokens": getattr(usage, "completion_tokens", None),
                "total_tokens": getattr(usage, "total_tokens", None),
            }
            if usage is not None
            else None
        ),
        "image": {
            "path": str(Path(image_path).resolve()),
            "sent_bytes": byte_count,
            "resized": resized,
        },
    }


# ---------------------------------------------------------------------------
# 命令行接口 (供 DSH 插件以子进程方式调用)
# ---------------------------------------------------------------------------
def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mimo_vision",
        description="图像转 base64 后调用小米 MiMo V2.6-Flash 进行理解, 结果以一行 JSON 输出",
    )
    parser.add_argument("image", help=r"本地图像路径, 如 C:\Users\iris0\Desktop\12.jpg")
    parser.add_argument("prompt", nargs="?", default=None, help="问题/指令, 默认请模型描述图像内容")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--api-key", default=None, help="覆盖 API Key (默认读 MIMO_API_KEY / mimo_api_key.txt)")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--no-resize", action="store_true", help="禁用大图自动压缩")
    parser.add_argument("--proxy", default=None, help="显式代理地址(如 http://127.0.0.1:7891); 默认直连, 亦可用环境变量 MIMO_PROXY_URL")
    parser.add_argument("--thinking", choices=["auto", "enabled", "disabled"], default=None,
                        help="思考模式: disabled(默认, 实测快 50 倍) / enabled / auto(不发送该字段=平台默认开启)")
    parser.add_argument("--read-timeout", type=float, default=None,
                        help="单次请求读超时秒数(默认 100; 亦可用环境变量 MIMO_READ_TIMEOUT)")
    parser.add_argument("--raw", action="store_true", help="只打印模型回答文本, 不输出 JSON")
    return parser


def _chain(exc: BaseException) -> list[BaseException]:
    """展开异常的因果链: OpenAI SDK 会把 httpx 异常包一层
    (APITimeoutError / APIConnectionError), httpx 又会把底层 OSError 包一层。
    只剥到最底会漏掉 httpx 自己的类型(如 ConnectTimeout), 所以整条链都要看。"""
    out: list[BaseException] = []
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        out.append(cur)
        cur = getattr(cur, "__cause__", None) or getattr(cur, "__context__", None)
    return out


def _classify_error(exc: BaseException) -> tuple[str, str]:
    """把底层异常翻译成 (给人看的摘要, 给排查看的细节)。"""
    status = getattr(exc, "status_code", None)
    response = getattr(exc, "response", None)
    body = ""
    if response is not None:
        try:
            body = (response.text or "")[:300]
        except Exception:  # noqa: BLE001
            body = ""
    retry_after = ""
    if response is not None:
        try:
            retry_after = response.headers.get("retry-after") or ""
        except Exception:  # noqa: BLE001
            retry_after = ""
    name = type(exc).__name__
    try:
        hx = httpx_exceptions()
    except Exception:  # noqa: BLE001 - httpx 缺失时退化为通用分类
        hx = {}
    if status == 429:
        return (
            "MiMo API 限流(HTTP 429 Request rate limited)",
            "请求过于频繁, 请稍后重试" + (f"; retry-after={retry_after}" if retry_after else "") + (f"; {body}" if body else ""),
        )
    if status in (401, 403):
        return (f"MiMo API 拒绝鉴权(HTTP {status})", f"API Key 无效或无权访问该模型; {body}")
    if status == 404:
        return ("MiMo API 找不到该模型(HTTP 404)", f"请检查 --model 是否为在售型号; {body}")
    if status is not None and 400 <= status < 500:
        return (f"MiMo API 拒绝请求(HTTP {status})", body or name)
    if status is not None and status >= 500:
        return (f"MiMo 上游错误(HTTP {status})", body or name)
    # OpenAI SDK 会把 httpx 异常包一层(APITimeoutError / APIConnectionError), httpx
    # 又会把底层 OSError 再包一层; 只看最外层就只能报 "Request timed out." 这种没有
    # 信息量的话。故在整条因果链上判定。
    chain = _chain(exc)
    tail = ""
    if len(chain) > 1:
        tail = "（底层: " + " <- ".join(type(x).__name__ for x in chain) + f"; {str(chain[-1])[:160]}）"

    def in_chain(*names: str) -> bool:
        return any(hx.get(n) and isinstance(x, hx[n]) for n in names for x in chain)

    if in_chain("ConnectTimeout"):
        return (
            f"连接 MiMo 超时({CONNECT_TIMEOUT:g}s)",
            "DNS 解析或 TCP 连接无响应; 检查本机网络。这与代理无关 —— 插件和客户端都强制直连。",
        )
    if in_chain("ConnectError"):
        return ("无法连接 api.xiaomimimo.com", f"DNS/TCP 建连失败{tail}")
    if in_chain("ReadTimeout", "WriteTimeout", "PoolTimeout"):
        budget = os.environ.get("MIMO_READ_TIMEOUT") or DEFAULT_READ_TIMEOUT
        return (
            f"MiMo 上游 {float(budget):g}s 内没有返回完整响应(读超时)",
            "TCP 已连上、服务器没回数据: 通常是上游排队/限流, 或视觉请求本身很慢"
            "(实测 1920x1080 图要 100-170s)。这不是代理或 DNS 问题。" + tail,
        )
    if in_chain("RemoteProtocolError", "ReadError"):
        return ("MiMo 连接被上游中断", f"服务器没回完整响应就断开{tail}")
    if any(isinstance(x, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)) for x in chain):
        return ("MiMo 连接被重置", f"对端(上游或中间设备)掐断了连接{tail}")
    if any(isinstance(x, TimeoutError) for x in chain):
        return ("MiMo 请求超时", f"连接或读取超时, 未收到完整响应{tail}")
    if isinstance(exc, FileNotFoundError):
        return ("图像文件不存在", str(exc))
    if isinstance(exc, PermissionError):
        return ("图像文件不可读(权限)", str(exc))
    return (f"MiMo 调用失败({name})", f"{exc}{tail}")


def _is_retryable(exc: BaseException) -> bool:
    """只有"可能是瞬时的"错误才重试: 限流、5xx、网络类异常。
    本地错误(文件不存在/参数非法)与 4xx(除 429)重试没有意义, 只会白等。"""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status == 429 or status >= 500
    if isinstance(exc, (FileNotFoundError, PermissionError, ValueError, IsADirectoryError)):
        return False
    return True


def httpx_exceptions() -> dict:
    """延迟导入 httpx 异常类, 避免模块导入时就依赖 httpx。"""
    import httpx

    return {
        "ConnectTimeout": httpx.ConnectTimeout,
        "ConnectError": httpx.ConnectError,
        "ReadTimeout": httpx.ReadTimeout,
        "RemoteProtocolError": httpx.RemoteProtocolError,
    }


def _understand_image_guarded(**kwargs) -> dict:
    """带硬超时的守护线程版调用 + 有界重试 + 结构化报错。

    背景: httpx 的 connect timeout 不覆盖 socket.getaddrinfo 的解析阶段, 系统 DNS
    被黑洞时请求会无限挂起; 反过来, 上游"慢"时(如 V2.6 默认开启思考)单次请求会
    长时间不返回。这里把整个 understand_image 调用放进守护线程并 join(timeout):
    到期仍未完成即判为挂起并进入下一次尝试; 全部尝试耗尽后抛 MimoVisionError,
    进程退出时守护线程随进程终止, 不会留下僵尸阻塞。

    重试策略(2026-10-06 修): 只重试"快速失败且可能瞬时"的错误(限流 429 / 5xx /
    连不上); 已经等了很久的尝试(读超时、慢上游)一律不重试 —— 重试只会把同样的
    等待再叠加一遍, 反而撞上插件侧墙钟。反过来说, 单次预算必须**足够大**, 否则
    会把本来能成功的慢请求判死(旧版 150s 硬超时就是这样杀掉了一个 139-169s 才能
    返回的视觉请求)。

    预算关系(改动时务必保持): 读超时 240s < 硬超时 250s < 插件墙钟 330s。这样
    客户端总能先带着明确原因退出(读超时/限流/连不上), 插件墙钟只兜"进程整个卡死"。
    SDK 自带重试已在 understand_image 里关掉(max_retries=0), 重试只在这里做。

    可用环境变量覆盖:
      MIMO_HARD_TIMEOUT: 单次尝试的硬超时秒数(默认 250)
      MIMO_READ_TIMEOUT: 单次请求读超时秒数(默认 240)
      MIMO_ATTEMPTS:     总尝试次数(默认 2)
    """
    read_s = float(
        kwargs.get("read_timeout")
        or os.environ.get("MIMO_READ_TIMEOUT")
        or DEFAULT_READ_TIMEOUT
    )
    # 硬超时默认跟着读超时走: 只调大读超时(比如图片更慢)就够了, 不会出现
    # "读超时 400s 但硬超时还是 250s" 这种自相矛盾的配置。环境变量可显式覆盖。
    hard_timeout = float(
        os.environ.get("MIMO_HARD_TIMEOUT") or max(DEFAULT_HARD_TIMEOUT, read_s + 10.0)
    )
    attempts = int(os.environ.get("MIMO_ATTEMPTS", "2") or 2)
    records: list[str] = []
    last_summary = "MiMo 调用失败"
    last_detail = ""

    def note(line: str) -> None:
        # 打到 stderr: 插件在超时路径上会把 stderr 一并回报, 便于定位卡在哪一步
        print(f"[mimo_vision] {line}", file=sys.stderr, flush=True)

    for attempt in range(1, attempts + 1):
        box: dict = {}

        def worker() -> None:
            try:
                box["result"] = understand_image(**kwargs)
            except Exception as exc:  # noqa: BLE001 - 线程内兜底, 交主线程重试/上报
                box["error"] = exc

        started = time.time()
        note(f"attempt {attempt}/{attempts} start")
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        thread.join(hard_timeout)
        elapsed = time.time() - started

        if thread.is_alive():
            last_summary = f"MiMo 单次请求超过 {hard_timeout:g}s 无结果"
            last_detail = (
                f"第 {attempt}/{attempts} 次尝试在 {elapsed:.1f}s 后中止(读超时 "
                f"{os.environ.get('MIMO_READ_TIMEOUT') or DEFAULT_READ_TIMEOUT:g}s 也没能兜住, "
                "通常是 DNS 解析被黑洞或上游长时间不返回)。已直接报错, 不再重试 —— "
                "重试只会把同样的等待再叠加一遍, 反而撞上插件侧墙钟。"
            )
            records.append(f"#{attempt} {elapsed:.1f}s 挂起")
            note(f"attempt {attempt} hung, aborted at {elapsed:.1f}s (no retry)")
            break

        if "result" in box:
            note(f"attempt {attempt} ok in {elapsed:.1f}s")
            return box["result"]

        exc = box.get("error")
        summary, detail = _classify_error(exc) if exc is not None else ("MiMo 调用失败", "未知错误")
        last_summary, last_detail = summary, detail
        records.append(f"#{attempt} {elapsed:.1f}s {summary}")
        note(f"attempt {attempt} failed in {elapsed:.1f}s: {summary} | {detail[:200]}")
        if exc is not None and (not _is_retryable(exc) or elapsed > 30.0):
            # 快速失败(限流/连不上/5xx)才值得重试; 已经等了很久的尝试(读超时/上游慢)
            # 再重试 = 把等待时间翻倍, 必然撞上外层墙钟, 直接如实上报。
            why = "该错误重试无意义" if not _is_retryable(exc) else f"单次已耗时 {elapsed:.1f}s, 不再重试"
            raise MimoVisionError(summary, detail + f"（{why}, 未重试）")
        if attempt < attempts:
            # 限流时给上游一点时间; 其余错误立刻重试(有界)
            wait = 2.0
            if getattr(exc, "status_code", None) == 429:
                wait = 5.0
            time.sleep(wait)

    raise MimoVisionError(
        last_summary,
        (f"共 {attempts} 次尝试: " + "; ".join(records) + " | " if records else "") + last_detail,
    )


def main(argv=None) -> int:
    # 保证 stdout 始终按 UTF-8 编码输出, 与 DSH 插件侧的解析保持一致
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    args = _build_parser().parse_args(argv)
    try:
        result = _understand_image_guarded(
            image_path=args.image,
            prompt=args.prompt or DEFAULT_PROMPT,
            model=args.model,
            api_key=args.api_key,
            base_url=args.base_url,
            max_completion_tokens=args.max_tokens,
            resize_if_large=not args.no_resize,
            proxy=args.proxy,
            thinking=args.thinking,
            read_timeout=args.read_timeout,
        )
    except Exception as exc:  # noqa: BLE001 - CLI 顶层兜底, 统一转为 JSON 错误
        # MimoVisionError 自带 "给人看的摘要 + 给排查看的细节"; 其它异常退回类名。
        payload = {
            "ok": False,
            "error": getattr(exc, "summary", type(exc).__name__),
            "detail": getattr(exc, "detail", str(exc)),
        }
        if args.raw:
            print(payload["detail"], file=sys.stderr)
        else:
            print(json.dumps(payload, ensure_ascii=False))
        return 1

    if args.raw:
        print(result["answer"])
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
