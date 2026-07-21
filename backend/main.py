"""Admin Server — 공지사항 관리 + 채팅 허브."""

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
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
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
    yield

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

# ==================== 채팅 API ====================

@app.get("/api/chat/rooms")
async def get_chat_rooms():
    return await db.list_chat_rooms()

@app.get("/api/chat/rooms/{room_id}/messages")
async def get_room_messages(room_id: str):
    return await db.get_messages(room_id)

@app.delete("/api/chat/rooms/{room_id}")
async def delete_room(room_id: str):
    # 연결된 유저에게 종료 알림
    if room_id in user_connections:
        ws = user_connections[room_id]
        try:
            await ws.send_json({"type": "closed", "message": "채팅이 삭제되었습니다."})
        except Exception:
            pass
    ok = await db.delete_chat_room(room_id)
    if not ok:
        raise HTTPException(status_code=404, detail="채팅방을 찾을 수 없습니다")
    await _notify_admins_room_update()
    return {"status": "ok"}

@app.post("/api/chat/rooms/{room_id}/close")
async def close_room(room_id: str):
    await db.close_chat_room(room_id)
    # 해당 방의 유저에게 종료 알림
    if room_id in user_connections:
        ws = user_connections[room_id]
        try:
            await ws.send_json({"type": "closed", "message": "관리자가 채팅을 종료했습니다."})
        except Exception:
            pass
    await _notify_admins_room_update()
    return {"status": "ok"}

# ==================== WebSocket 채팅 허브 ====================

# 유저 연결: room_id -> WebSocket
user_connections: dict[str, WebSocket] = {}
# 관리자 연결: set of WebSocket
admin_connections: set[WebSocket] = set()
# 관리자가 현재 보고 있는 방: WebSocket -> room_id
admin_active_room: dict[WebSocket, str] = {}


async def _broadcast_announcement_update():
    """공지사항 변경 시 연결된 모든 유저 클라이언트에 알림."""
    announcements = await db.list_announcements(active_only=True)
    msg = json.dumps({"type": "announcements_updated", "announcements": announcements})
    # 유저 연결에 전송
    for ws in list(user_connections.values()):
        try:
            await ws.send_text(msg)
        except Exception:
            pass


async def _notify_admins_room_update():
    """관리자들에게 채팅방 목록 갱신 알림."""
    rooms = await db.list_chat_rooms()
    msg = json.dumps({"type": "room_list", "rooms": rooms})
    for ws in list(admin_connections):
        try:
            await ws.send_text(msg)
        except Exception:
            admin_connections.discard(ws)


async def _notify_admins_message(room_id: str, message: dict):
    """관리자들에게 새 메시지 알림."""
    msg = json.dumps({"type": "new_message", "room_id": room_id, "message": message})
    for ws in list(admin_connections):
        try:
            await ws.send_text(msg)
        except Exception:
            admin_connections.discard(ws)


@app.websocket("/ws/chat")
async def ws_chat_user(ws: WebSocket):
    """유저 채팅 WebSocket.

    프로토콜:
    1. 유저 → {type: "join", name: "이름", department: "부서"}
    2. 서버 → {type: "joined", room_id: "..."}
    3. 유저 ↔ 서버: {type: "message", content: "..."}
    """
    await ws.accept()
    room_id = None
    try:
        # 첫 메시지: join
        raw = await ws.receive_text()
        data = json.loads(raw)
        if data.get("type") != "join" or not data.get("name") or not data.get("department"):
            await ws.send_json({"type": "error", "message": "이름과 부서를 입력해주세요."})
            await ws.close()
            return

        room_id = str(uuid.uuid4())[:8]
        room = await db.create_chat_room(room_id, data["name"], data["department"])
        user_connections[room_id] = ws

        await ws.send_json({"type": "joined", "room_id": room_id})
        logger.info("Chat room created: %s (%s / %s)", room_id, data["name"], data["department"])

        # 관리자에게 새 방 알림
        await _notify_admins_room_update()

        # 메시지 루프
        while True:
            raw = await ws.receive_text()
            msg_data = json.loads(raw)

            if msg_data.get("type") == "message" and msg_data.get("content"):
                saved = await db.add_message(room_id, "user", msg_data["content"])
                await _notify_admins_message(room_id, {**saved, "user_name": data["name"]})
                # 읽은 admin이 있으면 unread 리셋하지 않음
            elif msg_data.get("type") == "typing":
                # 타이핑 알림 → 해당 방을 보고있는 관리자에게
                for admin_ws, active_room in admin_active_room.items():
                    if active_room == room_id:
                        try:
                            await admin_ws.send_json({"type": "user_typing", "room_id": room_id})
                        except Exception:
                            pass

    except WebSocketDisconnect:
        logger.info("User disconnected from room %s", room_id)
    except Exception as e:
        logger.error("User WS error: %s", e)
    finally:
        if room_id:
            user_connections.pop(room_id, None)
            # 관리자에게 연결 해제 알림
            for admin_ws in list(admin_connections):
                try:
                    await admin_ws.send_json({"type": "user_disconnected", "room_id": room_id})
                except Exception:
                    pass


