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

        -- PC별 상태 시계열 샘플 (사용량 통계 그래프의 원본).
        -- 라이브 상태는 메모리에만 있어 서버가 죽으면 사라지므로, SAMPLE_INTERVAL_SEC 마다
        -- 전 PC 의 상태를 한 tick 으로 찍어 여기 남긴다. 그래프는 이걸 시간 버킷으로 집계.
        -- ts 는 tick 시각(epoch 초, UTC)이고 같은 tick 의 모든 PC 는 **같은 ts** 를 쓴다
        -- (버킷당 tick 수 = COUNT(DISTINCT ts) 로 평균 대수를 낼 수 있어야 하기 때문).
        -- WITHOUT ROWID + PK(ts, client_id) — 행이 작고 ts 범위조회가 대부분이라 이 편이 조밀하다.
        CREATE TABLE IF NOT EXISTS agent_state_samples (
            ts INTEGER NOT NULL,
            client_id TEXT NOT NULL,
            state TEXT NOT NULL,
            PRIMARY KEY (ts, client_id)
        ) WITHOUT ROWID;

        -- 클라이언트(ReplayKit)가 제출한 버그 리포트. ZIP 본문은 디스크
        -- (bug_reports/ 디렉토리)에 두고 여기는 메타만 영속화한다.
        CREATE TABLE IF NOT EXISTS bug_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            reporter TEXT,
            version TEXT,
            boot_id TEXT,
            platform TEXT,
            hostname TEXT,
            client_created_at TEXT,       -- 클라이언트가 찍은 생성 시각
            received_at TEXT NOT NULL,    -- 서버 수신 시각
            file_path TEXT,               -- 프로젝트 루트 기준 상대경로
            file_name TEXT,               -- 원본 업로드 파일명
            file_size INTEGER DEFAULT 0,
            status TEXT DEFAULT 'new'     -- 'new' | 'reviewed'
        );

        -- 서버 설정 키-값 저장소 (Jira 계정, 프로젝트 목록 등).
        -- ReplayKit 에이전트가 로그인(사용자 식별)에 쓸 값을 여기서 내려준다.
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
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
    # 마이그레이션: agent_usage 에 로그인 사용자 정보 (관제/통계의 부서·프로젝트 필터 원본)
    au_cols = {row["name"] for row in conn.execute("PRAGMA table_info(agent_usage)").fetchall()}
    for col, ddl in [
        ("user_name", "ALTER TABLE agent_usage ADD COLUMN user_name TEXT"),
        ("user_title", "ALTER TABLE agent_usage ADD COLUMN user_title TEXT"),
        ("user_team", "ALTER TABLE agent_usage ADD COLUMN user_team TEXT"),   # 부서/팀
        ("project", "ALTER TABLE agent_usage ADD COLUMN project TEXT"),       # HKMC/Nissan 등
    ]:
        if col not in au_cols:
            conn.execute(ddl)
    # 마이그레이션: bug_reports 에 제출 사용자 정보 (목록 헤더의 부서·프로젝트)
    br_cols = {row["name"] for row in conn.execute("PRAGMA table_info(bug_reports)").fetchall()}
    for col, ddl in [
        ("user_name", "ALTER TABLE bug_reports ADD COLUMN user_name TEXT"),
        ("user_team", "ALTER TABLE bug_reports ADD COLUMN user_team TEXT"),
        ("project", "ALTER TABLE bug_reports ADD COLUMN project TEXT"),
    ]:
        if col not in br_cols:
            conn.execute(ddl)
    conn.commit()
    conn.close()


# --- 서버 설정 (키-값) ---

async def get_settings_map(keys: list[str] | None = None) -> dict[str, str]:
    """설정 키-값 조회. keys 미지정 시 전체."""
    def _run():
        conn = get_conn()
        if keys:
            ph = ",".join("?" for _ in keys)
            rows = conn.execute(f"SELECT key, value FROM settings WHERE key IN ({ph})", keys).fetchall()
        else:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
        conn.close()
        return {r["key"]: (r["value"] or "") for r in rows}
    return await asyncio.to_thread(_run)


async def set_settings_map(values: dict[str, str]) -> None:
    """설정 키-값 저장(upsert)."""
    def _run():
        conn = get_conn()
        conn.executemany(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [(k, v) for k, v in values.items()],
        )
        conn.commit()
        conn.close()
    await asyncio.to_thread(_run)


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

