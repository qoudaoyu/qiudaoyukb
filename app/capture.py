"""收藏流程：分享进来的链接/文字/截图 -> 抓取 -> AI 整理 -> 笔记。

每一步失败都有兜底，保证"分享的东西不会丢"：
  抓不到正文 -> 保留分享原文 + 链接；AI 失败 -> 保留抓取的原始 Markdown；
  截图 -> 有视觉模型用视觉模型，没有就用本地 tesseract OCR。
"""
import hashlib
import json
import logging
import os
import re
import traceback
from datetime import datetime
from urllib.parse import urljoin, urlparse

import httpx
from lxml import html as lxml_html

from . import db, llm

log = logging.getLogger("kb.capture")

UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
           "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}
URL_RE = re.compile(r"https?://[^\s<>\"'，。！？、；）)】」]+")
MAX_IMAGES = 30
MAX_IMAGE_BYTES = 15 * 1024 * 1024
IMG_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
           "image/gif": "gif", "image/avif": "avif", "image/heic": "heic"}


# ---------------------------------------------------------------- 工具函数
def extract_url(text: str) -> str:
    m = URL_RE.search(text or "")
    return m.group(0).rstrip(".,") if m else ""


def save_media(data: bytes, ext: str) -> str:
    """保存文件到 /data/media/YYYYMM/<sha1>.<ext>，返回可访问的 URL 路径。"""
    h = hashlib.sha1(data).hexdigest()[:20]
    sub = datetime.now().strftime("%Y%m")
    d = os.path.join(db.MEDIA_DIR, sub)
    os.makedirs(d, exist_ok=True)
    name = f"{h}.{ext}"
    p = os.path.join(d, name)
    if not os.path.exists(p):
        with open(p, "wb") as f:
            f.write(data)
    return f"/media/{sub}/{name}"


def media_path(url_path: str) -> str:
    return os.path.join(db.MEDIA_DIR, url_path[len("/media/"):])


def first_line_title(text: str) -> str:
    for line in (text or "").splitlines():
        line = re.sub(r"https?://\S+", "", line).strip(" #\t")
        if line:
            return line[:40]
    return "未命名笔记"


def _decode(r: httpx.Response) -> str:
    if r.charset_encoding:
        return r.text
    m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", r.content[:4000], re.I)
    enc = m.group(1).decode() if m else "utf-8"
    try:
        return r.content.decode(enc, errors="replace")
    except LookupError:
        return r.content.decode("utf-8", errors="replace")


# ---------------------------------------------------------------- 网页抓取
def _meta(doc, *names):
    for n in names:
        v = doc.xpath(f'//meta[@property="{n}" or @name="{n}"]/@content')
        if v and v[0].strip():
            return v[0].strip()
    return ""


def _find_note_obj(o, depth=0):
    """在小红书 __INITIAL_STATE__ 里找笔记对象（含 desc 字段的那个 dict）。"""
    if depth > 12:
        return None
    if isinstance(o, dict):
        if isinstance(o.get("desc"), str) and ("imageList" in o or "title" in o or "user" in o):
            return o
        for v in o.values():
            r = _find_note_obj(v, depth + 1)
            if r:
                return r
    elif isinstance(o, list):
        for v in o:
            r = _find_note_obj(v, depth + 1)
            if r:
                return r
    return None


def _extract_xhs(html: str):
    m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*</script>", html, re.S)
    if not m:
        return None
    try:
        data = json.loads(re.sub(r"\bundefined\b", "null", m.group(1)))
    except Exception:
        return None
    note = _find_note_obj(data)
    if not note:
        return None
    imgs = []
    for im in note.get("imageList") or []:
        u = im.get("urlDefault") or im.get("url") or ""
        if not u and im.get("infoList"):
            u = im["infoList"][-1].get("url", "")
        if u:
            imgs.append(u if u.startswith("http") else "https:" + u)
    user = note.get("user") or {}
    return {
        "title": note.get("title") or "",
        "author": user.get("nickname") or user.get("nickName") or "",
        "markdown": note.get("desc") or "",
        "images": imgs,
    }


