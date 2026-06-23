# ReplayKit 팝업 공지 연동 — 작업 지시서

> 이 문서는 **ReplayKit(클라이언트 앱) 측 Claude 에이전트**에게 전달하는 핸드오프 문서입니다.
> 공지/팝업 데이터는 **ReplayKit Manager(관리 서버)** 가 제공하며, ReplayKit은 이를 **읽기 전용**으로 소비합니다.

---

## 0. ⚠️ 정정 안내 (필독 — 이미지가 안 보이는 원인)

이전 초안에 있던 **`image_path` / 서버 경로 지정 방식(Part A)은 폐기**되었습니다.
ReplayKit이 `image_path`를 기다리면 이미지가 **영원히 안 나옵니다.**

| 구분 | ❌ 옛 사양(폐기) | ✅ 현재 사양 |
|---|---|---|
| 이미지 필드 | `image_path` (서버 파일 경로) | **`image_data`** (base64 data URL) |
| 이미지 표시 | `GET /images/<path>` 호출 | `<img src={image_data}>` 로 **바로** 렌더 |
| 매니저 선행작업 | Part A 필요 | **불필요** — 매니저가 이미 응답에 포함해 내려줌 |

- **매니저는 이미 `is_popup` 과 `image_data` 를 응답에 내려주고 있습니다.** 매니저 측 추가 작업 없음.
- ReplayKit 측 수정: 코드에서 **`image_path` → `image_data`** 로 바꾸고, 별도 이미지 URL 조합 없이
  data URL을 그대로 `img src`에 넣으면 됩니다.
- 두 필드가 없을 때(undefined) 안전 처리해 둔 것은 그대로 유지하면 됩니다(빈 공지/구버전 대비).
- (빌드/배포 메모) `frontend/dist`를 git에 커밋할지/패키징 빌드로 생성할지는 **ReplayKit 레포의 자체 정책**(`build_dist.py` 등)에 따르면 됩니다 — 이 매니저 문서의 범위가 아닙니다.

---

## 1. 배경 / 목적

- 관리자가 **ReplayKit Manager**(이하 *매니저*) 관리 페이지에서 공지/팝업을 작성한다. (제목·내용·우선순위·**이미지**·팝업여부)
- 작성한 공지를 **모든 ReplayKit 사용자**에게 보여줘야 한다. 사용자는 **읽기만** 가능.
- ReplayKit **시작 시 팝업 공지**가 떠야 하고, **"오늘 하루 그만 보기"** 가 동작해야 한다.

> 참고: 이미지는 관리자 화면에서 업로드되어 **base64(data URL)로 공지 데이터에 포함**되어 내려온다.
> (별도 이미지 서버 호출 불필요 — `img src`에 바로 넣으면 됨. 이전에 검토했던 "서버 경로 지정" 방식은 취소됨.)

이 작업은 **ReplayKit 클라이언트 측 구현**이다. 매니저는 이미 필요한 공개 API를 제공한다(추가 서버 변경 없음).

---

## 2. 전체 구조

```
[관리자] ──작성──▶ ReplayKit Manager (FastAPI, 포트 9000)
                       │  - 공지 DB(SQLite), 이미지는 base64로 함께 저장
                       │
        REST + WebSocket│ (읽기 전용 공개, 인증 불필요)
                       ▼
[모든 사용자] ◀── ReplayKit 클라이언트 (시작 시 팝업 + 공지 표시)
```

---

## 3. 매니저 접속 정보 (⚠️ 환경에 맞게 확정 필요)

| 항목 | 값(예시) | 비고 |
|---|---|---|
| Base URL | `http://<MANAGER_HOST>:9000` | 매니저 서버 PC의 IP. `ipconfig` IPv4 |
| 공지 목록 | `GET /api/announcements?active_only=true` | 활성 공지만 |
| 실시간 갱신 | `ws://<MANAGER_HOST>:9000/ws/announcements` | 선택(권장) |

> **확인 필요**: `<MANAGER_HOST>`(매니저 서버 주소), HTTPS 사용 여부, ReplayKit이 같은 LAN인지/방화벽.

---

## 4. API 계약

