"""Admin SQLite Database — 공지사항 + 채팅."""

import sqlite3
import asyncio
import json
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = Path(__file__).parent / "admin.db"

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            priority TEXT DEFAULT 'normal',
            active INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_rooms (
            id TEXT PRIMARY KEY,
            user_name TEXT NOT NULL,
            department TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            unread_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            closed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            sender TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (room_id) REFERENCES chat_rooms(id)
        );

        -- 테스트 PC(에이전트)별 모듈/함수 사용통계 스냅샷.
        -- 실시간 라이브 상태는 메모리(AgentRegistry)에 두고, 함수통계 스냅샷만 여기 영속화.
        -- 키는 하드웨어 머신 UID (IP 아님 — IP 는 바뀔 수 있음). PC 당 한 행(최신) upsert.
        CREATE TABLE IF NOT EXISTS agent_usage (
            client_id TEXT PRIMARY KEY,   -- 머신 UID
            host TEXT,                    -- 호스트명(표시용)
            ip TEXT,                      -- 마지막 보고 IP(표시용)
            usage_json TEXT,              -- compact usage-stats JSON
            generated_at TEXT,            -- 시나리오 측 집계 시각
            updated_at TEXT NOT NULL      -- 서버 저장 시각
        );
    """)
    # 마이그레이션: 기존 announcements 테이블에 신규 컬럼 추가
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(announcements)").fetchall()}
    migrations = [
        ("image_data", "ALTER TABLE announcements ADD COLUMN image_data TEXT"),
        ("is_popup", "ALTER TABLE announcements ADD COLUMN is_popup INTEGER DEFAULT 0"),
        ("type", "ALTER TABLE announcements ADD COLUMN type TEXT DEFAULT 'notice'"),  # 'notice' | 'guide'
        ("images", "ALTER TABLE announcements ADD COLUMN images TEXT"),  # JSON: data URL 목록
        ("steps", "ALTER TABLE announcements ADD COLUMN steps TEXT"),    # JSON: [{text, text_en, image}]
        ("title_en", "ALTER TABLE announcements ADD COLUMN title_en TEXT"),    # 영문 제목(선택)
        ("content_en", "ALTER TABLE announcements ADD COLUMN content_en TEXT"),  # 영문 내용/개요(선택)
    ]
    for col, ddl in migrations:
        if col not in cols:
            conn.execute(ddl)
    conn.commit()
    conn.close()


def _row_to_ann(row) -> dict:
    """DB row → dict. images/steps JSON 문자열을 리스트로 변환."""
    d = dict(row)
    for key in ("images", "steps"):
        raw = d.get(key)
        if raw:
            try:
                d[key] = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                d[key] = []
        else:
            d[key] = []
    if not d.get("type"):
        d["type"] = "notice"
    return d

# --- 공지사항 ---

async def create_announcement(
    title: str,
    content: str,
    priority: str = "normal",
    image_data: str | None = None,
    is_popup: int = 0,
    type: str = "notice",
    images: str | None = None,  # JSON 문자열
    steps: str | None = None,   # JSON 문자열
    title_en: str | None = None,
    content_en: str | None = None,
) -> dict:
    def _run():
        conn = get_conn()
        now = _now()
        cur = conn.execute(
            "INSERT INTO announcements "
            "(title, content, priority, active, image_data, is_popup, type, images, steps, title_en, content_en, created_at, updated_at) "
            "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (title, content, priority, image_data, is_popup, type, images, steps, title_en, content_en, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM announcements WHERE id=?", (cur.lastrowid,)).fetchone()
        conn.close()
        return _row_to_ann(row)
    return await asyncio.to_thread(_run)

async def list_announcements(active_only: bool = False) -> list[dict]:
    def _run():
        conn = get_conn()
        if active_only:
            rows = conn.execute("SELECT * FROM announcements WHERE active=1 ORDER BY priority='urgent' DESC, priority='important' DESC, created_at DESC").fetchall()
        else:
            rows = conn.execute("SELECT * FROM announcements ORDER BY created_at DESC").fetchall()
        conn.close()
        return [_row_to_ann(r) for r in rows]
    return await asyncio.to_thread(_run)

async def update_announcement(ann_id: int, **kwargs) -> dict | None:
    def _run():
        conn = get_conn()
        sets = []
        vals = []
        for k, v in kwargs.items():
            if k in ("title", "content", "priority", "active", "image_data", "is_popup", "type", "images", "steps", "title_en", "content_en"):
                sets.append(f"{k}=?")
                vals.append(v)
        if not sets:
            conn.close()
            return None
        sets.append("updated_at=?")
        vals.append(_now())
        vals.append(ann_id)
        conn.execute(f"UPDATE announcements SET {', '.join(sets)} WHERE id=?", vals)
        conn.commit()
        row = conn.execute("SELECT * FROM announcements WHERE id=?", (ann_id,)).fetchone()
        conn.close()
        return _row_to_ann(row) if row else None
    return await asyncio.to_thread(_run)

async def delete_announcement(ann_id: int) -> bool:
    def _run():
        conn = get_conn()
        cur = conn.execute("DELETE FROM announcements WHERE id=?", (ann_id,))
        conn.commit()
        conn.close()
        return cur.rowcount > 0
    return await asyncio.to_thread(_run)

# --- 채팅방 ---

async def create_chat_room(room_id: str, user_name: str, department: str) -> dict:
    def _run():
        conn = get_conn()
        now = _now()
        conn.execute(
            "INSERT INTO chat_rooms (id, user_name, department, status, unread_count, created_at) VALUES (?, ?, ?, 'active', 1, ?)",
            (room_id, user_name, department, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM chat_rooms WHERE id=?", (room_id,)).fetchone()
        conn.close()
        return dict(row)
    return await asyncio.to_thread(_run)

async def list_chat_rooms() -> list[dict]:
    def _run():
        conn = get_conn()
        rows = conn.execute("""
            SELECT r.*,
                   (SELECT content FROM chat_messages WHERE room_id=r.id ORDER BY created_at DESC LIMIT 1) as last_message,
                   (SELECT created_at FROM chat_messages WHERE room_id=r.id ORDER BY created_at DESC LIMIT 1) as last_message_at
            FROM chat_rooms r ORDER BY r.status='active' DESC, COALESCE(last_message_at, r.created_at) DESC
        """).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_run)

async def close_chat_room(room_id: str):
    def _run():
        conn = get_conn()
        conn.execute("UPDATE chat_rooms SET status='closed', closed_at=? WHERE id=?", (_now(), room_id))
        conn.commit()
        conn.close()
    await asyncio.to_thread(_run)

async def delete_chat_room(room_id: str) -> bool:
    def _run():
        conn = get_conn()
        conn.execute("DELETE FROM chat_messages WHERE room_id=?", (room_id,))
        cur = conn.execute("DELETE FROM chat_rooms WHERE id=?", (room_id,))
        conn.commit()
        conn.close()
        return cur.rowcount > 0
    return await asyncio.to_thread(_run)

async def update_room_unread(room_id: str, count: int):
    def _run():
        conn = get_conn()
        conn.execute("UPDATE chat_rooms SET unread_count=? WHERE id=?", (count, room_id))
        conn.commit()
        conn.close()
    await asyncio.to_thread(_run)

# --- 메시지 ---

async def add_message(room_id: str, sender: str, content: str) -> dict:
    def _run():
        conn = get_conn()
        now = _now()
        cur = conn.execute(
            "INSERT INTO chat_messages (room_id, sender, content, created_at) VALUES (?, ?, ?, ?)",
            (room_id, sender, content, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM chat_messages WHERE id=?", (cur.lastrowid,)).fetchone()
        # 유저 메시지면 unread 증가
        if sender == "user":
            conn.execute("UPDATE chat_rooms SET unread_count = unread_count + 1 WHERE id=?", (room_id,))
            conn.commit()
        conn.close()
        return dict(row)
    return await asyncio.to_thread(_run)

async def get_messages(room_id: str, limit: int = 200) -> list[dict]:
    def _run():
        conn = get_conn()
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE room_id=? ORDER BY created_at ASC LIMIT ?",
            (room_id, limit),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_run)

# --- 에이전트(테스트 PC) 함수통계 스냅샷 ---

async def upsert_agent_usage(client_id: str, host: str, ip: str,
                             usage_json: str, generated_at: str | None) -> None:
    """PC별 최신 usage-stats 스냅샷을 저장(upsert). 머신 UID 기준 1행 유지."""
    def _run():
        conn = get_conn()
        conn.execute(
            "INSERT INTO agent_usage (client_id, host, ip, usage_json, generated_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(client_id) DO UPDATE SET "
            "host=excluded.host, ip=excluded.ip, usage_json=excluded.usage_json, "
            "generated_at=excluded.generated_at, updated_at=excluded.updated_at",
            (client_id, host, ip, usage_json, generated_at, _now()),
        )
        conn.commit()
        conn.close()
    await asyncio.to_thread(_run)

async def delete_agent_usage(client_id: str) -> bool:
    """에이전트의 함수통계 스냅샷을 삭제 (오래된/중복 카드 정리용)."""
    def _run():
        conn = get_conn()
        cur = conn.execute("DELETE FROM agent_usage WHERE client_id=?", (client_id,))
        conn.commit()
        conn.close()
        return cur.rowcount > 0
    return await asyncio.to_thread(_run)

async def list_agent_usage() -> list[dict]:
    """저장된 모든 PC의 usage-stats 스냅샷을 반환 (usage_json 파싱)."""
    def _run():
        conn = get_conn()
        rows = conn.execute("SELECT * FROM agent_usage ORDER BY updated_at DESC").fetchall()
        conn.close()
        out = []
        for r in rows:
            d = dict(r)
            raw = d.get("usage_json")
            try:
                d["usage_stats"] = json.loads(raw) if raw else None
            except (json.JSONDecodeError, TypeError):
                d["usage_stats"] = None
            d.pop("usage_json", None)
            out.append(d)
        return out
    return await asyncio.to_thread(_run)
