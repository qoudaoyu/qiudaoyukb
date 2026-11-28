"""OpenAI 兼容接口的极简客户端。

默认 DeepSeek；换别家（通义千问、Kimi、OpenAI……）只需改环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。
可选的视觉模型（VISION_*）用于截图识别；不配置时用本地 tesseract OCR 兜底。
"""
import base64
import json
import os
import re

import httpx


def _cfg(prefix: str):
    return {
        "base": os.environ.get(f"{prefix}_BASE_URL", "").rstrip("/"),
        "key": os.environ.get(f"{prefix}_API_KEY", ""),
        "model": os.environ.get(f"{prefix}_MODEL", ""),
    }


def text_enabled() -> bool:
    c = _cfg("LLM")
    return bool(c["base"] and c["key"] and c["model"])


def vision_enabled() -> bool:
    c = _cfg("VISION")
    return bool(c["base"] and c["key"] and c["model"])


def _chat(cfg, messages, json_mode=False, max_tokens=4000, timeout=180) -> str:
    url = cfg["base"]
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"
    body = {"model": cfg["model"], "messages": messages, "temperature": 0.2, "max_tokens": max_tokens}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    r = httpx.post(url, json=body, timeout=timeout,
                   headers={"Authorization": f"Bearer {cfg['key']}"})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"] or ""


def _parse_json(s: str) -> dict:
    s = s.strip()
    m = re.search(r"\{.*\}", s, re.S)
    return json.loads(m.group(0) if m else s)


SYSTEM = """你是个人知识库的整理助手。把用户收藏的网页/帖子/截图文字整理成一条干净的笔记。
要求：
- 只整理，不编造原文没有的信息；保持原文语言。
- 去掉广告、导航、"点赞收藏关注"、话题标签堆砌、无意义表情等噪音。
- 原文里的表格（Markdown 表格，或明显是行列结构的数据）在 content 中保留为 Markdown 表格，不要改写成列表或段落；表格内容不删减。
- 输出严格的 JSON 对象，字段：
  title: 简洁标题（原标题合适就沿用）
  author: 作者/博主名，没有就空字符串
  summary: 1~3 句中文摘要
  tags: 3~6 个中文短标签（数组，不带 #）
  content: 正文，Markdown 格式（需要时才给）
"""


IMAGE_TEXT_HINT = """
注意：原文里「图片文字」部分是从图片里机器识别出来的，比较杂乱。整理 content 时：
- 把它和帖子正文合成一篇连贯、好读的笔记，不要再单独保留「图片文字」这个标题，也不要按“第几张图”罗列。
- 保留有信息量的内容：观点、方法步骤、数据、清单条目、结论等；清单类内容保留全部条目，不要只挑几条。
- 删掉没价值的文字：重复出现的封面标题、水印、页码、账号名/logo、"关注我""点赞收藏"之类的引导语、广告和推广（如"更多内容见 xxx.com""免费注册""私信领取"等引流网址/话术）、话题标签、装饰性口号、对纯照片的描述。
- 明显的识别错字、断行可以顺手修正，但不要改变原意，不要补充原文没有的信息。"""


def organize(raw_text: str, title: str = "", url: str = "", author: str = "",
             want_content: bool = True, image_lines: str = "", from_images: bool = False,
             condense: bool = False) -> dict:
    """返回 {title, author, summary, tags, content?}；未配置 LLM 时返回 {}。"""
    if not text_enabled():
        return {}
    hint = ("请同时给出整理后的 content（用 Markdown 分段、列表、小标题让它好读）。"
            if want_content else "正文很长，content 字段留空，只给 title/author/summary/tags。")
    if want_content and from_images:
        hint += IMAGE_TEXT_HINT
        if condense:
            hint += "\n- 原文很长，content 请精简到 5000 字以内：合并重复、压缩啰嗦的表述，但要点和清单条目都要保留。"
    if want_content and image_lines:
        if from_images:
            hint += "\n原图用下面这些 Markdown 图片行表示，请在 content 最后加一节「## 原图」，把它们原样放在那里：\n" + image_lines
        else:
            hint += "\n原文里的图片用下面这些 Markdown 图片行表示，请原样保留在 content 中合适的位置：\n" + image_lines
    user = f"来源：{url or '无'}\n已知标题：{title or '无'}\n已知作者：{author or '无'}\n{hint}\n\n----- 原文 -----\n{raw_text[:24000 if from_images else 14000]}"
    out = _chat(_cfg("LLM"), [{"role": "system", "content": SYSTEM},
                              {"role": "user", "content": user}], json_mode=True,
                max_tokens=8000 if want_content else 1000)
    d = _parse_json(out)
    if isinstance(d.get("tags"), str):
        d["tags"] = re.split(r"[,，\s]+", d["tags"])
    return d


def read_images(paths, kind: str = "screenshot") -> str:
    """用视觉模型把截图 / 图文笔记的配图转成 Markdown 文字。"""
    table_rule = "图片里的表格请转写成 Markdown 表格（| 列 | 列 |），保留表头和每一行，合并单元格就在各行重复填写。"
    prompt = ("这些是手机截图（可能来自小红书、公众号等）。请把其中的正文内容完整、准确地转写成 Markdown，"
              "保留标题、作者、列表结构；" + table_rule + "忽略状态栏、按钮、评论区和广告。只输出转写结果。")
    if kind == "post":
        prompt = ("这些是一篇图文笔记（如小红书）的配图，按顺序排列。请把图片里有信息量的文字准确转写成 Markdown，"
                  "保留标题、列表等结构，多张图的内容按顺序连起来。" + table_rule +
                  "不要转写：水印、页码、平台 logo、账号名、每张图重复的封面标题、\"关注我/点赞收藏\"等引导语、广告和引流推广（推广网址、\"免费注册\"等）。"
                  "没有文字的纯照片直接跳过，不要描述。只输出转写结果。")
    content = [{"type": "text", "text": prompt}]
    for p in paths:
        ext = os.path.splitext(p)[1].lower().lstrip(".") or "png"
        mime = "jpeg" if ext in ("jpg", "jpeg") else ext
        with open(p, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        content.append({"type": "image_url", "image_url": {"url": f"data:image/{mime};base64,{b64}"}})
    return _chat(_cfg("VISION"), [{"role": "user", "content": content}], max_tokens=4000)