def _readability(html: str, url: str):
    from markdownify import markdownify
    from readability import Document

    # 公众号等懒加载图片：data-src -> src
    html = re.sub(r"<img([^>]*?)\sdata-src=", r"<img\1 src=", html)
    doc = Document(html, url=url)
    body_html = doc.summary(html_partial=True)
    md = markdownify(body_html, heading_style="ATX", strip=["script", "style"])
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    imgs = []

    def fix(m):
        alt, src = m.group(1), m.group(2)
        src = urljoin(url, src)
        if src.startswith("http") and src not in imgs:
            imgs.append(src)
        return f"![{alt}]({src})"

    md = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)[^)]*\)", fix, md)
    return doc.short_title(), md, imgs


def fetch_article(url: str) -> dict:
    with httpx.Client(follow_redirects=True, timeout=25, headers=HEADERS) as c:
        r = c.get(url)
        r.raise_for_status()
        final = str(r.url)
        html = _decode(r)
    doc = lxml_html.fromstring(html)
    meta = {
        "title": _meta(doc, "og:title", "twitter:title") or (doc.findtext(".//title") or "").strip(),
        "desc": _meta(doc, "og:description", "description"),
        "author": _meta(doc, "author", "article:author", "og:article:author"),
        "image": _meta(doc, "og:image"),
    }
    res = {"url": final, "title": meta["title"], "author": meta["author"], "markdown": "", "images": []}

    host = urlparse(final).hostname or ""
    is_xhs = any(h in host for h in ("xiaohongshu", "rednote", "xhslink"))
    xhs = _extract_xhs(html) if is_xhs or "__INITIAL_STATE__" in html else None
    if xhs and (xhs["markdown"] or xhs["images"]):
        res.update({k: v for k, v in xhs.items() if v})
        res["image_post"] = True  # 小红书图文：文字多在图片里
    else:
        try:
            t, md, imgs = _readability(html, final)
            res["markdown"], res["images"] = md, imgs
            if t and not res["title"]:
                res["title"] = t
        except Exception:
            log.warning("readability 失败: %s", traceback.format_exc(limit=1))

    plain = re.sub(r"!\[[^\]]*\]\([^)]*\)|[#>*_\-\s]", "", res["markdown"])
    if len(plain) < 40 and len(meta["desc"]) > len(plain):
        res["markdown"] = meta["desc"]
    if not res["images"] and meta["image"]:
        res["images"] = [urljoin(final, meta["image"])]
    res["title"] = re.sub(r"\s*[-|_]\s*小红书.*$", "", res["title"]).strip()
    return res


def localize_images(md: str, imgs, referer: str):
    """下载图片到本地，替换 Markdown 里的链接；没出现在正文里的图片追加到末尾。
    返回 (markdown, 按顺序的本地图片 /media/... 列表)。"""
    mapping, extra = {}, []
    with httpx.Client(follow_redirects=True, timeout=25,
                      headers={**HEADERS, "Referer": referer,
                               "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"}) as c:
        for u in imgs[:MAX_IMAGES]:
            try:
                r = c.get(u)
                ctype = r.headers.get("content-type", "").split(";")[0].strip()
                if r.status_code != 200 or not ctype.startswith("image/") or len(r.content) > MAX_IMAGE_BYTES:
                    continue
                mapping[u] = save_media(r.content, IMG_EXT.get(ctype, "jpg"))
            except Exception:
                continue
    for u, local in mapping.items():
        if u in md:
            md = md.replace(u, local)
        else:
            extra.append(f"![]({local})")
    if extra:
        md = (md + "\n\n" + "\n\n".join(extra)).strip()
    return md, list(mapping.values())


