"""SQLite 存储 + Markdown 文件镜像。

数据库是唯一的数据源；每篇笔记同时写一份 /data/notes/<id>.md（带 front matter），
方便随时拷走、用任何编辑器打开，不被本应用锁死。
"""
import os
import re
import sqlite3
import threading
from datetime import datetime

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "kb.db")
NOTES_DIR = os.path.join(DATA_DIR, "notes")
MEDIA_DIR = os.path.join(DATA_DIR, "media")

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, content, summary, tags, author,
  content='notes', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content, summary, tags, author)
  VALUES (new.id, new.title, new.content, new.summary, new.tags, new.author);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content, summary, tags, author)
  VALUES ('delete', old.id, old.title, old.content, old.summary, old.tags, old.author);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content, summary, tags, author)
  VALUES ('delete', old.id, old.title, old.content, old.summary, old.tags, old.author);
  INSERT INTO notes_fts(rowid, title, content, summary, tags, author)
  VALUES (new.id, new.title, new.content, new.summary, new.tags, new.author);
END;
"""

FIELDS = ("title", "content", "summary", "tags", "source_url", "author", "status", "error")


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def conn() -> sqlite3.Connection:
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=30000")
        _local.c = c
    return c


def init():
    os.makedirs(NOTES_DIR, exist_ok=True)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    c = conn()
    c.executescript(SCHEMA)
    c.commit()


def normalize_tags(tags) -> str:
    if isinstance(tags, str):
        tags = re.split(r"[,，\s#]+", tags)
    seen = []
    for t in tags or []:
        t = str(t).strip().lstrip("#").strip()
        if t and t not in seen:
            seen.append(t)
    return " ".join(seen[:12])


def create(**kw) -> int:
    data = {k: kw.get(k, "") or "" for k in FIELDS}
    data["status"] = kw.get("status") or "ready"
    data["tags"] = normalize_tags(data["tags"])
    ts = now()
    c = conn()
    cur = c.execute(
        f"INSERT INTO notes({','.join(FIELDS)},created_at,updated_at) "
        f"VALUES ({','.join('?' * len(FIELDS))},?,?)",
        [data[k] for k in FIELDS] + [ts, ts],
    )
    c.commit()
    nid = cur.lastrowid
    write_md(nid)
    return nid


def update(nid: int, **kw):
    data = {k: v for k, v in kw.items() if k in FIELDS and v is not None}
    if "tags" in data:
        data["tags"] = normalize_tags(data["tags"])
    if not data:
        return
    sets = ",".join(f"{k}=?" for k in data) + ",updated_at=?"
    c = conn()
    c.execute(f"UPDATE notes SET {sets} WHERE id=?", list(data.values()) + [now(), nid])
    c.commit()
    write_md(nid)


def get(nid: int):
    r = conn().execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
    return dict(r) if r else None


def delete(nid: int):
    c = conn()
    c.execute("DELETE FROM notes WHERE id=?", (nid,))
    c.commit()
    p = os.path.join(NOTES_DIR, f"{nid}.md")
    if os.path.exists(p):
        os.remove(p)


def search(q: str = "", tag: str = "", limit: int = 30, offset: int = 0):
    sql = ["SELECT id,title,summary,tags,source_url,author,status,created_at,updated_at,"
           "substr(content,1,160) AS excerpt,"
           "CASE WHEN instr(content,'](/media/')>0 "
           "THEN substr(content,instr(content,'](/media/')+2,80) ELSE '' END AS thumb "
           "FROM notes WHERE 1=1"]
    args = []
    for term in (q or "").split():
        if term.startswith("#") and len(term) > 1:
            tag_term = term[1:]
            sql.append("AND (' '||tags||' ') LIKE ?")
            args.append(f"% {tag_term} %")
        elif len(term) >= 3:
            # trigram 分词：对中文也能做子串匹配，>=3 个字走索引
            sql.append("AND id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)")
            args.append('"' + term.replace('"', '""') + '"')
        else:
            like = f"%{term}%"
            sql.append("AND (title LIKE ? OR content LIKE ? OR summary LIKE ? OR tags LIKE ? OR author LIKE ?)")
            args += [like] * 5
    if tag:
        sql.append("AND (' '||tags||' ') LIKE ?")
        args.append(f"% {tag} %")
    sql.append("ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    args += [limit, offset]
    return [dict(r) for r in conn().execute(" ".join(sql), args).fetchall()]


def top_tags(limit: int = 30):
    counts = {}
    for (tags,) in conn().execute("SELECT tags FROM notes WHERE tags!=''"):
        for t in tags.split():
            counts[t] = counts.get(t, 0) + 1
    return sorted(counts.items(), key=lambda x: -x[1])[:limit]


def _yaml(v: str) -> str:
    return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def write_md(nid: int):
    n = get(nid)
    if not n:
        return
    fm = [
        "---",
        f"title: {_yaml(n['title'])}",
        f"source: {_yaml(n['source_url'])}",
        f"author: {_yaml(n['author'])}",
        f"tags: [{', '.join(_yaml(t) for t in n['tags'].split())}]",
        f"summary: {_yaml(n['summary'])}",
        f"created: {_yaml(n['created_at'])}",
        f"updated: {_yaml(n['updated_at'])}",
        "---",
        "",
    ]
    path = os.path.join(NOTES_DIR, f"{nid}.md")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(fm) + n["content"] + "\n")
    os.replace(tmp, path)