async def upsert_agent_user(client_id: str, host: str, ip: str, user: dict) -> None:
    """PC별 로그인 사용자 정보 저장(upsert) — usage_json 은 건드리지 않는다.

    관제 라이브 상태는 메모리에만 있으므로, 오프라인 PC 의 부서·프로젝트 필터와
    사용량 통계의 client_id→부서/프로젝트 매핑은 이 컬럼이 원본이다.
    """
    def _run():
        conn = get_conn()
        conn.execute(
            "INSERT INTO agent_usage (client_id, host, ip, user_name, user_title, user_team, project, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(client_id) DO UPDATE SET "
            "host=excluded.host, ip=excluded.ip, "
            "user_name=excluded.user_name, user_title=excluded.user_title, "
            "user_team=excluded.user_team, project=excluded.project, "
            "updated_at=excluded.updated_at",
            (client_id, host, ip,
             str(user.get("name") or ""), str(user.get("title") or ""),
             str(user.get("team") or ""), str(user.get("project") or ""), _now()),
        )
        conn.commit()
        conn.close()
    await asyncio.to_thread(_run)


async def list_agent_meta() -> list[dict]:
    """PC별 표시 메타(호스트명 + 로그인 사용자/부서/프로젝트) — DB 스냅샷 기준.

    라이브 값은 registry 가 갖고 있으므로 호출부에서 registry 우선으로 병합한다.
    """
    def _run():
        conn = get_conn()
        rows = conn.execute(
            "SELECT client_id, host, user_name, user_title, user_team, project FROM agent_usage"
        ).fetchall()
        conn.close()
        return [
            {"client_id": r["client_id"], "host": r["host"] or "",
             "user_name": r["user_name"] or "", "user_title": r["user_title"] or "",
             "user_team": r["user_team"] or "", "project": r["project"] or ""}
            for r in rows
        ]
    return await asyncio.to_thread(_run)


async def delete_agent_usage(client_id: str) -> bool:
    """에이전트의 함수통계 스냅샷을 삭제 (오래된/중복 카드 정리용)."""
    def _run():
        conn = get_conn()
        cur = conn.execute("DELETE FROM agent_usage WHERE client_id=?", (client_id,))
        conn.commit()
        conn.close()
        return cur.rowcount > 0
    return await asyncio.to_thread(_run)

async def list_agent_usage_hosts() -> dict[str, str]:
    """client_id → 호스트명. 레지스트리에서 사라진 PC 의 이름을 그래프에 살리는 용도."""
    def _run():
        conn = get_conn()
        rows = conn.execute("SELECT client_id, host FROM agent_usage").fetchall()
        conn.close()
        return {r["client_id"]: (r["host"] or "") for r in rows}
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

# --- 에이전트 상태 시계열 (사용량 통계 그래프) ---


def _tz_offset_sec() -> int:
    """서버 로컬 타임존의 UTC 오프셋(초).

    버킷 경계를 **로컬 시각** 기준으로 맞추는 데 쓴다. epoch(UTC) 를 그대로 나누면
    '1일' 버킷이 KST 오전 9시에서 끊겨 하루 그래프가 이틀에 걸쳐 보인다.
    """
    off = datetime.now().astimezone().utcoffset()
    return int(off.total_seconds()) if off else 0


async def insert_state_samples(ts: int, rows: list[tuple[str, str]]) -> None:
    """한 tick 의 (client_id, state) 목록을 저장. 같은 tick 은 모두 같은 ts 를 쓴다."""
    if not rows:
        return

    def _run():
        conn = get_conn()
        conn.executemany(
            "INSERT OR REPLACE INTO agent_state_samples (ts, client_id, state) VALUES (?, ?, ?)",
            [(ts, cid, state) for cid, state in rows],
        )
        conn.commit()
        conn.close()
    await asyncio.to_thread(_run)


