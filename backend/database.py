"""Admin SQLite Database — 공지사항 + 채팅."""

import sqlite3
import asyncio
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
    """)
    conn.commit()
    conn.close()

# --- 공지사항 ---

async def create_announcement(title: str, content: str, priority: str = "normal") -> dict:
    def _run():
        conn = get_conn()
        now = _now()
        cur = conn.execute(
            "INSERT INTO announcements (title, content, priority, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
            (title, content, priority, now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM announcements WHERE id=?", (cur.lastrowid,)).fetchone()
        conn.close()
        return dict(row)
    return await asyncio.to_thread(_run)

async def list_announcements(active_only: bool = False) -> list[dict]:
    def _run():
        conn = get_conn()
        if active_only:
            rows = conn.execute("SELECT * FROM announcements WHERE active=1 ORDER BY priority='urgent' DESC, priority='important' DESC, created_at DESC").fetchall()
        else:
            rows = conn.execute("SELECT * FROM announcements ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_run)

async def update_announcement(ann_id: int, **kwargs) -> dict | None:
    def _run():
        conn = get_conn()
        sets = []
        vals = []
        for k, v in kwargs.items():
            if k in ("title", "content", "priority", "active"):
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
        return dict(row) if row else None
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