### 4.1 공지 목록

```
GET http://<MANAGER_HOST>:9000/api/announcements?active_only=true
```

응답(JSON 배열). 공지는 **두 가지 양식(`type`)** 이 있다:

**(a) 일반 공지/안내 — `type: "notice"`** (이미지 여러 장)

```json
{
  "id": 12,
  "type": "notice",
  "title": "정기 점검 안내",
  "content": "오늘 22:00 ~ 23:00 점검이 진행됩니다.\n이용에 참고 바랍니다.",
  "priority": "important",          // "normal" | "important" | "urgent"
  "active": 1,
  "is_popup": 1,                     // 1이면 시작 시 팝업으로 표시
  "images": [                        // 이미지 여러 장 (data URL 배열)
    "data:image/png;base64,iVBORw0KGgo...",
    "data:image/png;base64,iVBORw0KGgo..."
  ],
  "steps": [],
  "image_data": "data:image/png;base64,iVBORw0KGgo...",  // 하위호환: images[0]
  "created_at": "2026-06-23T01:11:15.314000+00:00",
  "updated_at": "2026-06-23T01:11:15.314000+00:00"
}
```

**(b) 단계별 가이드 — `type: "guide"`** (순서대로 글+이미지)

```json
{
  "id": 13,
  "type": "guide",
  "title": "앱 설치 방법",
  "content": "아래 순서대로 진행하세요.",   // 개요(선택)
  "priority": "normal",
  "active": 1,
  "is_popup": 1,
  "images": [],
  "steps": [                          // 순서가 곧 표시 순서
    { "text": "설치 파일을 실행합니다.", "image": "data:image/png;base64,..." },
    { "text": "'다음'을 누릅니다.",      "image": "data:image/png;base64,..." }
  ],
  "image_data": "data:image/png;base64,...",  // 하위호환: 첫 단계 이미지
  "created_at": "...",
  "updated_at": "..."
}
```

필드 요약:
- `type`: **`"notice"` | `"guide"`**. 없으면(undefined) `"notice"`로 간주.
- `content`: 본문(notice) 또는 개요(guide, 비어있을 수 있음).
- `images`: notice용 data URL **배열**(0~N장).
- `steps`: guide용 `{ text, image }` **배열**(순서 = 표시 순서). `image`는 `null` 가능.
- `image_data`: **하위호환용 단일 이미지**(첫 이미지). 구버전 클라이언트는 이것만 써도 됨.
- `is_popup`: `1`이면 시작 시 팝업 대상.
- 정렬: 활성 목록은 우선순위(긴급>중요>일반) 후 최신순.

> 모든 신규 필드는 **하위호환**된다. 예전처럼 `image_data` + `content`만 써도 동작하며,
> 양식을 제대로 표현하려면 `type`에 따라 `images`(갤러리) / `steps`(번호 단계)를 렌더하면 된다.

### 4.2 실시간 갱신 (선택, 권장)

```
WS  ws://<MANAGER_HOST>:9000/ws/announcements
```
- 연결 시 + 변경 시 서버가 푸시: `{ "type": "announcements", "announcements": [ ...위 스키마... ] }`
- 미사용 시: 시작 시 1회 fetch + 주기적(예: 5분) 폴링으로 대체.

> **CORS**: 매니저는 `allow_origins=["*"]` 이므로 웹 클라이언트의 cross-origin 호출 가능. 데스크톱/네이티브면 무관.

---

## 5. ReplayKit 측 구현 요구사항

1. **시작 시 팝업**: 앱/화면 시작 시 활성 공지를 가져와 `is_popup === 1` 인 항목을 **팝업(모달)** 으로 표시.
2. **오늘 하루 그만 보기**: 팝업에 체크박스 제공. 체크 후 닫으면 **그 공지들은 오늘(로컬 날짜) 동안 다시 표시하지 않음**.
   - 저장: 영구 저장소(웹=localStorage, 데스크톱=설정파일 등)에 `{ [공지id]: "YYYY-MM-DD" }` 형태.
   - 표시 조건: `is_popup === 1` 이고 `저장된날짜[id] !== 오늘` 인 공지만 팝업.