async def state_sample_stats() -> dict:
    """상태 이력 보관 현황 — 삭제 화면에서 '지금 뭐가 얼마나 쌓여 있는지' 보여준다.

    이력은 자동 삭제하지 않고 **무기한 보관**한다(정리는 관리자가 직접).
    """
    def _run():
        conn = get_conn()
        row = conn.execute(
            "SELECT COUNT(*) AS rows, MIN(ts) AS oldest, MAX(ts) AS newest, "
            "COUNT(DISTINCT client_id) AS agents, COUNT(DISTINCT ts) AS ticks "
            "FROM agent_state_samples"
        ).fetchone()
        # 파일 전체 크기(공지 이미지 등 포함)와, 상태 이력이 차지하는 대략치를 함께 준다.
        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        page_count = conn.execute("PRAGMA page_count").fetchone()[0]
        per_agent = conn.execute(
            "SELECT client_id, COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest "
            "FROM agent_state_samples GROUP BY client_id"
        ).fetchall()
        conn.close()
        return {
            "rows": row["rows"] or 0,
            "ticks": row["ticks"] or 0,
            "agents": row["agents"] or 0,
            "oldest_ts": row["oldest"],
            "newest_ts": row["newest"],
            # 행당 약 26바이트 — 실측(6.9만행 ≈ 1.7MB)으로 잡은 어림값. sqlite dbstat 확장이
            # 빌드에 없어 정확한 테이블 크기는 못 구한다. 표기도 '약'으로 한다.
            "approx_bytes": (row["rows"] or 0) * 26,
            "db_bytes": page_size * page_count,
            "per_agent": [
                {"client_id": r["client_id"], "rows": r["n"],
                 "oldest_ts": r["oldest"], "newest_ts": r["newest"]}
                for r in per_agent
            ],
        }
    return await asyncio.to_thread(_run)


async def delete_state_samples(*, client_id: str | None = None,
                               before_ts: int | None = None,
                               vacuum: bool = False) -> int:
    """상태 이력 삭제. 반환: 지운 행 수.

    - client_id 만: 그 PC 의 전체 이력 (관제 목록에서 PC 를 제거할 때)
    - before_ts 만: 그 시각 이전 전체 PC 이력 (오래된 것 정리)
    - 둘 다 없으면: **전 이력 삭제**
    - vacuum=True 면 삭제 후 파일 공간을 실제로 회수한다(느릴 수 있어 선택).
    """
    def _run():
        conn = get_conn()
        where, params = [], []
        if client_id:
            where.append("client_id=?")
            params.append(client_id)
        if before_ts is not None:
            where.append("ts < ?")
            params.append(before_ts)
        sql = "DELETE FROM agent_state_samples"
        if where:
            sql += " WHERE " + " AND ".join(where)
        cur = conn.execute(sql, params)
        conn.commit()
        n = cur.rowcount
        if vacuum and n:
            # DELETE 만으로는 파일이 줄지 않는다 — 재작성해서 공간을 실제로 반환.
            conn.execute("VACUUM")
        conn.close()
        return n
    return await asyncio.to_thread(_run)


async def state_sample_min_ts() -> int | None:
    """가장 오래된 상태 샘플 시각 — '전체 이력' 그래프의 시작점."""
    def _run():
        conn = get_conn()
        row = conn.execute("SELECT MIN(ts) AS m FROM agent_state_samples").fetchone()
        conn.close()
        return row["m"]
    return await asyncio.to_thread(_run)