# ---------------------------------------------------------------- 截图识别
def ocr_images(paths, kind: str = "screenshot") -> str:
    if not paths:
        return ""
    if llm.vision_enabled():
        try:
            # 分批送，避免单次请求过大/超时
            parts = [llm.read_images(paths[i:i + 6], kind) for i in range(0, len(paths), 6)]
            return "\n\n".join(p.strip() for p in parts if p and p.strip())
        except Exception as e:
            log.warning("视觉模型失败，改用 OCR: %s", e)
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        return ""
    out = []
    for p in paths:
        try:
            t = pytesseract.image_to_string(Image.open(p), lang="chi_sim+eng")
            # tesseract 中文结果字间常带空格，去掉
            t = re.sub(r"(?<=[一-鿿　-〿＀-￯]) (?=[一-鿿　-〿＀-￯])", "", t)
            out.append(t.strip())
        except Exception as e:
            log.warning("OCR 失败 %s: %s", p, e)
    return "\n\n".join(x for x in out if x)


# ---------------------------------------------------------------- 抓取失败的友好提示
SITE_NAMES = [("zhihu", "知乎"), ("xiaohongshu", "小红书"), ("rednote", "小红书"), ("xhslink", "小红书"),
              ("mp.weixin", "公众号"), ("weibo", "微博"), ("bilibili", "B站"), ("b23.tv", "B站"),
              ("douyin", "抖音"), ("toutiao", "今日头条"), ("douban", "豆瓣"), ("jianshu", "简书"),
              ("csdn", "CSDN"), ("juejin", "掘金")]
SCREENSHOT_TIP = "可以截图后分享到知识库，会自动识别文字"


def site_name(url: str) -> str:
    host = urlparse(url or "").hostname or ""
    for key, name in SITE_NAMES:
        if key in host:
            return name
    return re.sub(r"^www\.", "", host) or "网页"


def friendly_fetch_error(e: Exception, url: str) -> str:
    site = site_name(url)
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        if code in (401, 403, 412, 429, 451):
            return f"{site}限制了服务器抓取（HTTP {code}），{SCREENSHOT_TIP}"
        if code == 404:
            return f"{site}页面不存在或已删除（HTTP 404）"
        return f"{site}暂时无法访问（HTTP {code}），稍后可点「重新整理」再试，或{SCREENSHOT_TIP}"
    if isinstance(e, httpx.TimeoutException):
        return f"连接{site}超时，稍后可点「重新整理」再试，或{SCREENSHOT_TIP}"
    if isinstance(e, httpx.HTTPError):
        return f"连接{site}失败（{type(e).__name__}），稍后可点「重新整理」再试，或{SCREENSHOT_TIP}"
    return f"抓取{site}失败：{e}"


# ---------------------------------------------------------------- 主流程
STAGE = {}  # 笔记 id -> 当前处理阶段（内存里，单进程够用；前端轮询时显示）


def process(nid: int, text: str = "", url: str = "", image_urls=None):
    """后台执行。image_urls 是已经存到本地的截图（/media/...）。"""
    try:
        _process(nid, text, url, image_urls)
    finally:
        STAGE.pop(nid, None)


