"""Admin Server — 공지사항 관리 + 채팅 허브."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
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

# 간단 관리자 계정 (하드코딩)
ADMIN_USER = "admin"
ADMIN_PASS = "admin"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    logger.info("Admin server started — DB initialized")
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

# ==================== 공지사항 API ====================

class GuideStep(BaseModel):
    text: str = ""
    image: Optional[str] = None  # base64 data URL

class AnnouncementCreate(BaseModel):
    title: str
    content: str = ""
    priority: str = "normal"  # normal, important, urgent
    type: str = "notice"      # 'notice'(일반 공지/안내) | 'guide'(단계별 가이드)
    is_popup: int = 0         # 1이면 사용자 화면 진입 시 팝업으로 표시
    images: list[str] = []    # 일반 공지: data URL 목록(여러 장)
    steps: list[GuideStep] = []  # 가이드: 순서대로 글+이미지

class AnnouncementUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
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

@app.get("/api/announcements")
async def get_announcements(active_only: bool = False):
    return await db.list_announcements(active_only)

@app.post("/api/announcements")
async def create_announcement(req: AnnouncementCreate):
    images = req.images or []
    steps = [s.model_dump() for s in (req.steps or [])]
    ann = await db.create_announcement(
        req.title,
        req.content,
        req.priority,
        image_data=_first_image(images, steps),
        is_popup=req.is_popup,
        type=req.type,
        images=json.dumps(images, ensure_ascii=False),
        steps=json.dumps(steps, ensure_ascii=False),
    )
    # 새 공지 알림을 연결된 클라이언트에게 전파
    await _broadcast_announcement_update()
    return ann

@app.put("/api/announcements/{ann_id}")
async def update_announcement(ann_id: int, req: AnnouncementUpdate):
    data = req.model_dump(exclude_none=True)
    images = data.get("images")
    steps = data.get("steps")  # list[dict] (model_dump 변환됨)
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