3. **읽기 전용**: 수정/삭제 UI 없음.
4. **양식별 렌더링** (`type`):
   - `notice`: `content` 텍스트 + `images` 배열을 **갤러리(그리드)** 로 표시. (`images`가 비면 `image_data` 폴백)
   - `guide`: `content`(개요) + `steps`를 **번호 단계**로 세로 표시. 각 단계 = 번호 + `text` + `image`.
   - 이미지는 모두 data URL이라 `img src`에 바로 넣는다. 로드 실패 시 해당 이미지 숨김.
5. **우선순위 표기**(선택): `urgent`=긴급(빨강), `important`=중요(주황), `normal`=일반(파랑).
6. (선택) **공지 목록 화면**: 활성 공지 전체를 읽기 전용으로 표시.

> 매니저의 공개 페이지 `frontend/src/pages/PublicViewPage.tsx` 의 `AnnouncementBody` 컴포넌트가
> notice/guide 양식 렌더링의 **참고 구현**이다(갤러리 그리드 + 번호 단계 뱃지).

### 5.1 팝업 로직 (의사코드 — 스택 무관)

```text
시작 시:
  list = GET /api/announcements?active_only=true
  today = 로컬 날짜 "YYYY-MM-DD"
  dismiss = 저장소에서 읽기({})          // { id: "YYYY-MM-DD" }
  popups = list.filter(a => a.is_popup == 1 && dismiss[a.id] != today)
  if popups 비어있지 않으면 팝업 표시(popups)

팝업 닫기(checked: 오늘 하루 그만 보기 여부):
  if checked:
    for p in 현재표시중 popups: dismiss[p.id] = today
    저장소에 dismiss 저장
  팝업 닫기
```

### 5.2 예시 코드 (웹/React 기준 — 다른 스택이면 동일 로직으로 포팅)

```tsx
const BASE = "http://<MANAGER_HOST>:9000";
const DISMISS_KEY = "popup_dismiss";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
const readDismiss = () => { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || "{}"); } catch { return {}; } };

async function loadPopups() {
  const res = await fetch(`${BASE}/api/announcements?active_only=true`);
  const list = await res.json();
  const t = today(), dismiss = readDismiss();
  return list.filter((a) => a.is_popup === 1 && dismiss[a.id] !== t);
}

function dismissToday(popups) {
  const d = readDismiss(), t = today();
  popups.forEach((p) => (d[p.id] = t));
  localStorage.setItem(DISMISS_KEY, JSON.stringify(d));
}

// 이미지 렌더링: image_data 는 data URL 이므로 그대로 사용
// {a.image_data ? <img src={a.image_data} style={{maxWidth:"100%"}} /> : null}
```

> 매니저의 공개 페이지(`/view`)에 동일 동작이 이미 구현되어 있으니
> `frontend/src/pages/PublicViewPage.tsx` 를 참고 구현으로 활용할 수 있다.

---

## 6. 테스트 체크리스트

- [ ] 시작 시 `is_popup` 공지가 팝업으로 표시
- [ ] "오늘 하루 그만 보기" 체크 후 닫으면 같은 날 재표시 안 됨 / 다음 날 다시 표시
- [ ] 이미지(`image_data`)가 인라인 표시, 실패 시 텍스트만
- [ ] 비팝업 공지는 팝업으로 뜨지 않음(목록 화면 구현 시 거기 표시)
- [ ] (선택) WebSocket 갱신 시 화면 반영

---

## 7. 확인 필요 (열린 질문)

1. **매니저 서버 주소**(`<MANAGER_HOST>`)와 포트, HTTPS 여부.
2. **ReplayKit 기술 스택**(웹/Electron/네이티브 등) — "오늘 하루 그만 보기" 영구 저장 위치 결정에 필요.
3. 팝업이 여러 개일 때 **하나의 모달에 묶어 표시** vs **순차 표시** 선호.
4. 이미지 용량 정책 — 매니저는 현재 업로드 2MB 제한, base64로 응답에 포함됨(공지 많고 이미지 크면 응답 커짐). 필요 시 정책 합의.