@app.websocket("/ws/admin/chat")
async def ws_chat_admin(ws: WebSocket):
    """관리자 채팅 WebSocket.

    프로토콜:
    - 서버 → {type: "room_list", rooms: [...]}
    - 서버 → {type: "new_message", room_id, message}
    - 관리자 → {type: "join_room", room_id} (방 선택)
    - 관리자 → {type: "message", room_id, content}
    - 관리자 → {type: "typing", room_id}
    """
    await ws.accept()
    admin_connections.add(ws)
    logger.info("Admin connected to chat hub")

    try:
        # 초기 방 목록 전송
        rooms = await db.list_chat_rooms()
        await ws.send_json({"type": "room_list", "rooms": rooms})

        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)

            if data.get("type") == "join_room":
                room_id = data.get("room_id", "")
                admin_active_room[ws] = room_id
                # unread 리셋
                await db.update_room_unread(room_id, 0)
                # 메시지 히스토리 전송
                messages = await db.get_messages(room_id)
                await ws.send_json({"type": "room_messages", "room_id": room_id, "messages": messages})
                # 방 목록 갱신 (unread 변경 반영)
                await _notify_admins_room_update()

            elif data.get("type") == "message":
                room_id = data.get("room_id", "")
                content = data.get("content", "")
                if room_id and content:
                    saved = await db.add_message(room_id, "admin", content)
                    # 유저에게 전달
                    if room_id in user_connections:
                        try:
                            await user_connections[room_id].send_json({
                                "type": "message",
                                "from": "admin",
                                "content": content,
                                "created_at": saved["created_at"],
                            })
                        except Exception:
                            pass
                    # 다른 관리자에게도 전달
                    for other_ws in admin_connections:
                        if other_ws != ws:
                            try:
                                await other_ws.send_json({"type": "new_message", "room_id": room_id, "message": saved})
                            except Exception:
                                pass

            elif data.get("type") == "typing":
                room_id = data.get("room_id", "")
                if room_id and room_id in user_connections:
                    try:
                        await user_connections[room_id].send_json({"type": "admin_typing"})
                    except Exception:
                        pass

    except WebSocketDisconnect:
        logger.info("Admin disconnected from chat hub")
    except Exception as e:
        logger.error("Admin WS error: %s", e)
    finally:
        admin_connections.discard(ws)
        admin_active_room.pop(ws, None)


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


# 공지사항 브로드캐스트 (announcement_subscribers에도 전송)
_original_broadcast = _broadcast_announcement_update
async def _broadcast_announcement_update():
    announcements = await db.list_announcements(active_only=True)
    msg = json.dumps({"type": "announcements", "announcements": announcements})
    for ws in list(announcement_subscribers):
        try:
            await ws.send_text(msg)
        except Exception:
            announcement_subscribers.discard(ws)
    # 채팅 유저 연결에도 전송
    for ws in list(user_connections.values()):
        try:
            await ws.send_text(msg)
        except Exception:
            pass


# ==================== 테스트 PC 관제 (에이전트) ====================
# ReplayKit 각 PC 의 MonitorClient 가 /ws/client 로 연결해 2초마다 status_update 를 보낸다.
# 라이브 상태는 agents.registry(메모리), 함수통계 스냅샷은 db.agent_usage(영속).

from . import agents

# PC별 마지막으로 DB 에 저장한 usage generated_at — 매 2초 write 부하 방지용 스로틀.
_last_usage_gen: dict[str, str] = {}


@app.get("/api/agents")
async def api_agents():
    """관제 대상 테스트 PC 목록(라이브 상태)."""
    return {"agents": agents.registry.get_all(), "summary": agents.registry.summary()}


@app.get("/api/agents/function-stats")
async def api_agents_function_stats():
    """모든 PC 의 모듈/함수 사용통계 집계 (오프라인 PC 는 DB 스냅샷으로 보강)."""
    snapshots = await db.list_agent_usage()
    return agents.registry.aggregate_function_stats(extra_snapshots=snapshots)


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
