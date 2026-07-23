"""Admin Server — 공지사항 관리 + 테스트 PC 관제."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import threading
import uuid
import webbrowser
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import time

from fastapi import FastAPI, File, Form, Query, UploadFile, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pathlib import Path
from pydantic import BaseModel
from typing import Optional

from . import database as db

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# ==================== 자동 번역 (한 → 영) ====================
# deep-translator 미설치/오프라인이어도 앱은 정상 동작(영문 비우고 한국어로 폴백).
try:
    from deep_translator import GoogleTranslator
    _TRANSLATOR_OK = True
except Exception as _e:  # pragma: no cover
    _TRANSLATOR_OK = False
    logger.warning("deep-translator 사용 불가 — 자동 번역 비활성화: %s", _e)


def _translate_en_sync(text: str) -> str:
    text = (text or "").strip()
    if not text or not _TRANSLATOR_OK:
        return ""
    try:
        # 5000자 제한 대비 잘라서 호출
        return GoogleTranslator(source="auto", target="en").translate(text[:4900]) or ""
    except Exception as e:
        logger.warning("자동 번역 실패: %s", e)
        return ""


async def _auto_en(source_text: str, provided_en: str | None) -> str:
    """영문이 직접 입력돼 있으면 그대로, 없으면 한국어를 자동 번역."""
    provided = (provided_en or "").strip()
    if provided:
        return provided
    return await asyncio.to_thread(_translate_en_sync, source_text)

# 간단 관리자 계정 (하드코딩)
ADMIN_USER = "admin"
ADMIN_PASS = "admin"


def _maybe_open_browser():
    """서버 기동 후 기본 브라우저로 localhost:9000 자동 열기.

    - REPLAYKIT_OPEN_BROWSER=0 이면 비활성화(업데이트 재시작 시 자동 설정).
    - --reload(개발) 모드에서는 리로드마다 열리는 것을 방지.
    """
    if os.environ.get("REPLAYKIT_OPEN_BROWSER", "1") == "0":
        return
    if "--reload" in sys.argv:
        return

    def _open():
        try:
            webbrowser.open("http://localhost:9000")
        except Exception as e:
            logger.warning("브라우저 자동 열기 실패: %s", e)

    # 소켓이 실제로 연결을 받을 때까지 약간 대기
    threading.Timer(1.5, _open).start()


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    logger.info("Admin server started — DB initialized")
    _maybe_open_browser()
    # 이전 실행에서 닫히지 않고 남은 열린 상태 구간 정리(크래시/재시작 잔재).
    try:
        n = await db.close_dangling_state_intervals()
        if n:
            logger.info("이전 실행의 열린 상태 구간 %d개 정리", n)
    except Exception as e:
        logger.warning("상태 구간 정리 실패: %s", e)
    # 상태 시계열 샘플러 — 사용량 통계 그래프의 원본을 쌓는다(_state_sampler 참고).
    # (전이 기반 구간 기록 agent_state_intervals 과 병행 — 검증 후 그래프를 구간 기반으로 전환)
    sampler = asyncio.create_task(_state_sampler())
    try:
        yield
    finally:
        sampler.cancel()
        try:
            await sampler
        except (asyncio.CancelledError, Exception):
            pass

app = FastAPI(title="ReplayKit Admin", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================== 로그인 API ====================

class LoginRequest(BaseModel):
    username: str
    password: str

@app.post("/api/login")
async def login(req: LoginRequest):
    if req.username == ADMIN_USER and req.password == ADMIN_PASS:
        return {"status": "ok", "username": req.username}
    raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 틀립니다")

# ==================== 시스템(업데이트) API ====================
# ⚠️ 주의: 이 엔드포인트는 git pull + 서버 재시작을 수행한다.
#    내부망 관리 도구 전제이며, 외부 노출 시 인증 보강이 필요하다.

_PROJECT_ROOT = Path(__file__).parent.parent


def _git(args: list[str], timeout: int = 90) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(_PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def _deploy_remote() -> str:
    """run.bat과 동일하게 deploy 리모트가 있으면 우선 사용, 없으면 origin."""
    r = _git(["remote", "get-url", "deploy"], timeout=15)
    return "deploy" if r.returncode == 0 else "origin"


@app.post("/api/update")
async def update_app():
    """최신 코드를 받아(git) 서버를 재시작한다."""
    remote = _deploy_remote()
    try:
        fetch = _git(["fetch", remote, "main"])
        if fetch.returncode != 0:
            raise HTTPException(status_code=500, detail=f"git fetch 실패: {fetch.stderr.strip()}")
        reset = _git(["reset", "--hard", f"{remote}/main"])
        if reset.returncode != 0:
            raise HTTPException(status_code=500, detail=f"git reset 실패: {reset.stderr.strip()}")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="git 실행 파일을 찾을 수 없습니다")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="git 작업 시간 초과")

    head = reset.stdout.strip()
    logger.info("Update pulled from %s/main: %s", remote, head)

    reload_mode = "--reload" in sys.argv
    if reload_mode:
        # --reload 모드: 파일이 바뀌면 uvicorn이 자동 재시작하므로 별도 재실행 불필요
        logger.info("Reload mode — uvicorn will auto-restart on file change")
    else:
        # 운영 모드: 응답을 보낸 뒤 같은 프로세스를 재실행
        def _restart():
            logger.info("Restarting server (os.execv)...")
            # 재시작 시에는 브라우저를 다시 열지 않음
            os.environ["REPLAYKIT_OPEN_BROWSER"] = "0"
            os.execv(sys.executable, [sys.executable, "-m", "uvicorn", *sys.argv[1:]])
        threading.Timer(1.0, _restart).start()

    return {"status": "updating", "remote": remote, "head": head, "reload": reload_mode}

# ==================== 공지사항 API ====================

class GuideStep(BaseModel):
    text: str = ""
    text_en: str = ""            # 영문(선택)
    image: Optional[str] = None  # base64 data URL

class AnnouncementCreate(BaseModel):
    title: str
    content: str = ""
    title_en: str = ""           # 영문 제목(선택)
    content_en: str = ""         # 영문 내용/개요(선택)
    priority: str = "normal"  # normal, important, urgent
    type: str = "notice"      # 'notice'(일반 공지/안내) | 'guide'(단계별 가이드)
    is_popup: int = 0         # 1이면 사용자 화면 진입 시 팝업으로 표시
    images: list[str] = []    # 일반 공지: data URL 목록(여러 장)
    steps: list[GuideStep] = []  # 가이드: 순서대로 글+이미지

class AnnouncementUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    title_en: Optional[str] = None
    content_en: Optional[str] = None
    priority: Optional[str] = None
    active: Optional[int] = None
    type: Optional[str] = None
    is_popup: Optional[int] = None
    images: Optional[list[str]] = None
    steps: Optional[list[GuideStep]] = None


def _first_image(images: list[str], steps: list[dict]) -> Optional[str]:
    """하위호환용 단일 image_data: 첫 이미지를 선택."""
    if images:
        return images[0]
    for s in steps:
        if s.get("image"):
            return s["image"]
    return None

class TranslateRequest(BaseModel):
    texts: list[str]

@app.post("/api/translate")
async def translate_texts(req: TranslateRequest):
    """여러 한국어 텍스트를 영어로 번역(작성 중 검토용)."""
    if not _TRANSLATOR_OK:
        raise HTTPException(status_code=503, detail="번역 기능을 사용할 수 없습니다 (deep-translator 미설치/오프라인)")
    results = await asyncio.gather(*[asyncio.to_thread(_translate_en_sync, t) for t in req.texts])
    return {"translations": list(results)}

@app.get("/api/announcements")
async def get_announcements(active_only: bool = False):
    return await db.list_announcements(active_only)

@app.post("/api/announcements")
async def create_announcement(req: AnnouncementCreate):
    images = req.images or []
    src_steps = req.steps or []
    # 제목/내용/단계 텍스트를 동시에 자동 번역
    title_en, content_en, *step_ens = await asyncio.gather(
        _auto_en(req.title, req.title_en),
        _auto_en(req.content, req.content_en),
        *[_auto_en(s.text, s.text_en) for s in src_steps],
    )
    steps = []
    for s, ten in zip(src_steps, step_ens):
        d = s.model_dump()
        d["text_en"] = ten
        steps.append(d)
    ann = await db.create_announcement(
        req.title,
        req.content,
        req.priority,
        image_data=_first_image(images, steps),
        is_popup=req.is_popup,
        type=req.type,
        images=json.dumps(images, ensure_ascii=False),
        steps=json.dumps(steps, ensure_ascii=False),
        title_en=title_en,
        content_en=content_en,
    )
    # 새 공지 알림을 연결된 클라이언트에게 전파
    await _broadcast_announcement_update()
    return ann

@app.put("/api/announcements/{ann_id}")
async def update_announcement(ann_id: int, req: AnnouncementUpdate):
    data = req.model_dump(exclude_none=True)
    images = data.get("images")
    steps = data.get("steps")  # list[dict] (model_dump 변환됨)
    # 한국어 본문이 갱신되면 영문도 자동 재번역(영문이 직접 들어온 경우는 존중)
    if "title" in data:
        data["title_en"] = await _auto_en(data["title"], data.get("title_en"))
    if "content" in data:
        data["content_en"] = await _auto_en(data["content"], data.get("content_en"))
    if steps is not None:
        step_ens = await asyncio.gather(
            *[_auto_en(d.get("text", ""), d.get("text_en")) for d in steps]
        )
        for d, ten in zip(steps, step_ens):
            d["text_en"] = ten
    # 이미지/단계가 갱신되면 단일 image_data(하위호환)도 재계산
    if images is not None or steps is not None:
        data["image_data"] = _first_image(images or [], steps or [])
    if images is not None:
        data["images"] = json.dumps(images, ensure_ascii=False)
    if steps is not None:
        data["steps"] = json.dumps(steps, ensure_ascii=False)
    result = await db.update_announcement(ann_id, **data)
    if not result:
        raise HTTPException(status_code=404, detail="공지사항을 찾을 수 없습니다")
    await _broadcast_announcement_update()
    return result

@app.delete("/api/announcements/{ann_id}")
async def delete_announcement(ann_id: int):
    ok = await db.delete_announcement(ann_id)
    if not ok:
        raise HTTPException(status_code=404, detail="공지사항을 찾을 수 없습니다")
    await _broadcast_announcement_update()
    return {"status": "ok"}

# ==================== 공지사항 실시간 스트림 (유저용) ====================

announcement_subscribers: set[WebSocket] = set()

@app.websocket("/ws/announcements")
async def ws_announcements(ws: WebSocket):
    """유저가 공지사항 실시간 업데이트를 받는 WebSocket."""
    await ws.accept()
    announcement_subscribers.add(ws)
    try:
        # 초기 공지사항 전송
        announcements = await db.list_announcements(active_only=True)
        await ws.send_json({"type": "announcements", "announcements": announcements})
        # keep alive
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        announcement_subscribers.discard(ws)


# 공지사항 브로드캐스트 — 구독 중인 유저 클라이언트(/ws/announcements)에 전송
async def _broadcast_announcement_update():
    announcements = await db.list_announcements(active_only=True)
    msg = json.dumps({"type": "announcements", "announcements": announcements})
    for ws in list(announcement_subscribers):
        try:
            await ws.send_text(msg)
        except Exception:
            announcement_subscribers.discard(ws)


# ==================== 테스트 PC 관제 (에이전트) ====================
# ReplayKit 각 PC 의 MonitorClient 가 /ws/client 로 연결해 2초마다 status_update 를 보낸다.
# 라이브 상태는 agents.registry(메모리), 함수통계 스냅샷은 db.agent_usage(영속).

from . import agents

# PC별 마지막으로 DB 에 저장한 usage generated_at — 매 2초 write 부하 방지용 스로틀.
_last_usage_gen: dict[str, str] = {}
# PC별 마지막으로 DB 에 저장한 로그인 사용자(JSON) — 값이 바뀔 때만 upsert.
_last_user_json: dict[str, str] = {}
# PC별 현재 열려 있는 상태 구간의 state — 값이 바뀔 때만 전이 기록(전이 기반 구간 로그).
# 이게 있어 상태가 유지되는 동안엔 DB write 가 전혀 없다(샘플링 대비 저장량 급감).
_open_state: dict[str, str] = {}


async def _log_state_transition(client_id: str, activity: str, playback) -> None:
    """status_update 마다 호출 — 상태가 바뀌었을 때만 구간 전이를 DB 에 기록."""
    state = agents.derive_online_state(activity, playback)
    if _open_state.get(client_id) == state:
        return  # 상태 유지 → write 없음
    _open_state[client_id] = state
    try:
        await db.record_state_transition(client_id, state, int(time.time()))
    except Exception as e:
        logger.warning("상태 구간 전이 기록 실패(%s): %s", client_id, e)


async def _close_state_interval(client_id: str) -> None:
    """연결 종료/오프라인 시 열린 구간을 지금 시각으로 닫는다."""
    _open_state.pop(client_id, None)
    try:
        await db.close_state_interval(client_id, int(time.time()))
    except Exception as e:
        logger.warning("상태 구간 종료 실패(%s): %s", client_id, e)


@app.get("/api/agents")
async def api_agents():
    """관제 대상 테스트 PC 목록(라이브 상태)."""
    return {"agents": agents.registry.get_all(), "summary": agents.registry.summary()}


@app.get("/api/agents/function-stats")
async def api_agents_function_stats():
    """모든 PC 의 모듈/함수 사용통계 집계 (오프라인 PC 는 DB 스냅샷으로 보강)."""
    snapshots = await db.list_agent_usage()
    return agents.registry.aggregate_function_stats(extra_snapshots=snapshots)


# 상태 시계열 샘플링 — 라이브 상태는 메모리에만 있어 서버가 죽으면 사라지므로,
# 이 주기로 전 PC 상태를 한 tick 씩 DB 에 남겨 사용량 그래프의 원본으로 쓴다.
# 보관은 **무기한** — 자동 삭제하지 않는다. 정리는 관리자가 사용량 통계 화면의
# '이력 관리' 에서 직접 한다(DELETE /api/agents/state-history).
SAMPLE_INTERVAL_SEC = 60

# 조회 기간 → (초, 버킷 크기). 버킷은 "한 화면에 20~30개 막대" 가 되도록 잡는다.
HISTORY_RANGES: dict[str, tuple[int, int]] = {
    "1d":  (86400,      3600),       # 최근 24시간 — 1시간 버킷
    "7d":  (7 * 86400,  6 * 3600),   # 최근 7일   — 6시간 버킷
    "30d": (30 * 86400, 86400),      # 최근 30일  — 1일 버킷
}

# range=all — 전체 이력을 최대한 세밀한 버킷으로 내려주고, 프론트가 휠 줌으로
# 원하는 스케일(10분~1일)로 **재집계**한다. counts/ticks 는 합산 가능해서
# 클라이언트 재집계가 정확하다(버킷이 시간을 빈틈없이 분할하므로).
ALL_BUCKET_STEPS = [600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400]
# 응답 버킷 수 상한 — 600초 버킷이면 약 55일치. 넘으면 자동으로 굵은 버킷을 쓴다.
MAX_HISTORY_BUCKETS = 8000


async def _state_sampler():
    """SAMPLE_INTERVAL_SEC 마다 전 PC 상태를 DB 에 1 tick 기록하는 백그라운드 루프."""
    while True:
        try:
            await asyncio.sleep(SAMPLE_INTERVAL_SEC)
            rows = agents.registry.sample_states()
            if rows:
                # tick 시각은 주기에 맞춰 내림 — 버킷 경계가 깔끔하고 재시작해도 격자가 유지된다.
                ts = int(time.time()) // SAMPLE_INTERVAL_SEC * SAMPLE_INTERVAL_SEC
                await db.insert_state_samples(ts, rows)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # 샘플러가 죽으면 그래프가 조용히 비므로 반드시 남긴다.
            logger.warning("상태 샘플링 실패: %s", e)


@app.get("/api/agents/state-history")
async def api_agent_state_history(
    range_: str = Query("1d", alias="range"),
    team: str | None = Query(None, description="부서(팀)로 필터 — 해당 부서 사용자가 로그인한 PC 만 집계"),
    project: str | None = Query(None, description="프로젝트로 필터 (HKMC/Nissan 등)"),
):
    """사용량 통계 그래프용 — 상태별 시계열/시간대/PC별 집계.

    ⚠️ 이 라우트는 반드시 /api/agents/{client_id} **앞**에 선언돼야 한다.
       뒤에 두면 "state-history" 가 client_id 로 잡혀 404 가 난다.
    """
    now = int(time.time())
    if range_ == "all":
        # 전체 이력 — 첫 샘플부터. 데이터가 없으면 최근 하루 격자만(빈 그래프).
        oldest = await db.state_sample_min_ts()
        since = oldest if oldest is not None else now - 86400
        span = max(now - since, 3600)
        bucket_sec = next(
            (b for b in ALL_BUCKET_STEPS if span // b <= MAX_HISTORY_BUCKETS),
            ALL_BUCKET_STEPS[-1],
        )
    else:
        if range_ not in HISTORY_RANGES:
            range_ = "1d"
        span, bucket_sec = HISTORY_RANGES[range_]
        since = now - span

    # 부서/프로젝트 필터 → 대상 client_id 집합으로 변환해 SQL 단계에서 거른다.
    # 매핑은 "현재" 사용자 기준 — 과거 샘플에 사용자를 소급 기록하지는 않는다.
    client_ids: list[str] | None = None
    meta = await _merged_agent_meta()
    if team or project:
        client_ids = [
            cid for cid, m in meta.items()
            if (not team or m.get("user_team") == team)
            and (not project or m.get("project") == project)
        ]
        if not client_ids:
            client_ids = ["__no_match__"]   # 매칭 PC 없음 → 빈 그래프 (전체로 폴백하지 않게)

    agg = await db.query_state_history(since, bucket_sec, client_ids)
    off = agg["tz_offset_sec"]

    # 버킷 격자를 먼저 만들고(빈 구간 포함) 집계를 채운다 —
    # 서버가 꺼져 있던 구간은 ticks=0 으로 남아 '데이터 없음' 으로 그려진다.
    def _floor(t: int) -> int:
        return ((t + off) // bucket_sec) * bucket_sec - off

    grid: dict[int, dict] = {}
    b = _floor(since)
    while b <= _floor(now):
        grid[b] = {"t": b, "ticks": agg["bucket_ticks"].get(b, 0), "counts": {}}
        b += bucket_sec
    for bt, state, n in agg["by_bucket"]:
        if bt in grid:
            grid[bt]["counts"][state] = n

    hours = [{"hour": h, "ticks": agg["hour_ticks"].get(h, 0), "counts": {}} for h in range(24)]
    for h, state, n in agg["by_hour"]:
        hours[h]["counts"][state] = n

    # PC 이름/사용자 메타 — 라이브 레지스트리 우선, 없으면 스냅샷(_merged_agent_meta 가 병합)
    per_agent: dict[str, dict] = {}
    for cid, state, n in agg["by_agent"]:
        m = meta.get(cid) or {}
        a = per_agent.setdefault(cid, {
            "client_id": cid,
            "name": m.get("host") or cid,
            "user_name": m.get("user_name") or "",
            "user_team": m.get("user_team") or "",
            "project": m.get("project") or "",
            "samples": 0, "counts": {},
        })
        a["counts"][state] = n
        a["samples"] += n

    return {
        "range": range_,
        "since": since,
        "now": now,
        "bucket_sec": bucket_sec,
        "sample_interval_sec": SAMPLE_INTERVAL_SEC,
        "total_ticks": agg["total_ticks"],
        "buckets": [grid[k] for k in sorted(grid)],
        "hours": hours,
        "agents": sorted(per_agent.values(), key=lambda a: a["name"].lower()),
    }


@app.get("/api/agents/state-history-v2")
async def api_agent_state_history_v2(
    range_: str = Query("1d", alias="range"),
    team: str | None = Query(None, description="부서(팀)로 필터"),
    project: str | None = Query(None, description="프로젝트로 필터"),
):
    """사용량 통계 — **전이 기반 구간**에서 상태별 '실제 지속시간(초)' 을 집계.

    기존 /state-history 는 60초 샘플 개수라 60초 미만 이벤트를 놓치고 경계 오차가 ±60초다.
    이 라우트는 상태 구간의 길이를 그대로 합산하므로 초 단위로 정확하고 짧은 이벤트도 반영한다.
    응답 구조는 /state-history 와 맞추되 counts 값이 '초' 이며, 데이터 유무는 span_sec 로 판단한다.
    검증 후 프론트 그래프를 이 라우트로 전환한다(병행 단계).

    ⚠️ /api/agents/{client_id} 앞에 선언돼야 한다 (경로 충돌 방지).
    """
    now = int(time.time())
    if range_ == "all":
        st = await db.state_interval_stats()
        oldest = st.get("oldest_ts")
        since = int(oldest) if oldest is not None else now - 86400
        span = max(now - since, 3600)
        bucket_sec = next(
            (b for b in ALL_BUCKET_STEPS if span // b <= MAX_HISTORY_BUCKETS),
            ALL_BUCKET_STEPS[-1],
        )
    else:
        if range_ not in HISTORY_RANGES:
            range_ = "1d"
        span, bucket_sec = HISTORY_RANGES[range_]
        since = now - span

    client_ids: list[str] | None = None
    meta = await _merged_agent_meta()
    if team or project:
        client_ids = [
            cid for cid, m in meta.items()
            if (not team or m.get("user_team") == team)
            and (not project or m.get("project") == project)
        ]
        if not client_ids:
            client_ids = ["__no_match__"]

    agg = await db.query_state_intervals(since, now, bucket_sec, client_ids)
    off = db._tz_offset_sec()

    def _floor(t: int) -> int:
        return ((t + off) // bucket_sec) * bucket_sec - off

    # 버킷 격자 — span_sec(그 버킷에서 실제로 데이터가 있던 초)로 '데이터 없음' 을 구분
    grid: dict[int, dict] = {}
    b = _floor(since)
    while b <= _floor(now):
        grid[b] = {"t": b, "span_sec": agg["bucket_span"].get(b, 0), "counts": {}}
        b += bucket_sec
    for bt, state, sec in agg["by_bucket"]:
        if bt in grid:
            grid[bt]["counts"][state] = sec

    hours = [{"hour": h, "counts": {}} for h in range(24)]
    for h, state, sec in agg["by_hour"]:
        hours[h]["counts"][state] = sec

    per_agent: dict[str, dict] = {}
    for cid, state, sec in agg["by_agent"]:
        m = meta.get(cid) or {}
        a = per_agent.setdefault(cid, {
            "client_id": cid,
            "name": m.get("host") or cid,
            "user_name": m.get("user_name") or "",
            "user_team": m.get("user_team") or "",
            "project": m.get("project") or "",
            "seconds": 0, "counts": {},
        })
        a["counts"][state] = sec
        a["seconds"] += sec

    return {
        "range": range_,
        "since": since,
        "now": now,
        "bucket_sec": bucket_sec,
        "metric": "seconds",   # counts 값의 단위 (기존 라우트는 샘플 개수)
        "buckets": [grid[k] for k in sorted(grid)],
        "hours": hours,
        "agents": sorted(per_agent.values(), key=lambda a: a["name"].lower()),
    }


@app.get("/api/agents/state-history/info")
async def api_state_history_info():
    """상태 이력 보관 현황 (이력 관리 화면용). PC 이름을 붙여 반환한다."""
    info = await db.state_sample_stats()
    names = agents.registry.names()
    hosts = await db.list_agent_usage_hosts()
    for a in info.get("per_agent", []):
        cid = a["client_id"]
        a["name"] = names.get(cid) or hosts.get(cid) or cid
    info["per_agent"].sort(key=lambda a: a["name"].lower())
    return info


@app.delete("/api/agents/state-history")
async def api_state_history_delete(
    before: int | None = Query(None, description="이 epoch(초) 이전 삭제. 미지정이면 기간 제한 없음"),
    client_id: str | None = Query(None, description="이 PC 만 삭제. 미지정이면 전체 PC"),
    vacuum: bool = Query(True, description="삭제 후 DB 파일 공간 회수(느릴 수 있음)"),
):
    """상태 이력 수동 삭제 — 보관은 무기한이라 정리는 여기서만 일어난다.

    before/client_id 를 모두 비우면 **전 이력 삭제**다(프론트가 확인창을 띄운다).
    """
    deleted = await db.delete_state_samples(
        client_id=client_id or None, before_ts=before, vacuum=vacuum)
    logger.info("상태 이력 삭제: %d행 (before=%s, client_id=%s)", deleted, before, client_id)
    return {"status": "ok", "deleted": deleted}


async def _merged_agent_meta() -> dict[str, dict]:
    """client_id → {host, user_name, user_title, user_team, project}.

    DB 스냅샷(오프라인 PC 포함)을 바탕에 깔고 라이브 레지스트리 값을 덮어쓴다 —
    사용자 변경 직후에도 라이브 값이 우선 보이게.
    """
    rows = {m["client_id"]: dict(m) for m in await db.list_agent_meta()}
    for cid, name in agents.registry.names().items():
        if not cid:
            continue
        m = rows.setdefault(cid, {"client_id": cid, "host": "", "user_name": "",
                                  "user_title": "", "user_team": "", "project": ""})
        if name:
            m["host"] = name
    for cid, user in agents.registry.users().items():
        m = rows.get(cid)
        if not m:
            continue
        m["user_name"] = str(user.get("name") or "") or m["user_name"]
        m["user_title"] = str(user.get("title") or "") or m["user_title"]
        m["user_team"] = str(user.get("team") or "") or m["user_team"]
        m["project"] = str(user.get("project") or "") or m["project"]
    return rows


@app.get("/api/agents/meta")
async def api_agents_meta():
    """PC별 표시 메타(호스트명·사용자·부서·프로젝트) — 통계 필터 옵션의 원본.

    ⚠️ /api/agents/{client_id} 보다 **앞**에 선언 — 뒤면 "meta" 가 client_id 로 잡힌다.
    """
    rows = await _merged_agent_meta()
    return {"agents": sorted(rows.values(), key=lambda m: (m["host"] or m["client_id"]).lower())}


@app.get("/api/agents/{client_id}")
async def api_agent_detail(client_id: str):
    """단일 PC 상세 (usage_stats 포함). 오프라인이면 DB 스냅샷으로 폴백."""
    one = agents.registry.get_one(client_id)
    if one:
        return one
    # 라이브에 없으면 DB 스냅샷에서 조회
    for snap in await db.list_agent_usage():
        if snap.get("client_id") == client_id:
            return {
                "client_id": client_id,
                "name": snap.get("host", ""),
                "ip": snap.get("ip", ""),
                "online": False,
                "playback": None,
                "devices": [],
                "usage_stats": snap.get("usage_stats"),
                "last_seen": snap.get("updated_at"),
            }
    raise HTTPException(status_code=404, detail="에이전트를 찾을 수 없습니다")


@app.delete("/api/agents/{client_id}")
async def api_agent_delete(client_id: str):
    """관제 목록에서 에이전트 제거 (오래된/중복 카드 정리).

    머신 UID 가 바뀌면(OS 재설치, 식별자 소스 변경 등) 같은 PC 가 두 개로 보인다.
    삭제해도 해당 PC 가 다시 접속하면 자동 재등록되므로 안전하다.
    라이브 상태와 저장된 함수통계 스냅샷을 함께 지운다.
    """
    removed = agents.registry.remove(client_id)
    await db.delete_agent_usage(client_id)
    await db.delete_state_samples(client_id=client_id)   # 사용량 그래프에서도 사라지게
    await db.delete_state_intervals(client_id)           # 구간 이력도 함께
    _last_usage_gen.pop(client_id, None)
    _last_user_json.pop(client_id, None)
    _open_state.pop(client_id, None)
    logger.info("에이전트 삭제: %s (live=%s)", client_id, removed)
    return {"status": "ok", "removed": removed}


# ==================== 로그인(사용자 식별) 설정 ====================
# ReplayKit 이 시작할 때 이 서버에서 Jira 계정을 받아 유저 검색(로그인)에 쓴다.
# 계정 관리는 관리자 화면(설정 페이지)에서. 프로젝트/모델 목록은 여기서 내려주지
# 않는다 — 각 ReplayKit 의 주 디바이스 카탈로그(device_catalog)가 원본이다.

_LOGIN_DEFAULT_JIRA_SERVER = "http://vlm.lge.com/issue"
_LOGIN_KEYS = ["jira_server", "jira_id", "jira_pw"]


async def _load_login_settings() -> dict:
    s = await db.get_settings_map(_LOGIN_KEYS)
    return {
        "jira_server": s.get("jira_server") or _LOGIN_DEFAULT_JIRA_SERVER,
        "jira_id": s.get("jira_id") or "",
        "jira_pw": s.get("jira_pw") or "",
    }


@app.get("/api/settings/login")
async def api_get_login_settings():
    """관리자 화면용 — Jira 비밀번호는 설정 여부만 노출(값은 되돌려주지 않음)."""
    cfg = await _load_login_settings()
    return {
        "jira_server": cfg["jira_server"],
        "jira_id": cfg["jira_id"],
        "jira_pw_set": bool(cfg["jira_pw"]),
    }


class LoginSettingsUpdate(BaseModel):
    jira_server: Optional[str] = None
    jira_id: Optional[str] = None
    jira_pw: Optional[str] = None          # 빈 값/미지정 = 기존 비밀번호 유지


@app.put("/api/settings/login")
async def api_put_login_settings(req: LoginSettingsUpdate):
    values: dict[str, str] = {}
    if req.jira_server is not None:
        values["jira_server"] = req.jira_server.strip()
    if req.jira_id is not None:
        values["jira_id"] = req.jira_id.strip()
    if req.jira_pw:
        # 빈 문자열은 '변경 안 함' — GET 이 비밀번호를 돌려주지 않아 폼이 빈 값으로 저장될 수 있다
        values["jira_pw"] = req.jira_pw
    if values:
        await db.set_settings_map(values)
    return await api_get_login_settings()


@app.get("/api/login-config")
async def api_login_config():
    """ReplayKit 에이전트용 — 시작 시 받아가는 Jira 계정.

    ⚠️ Jira 비밀번호가 응답에 평문으로 포함된다 — 사내망 전용 서비스 전제.
      (에이전트 백엔드만 호출하고 브라우저에는 노출하지 않는다)
    """
    cfg = await _load_login_settings()
    return {
        "jira": {"server": cfg["jira_server"], "id": cfg["jira_id"], "pw": cfg["jira_pw"]},
    }


@app.websocket("/ws/client")
async def ws_client(ws: WebSocket):
    """ReplayKit 테스트 PC(에이전트) 연결 — 상태 수신 전용 (모니터링만, 원격제어 미노출).

    프로토콜(에이전트 → 서버):
      1. {type:"register", client_id(머신 UID), name(호스트명), version}
         ← 서버: {type:"registered"}
      2. {type:"status_update", activity, devices[], playback{...}, scenarios[], usage_stats{...}}
    """
    await ws.accept()
    ip = ws.client.host if ws.client else ""
    client_id: str | None = None
    try:
        # 첫 메시지: register
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
        data = json.loads(raw)
        if data.get("type") != "register" or not data.get("client_id"):
            await ws.close()
            return
        client_id = str(data["client_id"])
        agents.registry.register(
            client_id,
            name=data.get("name", ""),
            ip=ip,
            version=data.get("version", ""),
        )
        await ws.send_json({"type": "registered", "server": "replaykit-manager"})
        logger.info("에이전트 등록: %s (%s / %s)", client_id, data.get("name", ""), ip)

        # 상태 수신 루프
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("type") == "status_update":
                agents.registry.update_status(client_id, msg, ip)
                # 전이 기반 구간 기록 — 상태가 바뀐 순간에만 1행. (샘플러와 병행)
                await _log_state_transition(client_id, msg.get("activity", "idle"), msg.get("playback"))
                # 로그인 사용자 영속화 — 값이 바뀔 때만 저장(오프라인 후에도 부서/프로젝트 필터에 쓰인다)
                u = msg.get("user")
                if isinstance(u, dict) and u:
                    uj = json.dumps(u, ensure_ascii=False, sort_keys=True)
                    if _last_user_json.get(client_id) != uj:
                        _last_user_json[client_id] = uj
                        try:
                            await db.upsert_agent_user(client_id, msg.get("name", ""), ip, u)
                        except Exception as e:
                            logger.warning("agent user 저장 실패(%s): %s", client_id, e)
                # 함수통계 스냅샷 영속화 — generated_at 이 바뀔 때만 저장(2초마다 write 방지)
                us = msg.get("usage_stats")
                if us:
                    gen = us.get("generated_at") or ""
                    if gen and _last_usage_gen.get(client_id) != gen:
                        _last_usage_gen[client_id] = gen
                        try:
                            await db.upsert_agent_usage(
                                client_id, msg.get("name", ""), ip,
                                json.dumps(us, ensure_ascii=False), gen,
                            )
                        except Exception as e:
                            logger.warning("agent_usage 저장 실패(%s): %s", client_id, e)
            # command_result 등 기타 메시지는 모니터링 단계에선 무시

    except WebSocketDisconnect:
        logger.info("에이전트 연결 종료: %s", client_id)
    except Exception as e:
        logger.warning("에이전트 WS 오류(%s): %s", client_id, e)
    finally:
        if client_id:
            agents.registry.mark_offline(client_id)
            # 열린 상태 구간을 지금 시각으로 닫는다 (오프라인은 어떤 상태에도 누적하지 않음).
            await _close_state_interval(client_id)


# ==================== 버그 리포트 API ====================
# ReplayKit 클라이언트가 multipart(meta JSON 문자열 + ZIP)로 제출한다.
# ZIP 본문은 bug_reports/YYYYMMDD/ 디렉토리에 저장하고 DB에는 메타만 남긴다.

BUG_REPORTS_DIR = _PROJECT_ROOT / "bug_reports"
_BUG_REPORT_MAX_BYTES = 200 * 1024 * 1024  # 업로드 상한 200MB


@app.post("/api/bug-reports")
async def submit_bug_report(meta: str = Form(...), file: UploadFile = File(...)):
    try:
        meta_obj = json.loads(meta)
        if not isinstance(meta_obj, dict):
            raise ValueError("meta must be a JSON object")
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"invalid meta JSON: {e}")

    title = str(meta_obj.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="meta.title is required")

    # 저장 파일명은 서버가 생성 (업로드 파일명은 표시용으로만 DB에 보관)
    now = datetime.now(timezone.utc)
    day_dir = BUG_REPORTS_DIR / now.strftime("%Y%m%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    save_path = day_dir / f"{now.strftime('%H%M%S')}_{uuid.uuid4().hex[:8]}.zip"

    size = 0
    try:
        with open(save_path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > _BUG_REPORT_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="file too large (max 200MB)")
                out.write(chunk)
    except HTTPException:
        save_path.unlink(missing_ok=True)
        raise
    except OSError as e:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"file save failed: {e}")

    report = await db.create_bug_report(
        title=title,
        description=str(meta_obj.get("description") or ""),
        reporter=str(meta_obj.get("reporter") or ""),
        version=str(meta_obj.get("version") or ""),
        boot_id=str(meta_obj.get("boot_id") or ""),
        platform=str(meta_obj.get("platform") or ""),
        hostname=str(meta_obj.get("hostname") or ""),
        client_created_at=str(meta_obj.get("created_at") or ""),
        file_path=str(save_path.relative_to(_PROJECT_ROOT)).replace("\\", "/"),
        file_name=file.filename or "bugreport.zip",
        file_size=size,
        user_name=str(meta_obj.get("user_name") or ""),
        user_team=str(meta_obj.get("user_team") or ""),
        project=str(meta_obj.get("project") or ""),
    )
    logger.info("bug report #%s received: %s (%s, %.1f MB)",
                report["id"], title, report["reporter"], size / 1048576)
    return {"id": report["id"], "received_at": report["received_at"]}


@app.get("/api/bug-reports")
async def list_bug_reports():
    return await db.list_bug_reports()


@app.get("/api/bug-reports/{report_id}/download")
async def download_bug_report(report_id: int):
    report = await db.get_bug_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="버그 리포트를 찾을 수 없습니다")
    path = _PROJECT_ROOT / (report.get("file_path") or "")
    if not report.get("file_path") or not path.is_file():
        raise HTTPException(status_code=404, detail="첨부 파일이 없습니다")
    # 파일명은 서버 생성 ASCII(bugreport_*.zip)라 단순 헤더로 충분
    name = report.get("file_name") or path.name
    safe = name.encode("ascii", "ignore").decode() or path.name
    return FileResponse(
        str(path),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe}"'},
    )


class BugReportStatusUpdate(BaseModel):
    status: str  # 'new' | 'in_progress' | 'reviewed' | 'done'


_BUG_REPORT_STATUSES = ("new", "in_progress", "reviewed", "done")


@app.put("/api/bug-reports/{report_id}")
async def update_bug_report(report_id: int, req: BugReportStatusUpdate):
    if req.status not in _BUG_REPORT_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"status must be one of {_BUG_REPORT_STATUSES}",
        )
    report = await db.update_bug_report_status(report_id, req.status)
    if not report:
        raise HTTPException(status_code=404, detail="버그 리포트를 찾을 수 없습니다")
    return report


@app.post("/api/bug-reports/import")
async def import_bug_report(file: UploadFile = File(...)):
    """로컬 폴백으로 받은 버그 리포트 ZIP 을 관리자가 수동 등록.

    Manager 에 접근하지 못하는 유저는 업로드 실패 시 ZIP 을 로컬 다운로드해
    메일/메신저로 전달한다 — 그 파일을 여기로 올리면 메타를 ZIP 안
    report.json 에서 추출해 일반 제출과 동일하게 목록/뷰어에 나타난다.
    """
    now = datetime.now(timezone.utc)
    day_dir = BUG_REPORTS_DIR / now.strftime("%Y%m%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    save_path = day_dir / f"{now.strftime('%H%M%S')}_{uuid.uuid4().hex[:8]}.zip"

    size = 0
    try:
        with open(save_path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > _BUG_REPORT_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="file too large (max 200MB)")
                out.write(chunk)
    except HTTPException:
        save_path.unlink(missing_ok=True)
        raise
    except OSError as e:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"file save failed: {e}")

    # ZIP 검증 + report.json 메타 추출 (없거나 손상이면 파일명으로 폴백)
    def _extract_meta():
        with zipfile.ZipFile(save_path) as zf:
            for info in zf.infolist():
                if not info.is_dir() and _zip_rel(info.filename) == "report.json":
                    return json.loads(zf.read(info))
        return None

    try:
        meta_obj = await asyncio.to_thread(_extract_meta)
    except zipfile.BadZipFile:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="ZIP 파일이 아니거나 손상되었습니다")
    except (json.JSONDecodeError, KeyError):
        meta_obj = None  # report.json 손상 — 파일명 폴백으로 계속

    meta_obj = meta_obj or {}
    env = meta_obj.get("env") or {}
    fallback_title = Path(file.filename or "bugreport.zip").stem
    report = await db.create_bug_report(
        title=str(meta_obj.get("title") or fallback_title),
        description=str(meta_obj.get("description") or ""),
        reporter=str(meta_obj.get("reporter") or ""),
        version=str(env.get("version") or ""),
        boot_id=str(env.get("boot_id") or ""),
        platform=str(env.get("platform") or ""),
        hostname=str(env.get("hostname") or ""),
        client_created_at=str(env.get("created_at") or ""),
        file_path=str(save_path.relative_to(_PROJECT_ROOT)).replace("\\", "/"),
        file_name=file.filename or "bugreport.zip",
        file_size=size,
    )
    logger.info("bug report #%s imported: %s (%.1f MB)", report["id"], report["title"], size / 1048576)
    return report


def _bug_report_zip_path(report: dict) -> Path:
    path = _PROJECT_ROOT / (report.get("file_path") or "")
    if not report.get("file_path") or not path.is_file():
        raise HTTPException(status_code=404, detail="첨부 파일이 없습니다")
    return path


# ZIP 안 상대경로(루트 폴더 제외) → 표준 구성요소 파싱용
def _zip_rel(name: str) -> str:
    parts = name.split("/", 1)
    return parts[1] if len(parts) > 1 else parts[0]


@app.get("/api/bug-reports/{report_id}/contents")
async def bug_report_contents(report_id: int):
    """리포트 ZIP을 서버에서 열어 뷰어용 구조로 반환.

    report.json / step_tests/records.json / results/*/range_steps.json 은
    파싱해서 내려주고, 나머지(이미지·로그)는 파일 목록만 준다 —
    개별 파일 본문은 GET /file?path= 로 지연 로드.
    """
    report = await db.get_bug_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="버그 리포트를 찾을 수 없습니다")
    path = _bug_report_zip_path(report)

    def _read():
        out = {"files": [], "report": None, "step_tests": None, "playback": {}}
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                rel = _zip_rel(info.filename)
                out["files"].append({"path": info.filename, "rel": rel, "size": info.file_size})
                try:
                    if rel == "report.json":
                        out["report"] = json.loads(zf.read(info))
                    elif rel == "step_tests/records.json":
                        out["step_tests"] = json.loads(zf.read(info))
                    elif rel.startswith("results/") and rel.endswith("/range_steps.json"):
                        run = rel.split("/")[1]
                        out["playback"][run] = json.loads(zf.read(info))
                except (json.JSONDecodeError, KeyError):
                    pass  # 손상된 항목은 파일 목록만 남긴다
        return out

    return await asyncio.to_thread(_read)


_ZIP_MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
}


@app.get("/api/bug-reports/{report_id}/file")
async def bug_report_file(report_id: int, path: str, max_bytes: int = 0):
    """ZIP 안 개별 파일 서빙 (이미지/로그 뷰어용).

    max_bytes > 0 이면 tail 만 반환 (대형 로그 뷰어 보호).
    """
    report = await db.get_bug_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="버그 리포트를 찾을 수 없습니다")
    zip_path = _bug_report_zip_path(report)

    def _read():
        with zipfile.ZipFile(zip_path) as zf:
            try:
                info = zf.getinfo(path)
            except KeyError:
                raise HTTPException(status_code=404, detail="ZIP 안에 해당 파일이 없습니다")
            data = zf.read(info)
        return data, info.file_size

    data, full_size = await asyncio.to_thread(_read)
    truncated = False
    if max_bytes and len(data) > max_bytes:
        data = data[-max_bytes:]
        truncated = True
    suffix = Path(path).suffix.lower()
    media = _ZIP_MEDIA_TYPES.get(suffix, "text/plain; charset=utf-8")
    return Response(
        content=data,
        media_type=media,
        headers={
            "Cache-Control": "private, max-age=3600",  # ZIP 은 불변이라 캐시 안전
            "X-Full-Size": str(full_size),
            "X-Truncated": "1" if truncated else "0",
        },
    )


@app.delete("/api/bug-reports/{report_id}")
async def delete_bug_report(report_id: int):
    report = await db.get_bug_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="버그 리포트를 찾을 수 없습니다")
    if report.get("file_path"):
        try:
            (_PROJECT_ROOT / report["file_path"]).unlink(missing_ok=True)
        except OSError:
            logger.warning("bug report file delete failed: %s", report["file_path"])
    await db.delete_bug_report(report_id)
    return {"status": "ok"}


# ==================== Static files (Admin Frontend) ====================

_FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

@app.get("/health")
async def health():
    return {"status": "ok"}

# SPA fallback: 모든 비-API 경로를 index.html로
if _FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(_FRONTEND_DIST / "assets")), name="static")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        file_path = _FRONTEND_DIST / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(_FRONTEND_DIST / "index.html"))
