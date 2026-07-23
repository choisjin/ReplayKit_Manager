"""테스트 PC(에이전트) 관제 — 실시간 라이브 상태 레지스트리 + PC 간 함수통계 집계.

ReplayKit 각 PC 의 MonitorClient 가 /ws/client 로 연결해 2초마다 status_update 를 보낸다.
- 라이브 상태(온라인 여부, 현재 재생 시나리오/그룹, 디바이스, 회차, pass/fail/error)는
  이 모듈의 인메모리 레지스트리에 보관한다(서버 재시작 시 초기화 — 에이전트가 재연결하면 복구).
- 모듈/함수 사용통계 스냅샷은 database.agent_usage 에 별도 영속화(서버 재시작해도 유지).

식별 키는 **머신 UID**(하드웨어 기반, 부품 교체 전 불변). IP 는 표시용으로만 저장한다.
"""

from __future__ import annotations

from datetime import datetime, timezone

# 마지막 보고 후 이 시간(초)이 지나면 WS 가 살아있어도 오프라인으로 간주.
# 재생 중 이벤트 루프가 잠깐 바빠 status_update 가 지연돼도 오프라인으로 깜빡이지 않도록 넉넉히.
# (2초 주기 보고 기준 20여 회 누락까지 허용. 진짜 다운은 WS 끊김으로 즉시 오프라인 처리됨)
OFFLINE_AFTER_SEC = 45.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _derive_os(devices: list | None) -> str:
    """기본 디바이스의 OS 별 차이로 OS 를 추정한다 (에이전트가 시스템 정보를 보내지 않음).

    ReplayKit 이 자동 등록하는 두 디바이스가 OS 에 따라 다르게 잡힌다:
      1) Common 디바이스의 모듈 — Windows=CMD, Linux=SHELL
      2) 창 제어 디바이스의 표시명 — Windows="WinControl", Linux="LinuxControl"
         (device_id/type 은 OS 공통으로 "WinControl"/"wincontrol" 고정, 표시명만 갈림)
    둘 중 먼저 확인되는 신호를 쓴다. 판별 불가면 빈 문자열(표기 생략).
    """
    for d in devices or []:
        d = d or {}
        module = str(d.get("module") or "").upper()
        if module == "SHELL":
            return "Linux"
        if module == "CMD":
            return "Windows"
        name = str(d.get("name") or "")
        if name == "LinuxControl":
            return "Linux"
        if name == "WinControl":
            return "Windows"
    return ""