async def query_state_history(since_ts: int, bucket_sec: int,
                              client_ids: list[str] | None = None) -> dict:
    """since_ts 이후 상태 샘플을 세 가지로 집계한다.

      - by_bucket : 시간 흐름(버킷)별 상태 카운트 — 메인 시계열 그래프
      - by_hour   : 기간 전체를 0~23시로 접은 시간대별 카운트 — '몇 시에 바쁜가'
      - by_agent  : PC별 상태 카운트 — 가동률 표

    카운트는 **샘플 수**다. 버킷의 tick 수(= COUNT(DISTINCT ts))로 나누면
    그 구간의 '평균 PC 대수' 가 된다. 서버가 꺼져 있던 구간은 tick 이 0 이므로
    '전부 대기' 가 아니라 **데이터 없음**으로 구분할 수 있다.

    client_ids 지정 시 해당 PC 들만 집계한다 (부서/프로젝트 필터).
    tick 수도 필터된 집합 기준(선택 PC 중 하나라도 찍힌 tick)이므로
    평균 대수 계산이 필터와 일관된다.
    """
    off = _tz_offset_sec()

    def _run():
        conn = get_conn()
        where = "ts >= ?"
        params: list = [since_ts]
        if client_ids:
            where += f" AND client_id IN ({','.join('?' for _ in client_ids)})"
            params.extend(client_ids)
        # 로컬 시각 기준으로 내림한 버킷 시작(epoch 초)
        bexpr = f"(((ts + {off}) / {bucket_sec}) * {bucket_sec} - {off})"
        by_bucket = conn.execute(
            f"SELECT {bexpr} AS b, state, COUNT(*) AS n FROM agent_state_samples "
            f"WHERE {where} GROUP BY b, state", params,
        ).fetchall()
        bucket_ticks = conn.execute(
            f"SELECT {bexpr} AS b, COUNT(DISTINCT ts) AS t FROM agent_state_samples "
            f"WHERE {where} GROUP BY b", params,
        ).fetchall()
        hexpr = f"(((ts + {off}) / 3600) % 24)"
        by_hour = conn.execute(
            f"SELECT {hexpr} AS h, state, COUNT(*) AS n FROM agent_state_samples "
            f"WHERE {where} GROUP BY h, state", params,
        ).fetchall()
        hour_ticks = conn.execute(
            f"SELECT {hexpr} AS h, COUNT(DISTINCT ts) AS t FROM agent_state_samples "
            f"WHERE {where} GROUP BY h", params,
        ).fetchall()
        by_agent = conn.execute(
            "SELECT client_id, state, COUNT(*) AS n FROM agent_state_samples "
            f"WHERE {where} GROUP BY client_id, state", params,
        ).fetchall()
        total_ticks = conn.execute(
            f"SELECT COUNT(DISTINCT ts) AS t FROM agent_state_samples WHERE {where}",
            params,
        ).fetchone()["t"]
        conn.close()
        return {
            "by_bucket": [(r["b"], r["state"], r["n"]) for r in by_bucket],
            "bucket_ticks": {r["b"]: r["t"] for r in bucket_ticks},
            "by_hour": [(r["h"], r["state"], r["n"]) for r in by_hour],
            "hour_ticks": {r["h"]: r["t"] for r in hour_ticks},
            "by_agent": [(r["client_id"], r["state"], r["n"]) for r in by_agent],
            "total_ticks": total_ticks,
            "tz_offset_sec": off,
        }
    return await asyncio.to_thread(_run)

# --- 버그 리포트 ---

async def create_bug_report(
    title: str,
    description: str = "",
    reporter: str = "",
    version: str = "",
    boot_id: str = "",
    platform: str = "",
    hostname: str = "",
    client_created_at: str = "",
    file_path: str = "",
    file_name: str = "",
    file_size: int = 0,
    user_name: str = "",
    user_team: str = "",
    project: str = "",
) -> dict:
    def _run():
        conn = get_conn()
        now = _now()
        cur = conn.execute(
            "INSERT INTO bug_reports "
            "(title, description, reporter, version, boot_id, platform, hostname, "
            " client_created_at, received_at, file_path, file_name, file_size, status, "
            " user_name, user_team, project) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)",
            (title, description, reporter, version, boot_id, platform, hostname,
             client_created_at, now, file_path, file_name, file_size,
             user_name, user_team, project),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM bug_reports WHERE id=?", (cur.lastrowid,)).fetchone()
        conn.close()
        return dict(row)
    return await asyncio.to_thread(_run)

async def list_bug_reports() -> list[dict]:
    def _run():
        conn = get_conn()
        rows = conn.execute("SELECT * FROM bug_reports ORDER BY received_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]
    return await asyncio.to_thread(_run)

async def get_bug_report(report_id: int) -> dict | None:
    def _run():
        conn = get_conn()
        row = conn.execute("SELECT * FROM bug_reports WHERE id=?", (report_id,)).fetchone()
        conn.close()
        return dict(row) if row else None
    return await asyncio.to_thread(_run)

async def update_bug_report_status(report_id: int, status: str) -> dict | None:
    def _run():
        conn = get_conn()
        conn.execute("UPDATE bug_reports SET status=? WHERE id=?", (status, report_id))
        conn.commit()
        row = conn.execute("SELECT * FROM bug_reports WHERE id=?", (report_id,)).fetchone()
        conn.close()
        return dict(row) if row else None
    return await asyncio.to_thread(_run)

async def delete_bug_report(report_id: int) -> bool:
    def _run():
        conn = get_conn()
        cur = conn.execute("DELETE FROM bug_reports WHERE id=?", (report_id,))
        conn.commit()
        conn.close()
        return cur.rowcount > 0
    return await asyncio.to_thread(_run)