def _process(nid: int, text: str = "", url: str = "", image_urls=None):
    image_urls = image_urls or []
    errors = []
    from_images = False  # 正文里有从图片识别出的文字
    link_post = False    # 链接收藏的图文笔记（不留原图，末尾放原文链接）
    fetch_failed = False
    title, author, body = "", "", ""
    url = url or extract_url(text)
    final_url = url
    try:
        if url:
            STAGE[nid] = "抓取正文"
            try:
                art = fetch_article(url)
                final_url = art["url"]
                title, author = art["title"], art["author"]
                body, local_imgs = localize_images(art["markdown"], art["images"], final_url)
                # 图文笔记（小红书，或正文几乎没字只有图）：识别图片里的文字
                text_len = len(re.sub(r"!\[[^\]]*\]\([^)]*\)|\s", "", body))
                if local_imgs and (art.get("image_post") or text_len < 100):
                    STAGE[nid] = "识别图片文字"
                    ocr = ocr_images([media_path(u) for u in local_imgs[:18]], kind="post")
                    if ocr:
                        # 链接收藏的图文笔记：只留 AI 整理后的文字 + 原文链接，不存原图
                        from_images = link_post = True
                        body = re.sub(r"!\[[^\]]*\]\(/media/[^)]+\)", "", body).strip()
                        body = "\n\n".join(x for x in (body, "**图片文字：**\n\n" + ocr) if x)
                        for u in local_imgs:
                            try:
                                os.remove(media_path(u))
                            except OSError:
                                pass
                    else:
                        errors.append("图片文字识别没有结果")
            except Exception as e:
                fetch_failed = True
                log.warning("抓取失败 %s: %s", url, e)
                errors.append(friendly_fetch_error(e, url))

        shared_text = (text or "").strip()
        if image_urls:
            STAGE[nid] = "识别图片文字"
            ocr = ocr_images([media_path(u) for u in image_urls])
            pics = "\n\n".join(f"![]({u})" for u in image_urls)
            body = "\n\n".join(x for x in (body, "**图片文字：**\n\n" + ocr if ocr else "", pics) if x)
            if ocr:
                from_images = True
            else:
                errors.append("截图文字识别没有结果")

        if not body:
            # 什么都没抓到：至少保留分享的原文
            body = shared_text or (f"<{url}>" if url else "")

        raw_title = title or first_line_title(shared_text or body)
        result = {}
        plain_len = len(re.sub(r"\s", "", re.sub(r"!\[[^\]]*\]\([^)]*\)|<?https?://\S+", "", body)))
        # 抓取失败、手里只有链接（或几乎没字）：不让 AI 硬整理，直接存链接并说明原因
        nothing_usable = fetch_failed and not from_images and plain_len < 20
        if nothing_usable:
            raw_title = f"{site_name(url)}链接（未能抓取正文）"
            safe = url.replace(" ", "%20").replace("(", "%28").replace(")", "%29")
            body = f"[打开原文]({safe})"
        if llm.text_enabled() and plain_len > 20 and not nothing_usable:
            # 图片识别出的文字一定要 AI 加工（太长就让它精简），普通网页太长则只要摘要
            want_content = from_images or plain_len < 7000
            image_lines = "\n".join(re.findall(r"!\[[^\]]*\]\(/media/[^)]+\)", body))
            STAGE[nid] = "AI 整理"
            try:
                result = llm.organize(body, raw_title, final_url, author, want_content, image_lines,
                                      from_images=from_images, condense=from_images and plain_len > 12000)
            except Exception as e:
                errors.append(f"AI 整理失败：{e}")

        content = (result.get("content") or "").strip() or body
        # AI 若漏掉了本地图片，补回去（图文笔记统一放在末尾「原图」下）
        missing = [l for l in re.findall(r"!\[[^\]]*\]\(/media/[^)]+\)", body) if l.split("(")[1] not in content]
        if missing:
            if from_images and result.get("content") and "## 原图" not in content:
                content += "\n\n## 原图"
            content += "\n\n" + "\n\n".join(missing)
        if link_post and final_url:
            safe = final_url.replace(" ", "%20").replace("(", "%28").replace(")", "%29")
            content += f"\n\n[查看原文]({safe})"

        db.update(nid,
                  title=(result.get("title") or raw_title).strip()[:120],
                  author=(result.get("author") or author or "").strip()[:60],
                  summary=(result.get("summary") or "").strip(),
                  tags=result.get("tags") or "",
                  source_url=final_url or "",
                  content=content,
                  status="ready",
                  error="；".join(errors))
    except Exception as e:
        log.error("处理笔记 %s 失败: %s", nid, traceback.format_exc())
        db.update(nid, status="failed", error=f"{e}",
                  content=(text or "") + ("\n\n" + "\n\n".join(f"![]({u})" for u in image_urls) if image_urls else ""))
