import hmac
import logging
import os
import re
import time
from typing import List, Optional

import markdown as md_lib
import nh3
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from . import backup, capture, db, llm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("kb")

STATIC = os.path.join(os.path.dirname(__file__), "static")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SECRET = os.environ.get("SECRET_KEY", "")
if not PASSWORD or not SECRET:
    raise SystemExit("必须设置环境变量 ADMIN_PASSWORD 和 SECRET_KEY")
MAX_UPLOAD = 20 * 1024 * 1024

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(SessionMiddleware, secret_key=SECRET, session_cookie="kb_session",
                   max_age=180 * 24 * 3600, same_site="lax",
                   https_only=os.environ.get("COOKIE_SECURE", "1") == "1")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.on_event("startup")
def startup():
    db.init()
    c = db.conn()
    c.execute("UPDATE notes SET status='failed', error='服务重启导致整理中断，可点「重新整理」' "
              "WHERE status='processing'")
    c.commit()
    backup.start_scheduler()
    log.info("知识库启动：LLM=%s 视觉=%s", llm.text_enabled(), llm.vision_enabled())


# ---------------------------------------------------------------- 登录
_fails = {}


def client_ip(req: Request) -> str:
    return req.client.host if req.client else "?"


def require_login(req: Request):
    if not req.session.get("ok"):
        raise HTTPException(401, "未登录")


class LoginIn(BaseModel):
    password: str


@app.post("/api/login")
def login(body: LoginIn, req: Request):
    ip = client_ip(req)
    recent = [t for t in _fails.get(ip, []) if t > time.time() - 900]
    if len(recent) >= 5:
        raise HTTPException(429, "尝试次数过多，请 15 分钟后再试")
    if not hmac.compare_digest(body.password.encode(), PASSWORD.encode()):
        recent.append(time.time())
        _fails[ip] = recent
        time.sleep(1)
        raise HTTPException(401, "密码错误")
    _fails.pop(ip, None)
    req.session["ok"] = True
    return {"ok": True}


@app.post("/api/logout")
def logout(req: Request):
    req.session.clear()
    return {"ok": True}


@app.get("/api/me")
def me(req: Request):
    return {"logged_in": bool(req.session.get("ok")), "llm": llm.text_enabled(),
            "vision": llm.vision_enabled()}


# ---------------------------------------------------------------- 笔记
class NoteIn(BaseModel):
    title: str = ""
    content: str = ""
    tags: str = ""
    summary: Optional[str] = None
    source_url: Optional[str] = None


def render(text: str) -> str:
    h = md_lib.markdown(text or "", extensions=["fenced_code", "tables", "sane_lists", "nl2br"])
    return nh3.clean(h)


class RenderIn(BaseModel):
    content: str = ""


@app.post("/api/render", dependencies=[Depends(require_login)])
def render_preview(body: RenderIn):
    return {"html": render(body.content)}


@app.get("/api/notes", dependencies=[Depends(require_login)])
def list_notes(q: str = "", tag: str = "", offset: int = 0):
    return {"items": db.search(q, tag, 30, offset), "tags": db.top_tags() if not offset else []}


@app.get("/api/notes/{nid}", dependencies=[Depends(require_login)])
def get_note(nid: int):
    n = db.get(nid)
    if not n:
        raise HTTPException(404, "笔记不存在")
    n["html"] = render(n["content"])
    n["stage"] = capture.STAGE.get(nid, "") if n.get("status") == "processing" else ""
    return n


@app.post("/api/notes", dependencies=[Depends(require_login)])
def create_note(body: NoteIn):
    nid = db.create(title=body.title.strip() or capture.first_line_title(body.content),
                    content=body.content, tags=body.tags, summary=body.summary or "",
                    source_url=body.source_url or "")
    return {"id": nid}


@app.put("/api/notes/{nid}", dependencies=[Depends(require_login)])
def update_note(nid: int, body: NoteIn):
    if not db.get(nid):
        raise HTTPException(404, "笔记不存在")
    db.update(nid, title=body.title.strip() or capture.first_line_title(body.content),
              content=body.content, tags=body.tags, summary=body.summary,
              source_url=body.source_url)
    return {"id": nid}