class AgentRegistry:
    """머신 UID → 라이브 상태(dict) 인메모리 레지스트리."""

    def __init__(self):
        self._agents: dict[str, dict] = {}
        self._seq = 0   # 최초 등록 순번 — 카드 정렬을 '연결 순서'로 고정하는 데 쓴다

    def _ensure(self, client_id: str) -> dict:
        """에이전트 항목을 얻거나 새로 만든다. 최초 생성 시 연결 순번(seq)을 부여한다.

        seq 는 한 번 정해지면 바뀌지 않으므로, 온라인/오프라인 전환이나 이름 변경으로
        대시보드 카드 순서가 뒤바뀌지 않는다(사용자가 위치를 기억할 수 있게).
        """
        st = self._agents.get(client_id)
        if st is None:
            self._seq += 1
            st = {"client_id": client_id, "seq": self._seq}
            self._agents[client_id] = st
        return st

    # ---- 갱신 ----

    def register(self, client_id: str, *, name: str, ip: str, version: str) -> None:
        st = self._ensure(client_id)
        st.update({
            "client_id": client_id,
            "name": name or st.get("name", ""),
            "ip": ip or st.get("ip", ""),
            "version": version or st.get("version", ""),
            "connected": True,
            "last_seen": _now_iso(),
            "registered_at": st.get("registered_at") or _now_iso(),
        })

    def update_status(self, client_id: str, msg: dict, ip: str) -> None:
        st = self._ensure(client_id)
        st["name"] = msg.get("name") or st.get("name", "")
        st["version"] = msg.get("version") or st.get("version", "")
        if ip:
            st["ip"] = ip
        st["connected"] = True
        st["last_seen"] = _now_iso()
        st["activity"] = msg.get("activity", "idle")
        st["devices"] = msg.get("devices", []) or []
        st["playback"] = msg.get("playback")  # None 이면 재생 안 함
        st["scenario_count"] = len(msg.get("scenarios", []) or [])
        # 현재 UI 모드(#test/#admin/#stats/normal)와 페이지. 브라우저가 닫혀 있으면 빈 값.
        st["ui"] = msg.get("ui") or {}
        # usage_stats 는 값이 바뀌었을 때만(약 60초 주기) 전송된다 — 대역폭 절감.
        # 키가 아예 없으면 "변경 없음"이므로 **마지막 값을 그대로 유지**한다.
        # (msg.get() 으로 덮어쓰면 매 tick None 이 되어 함수통계가 사라진다)
        if "usage_stats" in msg:
            st["usage_stats"] = msg["usage_stats"]
        # 로그인 사용자 {user_id, name, title, team, project}. 키가 있을 때만 반영 —
        # None(로그아웃/미로그인)도 유효한 값이므로 usage_stats 와 달리 그대로 덮어쓴다.
        if "user" in msg:
            st["user"] = msg.get("user") or None

    def mark_offline(self, client_id: str) -> None:
        st = self._agents.get(client_id)
        if st:
            st["connected"] = False

    def remove(self, client_id: str) -> bool:
        """레지스트리에서 에이전트를 제거한다 (오래된/중복 카드 정리용).

        지운 뒤에도 해당 PC 가 다시 접속하면 register 로 자동 재등록되므로 안전하다.
        머신 UID 가 바뀌어(예: OS 재설치, 식별자 소스 변경) 같은 PC 가 두 개로 보일 때 사용.
        """
        return self._agents.pop(client_id, None) is not None

    # ---- 조회 ----

    def _is_online(self, st: dict) -> bool:
        if not st.get("connected"):
            return False
        seen = _parse_iso(st.get("last_seen"))
        if not seen:
            return False
        age = (datetime.now(timezone.utc) - seen).total_seconds()
        return age <= OFFLINE_AFTER_SEC

    def _public_view(self, st: dict) -> dict:
        """대시보드 카드용 경량 뷰 (무거운 usage_stats 제외)."""
        pb = st.get("playback")
        ui = st.get("ui") or {}
        all_devices = st.get("devices", []) or []

        # #test 모드에서만 UI 에 노출되는 실험 모듈(test_only)은 관제에서도 같은 규칙을 따른다 —
        # 사용자 화면엔 없는 모듈을 관제에만 띄우면 실제 구성과 어긋나 보이기 때문.
        # 모드를 모를 때(브라우저 미접속 등)도 일반 모드와 동일하게 숨긴다.
        if (ui.get("mode") or "") == "test":
            devices = all_devices
        else:
            devices = [d for d in all_devices if not (d or {}).get("test_only")]

        return {
            "client_id": st.get("client_id"),
            "seq": st.get("seq") or 0,   # 연결 순서 (카드 정렬 고정용)
            "name": st.get("name", ""),
            "ip": st.get("ip", ""),
            "version": st.get("version", ""),
            # OS 는 에이전트가 보고하지 않는다 — Common 디바이스 모듈(CMD/SHELL)로 추정.
            # (필터 전 전체 목록으로 판별 — 실험 모듈 숨김과 무관하게 항상 동일한 결과)
            "os": _derive_os(all_devices),
            "online": self._is_online(st),
            "last_seen": st.get("last_seen"),
            "activity": st.get("activity", "idle"),
            "devices": devices,
            "device_count": len(devices),
            "connected_device_count": sum(
                1 for d in devices if d.get("status") == "connected"
            ),
            "playback": pb,
            "scenario_count": st.get("scenario_count", 0),
            "ui": ui,   # {mode, page} — 빈 값이면 브라우저 미접속
            # 로그인 사용자(부서/프로젝트 포함). None = 미로그인.
            "user": st.get("user") or None,
        }

    def get_all(self) -> list[dict]:
        """전체 에이전트를 **연결 순서(seq)** 로 반환한다.

        온라인 여부로 정렬하면 PC 가 접속/해제될 때마다 카드가 튀어 보기 어렵다.
        활성/비활성 구분은 프론트가 섹션으로 나눠 표시하고, 각 섹션 내 순서는 이 seq 를 따른다.
        """
        views = [self._public_view(st) for st in self._agents.values()]
        views.sort(key=lambda v: v.get("seq") or 0)
        return views

    def get_one(self, client_id: str) -> dict | None:
        st = self._agents.get(client_id)
        if not st:
            return None
        v = self._public_view(st)
        v["usage_stats"] = st.get("usage_stats")
        return v

    def sample_states(self) -> list[tuple[str, str]]:
        """지금 이 순간 전 PC 의 (client_id, state) — 상태 시계열 1 tick.

        state 는 프론트 agentState.ts 의 StateKey 와 **같은 값**이어야 한다
        (그래프 색·라벨을 프론트가 그 표로 그린다). 규칙도 동일:
        오프라인 > 재생중(일시정지 분리) > 녹화중 > 사용중 > 대기.
        """
        out: list[tuple[str, str]] = []
        for st in self._agents.values():
            cid = st.get("client_id") or ""
            if not cid:
                continue
            if not self._is_online(st):
                state = "offline"
            else:
                act = st.get("activity", "idle")
                if act == "playing":
                    pb = st.get("playback") or {}
                    state = "paused" if pb.get("status") == "paused" else "playing"
                elif act in ("recording", "in_use"):
                    state = act
                else:
                    state = "idle"
            out.append((cid, state))
        return out

    def names(self) -> dict[str, str]:
        """client_id → 호스트명 (그래프의 PC별 표시용)."""
        return {st.get("client_id", ""): st.get("name", "") for st in self._agents.values()}

    def users(self) -> dict[str, dict]:
        """client_id → 로그인 사용자 dict (라이브 값 — DB 스냅샷보다 우선)."""
        return {
            st.get("client_id", ""): st["user"]
            for st in self._agents.values()
            if st.get("user")
        }

    def summary(self) -> dict:
        views = self.get_all()
        online = [v for v in views if v["online"]]
        return {
            "total": len(views),
            "online": len(online),
            "playing": sum(1 for v in online if v["activity"] == "playing"),
            "recording": sum(1 for v in online if v["activity"] == "recording"),
        }

    # ---- PC 간 함수통계 집계 ----

    def aggregate_function_stats(self, extra_snapshots: list[dict] | None = None) -> dict:
        """온라인/보고된 PC 들의 usage_stats 를 합산해 PC 간 함수 사용통계를 만든다.

        extra_snapshots: DB 에 저장된 오프라인 PC 스냅샷(list_agent_usage 결과)도 포함하려면 전달.
        각 항목은 {"client_id","host","usage_stats"} 형태.
        반환: 모듈/함수별 총 사용횟수 + 사용한 PC 목록 + 전 PC 미사용(fleet_unused).
        """
        # (module) -> {count, hosts:set, functions:{fn:{count, hosts:set}}}
        modules: dict[str, dict] = {}
        available: set[tuple[str, str]] = set()  # (module, function) 가용 카탈로그 합집합
        step_types: dict[str, int] = {}
        contributors: dict[str, str] = {}  # client_id -> host (집계에 기여한 PC)

        def _ingest(client_id: str, host: str, us: dict | None):
            if not us:
                return
            contributors[client_id] = host or client_id
            for s in us.get("step_types", []):
                step_types[s["type"]] = step_types.get(s["type"], 0) + s.get("count", 0)
            for m in us.get("modules", []):
                mod = m.get("module", "")
                mm = modules.setdefault(mod, {"count": 0, "hosts": set(), "functions": {}})
                for f in m.get("functions", []):
                    fn = f.get("function", "")
                    available.add((mod, fn))
                    cnt = f.get("count", 0)
                    mm["count"] += cnt
                    mm["hosts"].add(host or client_id)
                    ff = mm["functions"].setdefault(fn, {"count": 0, "hosts": set()})
                    ff["count"] += cnt
                    ff["hosts"].add(host or client_id)
            for u in us.get("unused_functions", []):
                available.add((u.get("module", ""), u.get("function", "")))

        # 라이브(온라인) 우선
        seen_ids: set[str] = set()
        for st in self._agents.values():
            cid = st.get("client_id", "")
            seen_ids.add(cid)
            _ingest(cid, st.get("name", ""), st.get("usage_stats"))
        # DB 스냅샷 중 라이브에 없는 PC 만 보강
        for snap in (extra_snapshots or []):
            cid = snap.get("client_id", "")
            if cid in seen_ids:
                continue
            _ingest(cid, snap.get("host", ""), snap.get("usage_stats"))

        # fleet_unused = 가용 카탈로그 중 어떤 PC 에서도 count>0 이 없는 함수
        used_keys = {(mod, fn) for mod, mm in modules.items() for fn in mm["functions"]}
        fleet_unused = sorted(available - used_keys)

        modules_out = []
        for mod, mm in modules.items():
            funcs_out = sorted(
                [
                    {"function": fn, "count": fv["count"], "pc_count": len(fv["hosts"]),
                     "hosts": sorted(fv["hosts"])}
                    for fn, fv in mm["functions"].items()
                ],
                key=lambda x: x["count"], reverse=True,
            )
            modules_out.append({
                "module": mod,
                "count": mm["count"],
                "pc_count": len(mm["hosts"]),
                "function_count": len(funcs_out),
                "functions": funcs_out,
            })
        modules_out.sort(key=lambda x: x["count"], reverse=True)

        step_types_out = sorted(
            [{"type": t, "count": c} for t, c in step_types.items()],
            key=lambda x: x["count"], reverse=True,
        )

        return {
            "generated_at": _now_iso(),
            "contributor_count": len(contributors),
            "contributors": [{"client_id": k, "host": v} for k, v in contributors.items()],
            "step_types": step_types_out,
            "modules": modules_out,
            "fleet_unused": [{"module": m, "function": f} for m, f in fleet_unused],
            "available_function_count": len(available),
            "used_function_count": len(used_keys),
        }


# 프로세스 전역 싱글톤
registry = AgentRegistry()
