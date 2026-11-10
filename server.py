#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
خادم موقع معهد هدى للناس
------------------------
بدون أي مكتبات خارجية: Python 3.8+ فقط (http.server + sqlite3).

تشغيل:        python server.py
إعادة كلمة مرور:  python server.py setpass USERNAME NEWPASSWORD
"""
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import seed

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
UPLOADS = STATIC / "uploads"
DB_PATH = os.environ.get("DB_PATH", str(BASE / "mahad.db"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
SECURE_COOKIE = os.environ.get("SECURE_COOKIE", "") == "1"   # فعّله عند النشر خلف HTTPS
TRUST_PROXY = os.environ.get("TRUST_PROXY", "") == "1"       # فعّله إن كان خلف nginx ونحوه
SESSION_DAYS = 14
MAX_JSON = 1 * 1024 * 1024
MAX_UPLOAD = 3 * 1024 * 1024

USERNAME_RE = re.compile(r"^[a-z0-9_]{3,32}$")
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


# ───────────────────────── قاعدة البيانات ─────────────────────────
SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '' CHECK (gender IN ('','male','female')),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('supervisor','student')),
  city TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS programs (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  headline TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS program_axes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_key TEXT NOT NULL REFERENCES programs(key) ON DELETE CASCADE ON UPDATE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS program_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_key TEXT NOT NULL REFERENCES programs(key) ON DELETE CASCADE ON UPDATE CASCADE,
  stage TEXT NOT NULL, activity TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  q TEXT NOT NULL, a TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('video','playlist')),
  youtube_id TEXT NOT NULL DEFAULT '',
  thumb TEXT NOT NULL DEFAULT '',
  home_section TEXT NOT NULL DEFAULT '' CHECK (home_section IN ('','lectures','benefit')),
  program_key TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_key TEXT NOT NULL REFERENCES programs(key) ON DELETE CASCADE ON UPDATE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active')),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE (user_id, program_key)
);
CREATE TABLE IF NOT EXISTS supervisor_programs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_key TEXT NOT NULL REFERENCES programs(key) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (user_id, program_key)
);
CREATE TABLE IF NOT EXISTS saved_videos (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_key TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '' CHECK (gender IN ('','male','female')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered')),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, telegram TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enroll_prog ON enrollments(program_key);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def rows(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def one(conn, sql, args=()):
    r = conn.execute(sql, args).fetchone()
    return dict(r) if r else None


def now():
    return int(time.time())


def init_db():
    UPLOADS.mkdir(parents=True, exist_ok=True)
    conn = db()
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    user_columns = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "gender" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT ''")
    outbox_columns = {r["name"] for r in conn.execute("PRAGMA table_info(outbox)")}
    if "gender" not in outbox_columns:
        conn.execute("ALTER TABLE outbox ADD COLUMN gender TEXT NOT NULL DEFAULT ''")
    conn.execute(
        "UPDATE settings SET value=replace(value, ?, ?) WHERE key='terms_text' AND instr(value, ?) > 0",
        ("الاسم، ومعرّف تيليجرام، والمدينة والنبذة (اختياريتان)",
         "الاسم، ومعرّف تيليجرام، والنوع، والمدينة والنبذة (اختياريتان)",
         "الاسم، ومعرّف تيليجرام، والمدينة والنبذة (اختياريتان)"))
    conn.execute("INSERT OR IGNORE INTO supervisor_programs (user_id,program_key) "
                 "SELECT u.id,p.key FROM users u CROSS JOIN programs p WHERE u.role='admin'")
    conn.execute("UPDATE users SET role='supervisor', name=CASE WHEN name='مدير الموقع' "
                 "THEN 'مشرف الموقع' ELSE name END WHERE role='admin'")
    if not one(conn, "SELECT 1 AS x FROM programs LIMIT 1"):
        t = now()
        for k, v in seed.SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings VALUES (?,?)", (k, v))
        for key, name, head, aud, desc, cover, srt in seed.PROGRAMS:
            conn.execute("INSERT INTO programs (key,name,headline,audience,description,cover,sort) VALUES (?,?,?,?,?,?,?)",
                         (key, name, head, aud, desc, cover, srt))
            for i, (a, b) in enumerate(seed.AXES.get(key, [])):
                conn.execute("INSERT INTO program_axes (program_key,title,body,sort) VALUES (?,?,?,?)", (key, a, b, i))
            for i, (a, b) in enumerate(seed.PLAN.get(key, [])):
                conn.execute("INSERT INTO program_plan (program_key,stage,activity,sort) VALUES (?,?,?,?)", (key, a, b, i))
        for i, (q, a) in enumerate(seed.FAQS):
            conn.execute("INSERT INTO faqs (q,a,sort) VALUES (?,?,?)", (q, a, i))
        for title, kind, thumb, sec, pk, desc, srt in seed.VIDEOS:
            conn.execute("INSERT INTO videos (title,kind,thumb,home_section,program_key,description,sort,created_at) VALUES (?,?,?,?,?,?,?,?)",
                         (title, kind, thumb, sec, pk, desc, srt, t))
    # حساب المشرف الأول، بصلاحيات كاملة على الموقع.
    if not one(conn, "SELECT 1 AS x FROM users WHERE role='supervisor' LIMIT 1"):
        user = norm_username(os.environ.get("ADMIN_USER", "admin"))
        pw = os.environ.get("ADMIN_PASS") or secrets.token_urlsafe(9)
        cur = conn.execute("INSERT INTO users (username,name,password_hash,role,created_at) VALUES (?,?,?,?,?)",
                           (user, "مشرف الموقع", hash_pw(pw), "supervisor", now()))
        conn.executemany("INSERT OR IGNORE INTO supervisor_programs (user_id,program_key) VALUES (?,?)",
                         [(cur.lastrowid, r["key"]) for r in rows(conn, "SELECT key FROM programs")])
        print("=" * 60)
        print(" تم إنشاء حساب المشرف (يظهر هذا مرة واحدة فقط):")
        print("   معرّف الدخول :", user)
        print("   كلمة المرور  :", pw)
        print(" غيّرها بعد أول دخول من صفحة «حسابي».")
        print("=" * 60)
    conn.execute("INSERT OR IGNORE INTO supervisor_programs (user_id,program_key) "
                 "SELECT u.id,p.key FROM users u CROSS JOIN programs p WHERE u.role='supervisor'")
    conn.commit()
    conn.close()


# ───────────────────────── كلمات المرور والجلسات ─────────────────────────
def hash_pw(pw, iters=240_000):
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, iters)
    return "pbkdf2$%d$%s$%s" % (iters, salt.hex(), dk.hex())


def verify_pw(pw, stored):
    try:
        _, iters, salt, h = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), h)
    except Exception:
        return False


DUMMY_HASH = hash_pw("dummy-password-for-timing")


def norm_username(s):
    return (s or "").strip().lower().lstrip("@")


def create_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    t = now()
    conn.execute("INSERT INTO sessions VALUES (?,?,?,?)",
                 (hashlib.sha256(token.encode()).hexdigest(), user_id, t, t + SESSION_DAYS * 86400))
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (t,))
    return token


def session_user(conn, token):
    if not token:
        return None
    return one(conn, """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.token_hash = ? AND s.expires_at > ?""",
               (hashlib.sha256(token.encode()).hexdigest(), now()))


_rl, _rl_lock = {}, threading.Lock()


def rl_count(key, window):
    t = time.time()
    with _rl_lock:
        arr = [x for x in _rl.get(key, []) if t - x < window]
        _rl[key] = arr
        return len(arr)


def rl_add(key):
    with _rl_lock:
        _rl.setdefault(key, []).append(time.time())


# ───────────────────────── أدوات مساعدة ─────────────────────────
class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


class Ctx:
    def __init__(self, conn, user, body, query, ip, raw, ctype):
        self.conn, self.user, self.body, self.query = conn, user, body, query
        self.ip, self.raw, self.ctype = ip, raw, ctype
        self.cookies = []

    @property
    def has_full_access(self):
        return bool(self.user) and self.user["role"] in ("admin", "supervisor")

    def sup_programs(self):
        return [r["program_key"] for r in rows(self.conn, "SELECT program_key FROM supervisor_programs WHERE user_id=?", (self.user["id"],))]

    def allowed_programs(self):
        if self.has_full_access:
            return [r["key"] for r in rows(self.conn, "SELECT key FROM programs")]
        return self.sup_programs()


def text(body, key, label, lo=0, hi=200, required=True):
    v = body.get(key, "")
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise ApiError(400, "قيمة غير صالحة: " + label)
    v = v.strip()
    if (required and not v) or len(v) < lo:
        raise ApiError(400, "من فضلك أكمل: " + label)
    if len(v) > hi:
        raise ApiError(400, "«%s» أطول من المسموح (%d حرفًا)" % (label, hi))
    return v


def integer(body, key, default=0):
    try:
        return int(body.get(key, default))
    except (TypeError, ValueError):
        return default


def valid_program_keys(conn, keys):
    if not isinstance(keys, list):
        return []
    have = {r["key"] for r in rows(conn, "SELECT key FROM programs")}
    return [k for k in dict.fromkeys(keys) if isinstance(k, str) and k in have]


def clean_path(p, label="المسار"):
    p = (p or "").strip()
    if not p:
        return ""
    if len(p) > 300 or not (p.startswith("/") or p.startswith("https://")) or p.startswith("//") or any(c in p for c in "\"'<>\\ "):
        raise ApiError(400, label + " غير صالح")
    return p


def parse_youtube(raw):
    """يُرجع (kind, id) من رابط يوتيوب أو معرّف مجرّد. ('', '') إن كان الحقل فارغًا."""
    raw = (raw or "").strip()
    if not raw:
        return "", ""
    kind = vid = None
    looks_url = re.match(r"^(https?://|www\.|m\.|music\.|youtu)", raw, re.I)
    if looks_url:
        if not raw.lower().startswith("http"):
            raw = "https://" + raw
        u = urlparse(raw)
        host = (u.hostname or "").lower()
        if not (host == "youtu.be" or host.endswith("youtube.com") or host.endswith("youtube-nocookie.com")):
            raise ApiError(400, "الرابط ليس رابط يوتيوب")
        qs, parts = parse_qs(u.query), [p for p in u.path.split("/") if p]
        if host == "youtu.be" and parts:
            kind, vid = "video", parts[0]
        elif parts[:1] == ["playlist"] and "list" in qs:
            kind, vid = "playlist", qs["list"][0]
        elif parts[:1] in (["embed"], ["shorts"], ["live"], ["v"]) and len(parts) > 1:
            if parts[1] == "videoseries" and "list" in qs:
                kind, vid = "playlist", qs["list"][0]
            else:
                kind, vid = "video", parts[1]
        elif "v" in qs:
            kind, vid = "video", qs["v"][0]
        elif "list" in qs:
            kind, vid = "playlist", qs["list"][0]
    else:
        vid = raw
        kind = "playlist" if re.match(r"^(PL|UU|OL|FL|RD|LL)", raw) and len(raw) >= 13 else "video"
    if not vid or not YT_ID_RE.match(vid):
        raise ApiError(400, "تعذّر فهم رابط يوتيوب؛ الصق رابط الفيديو أو قائمة التشغيل كاملًا")
    return kind, vid


def video_url(kind, yid):
    if not yid:
        return ""
    if kind == "playlist":
        return "https://www.youtube.com/playlist?list=" + yid
    return "https://www.youtube.com/watch?v=" + yid


def video_public(v):
    v = dict(v)
    thumb = v["thumb"]
    if not thumb and v["kind"] == "video" and v["youtube_id"]:
        thumb = "https://i.ytimg.com/vi/%s/hqdefault.jpg" % v["youtube_id"]
    v["thumb_url"] = thumb
    v["url"] = video_url(v["kind"], v["youtube_id"])
    v["published"] = bool(v["published"])
    return v


def user_public(u):
    return {k: u[k] for k in ("id", "name", "username", "gender", "role", "city", "bio", "created_at")}


def me_payload(conn, user):
    if not user:
        return {"user": None}
    out = {"user": user_public(user)}
    out["enrollments"] = rows(conn, """SELECT e.program_key, e.status, e.sent_at FROM enrollments e
                                       WHERE e.user_id=? ORDER BY e.created_at""", (user["id"],))
    out["saved"] = [r["video_id"] for r in rows(conn, "SELECT video_id FROM saved_videos WHERE user_id=? ORDER BY created_at DESC", (user["id"],))]
    if user["role"] == "supervisor":
        out["programs"] = [r["program_key"] for r in rows(conn, "SELECT program_key FROM supervisor_programs WHERE user_id=?", (user["id"],))]
    return out


def set_cookie(ctx, token, max_age):
    c = "sid=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (token, max_age)
    if SECURE_COOKIE:
        c += "; Secure"
    ctx.cookies.append(c)


def check_password_rules(pw):
    if not isinstance(pw, str) or len(pw) < 8:
        raise ApiError(400, "كلمة المرور يجب ألا تقل عن ٨ أحرف")
    if len(pw) > 128:
        raise ApiError(400, "كلمة المرور طويلة جدًا")


# ───────────────────────── المسارات ─────────────────────────
ROUTES = []


def route(method, pattern, auth=None, raw=False):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, auth, raw, fn))
        return fn
    return deco


# ---- عام ----
@route("GET", r"/api/site")
def api_site(ctx):
    c = ctx.conn
    settings = {r["key"]: r["value"] for r in rows(c, "SELECT * FROM settings")}
    programs = rows(c, "SELECT * FROM programs WHERE active=1 ORDER BY sort, key")
    for p in programs:
        p["axes"] = rows(c, "SELECT title, body FROM program_axes WHERE program_key=? ORDER BY sort, id", (p["key"],))
        p["plan"] = rows(c, "SELECT stage, activity FROM program_plan WHERE program_key=? ORDER BY sort, id", (p["key"],))
        p["active"] = True
    videos = [video_public(v) for v in rows(c, "SELECT * FROM videos WHERE published=1 ORDER BY sort, id")]
    return {"settings": settings, "programs": programs, "faqs": rows(c, "SELECT id,q,a FROM faqs ORDER BY sort, id"), "videos": videos}


@route("GET", r"/api/me")
def api_me(ctx):
    return me_payload(ctx.conn, ctx.user)


@route("POST", r"/api/signup")
def api_signup(ctx):
    b, c = ctx.body, ctx.conn
    if rl_count("signup:" + ctx.ip, 3600) >= 10:
        raise ApiError(429, "محاولات تسجيل كثيرة، حاول لاحقًا")
    name = text(b, "name", "الاسم الكامل", 2, 80)
    username = norm_username(b.get("username"))
    if not USERNAME_RE.match(username):
        raise ApiError(400, "معرّف تيليجرام: ٣ إلى ٣٢ حرفًا إنجليزيًا أو أرقامًا أو _ فقط")
    gender = b.get("gender")
    if gender not in ("male", "female"):
        raise ApiError(400, "اختر النوع")
    check_password_rules(b.get("password"))
    if b.get("password") != b.get("password2"):
        raise ApiError(400, "كلمتا المرور غير متطابقتين")
    if b.get("terms") is not True:
        raise ApiError(400, "يلزم الموافقة على شروط الاستخدام وسياسة الخصوصية")
    programs = valid_program_keys(c, b.get("programs"))
    try:
        cur = c.execute("INSERT INTO users (username,name,gender,password_hash,role,created_at) VALUES (?,?,?,?,?,?)",
                        (username, name, gender, hash_pw(b["password"]), "student", now()))
    except sqlite3.IntegrityError:
        raise ApiError(409, "معرّف تيليجرام هذا مسجّل من قبل")
    uid = cur.lastrowid
    for k in programs:
        c.execute("INSERT INTO enrollments (user_id,program_key,status,created_at) VALUES (?,?,?,?)", (uid, k, "pending", now()))
    rl_add("signup:" + ctx.ip)
    set_cookie(ctx, create_session(c, uid), SESSION_DAYS * 86400)
    return me_payload(c, one(c, "SELECT * FROM users WHERE id=?", (uid,)))


@route("POST", r"/api/login")
def api_login(ctx):
    b, c = ctx.body, ctx.conn
    username = norm_username(b.get("username"))
    pw = b.get("password") if isinstance(b.get("password"), str) else ""
    if rl_count("login-ip:" + ctx.ip, 600) >= 30 or rl_count("login-user:" + username, 600) >= 8:
        raise ApiError(429, "محاولات دخول كثيرة، انتظر بضع دقائق ثم أعد المحاولة")
    u = one(c, "SELECT * FROM users WHERE username=?", (username,))
    ok = verify_pw(pw, u["password_hash"] if u else DUMMY_HASH)
    if not (u and ok):
        rl_add("login-ip:" + ctx.ip)
        rl_add("login-user:" + username)
        raise ApiError(401, "معرّف تيليجرام أو كلمة المرور غير صحيحة")
    set_cookie(ctx, create_session(c, u["id"]), SESSION_DAYS * 86400)
    return me_payload(c, u)


@route("POST", r"/api/logout")
def api_logout(ctx):
    sid = ctx.query.get("_sid")
    if sid:
        ctx.conn.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(sid.encode()).hexdigest(),))
    set_cookie(ctx, "", 0)
    return {"ok": True}


@route("POST", r"/api/contact")
def api_contact(ctx):
    b = ctx.body
    if rl_count("contact:" + ctx.ip, 3600) >= 5:
        raise ApiError(429, "أرسلت رسائل كثيرة، حاول بعد قليل")
    name = text(b, "name", "الاسم", 2, 80)
    tg = text(b, "telegram", "معرّف التيليجرام", 0, 64, required=False)
    body = text(b, "message", "الرسالة", 5, 3000)
    ctx.conn.execute("INSERT INTO messages (name,telegram,body,created_at) VALUES (?,?,?,?)", (name, tg, body, now()))
    rl_add("contact:" + ctx.ip)
    return {"ok": True}


# ---- الطالب ----
@route("PUT", r"/api/me", "user")
def api_me_update(ctx):
    b = ctx.body
    ctx.conn.execute("UPDATE users SET name=?, city=?, bio=? WHERE id=?",
                     (text(b, "name", "الاسم", 2, 80), text(b, "city", "المدينة", 0, 80, False),
                      text(b, "bio", "النبذة", 0, 300, False), ctx.user["id"]))
    return me_payload(ctx.conn, one(ctx.conn, "SELECT * FROM users WHERE id=?", (ctx.user["id"],)))


@route("PUT", r"/api/me/password", "user")
def api_me_password(ctx):
    b = ctx.body
    if not verify_pw(b.get("old") or "", ctx.user["password_hash"]):
        raise ApiError(400, "كلمة المرور الحالية غير صحيحة")
    check_password_rules(b.get("new"))
    ctx.conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_pw(b["new"]), ctx.user["id"]))
    return {"ok": True}


@route("POST", r"/api/enroll", "user")
def api_enroll(ctx):
    keys = valid_program_keys(ctx.conn, [ctx.body.get("program")])
    if not keys:
        raise ApiError(404, "البرنامج غير موجود")
    if ctx.user["role"] != "student":
        raise ApiError(400, "التسجيل في البرامج للطلاب فقط")
    ctx.conn.execute("INSERT OR IGNORE INTO enrollments (user_id,program_key,status,created_at) VALUES (?,?,?,?)",
                     (ctx.user["id"], keys[0], "pending", now()))
    return me_payload(ctx.conn, ctx.user)


@route("DELETE", r"/api/enroll/([a-z0-9_]+)", "user")
def api_unenroll(ctx, key):
    ctx.conn.execute("DELETE FROM enrollments WHERE user_id=? AND program_key=? AND status='pending'", (ctx.user["id"], key))
    return me_payload(ctx.conn, ctx.user)


@route("POST", r"/api/saved/(\d+)", "user")
def api_save(ctx, vid):
    if not one(ctx.conn, "SELECT 1 AS x FROM videos WHERE id=? AND published=1", (vid,)):
        raise ApiError(404, "الدرس غير موجود")
    ctx.conn.execute("INSERT OR IGNORE INTO saved_videos VALUES (?,?,?)", (ctx.user["id"], int(vid), now()))
    return me_payload(ctx.conn, ctx.user)


@route("DELETE", r"/api/saved/(\d+)", "user")
def api_unsave(ctx, vid):
    ctx.conn.execute("DELETE FROM saved_videos WHERE user_id=? AND video_id=?", (ctx.user["id"], int(vid)))
    return me_payload(ctx.conn, ctx.user)


# ---- لوحة التحكم (مشرفون بصلاحيات كاملة) ----
@route("GET", r"/api/admin/stats", "staff")
def adm_stats(ctx):
    c = ctx.conn
    allowed = ctx.allowed_programs()
    qm = ",".join("?" * len(allowed)) or "''"
    per = rows(c, "SELECT p.key, p.name, "
                  "SUM(CASE WHEN e.status='active' THEN 1 ELSE 0 END) AS active, "
                  "SUM(CASE WHEN e.status='pending' THEN 1 ELSE 0 END) AS pending "
                  "FROM programs p LEFT JOIN enrollments e ON e.program_key=p.key "
                  "WHERE p.key IN (%s) GROUP BY p.key ORDER BY p.sort" % qm, allowed)
    for p in per:
        p["active"], p["pending"] = p["active"] or 0, p["pending"] or 0
    out = {"programs": per}
    if ctx.has_full_access:
        out.update(students=one(c, "SELECT COUNT(*) n FROM users WHERE role='student'")["n"],
                   supervisors=one(c, "SELECT COUNT(*) n FROM users WHERE role='supervisor'")["n"],
                   videos=one(c, "SELECT COUNT(*) n FROM videos")["n"],
                   unlinked=one(c, "SELECT COUNT(*) n FROM videos WHERE youtube_id=''")["n"],
                   unread=one(c, "SELECT COUNT(*) n FROM messages WHERE is_read=0")["n"],
                   outbox=one(c, "SELECT COUNT(*) n FROM outbox WHERE status='pending'")["n"])
    else:
        out["students"] = one(c, "SELECT COUNT(DISTINCT user_id) n FROM enrollments WHERE program_key IN (%s)" % qm, allowed)["n"]
    return out


@route("GET", r"/api/admin/students", "staff")
def adm_students(ctx):
    c = ctx.conn
    if ctx.has_full_access:
        users = rows(c, "SELECT id,name,username,gender,city,created_at FROM users WHERE role='student' ORDER BY created_at DESC")
    else:
        allowed = ctx.sup_programs()
        qm = ",".join("?" * len(allowed)) or "''"
        users = rows(c, "SELECT DISTINCT u.id,u.name,u.username,u.gender,u.city,u.created_at FROM users u "
                        "JOIN enrollments e ON e.user_id=u.id WHERE u.role='student' AND e.program_key IN (%s) "
                        "ORDER BY u.created_at DESC" % qm, allowed)
    by = {}
    for e in rows(c, "SELECT user_id, program_key, status, sent_at FROM enrollments"):
        by.setdefault(e["user_id"], []).append(e)
    for u in users:
        u["enrollments"] = by.get(u["id"], [])
    return {"students": users}


def get_student(ctx, sid):
    s = one(ctx.conn, "SELECT * FROM users WHERE id=? AND role='student'", (sid,))
    if not s:
        raise ApiError(404, "الطالب غير موجود")
    return s


@route("PUT", r"/api/admin/students/(\d+)/programs", "staff")
def adm_set_programs(ctx, sid):
    c = ctx.conn
    get_student(ctx, sid)
    allowed = set(ctx.allowed_programs())
    desired = set(valid_program_keys(c, ctx.body.get("programs"))) & allowed
    existing = {e["program_key"]: e for e in rows(c, "SELECT * FROM enrollments WHERE user_id=?", (sid,))}
    for k in allowed:
        if k in desired:
            if k not in existing:
                c.execute("INSERT INTO enrollments (user_id,program_key,status,created_at) VALUES (?,?,?,?)", (sid, k, "active", now()))
            elif existing[k]["status"] != "active":
                c.execute("UPDATE enrollments SET status='active' WHERE id=?", (existing[k]["id"],))
        elif k in existing:
            c.execute("DELETE FROM enrollments WHERE id=?", (existing[k]["id"],))
    return {"ok": True}


@route("POST", r"/api/admin/students/(\d+)/send", "staff")
def adm_send(ctx, sid):
    c = ctx.conn
    s = get_student(ctx, sid)
    allowed = set(ctx.allowed_programs())
    todo = [e for e in rows(c, "SELECT * FROM enrollments WHERE user_id=? AND status='active' AND sent_at IS NULL", (sid,))
            if e["program_key"] in allowed]
    if not todo:
        raise ApiError(400, "لا توجد برامج جديدة للإرسال (اختر برنامجًا واحفظ أولًا)")
    for e in todo:
        c.execute("INSERT INTO outbox (program_key,user_id,name,username,gender,created_at) VALUES (?,?,?,?,?,?)",
                  (e["program_key"], sid, s["name"], s["username"], s["gender"], now()))
        c.execute("UPDATE enrollments SET sent_at=? WHERE id=?", (now(), e["id"]))
    return {"sent": [e["program_key"] for e in todo]}


@route("GET", r"/api/admin/supervisors", "admin")
def adm_sups(ctx):
    c = ctx.conn
    sups = rows(c, "SELECT id,name,username,created_at FROM users WHERE role='supervisor' ORDER BY created_at DESC")
    for s in sups:
        s["programs"] = [r["program_key"] for r in rows(c, "SELECT program_key FROM supervisor_programs WHERE user_id=?", (s["id"],))]
    return {"supervisors": sups}


@route("POST", r"/api/admin/supervisors", "admin")
def adm_sup_add(ctx):
    b, c = ctx.body, ctx.conn
    name = text(b, "name", "اسم المشرف", 2, 80)
    username = norm_username(b.get("username"))
    if not USERNAME_RE.match(username):
        raise ApiError(400, "معرّف تيليجرام غير صالح")
    check_password_rules(b.get("password"))
    try:
        cur = c.execute("INSERT INTO users (username,name,password_hash,role,created_at) VALUES (?,?,?,?,?)",
                        (username, name, hash_pw(b["password"]), "supervisor", now()))
    except sqlite3.IntegrityError:
        raise ApiError(409, "هذا المعرّف مستخدم من قبل")
    c.executemany("INSERT OR IGNORE INTO supervisor_programs (user_id,program_key) VALUES (?,?)",
                  [(cur.lastrowid, r["key"]) for r in rows(c, "SELECT key FROM programs")])
    return {"id": cur.lastrowid}


@route("PUT", r"/api/admin/supervisors/(\d+)/programs", "admin")
def adm_sup_programs(ctx, sid):
    c = ctx.conn
    if not one(c, "SELECT 1 AS x FROM users WHERE id=? AND role='supervisor'", (sid,)):
        raise ApiError(404, "المشرف غير موجود")
    c.execute("DELETE FROM supervisor_programs WHERE user_id=?", (sid,))
    for k in valid_program_keys(c, ctx.body.get("programs")):
        c.execute("INSERT INTO supervisor_programs VALUES (?,?)", (sid, k))
    return {"ok": True}


@route("DELETE", r"/api/admin/users/(\d+)", "admin")
def adm_user_delete(ctx, uid):
    u = one(ctx.conn, "SELECT * FROM users WHERE id=?", (uid,))
    if not u or u["role"] == "admin" or int(uid) == ctx.user["id"]:
        raise ApiError(404, "المستخدم غير موجود")
    ctx.conn.execute("DELETE FROM users WHERE id=?", (uid,))
    return {"ok": True}


@route("PUT", r"/api/admin/users/(\d+)/password", "admin")
def adm_user_password(ctx, uid):
    pw = ctx.body.get("password")
    check_password_rules(pw)
    cur = ctx.conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_pw(pw), uid))
    if not cur.rowcount:
        raise ApiError(404, "المستخدم غير موجود")
    ctx.conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    return {"ok": True}


@route("GET", r"/api/admin/messages", "admin")
def adm_messages(ctx):
    return {"messages": rows(ctx.conn, "SELECT * FROM messages ORDER BY created_at DESC LIMIT 500")}


@route("PUT", r"/api/admin/messages/(\d+)", "admin")
def adm_message_read(ctx, mid):
    ctx.conn.execute("UPDATE messages SET is_read=? WHERE id=?", (1 if ctx.body.get("read", True) else 0, mid))
    return {"ok": True}


@route("DELETE", r"/api/admin/messages/(\d+)", "admin")
def adm_message_del(ctx, mid):
    ctx.conn.execute("DELETE FROM messages WHERE id=?", (mid,))
    return {"ok": True}


@route("GET", r"/api/admin/outbox", "admin")
def adm_outbox(ctx):
    return {"outbox": rows(ctx.conn, "SELECT o.*, p.name AS program_name FROM outbox o LEFT JOIN programs p ON p.key=o.program_key "
                                     "ORDER BY (o.status='pending') DESC, o.created_at DESC LIMIT 500")}


@route("PUT", r"/api/admin/outbox/(\d+)", "admin")
def adm_outbox_done(ctx, oid):
    ctx.conn.execute("UPDATE outbox SET status='delivered', delivered_at=? WHERE id=?", (now(), oid))
    return {"ok": True}


@route("DELETE", r"/api/admin/outbox/(\d+)", "admin")
def adm_outbox_del(ctx, oid):
    ctx.conn.execute("DELETE FROM outbox WHERE id=?", (oid,))
    return {"ok": True}


# ---- الفيديوهات ----
def video_fields(ctx):
    b, c = ctx.body, ctx.conn
    title = text(b, "title", "العنوان", 2, 200)
    kind, yid = parse_youtube(b.get("url"))
    pk = (b.get("program_key") or "").strip()
    if pk and pk not in valid_program_keys(c, [pk]):
        raise ApiError(400, "البرنامج غير موجود")
    sec = b.get("home_section") or ""
    if sec not in ("", "lectures", "benefit"):
        raise ApiError(400, "مكان الظهور غير صالح")
    return dict(title=title, kind=kind or "video", youtube_id=yid, thumb=clean_path(b.get("thumb"), "الصورة المصغرة"),
                home_section=sec, program_key=pk, description=text(b, "description", "الوصف", 0, 300, False),
                sort=integer(b, "sort"), published=1 if b.get("published", True) else 0)


@route("GET", r"/api/admin/videos", "admin")
def adm_videos(ctx):
    return {"videos": [video_public(v) for v in rows(ctx.conn, "SELECT * FROM videos ORDER BY sort, id")]}


@route("POST", r"/api/admin/videos", "admin")
def adm_video_add(ctx):
    f = video_fields(ctx)
    cur = ctx.conn.execute("INSERT INTO videos (title,kind,youtube_id,thumb,home_section,program_key,description,sort,published,created_at) "
                           "VALUES (:title,:kind,:youtube_id,:thumb,:home_section,:program_key,:description,:sort,:published,:t)",
                           dict(f, t=now()))
    return {"id": cur.lastrowid}


@route("PUT", r"/api/admin/videos/(\d+)", "admin")
def adm_video_edit(ctx, vid):
    f = video_fields(ctx)
    cur = ctx.conn.execute("UPDATE videos SET title=:title,kind=:kind,youtube_id=:youtube_id,thumb=:thumb,home_section=:home_section,"
                           "program_key=:program_key,description=:description,sort=:sort,published=:published WHERE id=:id",
                           dict(f, id=int(vid)))
    if not cur.rowcount:
        raise ApiError(404, "غير موجود")
    return {"ok": True}


@route("DELETE", r"/api/admin/videos/(\d+)", "admin")
def adm_video_del(ctx, vid):
    ctx.conn.execute("DELETE FROM videos WHERE id=?", (vid,))
    return {"ok": True}


# ---- الأسئلة الشائعة ----
@route("GET", r"/api/admin/faqs", "admin")
def adm_faqs(ctx):
    return {"faqs": rows(ctx.conn, "SELECT * FROM faqs ORDER BY sort, id")}


@route("POST", r"/api/admin/faqs", "admin")
def adm_faq_add(ctx):
    b = ctx.body
    cur = ctx.conn.execute("INSERT INTO faqs (q,a,sort) VALUES (?,?,?)",
                           (text(b, "q", "السؤال", 2, 300), text(b, "a", "الجواب", 2, 3000), integer(b, "sort")))
    return {"id": cur.lastrowid}


@route("PUT", r"/api/admin/faqs/(\d+)", "admin")
def adm_faq_edit(ctx, fid):
    b = ctx.body
    ctx.conn.execute("UPDATE faqs SET q=?, a=?, sort=? WHERE id=?",
                     (text(b, "q", "السؤال", 2, 300), text(b, "a", "الجواب", 2, 3000), integer(b, "sort"), fid))
    return {"ok": True}


@route("DELETE", r"/api/admin/faqs/(\d+)", "admin")
def adm_faq_del(ctx, fid):
    ctx.conn.execute("DELETE FROM faqs WHERE id=?", (fid,))
    return {"ok": True}


# ---- البرامج ----
def pairs(v, label):
    out = []
    if not isinstance(v, list) or len(v) > 40:
        raise ApiError(400, "قائمة غير صالحة: " + label)
    for it in v:
        if not (isinstance(it, list) and len(it) == 2 and all(isinstance(x, str) for x in it)):
            raise ApiError(400, "قائمة غير صالحة: " + label)
        a, b = it[0].strip(), it[1].strip()
        if a:
            if len(a) > 200 or len(b) > 1000:
                raise ApiError(400, "نص طويل في: " + label)
            out.append((a, b))
    return out


def save_program_children(c, key, b):
    axes, plan = pairs(b.get("axes", []), "المحاور"), pairs(b.get("plan", []), "الخطة")
    c.execute("DELETE FROM program_axes WHERE program_key=?", (key,))
    c.execute("DELETE FROM program_plan WHERE program_key=?", (key,))
    for i, (x, y) in enumerate(axes):
        c.execute("INSERT INTO program_axes (program_key,title,body,sort) VALUES (?,?,?,?)", (key, x, y, i))
    for i, (x, y) in enumerate(plan):
        c.execute("INSERT INTO program_plan (program_key,stage,activity,sort) VALUES (?,?,?,?)", (key, x, y, i))


def program_fields(b):
    return (text(b, "name", "اسم البرنامج", 2, 80), text(b, "headline", "العنوان الفرعي", 0, 200, False),
            text(b, "audience", "الفئة المستهدفة", 0, 200, False), text(b, "description", "الوصف", 0, 1500, False),
            clean_path(b.get("cover"), "الصورة"), integer(b, "sort"), 1 if b.get("active", True) else 0)


@route("GET", r"/api/admin/programs", "admin")
def adm_programs(ctx):
    c = ctx.conn
    ps = rows(c, "SELECT * FROM programs ORDER BY sort, key")
    for p in ps:
        p["axes"] = rows(c, "SELECT title, body FROM program_axes WHERE program_key=? ORDER BY sort, id", (p["key"],))
        p["plan"] = rows(c, "SELECT stage, activity FROM program_plan WHERE program_key=? ORDER BY sort, id", (p["key"],))
        p["active"] = bool(p["active"])
    return {"programs": ps}


@route("POST", r"/api/admin/programs", "admin")
def adm_program_add(ctx):
    b, c = ctx.body, ctx.conn
    key = (b.get("key") or "").strip().lower()
    if not KEY_RE.match(key):
        raise ApiError(400, "المفتاح: حروف إنجليزية صغيرة وأرقام و _ (يبدأ بحرف)")
    if key in ("home", "lessons", "contact", "login", "signup", "account", "dashboard", "terms"):
        raise ApiError(400, "هذا المفتاح محجوز")
    if one(c, "SELECT 1 AS x FROM programs WHERE key=?", (key,)):
        raise ApiError(409, "المفتاح مستخدم من قبل")
    c.execute("INSERT INTO programs (key,name,headline,audience,description,cover,sort,active) VALUES (?,?,?,?,?,?,?,?)", (key,) + program_fields(b))
    save_program_children(c, key, b)
    return {"ok": True}


@route("PUT", r"/api/admin/programs/([a-z][a-z0-9_]*)", "admin")
def adm_program_edit(ctx, key):
    c = ctx.conn
    if not one(c, "SELECT 1 AS x FROM programs WHERE key=?", (key,)):
        raise ApiError(404, "البرنامج غير موجود")
    n, h, a, d, cv, s, ac = program_fields(ctx.body)
    c.execute("UPDATE programs SET name=?,headline=?,audience=?,description=?,cover=?,sort=?,active=? WHERE key=?", (n, h, a, d, cv, s, ac, key))
    save_program_children(c, key, ctx.body)
    return {"ok": True}


@route("DELETE", r"/api/admin/programs/([a-z][a-z0-9_]*)", "admin")
def adm_program_del(ctx, key):
    ctx.conn.execute("UPDATE videos SET program_key='' WHERE program_key=?", (key,))
    ctx.conn.execute("DELETE FROM programs WHERE key=?", (key,))
    return {"ok": True}


# ---- الإعدادات والرفع ----
@route("GET", r"/api/admin/settings", "admin")
def adm_settings(ctx):
    return {"settings": {r["key"]: r["value"] for r in rows(ctx.conn, "SELECT * FROM settings")}}


@route("PUT", r"/api/admin/settings", "admin")
def adm_settings_save(ctx):
    for k, v in ctx.body.items():
        if k not in seed.SETTINGS or not isinstance(v, str) or len(v) > 5000:
            continue
        if k.startswith(("tg_", "yt_")) and v.strip() and not re.match(r"^https://", v.strip()):
            raise ApiError(400, "الروابط يجب أن تبدأ بـ https://")
        ctx.conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v.strip() if k.startswith(("tg_", "yt_")) else v))
    return {"ok": True}


@route("POST", r"/api/admin/upload", "admin", raw=True)
def adm_upload(ctx):
    data = ctx.raw
    if not data or len(data) > MAX_UPLOAD:
        raise ApiError(400, "حجم الملف غير مقبول (الحد الأقصى ٣ ميجا)")
    if data[:3] == b"\xff\xd8\xff":
        ext = "jpg"
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        ext = "png"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = "webp"
    else:
        raise ApiError(400, "الصور المسموحة: JPG أو PNG أو WEBP")
    name = "%s.%s" % (secrets.token_hex(8), ext)
    (UPLOADS / name).write_bytes(data)
    return {"path": "/uploads/" + name}


# ───────────────────────── معالج HTTP ─────────────────────────
SEC_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",   # مطلوب لتشغيل مشغّل يوتيوب
    "Content-Security-Policy": ("default-src 'self'; img-src 'self' data: https://i.ytimg.com; "
                                "frame-src https://www.youtube-nocookie.com https://www.youtube.com; "
                                "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
                                "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"),
}
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/webp", ".webp")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Mahad"
    sys_version = ""

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def client_ip(self):
        if TRUST_PROXY:
            xf = self.headers.get("X-Forwarded-For", "")
            if xf:
                return xf.split(",")[0].strip()
        return self.client_address[0]

    def send_bytes(self, status, data, ctype, extra=None, head=False):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in SEC_HEADERS.items():
            self.send_header(k, v)
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def send_json(self, status, obj, cookies=()):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_bytes(status, data, "application/json; charset=utf-8",
                        [("Cache-Control", "no-store")] + [("Set-Cookie", c) for c in cookies])

    def handle_any(self, method):
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            length = int(self.headers.get("Content-Length") or 0)
            limit = MAX_UPLOAD + 1024 if path == "/api/admin/upload" else MAX_JSON
            if length > limit:
                self.close_connection = True
                return self.send_json(413, {"error": "الطلب كبير جدًا"})
            raw = self.rfile.read(length) if length else b""
            if path.startswith("/api/"):
                return self.api(method, path, parsed.query, raw)
            if method not in ("GET", "HEAD"):
                return self.send_json(405, {"error": "method not allowed"})
            return self.static(path, method == "HEAD")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.send_json(500, {"error": "خطأ في الخادم"})
            except Exception:
                pass

    do_GET = lambda self: self.handle_any("GET")
    do_HEAD = lambda self: self.handle_any("HEAD")
    do_POST = lambda self: self.handle_any("POST")
    do_PUT = lambda self: self.handle_any("PUT")
    do_DELETE = lambda self: self.handle_any("DELETE")

    # ---- API ----
    def api(self, method, path, query, raw):
        conn = db()
        cookies = []
        try:
            token = None
            if "Cookie" in self.headers:
                try:
                    sc = SimpleCookie(self.headers["Cookie"])
                    token = sc["sid"].value if "sid" in sc else None
                except Exception:
                    token = None
            user = session_user(conn, token)
            matched = False
            for m, rx, auth, is_raw, fn in ROUTES:
                mt = rx.match(path)
                if not mt:
                    continue
                matched = True
                if m != method:
                    continue
                if method != "GET":
                    origin = self.headers.get("Origin")
                    if origin and urlparse(origin).netloc != self.headers.get("Host", ""):
                        raise ApiError(403, "طلب مرفوض (مصدر غير مطابق)")
                if auth and not user:
                    raise ApiError(401, "سجّل الدخول أولًا")
                if auth == "staff" and user["role"] not in ("admin", "supervisor"):
                    raise ApiError(403, "غير مصرح لك")
                if auth == "admin" and user["role"] not in ("admin", "supervisor"):
                    raise ApiError(403, "غير مصرح لك")
                ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                body = {}
                if not is_raw and raw:
                    if ctype != "application/json":
                        raise ApiError(415, "نوع المحتوى غير مدعوم")
                    try:
                        body = json.loads(raw.decode("utf-8"))
                    except ValueError:
                        raise ApiError(400, "بيانات غير صالحة")
                    if not isinstance(body, dict):
                        raise ApiError(400, "بيانات غير صالحة")
                q = {k: v[0] for k, v in parse_qs(query).items()}
                q["_sid"] = token
                ctx = Ctx(conn, user, body, q, self.client_ip(), raw, ctype)
                result = fn(ctx, *mt.groups())
                conn.commit()
                return self.send_json(200, result, ctx.cookies)
            raise ApiError(405 if matched else 404, "غير موجود")
        except ApiError as e:
            conn.rollback()
            self.send_json(e.status, {"error": e.msg}, cookies)
        except Exception:
            conn.rollback()
            traceback.print_exc()
            self.send_json(500, {"error": "خطأ في الخادم"})
        finally:
            conn.close()

    # ---- ملفات ثابتة ----
    def static(self, path, head):
        if path in ("", "/"):
            path = "/index.html"
        target = (STATIC / path.lstrip("/")).resolve()
        try:
            target.relative_to(STATIC.resolve())
        except ValueError:
            return self.send_json(404, {"error": "not found"})
        if not target.is_file():
            return self.send_json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith(("text/", "application/javascript")):
            ctype += "; charset=utf-8"
        cache = "public, max-age=86400" if target.suffix in (".jpg", ".png", ".webp") else "no-cache"
        self.send_bytes(200, target.read_bytes(), ctype, [("Cache-Control", cache)], head)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "setpass":
        if len(sys.argv) != 4:
            sys.exit("الاستخدام: python server.py setpass USERNAME NEWPASSWORD")
        init_db()
        conn = db()
        u = norm_username(sys.argv[2])
        if len(sys.argv[3]) < 8:
            sys.exit("كلمة المرور يجب ألا تقل عن ٨ أحرف")
        cur = conn.execute("UPDATE users SET password_hash=? WHERE username=?", (hash_pw(sys.argv[3]), u))
        conn.execute("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username=?)", (u,))
        conn.commit()
        sys.exit("تم التحديث" if cur.rowcount else "المستخدم غير موجود")
    init_db()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("الموقع يعمل على http://localhost:%d" % PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nتم الإيقاف")


if __name__ == "__main__":
    main()