@app.delete("/api/notes/{nid}", dependencies=[Depends(require_login)])
def delete_note(nid: int):
    db.delete(nid)
    return {"ok": True}


@app.post("/api/notes/{nid}/reprocess", dependencies=[Depends(require_login)])
def reprocess(nid: int, bg: BackgroundTasks):
    n = db.get(nid)
    if not n:
        raise HTTPException(404, "笔记不存在")
    imgs = [] if n["source_url"] else re.findall(r"!\[[^\]]*\]\((/media/[^)\s]+)\)", n["content"])
    text = "" if (n["source_url"] or imgs) else n["content"]
    db.update(nid, status="processing", error="")
    bg.add_task(capture.process, nid, text, n["source_url"], imgs)
    return {"ok": True}


# ---------------------------------------------------------------- 收藏 / 分享
async def _save_uploads(files: List[UploadFile]) -> List[str]:
    urls = []
    for f in files or []:
        if not f or not f.filename:
            continue
        ctype = (f.content_type or "").split(";")[0]
        if not ctype.startswith("image/"):
            continue
        data = await f.read()
        if 0 < len(data) <= MAX_UPLOAD:
            urls.append(capture.save_media(data, capture.IMG_EXT.get(ctype, "jpg")))
    return urls


async def _capture(bg: BackgroundTasks, title: str, text: str, url: str, files) -> int:
    title, text, url = (title or "").strip(), (text or "").strip(), (url or "").strip()
    if title and title not in text:
        text = f"{title}\n{text}".strip()
    if url and url not in text:
        text = f"{text}\n{url}".strip()
    imgs = await _save_uploads(files)
    if not (text.strip() or url.strip() or imgs):
        raise HTTPException(400, "没有可保存的内容")
    nid = db.create(title=capture.first_line_title(text) if text.strip() else "截图笔记",
                    content=text, source_url=url or capture.extract_url(text), status="processing")
    bg.add_task(capture.process, nid, text, url, imgs)
    return nid


@app.post("/api/capture", dependencies=[Depends(require_login)])
async def api_capture(bg: BackgroundTasks, title: str = Form(""), text: str = Form(""),
                      url: str = Form(""), files: List[UploadFile] = File(default=[])):
    return {"id": await _capture(bg, title, text, url, files)}


@app.post("/share")
async def share_target(req: Request, bg: BackgroundTasks, title: str = Form(""), text: str = Form(""),
                       url: str = Form(""), files: List[UploadFile] = File(default=[])):
    # 一般由 Service Worker 接管；这里是 SW 未生效时的兜底
    if not req.session.get("ok"):
        return RedirectResponse("/#/login", status_code=303)
    nid = await _capture(bg, title, text, url, files)
    return RedirectResponse(f"/#/note/{nid}", status_code=303)


@app.post("/api/media", dependencies=[Depends(require_login)])
async def upload_media(file: UploadFile = File(...)):
    urls = await _save_uploads([file])
    if not urls:
        raise HTTPException(400, "只支持 20MB 以内的图片")
    return {"url": urls[0]}


@app.get("/media/{path:path}", dependencies=[Depends(require_login)])
def media(path: str):
    full = os.path.realpath(os.path.join(db.MEDIA_DIR, path))
    if not full.startswith(os.path.realpath(db.MEDIA_DIR) + os.sep) or not os.path.isfile(full):
        raise HTTPException(404)
    return FileResponse(full, headers={"Cache-Control": "private, max-age=31536000, immutable"})


# ---------------------------------------------------------------- 备份 / 导出
@app.get("/api/export", dependencies=[Depends(require_login)])
def export():
    path = backup.run_backup()
    return FileResponse(path, filename=os.path.basename(path), media_type="application/gzip")


# ---------------------------------------------------------------- 页面
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"), headers={"Cache-Control": "no-cache"})


@app.get("/sw.js")
def sw():
    return FileResponse(os.path.join(STATIC, "sw.js"), media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/healthz")
def health():
    return {"ok": True}


@app.exception_handler(HTTPException)
async def http_err(req: Request, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
