"""每日备份：数据库快照 + Markdown + 图片打包成 tar.gz，本地保留 N 份，可选上传阿里云 OSS。"""
import logging
import os
import sqlite3
import tarfile
import tempfile
import threading
import time
from datetime import datetime

from . import db

log = logging.getLogger("kb.backup")
BACKUP_DIR = os.environ.get("BACKUP_DIR", "/backups")


def run_backup() -> str:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = os.path.join(BACKUP_DIR, f"kb-{stamp}.tar.gz")
    with tempfile.TemporaryDirectory() as tmp:
        snap = os.path.join(tmp, "kb.db")
        src = sqlite3.connect(db.DB_PATH)
        dst = sqlite3.connect(snap)
        src.backup(dst)  # 在线一致性快照，不需要停服务
        dst.close()
        src.close()
        with tarfile.open(out + ".part", "w:gz") as tar:
            tar.add(snap, arcname="kb.db")
            tar.add(db.NOTES_DIR, arcname="notes")
            tar.add(db.MEDIA_DIR, arcname="media")
    os.replace(out + ".part", out)
    _prune()
    _upload_oss(out)
    log.info("备份完成 %s", out)
    return out


def _prune():
    keep = int(os.environ.get("BACKUP_KEEP", "14"))
    files = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("kb-") and f.endswith(".tar.gz"))
    for f in files[:-keep] if keep > 0 else []:
        os.remove(os.path.join(BACKUP_DIR, f))


def _upload_oss(path: str):
    ep, bucket = os.environ.get("OSS_ENDPOINT"), os.environ.get("OSS_BUCKET")
    ak, sk = os.environ.get("OSS_ACCESS_KEY_ID"), os.environ.get("OSS_ACCESS_KEY_SECRET")
    if not (ep and bucket and ak and sk):
        return
    try:
        import oss2
        b = oss2.Bucket(oss2.Auth(ak, sk), ep, bucket)
        key = os.environ.get("OSS_PREFIX", "kb-backup/") + os.path.basename(path)
        oss2.resumable_upload(b, key, path)
        log.info("已上传 OSS: %s", key)
    except Exception as e:
        log.error("上传 OSS 失败: %s", e)


def start_scheduler():
    hour = int(os.environ.get("BACKUP_HOUR", "4"))
    if hour < 0:
        return

    def loop():
        last = None
        while True:
            n = datetime.now()
            if n.hour == hour and last != n.date():
                last = n.date()
                try:
                    run_backup()
                except Exception as e:
                    log.error("备份失败: %s", e)
            time.sleep(60)

    threading.Thread(target=loop, daemon=True, name="backup").start()
