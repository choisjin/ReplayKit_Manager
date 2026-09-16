import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Col, Empty, Modal, Progress, Row, Segmented, Select, Statistic, Table, Tag, theme, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, DesktopOutlined, PlayCircleOutlined, SortAscendingOutlined, UserOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { agentApi } from '../services/api';
import { STATE, StateKey, stateOf, tint } from '../lib/agentState';
import { StateLegend } from '../components/StackedBars';

interface DeviceInfo {
  device_id: string; name: string; module?: string; device_model?: string;
  category?: string; type: string; status: string; raw_status?: string;
  test_only?: boolean;   // #test 모드에서만 UI 에 노출되는 실험 모듈
}
interface UiState { mode?: string; page?: string; }

// UI 모드 — ReplayKit 의 URL hash 게이트. 모드마다 노출되는 모듈이 다르다.
const MODE_LABEL: Record<string, string> = {
  test: '#test', admin: '#admin', stats: '#stats', normal: '일반',
};
// 표에서는 태그 대신 **글자색**으로만 모드를 구분한다 (태그를 쓰면 행 높이가 커진다).
// 색은 [라이트, 다크] 두 벌 — 한 색으로 맞추면 반드시 한쪽 테마에서 배경에 묻힌다.
type Duo = readonly [light: string, dark: string];
const MODE_COLOR: Record<string, Duo> = {
  test: ['#722ed1', '#b37feb'], admin: ['#d46b08', '#ffa940'],
  stats: ['#08979c', '#36cfc9'], normal: ['', ''],
};
// 프로젝트/OS 강조색도 같은 규칙.
const ACCENT: Record<string, Duo> = {
  project: ['#1677ff', '#4096ff'],
  Linux: ['#ad6800', '#d89614'],
  Windows: ['#2f54eb', '#597ef7'],
};
// 현재 보고 있는 페이지 (App.tsx 의 activeKey)
const PAGE_LABEL: Record<string, string> = {
  '/': '디바이스', '/record': '녹화', '/scenarios': '시나리오', '/results': '결과',
  '/settings': '설정', '/changelog': '변경이력', '/admin': '관리자', '/stats': '통계',
};

/** 디바이스 표시명.
 *  - auxiliary(모듈·시리얼): 연결된 **모듈명**(CMD·SHELL·OCR·Frame_Check…).
 *    Common/OCR/Frame_Check 는 name 이 전부 "Common" 이라 구분이 안 되기 때문.
 *    모듈이 없는 auxiliary(WinControl 등)는 **name** 을 쓴다 — device_id 는 OS 공통으로
 *    "WinControl" 로 고정돼 있고 표시명만 OS 별로 갈리기 때문(Linux=LinuxControl).
 *  - primary(ADB 등 물리 디바이스): **모델 기준 이름**(device_id, 예: "Europe_New_1").
 *    dev.name 은 ADB 가 보고한 모델명(예: "AIVI2_N_FULL")이라 카탈로그 모델과 달라 혼동된다. */
function deviceLabel(d: DeviceInfo): string {
  if (d.category === 'auxiliary') return d.module || d.name || d.device_id;
  return d.device_id || d.device_model || d.name;
}
interface Playback {
  scenario_name: string;
  current_cycle: number;
  total_cycles: number;
  current_step: number;
  total_steps: number;
  status: string;
  passed: number;
  failed: number;
  warning: number;
  error: number;
  error_message?: string;
}
// 로그인(사용자 식별) — ReplayKit 에서 선택한 사용자. null = 미로그인.
interface AgentUser {
  user_id: string;
  name: string;
  title: string;
  team: string;      // 부서/팀
  project: string;   // 카탈로그 프로젝트 (HKMC / VW 등)
  model?: string;    // 카탈로그 모델 (선택)
}
interface Agent {
  client_id: string;
  name: string;
  ip: string;
  version: string;
  os: string;          // "Linux" | "Windows" | "" — Common 모듈(SHELL/CMD)로 매니저가 추정
  online: boolean;
  last_seen: string;
  activity: string;
  devices: DeviceInfo[];
  device_count: number;
  connected_device_count: number;
  playback: Playback | null;
  scenario_count: number;
  ui?: UiState;
  user?: AgentUser | null;
}
interface Summary { total: number; online: number; playing: number; recording: number; }

// 상태(색·라벨·순서) 정의는 lib/agentState.ts 한 곳 — 사용량 그래프와 공유한다.

// ── 정렬 ──
// 관제 표는 **행 위치가 흔들리지 않는 것**이 가장 중요하다 — 2초 폴링마다 행이 자리를 옮기면
// 보고 있던 PC 를 매번 다시 찾아야 한다. 그래서 어떤 정렬을 골라도 행은 제자리에 있고
// 접속이 끊겨도 목록에서 빠지지 않는다 — **상태만 '오프라인' 으로 바뀐다**.
// 그래서 **어떤 정렬을 골라도 순서는 한 번 세우고 얼린다**. 폴링마다 다시 정렬하면,
// 에이전트가 사용자/부서 정보를 한 tick 비워 보내는 것만으로도 행이 미로그인 그룹으로
// 내려갔다 올라온다. 저절로 순서가 바뀌는 건 **새 PC 가 처음 목록에 들어올 때뿐**이고
// (정렬 규칙에 맞는 자리에 끼워 넣는다), 그 밖에는 정렬 기준을 바꾸거나 '재정렬' 을
// 누를 때만 다시 세운다.
type SortKey = 'team' | 'project' | 'name' | 'state';
// v3 — 기본 정렬이 '부서 → 프로젝트 → 사용자이름' 으로 바뀌었다. 예전 키에 저장된 선택을
// 물려받으면 기본값이 적용되지 않으므로 키를 올려 처음부터 다시 시작한다.
const SORT_KEY = 'fleet_sort_v3';
const DEFAULT_SORT: SortKey = 'team';
const SORT_OPTIONS = [
  { label: '부서순', value: 'team' },        // 부서 → 프로젝트 → 사용자이름 (기본)
  { label: '프로젝트순', value: 'project' },  // 프로젝트 → 부서 → 사용자이름
  { label: 'PC 이름순', value: 'name' },
  { label: '상태순', value: 'state' },
];
const SORT_KEYS: SortKey[] = ['team', 'project', 'name', 'state'];

/** antd 다크 알고리즘이 켜져 있는지 — ConfigProvider 에 직접 묻는 API 가 없어
 *  컨테이너 배경색의 밝기로 판단한다. (라이트 #ffffff / 다크 #141414) */
function isDarkBg(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) < 128;
}

function agentName(a: Agent): string {
  return a.name || a.client_id;
}

/** 부서/프로젝트/사용자 정렬 키 — 값이 없으면(미로그인) 맨 뒤로 보낸다. */
function groupKey(v: string | undefined): string {
  return v ? `0${v}` : '1';
}

/** 최종 tie-break — 같은 부서·프로젝트·사용자라도 순서가 흔들리면 안 되므로
 *  마지막엔 항상 PC 이름(없으면 머신 UID)으로 못박는다. */
function tieBreak(x: Agent, y: Agent): number {
  return agentName(x).localeCompare(agentName(y));
}

/** 필터 Select 를 내용(가장 긴 옵션/placeholder)에 맞춰 폭 계산.
 *  고정폭이면 긴 부서명이 잘리므로, 글자 수 기반으로 폭을 잡고 너무 길면 상한을 둔다.
 *  (한글은 소형 폰트에서 대략 13px/자, 화살표·clear·좌우패딩에 약 52px 여유) */
function fitSelectWidth(options: string[], placeholder: string): number {
  const longest = Math.max(placeholder.length, ...options.map(o => o.length), 0);
  return Math.min(340, Math.max(96, longest * 13 + 52));
}

/** 정렬 규칙 — 줄을 세울 때와 **새 PC 를 끼워 넣을 때** 같은 함수를 쓴다. */
function comparatorFor(sort: SortKey): (x: Agent, y: Agent) => number {
  if (sort === 'team') {
    // 기본 정렬 — 부서 → 프로젝트 → 사용자이름. 같은 팀 사람들이 붙어 보이고,
    // 그 안에서 프로젝트별로 묶이며, 마지막으로 담당자 이름순.
    return (x, y) =>
      groupKey(x.user?.team).localeCompare(groupKey(y.user?.team)) ||
      groupKey(x.user?.project).localeCompare(groupKey(y.user?.project)) ||
      groupKey(x.user?.name).localeCompare(groupKey(y.user?.name)) ||
      tieBreak(x, y);
  }
  if (sort === 'project') {
    // 프로젝트 우선 — 그다음은 기본 정렬과 같은 순서(부서 → 사용자이름).
    return (x, y) =>
      groupKey(x.user?.project).localeCompare(groupKey(y.user?.project)) ||
      groupKey(x.user?.team).localeCompare(groupKey(y.user?.team)) ||
      groupKey(x.user?.name).localeCompare(groupKey(y.user?.name)) ||
      tieBreak(x, y);
  }
  if (sort === 'state') {
    // 상태가 같으면 이름순 — 같은 상태 안에서는 순서가 흔들리지 않는다.
    return (x, y) => STATE[stateOf(x)].order - STATE[stateOf(y)].order || tieBreak(x, y);
  }
  return tieBreak;
}

function sortAgents(list: Agent[], sort: SortKey): Agent[] {
  return [...list].sort(comparatorFor(sort));
}

/** 관제 표 전용 CSS — antd small 테이블보다 행 높이·글자를 더 줄이고 격자를 살려,
 *  한 화면에 수십 대가 들어오는 '벤치 모니터' 밀도를 만든다.
 *  틴트는 rgba 라 라이트/다크 어느 테마 위에 얹혀도 글자가 묻히지 않는다. */
const TABLE_CSS = `
.fleet-table .ant-table { font-size: 11px; }
.fleet-table .ant-table-thead > tr > th {
  padding: 4px 6px !important;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}
.fleet-table .ant-table-thead > tr > th::before { display: none !important; }
.fleet-table .ant-table-tbody > tr > td {
  padding: 2px 6px !important;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
/* 상태 틴트 — onRow 에서 행마다 --fleet-tint 로 색을 넘긴다 */
.fleet-table .ant-table-tbody > tr.fleet-tinted > td { background: var(--fleet-tint); }
/* 오프라인 행은 자리를 지킨 채 흐려지기만 한다 (목록에서 빠지거나 아래로 내려가지 않음) */
.fleet-table .ant-table-tbody > tr.fleet-off > td { opacity: 0.45; }
`;

// 툴팁 안 디바이스 목록용 미니 태그 (표 본문은 태그 없이 글자만 — 행 높이를 키우지 않으려고)
const MINI_TAG: React.CSSProperties = {
  fontSize: 10, margin: 0, padding: '0 5px', lineHeight: '17px',
};

// ── hover 상세 (표에는 핵심 값만, 상세는 전부 툴팁으로) ──
function hostTooltip(a: Agent) {
  return (
    <div style={{ fontSize: 11, lineHeight: 1.7 }}>
      <div><b>{a.name || a.client_id}</b></div>
      <div>IP {a.ip || '-'}</div>
      <div>머신 UID {a.client_id}</div>
      {a.version && <div>버전 {a.version}</div>}
      <div>{a.online ? '온라인' : `오프라인 · ${relTime(a.last_seen)}`}</div>
    </div>
  );
}

function deviceTooltip(a: Agent) {
  return (
    <div style={{ maxWidth: 300, fontSize: 11 }}>
      <div style={{ marginBottom: 4 }}>
        디바이스 <b>{a.connected_device_count}/{a.device_count}</b> 연결
      </div>
      {a.devices.length === 0 ? (
        <div style={{ opacity: 0.7 }}>등록된 디바이스 없음</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {a.devices.map(d => (
            <Tag
              key={d.device_id}
              color={d.test_only ? 'purple' : (d.status === 'connected' ? 'green' : 'default')}
              style={{
                ...MINI_TAG,
                borderStyle: d.test_only ? 'dashed' : undefined,
                opacity: d.status === 'connected' ? 1 : 0.55,
              }}
            >
              {deviceLabel(d)}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
}

function userTooltip(a: Agent) {
  const u = a.user;
  if (!u) return '미로그인 — ReplayKit 웹에서 사용자를 선택하지 않았습니다';
  return (
    <div style={{ fontSize: 11, lineHeight: 1.7 }}>
      <div><b>{u.name}</b>{u.title ? ` ${u.title}` : ''}</div>
      {u.team && <div>부서 {u.team}</div>}
      {u.project && <div>프로젝트 {u.project}{u.model ? ` · ${u.model}` : ''}</div>}
    </div>
  );
}

function modeTooltip(a: Agent) {
  const mode = a.ui?.mode || '';
  const page = a.ui?.page || '';
  return (
    <div style={{ fontSize: 11, lineHeight: 1.7 }}>
      <div>모드 <b>{MODE_LABEL[mode] || mode}</b></div>
      {page && <div>화면 {PAGE_LABEL[page] || page}</div>}
      {mode === 'test' && <div style={{ opacity: 0.8 }}>#test — 실험 모듈이 추가로 노출됨</div>}
    </div>
  );
}

/** 재생 진행률(0~100) + 총량을 아는지 여부.
 *
 *  ⚠️ 회차만으로 계산하면 안 된다 — current_cycle 은 1-based 라 1회 재생(1/1)은 시작하자마자
 *  100% 가 되고, antd Progress 는 100% 를 '완료(초록)' 로 칠해 늘 초록 막대로 보인다.
 *  실제로 보고 싶은 건 "지금 어디까지 왔나" 이므로 **회차 + 그 회차 안의 스텝**을 합쳐 쓴다.
 *
 *      진행률 = (완료한 회차 + 현재 회차의 스텝 진행분) / 총 회차
 *
 *  · current_step 은 step_start 에서 올라가는 **진행 중** 스텝 번호(1-based) →
 *    완료분은 (current_step - 1). 그래서 시작 직후엔 0% 에서 출발한다.
 *  · current_step > total_steps 가 될 수 있다(구간반복 loops·조건부이동 revisit 은 같은 스텝을
 *    다시 실행하지만 total_steps 는 시나리오의 스텝 수 그대로) → 1로 클램프.
 *  · total_cycles = 0 은 '시간 지정 재생'(끝 회차 미정) → 총량 미상. 현재 회차 안의 진행만
 *    보여주고 determinate=false 로 구분한다.
 *  · 실행 중에는 99% 상한 — 100% 를 넘기면 antd 가 초록 '완료' 로 바꿔 끝난 것처럼 보인다. */
function playbackProgress(pb: Playback): { percent: number; determinate: boolean } {
  const totalSteps = pb.total_steps > 0 ? pb.total_steps : 0;
  const stepFrac = totalSteps > 0
    ? Math.min(1, Math.max(0, (pb.current_step - 1) / totalSteps))
    : 0;
  const totalCycles = pb.total_cycles > 0 ? pb.total_cycles : 0;
  if (totalCycles === 0) {
    return { percent: Math.round(stepFrac * 100), determinate: false };
  }
  const doneCycles = Math.min(totalCycles, Math.max(0, pb.current_cycle - 1));
  const frac = (doneCycles + stepFrac) / totalCycles;
  return { percent: Math.min(99, Math.max(0, Math.round(frac * 100))), determinate: true };
}

function playbackTooltip(a: Agent) {
  const pb = a.playback;
  if (!pb) return `재생 중 아님 · 시나리오 ${a.scenario_count}개 보유`;
  const { percent, determinate } = playbackProgress(pb);
  return (
    <div style={{ maxWidth: 320, fontSize: 11, lineHeight: 1.7 }}>
      <div><b>{pb.scenario_name}</b></div>
      <div>회차 {pb.current_cycle}/{pb.total_cycles || '?'} · 스텝 {pb.current_step}/{pb.total_steps}</div>
      <div>
        진행 {percent}%
        {determinate
          ? ' (전체 회차 기준)'
          : ' — 시간 지정 재생이라 남은 회차를 알 수 없어 현재 회차 안의 진행만 표시'}
      </div>
      <div>
        <span style={{ color: '#52c41a' }}>PASS {pb.passed}</span>{' · '}
        <span style={{ color: '#ff4d4f' }}>FAIL {pb.failed}</span>
        {pb.warning > 0 && <> · <span style={{ color: '#faad14' }}>WARN {pb.warning}</span></>}
        {' · '}<span style={{ color: '#fa541c' }}>ERROR {pb.error}</span>
      </div>
      {pb.status === 'paused' && <div>일시정지</div>}
      {pb.error_message && <div style={{ color: '#ff7875' }}>{pb.error_message}</div>}
    </div>
  );
}

function relTime(iso?: string): string {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '-';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 5) return '방금';
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  return `${Math.floor(sec / 3600)}시간 전`;
}

// 표 아래 여백 — App.tsx 의 Content 가 갖는 padding-bottom(24) + margin-bottom(16).
// 헤더 행·푸터 높이는 상수로 두지 않고 실제 DOM 에서 잰다(_measure 참고) — 폰트나 테마가
// 바뀌면 값이 달라져서, 상수로 박아 두면 창에 군더더기 스크롤이 생긴다.
const GAP_BELOW = 40;

/** 값 없음 — 빈 칸으로 두면 격자만 남아 '데이터가 안 온 건가' 싶으니 옅은 대시로 채운다. */
const DASH = <span style={{ opacity: 0.3 }}>—</span>;

/** 상태 배지 — 표에서 제일 먼저 눈에 들어와야 하는 칸이라 셀을 통째로 칠한다. */
function StateCell({ st }: { st: StateKey }) {
  const s = STATE[st];
  return (
    <Tooltip title={s.desc}>
      <div style={{
        background: s.color, color: '#fff', fontWeight: 700, fontSize: 10,
        lineHeight: '17px', borderRadius: 3, textAlign: 'center',
        letterSpacing: 0.2, cursor: 'default',
      }}>
        {s.label}
      </div>
    </Tooltip>
  );
}

/**
 * 테스트 PC 관제 대시보드 — 각 PC(머신 UID 기준)의 실시간 재생 상태를 한 줄씩 표로 표시.
 * 2초마다 /api/agents 폴링. 원격제어 없이 모니터링 전용.
 *
 * 행 위치는 **정렬 선택을 그대로 따른다** — 접속이 끊겨도 행이 사라지거나 아래로 내려가지 않고
 * 그 자리에서 '오프라인' 으로 흐려질 뿐이다. (상태순을 고른 경우에만 상태 변화로 재정렬)
 */
export default function FleetPage() {
  // 강조색 인덱스 — 0=라이트, 1=다크 (MODE_COLOR/ACCENT 의 [라이트, 다크] 중 고를 쪽)
  const { token } = theme.useToken();
  const ci = isDarkBg(token.colorBgContainer) ? 1 : 0;

  const [agents, setAgents] = useState<Agent[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, online: 0, playing: 0, recording: 0 });
  const [loaded, setLoaded] = useState(false);
  // 정렬 기준은 브라우저에 기억 — 관제 화면은 띄워 두고 쓰는 경우가 많다.
  // (저장된 값이 없으면 기본 정렬: 부서 → 프로젝트 → 사용자이름)
  const [sort, setSort] = useState<SortKey>(() => {
    const saved = localStorage.getItem(SORT_KEY) as SortKey;
    return SORT_KEYS.includes(saved) ? saved : DEFAULT_SORT;
  });
  // 부서/프로젝트 필터 ('' = 전체) — 로그인 사용자 정보 기준
  const [teamFilter, setTeamFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const timer = useRef<number | null>(null);
  // 표 본문 높이(틀 고정용) — 마운트 후 실제 위치를 재서 채운다
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(420);

  // 표시 순서(client_id 목록)를 얼려 둔다 — 행 위치는 여기서만 정해진다.
  // 필터와는 무관하게 **전체 PC** 기준으로 한 번 세워 두고, 화면에는 필터를 통과한 것만 그린다
  // (필터를 껐다 켜도 순서가 흔들리지 않게).
  const [order, setOrder] = useState<string[]>([]);
  // 정렬 시점의 목록이 필요해 ref 로 최신 agents 를 들고 있는다 (effect 의존성에 안 넣으려고)
  const agentsRef = useRef<Agent[]>([]);
  agentsRef.current = agents;

  /** 지금 값 기준으로 줄을 다시 세운다 — 정렬 기준 변경과 '재정렬' 버튼에서만 호출. */
  const resort = (key: SortKey) =>
    setOrder(sortAgents(agentsRef.current, key).map(a => a.client_id));

  const changeSort = (v: SortKey) => {
    setSort(v);
    localStorage.setItem(SORT_KEY, v);
    resort(v);
  };

  // 명부 동기화 — 이미 자리를 잡은 행은 **절대 건드리지 않는다**.
  // 순서가 저절로 바뀌는 건 여기, 새 PC 가 처음 들어올 때뿐이다:
  // 정렬 규칙상 자기가 들어가야 할 자리를 찾아 끼운다(그래야 같은 부서끼리 붙어 있다).
  // 관제 목록에서 PC 가 빠지는 건 명시적 '제거' 뿐이라 삭제는 사실상 그때만 일어난다.
  useEffect(() => {
    if (agents.length === 0) return;
    setOrder(prev => {
      if (prev.length === 0) return sortAgents(agents, sort).map(a => a.client_id);
      const live = new Set(agents.map(a => a.client_id));
      const known = new Set(prev);
      const kept = prev.filter(id => live.has(id));
      const added = agents.filter(a => !known.has(a.client_id));
      if (kept.length === prev.length && added.length === 0) return prev;   // 변화 없음

      const byId = new Map(agents.map(a => [a.client_id, a]));
      const cmp = comparatorFor(sort);
      const next = [...kept];
      for (const a of sortAgents(added, sort)) {
        // 정렬 규칙상 '이 행보다 앞' 인 첫 자리에 끼운다. 못 찾으면 맨 뒤.
        let at = next.findIndex(id => {
          const b = byId.get(id);
          return !!b && cmp(a, b) < 0;
        });
        if (at < 0) at = next.length;
        next.splice(at, 0, a.client_id);
      }
      return next;
    });
  }, [agents, sort]);

  const load = async () => {
    try {
      const res = await agentApi.list();
      setAgents(res.data.agents || []);
      setSummary(res.data.summary || { total: 0, online: 0, playing: 0, recording: 0 });
      setLoaded(true);
    } catch {
      /* 폴링 중 일시 실패 무시 */
    }
  };

  useEffect(() => {
    load();
    timer.current = window.setInterval(load, 2000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  const removeAgent = (a: Agent) => {
    Modal.confirm({
      title: '관제 목록에서 제거',
      content: (
        <div style={{ fontSize: 12, lineHeight: 1.8 }}>
          <b>{a.name || a.client_id}</b> 를 목록에서 제거합니다.<br />
          저장된 함수통계 스냅샷과 사용량 이력(그래프)도 함께 삭제됩니다.<br />
          <span style={{ color: '#888' }}>
            해당 PC 가 다시 접속하면 자동으로 재등록됩니다.
          </span>
        </div>
      ),
      okText: '제거', okType: 'danger', cancelText: '취소',
      onOk: async () => {
        try {
          await agentApi.remove(a.client_id);
          message.success('제거되었습니다');
          load();
        } catch (e: any) {
          message.error('제거 실패: ' + (e?.response?.data?.detail || e?.message || ''));
        }
      },
    });
  };

  // 부서/프로젝트 필터 옵션 — 현재 접속 이력이 있는 값들만
  const teamOptions = useMemo(
    () => Array.from(new Set(agents.map(a => a.user?.team).filter(Boolean) as string[])).sort(),
    [agents]);
  const projectOptions = useMemo(
    () => Array.from(new Set(agents.map(a => a.user?.project).filter(Boolean) as string[])).sort(),
    [agents]);

  // 화면에 그릴 행 — **얼린 순서(order)** 대로 늘어놓고 필터만 적용한다.
  // 여기서 정렬을 다시 하지 않는 게 핵심: 상태나 사용자 정보가 바뀌어도 행은 제자리에 있고
  // 온라인/오프라인으로 나누지도 않는다(접속이 끊겨도 그 자리에서 상태만 바뀐다).
  const rows = useMemo(() => {
    const byId = new Map(agents.map(a => [a.client_id, a]));
    return order
      .map(id => byId.get(id))
      .filter((a): a is Agent => !!a)
      .filter(a =>
        (!teamFilter || a.user?.team === teamFilter) &&
        (!projectFilter || a.user?.project === projectFilter));
  }, [agents, order, teamFilter, projectFilter]);

  const onlineCount = useMemo(() => rows.filter(a => a.online).length, [rows]);

  // 표 본문 높이 — 표가 시작되는 지점부터 창 아래까지를 그대로 쓴다.
  // 고정값을 쓰면 모니터마다 표가 잘리거나 빈 공간이 남는다.
  useLayoutEffect(() => {
    const measure = () => {
      const wrap = tableWrapRef.current;
      if (!wrap) return;
      const bodyEl = wrap.querySelector<HTMLElement>('.ant-table-body');
      // 표에서 본문이 아닌 부분(고정 헤더 행 + 요약 푸터 + 테두리)의 높이.
      // bodyHeight 와 무관하게 일정하므로 한 번 재면 그대로 쓸 수 있다.
      const chrome = bodyEl ? wrap.offsetHeight - bodyEl.offsetHeight : 60;
      const top = wrap.getBoundingClientRect().top;
      setBodyHeight(Math.max(200, Math.round(window.innerHeight - top - chrome - GAP_BELOW)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // 위쪽 요약/범례가 줄바꿈되면 시작 지점이 달라지므로 대수가 바뀔 때도 다시 잰다
  }, [rows.length]);

  // 범례에 상태별 대수도 같이 — 색이 무슨 뜻인지 + 지금 몇 대인지 한 줄에서 읽힌다.
  const stateCount = useMemo(() => {
    const m = {} as Record<StateKey, number>;
    agents.forEach(a => { const k = stateOf(a); m[k] = (m[k] || 0) + 1; });
    return m;
  }, [agents]);

  const columns: ColumnsType<Agent> = [
    {
      title: 'No.', key: 'no', width: 44, align: 'center', fixed: 'left',
      render: (_: unknown, __: Agent, i: number) => <span style={{ opacity: 0.55 }}>{i + 1}</span>,
    },
    {
      title: '상태', key: 'state', width: 72, align: 'center', fixed: 'left',
      render: (_: unknown, a: Agent) => <StateCell st={stateOf(a)} />,
    },
    {
      title: '사용자', key: 'user', width: 110, ellipsis: true,
      render: (_: unknown, a: Agent) => (
        <Tooltip title={userTooltip(a)}>
          {a.user
            ? <span style={{ fontWeight: 600, cursor: 'default' }}><UserOutlined /> {a.user.name}</span>
            : <span style={{ opacity: 0.4, cursor: 'default' }}><UserOutlined /> 미로그인</span>}
        </Tooltip>
      ),
    },
    {
      title: '부서', key: 'team', width: 120, ellipsis: true,
      render: (_: unknown, a: Agent) => a.user?.team || DASH,
    },
    {
      title: '프로젝트', key: 'project', width: 110, ellipsis: true,
      render: (_: unknown, a: Agent) => (a.user?.project
        ? (
          <span style={{ color: ACCENT.project[ci] }}>
            {a.user.project}
            {a.user.model ? <span style={{ opacity: 0.7 }}> · {a.user.model}</span> : null}
          </span>
        )
        : DASH),
    },
    {
      title: 'PC 이름', key: 'host', width: 150, ellipsis: true,
      render: (_: unknown, a: Agent) => (
        <Tooltip title={hostTooltip(a)}>
          <span style={{ cursor: 'default' }}><DesktopOutlined /> {agentName(a)}</span>
        </Tooltip>
      ),
    },
    {
      title: 'OS', key: 'os', width: 62, align: 'center',
      render: (_: unknown, a: Agent) => (a.os
        ? <span style={{ color: ACCENT[a.os]?.[ci] }}>{a.os}</span>
        : DASH),
    },
    {
      title: '디바이스', key: 'dev', width: 68, align: 'center',
      render: (_: unknown, a: Agent) => (
        <Tooltip title={deviceTooltip(a)}>
          {/* 등록은 됐는데 하나도 안 붙은 경우는 빨강 — 관제에서 제일 먼저 보는 이상 신호 */}
          <span style={{
            cursor: 'default',
            color: a.device_count > 0 && a.connected_device_count === 0 ? '#ff4d4f' : undefined,
          }}>
            {a.connected_device_count}/{a.device_count}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '모드', key: 'mode', width: 62, align: 'center',
      render: (_: unknown, a: Agent) => (a.online && a.ui?.mode
        ? (
          <Tooltip title={modeTooltip(a)}>
            <span style={{ cursor: 'default', color: MODE_COLOR[a.ui.mode]?.[ci] || undefined }}>
              {MODE_LABEL[a.ui.mode] || a.ui.mode}
            </span>
          </Tooltip>
        )
        : DASH),
    },
    {
      title: '시나리오', key: 'scenario', width: 200, ellipsis: true,
      render: (_: unknown, a: Agent) => (
        <Tooltip title={playbackTooltip(a)}>
          {a.playback
            ? <span style={{ cursor: 'default' }}>{a.playback.scenario_name}</span>
            : <span style={{ opacity: 0.45, cursor: 'default' }}>보유 {a.scenario_count}개</span>}
        </Tooltip>
      ),
    },
    {
      title: '회차', key: 'cycle', width: 74, align: 'center',
      render: (_: unknown, a: Agent) => (a.playback
        ? <span>{a.playback.current_cycle}/{a.playback.total_cycles || '?'}</span>
        : DASH),
    },
    {
      title: '스텝', key: 'step', width: 74, align: 'center',
      render: (_: unknown, a: Agent) => (a.playback
        ? <span>{a.playback.current_step}/{a.playback.total_steps || '?'}</span>
        : DASH),
    },
    {
      title: '진행률', key: 'progress', width: 110,
      render: (_: unknown, a: Agent) => {
        const pb = a.playback;
        if (!pb) return <div style={{ textAlign: 'center' }}>{DASH}</div>;
        const prog = playbackProgress(pb);
        return (
          <Tooltip title={playbackTooltip(a)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'default' }}>
              <Progress
                percent={prog.percent}
                size="small"
                showInfo={false}
                /* status 를 고정하지 않으면 antd 가 100% 를 '완료(초록)' 로 칠한다.
                   일시정지는 노랑, 총량 미상(시간 지정)은 연한 색으로 구분. */
                status="normal"
                strokeColor={
                  pb.status === 'paused' ? '#faad14'
                    : prog.determinate ? '#1677ff' : '#69b1ff'
                }
                style={{ flex: 1, minWidth: 40, margin: 0 }}
              />
              <span style={{ width: 26, textAlign: 'right', opacity: prog.determinate ? 1 : 0.6 }}>
                {prog.percent}%
              </span>
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: 'P / F / E', key: 'result', width: 92, align: 'center',
      render: (_: unknown, a: Agent) => {
        const pb = a.playback;
        if (!pb) return DASH;
        return (
          <Tooltip title={playbackTooltip(a)}>
            <span style={{ cursor: 'default' }}>
              <span style={{ color: '#52c41a' }}>{pb.passed}</span>
              <span style={{ opacity: 0.35 }}> / </span>
              <span style={{ color: '#ff4d4f' }}>{pb.failed}</span>
              <span style={{ opacity: 0.35 }}> / </span>
              <span style={{ color: '#fa541c' }}>{pb.error}</span>
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'IP', key: 'ip', width: 105, align: 'center',
      render: (_: unknown, a: Agent) => a.ip || DASH,
    },
    {
      title: '최근 보고', key: 'seen', width: 84, align: 'center',
      render: (_: unknown, a: Agent) => (
        <span style={{ color: a.online ? undefined : '#ff7875' }}>{relTime(a.last_seen)}</span>
      ),
    },
    {
      title: '', key: 'act', width: 40, align: 'center', fixed: 'right',
      render: (_: unknown, a: Agent) => (a.online ? null : (
        <Tooltip title="목록에서 제거 (다시 접속하면 재등록)">
          <Button
            type="text" size="small" danger icon={<DeleteOutlined />}
            style={{ width: 20, height: 20, minWidth: 20, padding: 0 }}
            onClick={() => removeAgent(a)}
          />
        </Tooltip>
      )),
    },
  ];

  return (
    <div>
      <style>{TABLE_CSS}</style>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="전체 PC" value={summary.total} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="온라인" value={summary.online} valueStyle={{ color: '#52c41a' }} /></Card></Col>
        {/* 색은 상태 배지/범례와 같은 STATE 표에서 가져온다 — 요약과 표 색이 어긋나지 않게. */}
        <Col xs={12} sm={6}><Card size="small"><Statistic title="재생 중" value={summary.playing} valueStyle={{ color: STATE.playing.color }} prefix={<PlayCircleOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="녹화 중" value={summary.recording} valueStyle={{ color: STATE.recording.color }} prefix={<VideoCameraOutlined />} /></Card></Col>
      </Row>

      {/* 범례(상태 색의 의미 + 상태별 대수) / 필터 / 정렬 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        flexWrap: 'wrap', marginBottom: 12,
      }}>
        {/* 범례는 사용량 통계 페이지와 공용 컴포넌트 — 색 정의가 갈라지지 않게 */}
        <div style={{ flex: 1, minWidth: 0 }}><StateLegend counts={stateCount} /></div>
        {/* 부서/프로젝트 필터 — 로그인 사용자 정보 기준 (미로그인 PC 는 필터 시 제외) */}
        <Select
          size="small" style={{ width: fitSelectWidth(teamOptions, '부서 전체') }} allowClear
          // 드롭다운 목록도 옵션 내용에 맞춰 넓혀 긴 부서명이 잘리지 않게
          popupMatchSelectWidth={false}
          placeholder="부서 전체"
          value={teamFilter || undefined}
          onChange={(v) => setTeamFilter(v || '')}
          options={teamOptions.map(t => ({ label: t, value: t }))}
          showSearch optionFilterProp="label"
        />
        <Select
          size="small" style={{ width: fitSelectWidth(projectOptions, '프로젝트 전체') }} allowClear
          popupMatchSelectWidth={false}
          placeholder="프로젝트 전체"
          value={projectFilter || undefined}
          onChange={(v) => setProjectFilter(v || '')}
          options={projectOptions.map(p => ({ label: p, value: p }))}
          showSearch optionFilterProp="label"
        />
        <Tooltip title="부서순(기본) = 부서 → 프로젝트 → 사용자이름 · 프로젝트순 = 프로젝트 → 부서 → 사용자이름. 고른 순간에 한 번 줄을 세우고 그 순서를 유지합니다 — 이후 저절로 자리가 바뀌는 건 새 PC 가 처음 들어올 때뿐이고, 상태나 사용자 정보가 바뀌어도 행은 그대로 있고 칸 내용만 바뀝니다.">
          <Segmented
            size="small"
            value={sort}
            onChange={(v) => changeSort(v as SortKey)}
            options={SORT_OPTIONS}
          />
        </Tooltip>
        {/* 순서는 얼려 있어 스스로 갱신되지 않는다 — 다시 세우고 싶을 때만 누른다 */}
        <Tooltip title="지금 값 기준으로 줄을 다시 세웁니다 (누르기 전까지 행 위치는 고정)">
          <Button size="small" icon={<SortAscendingOutlined />} onClick={() => resort(sort)}>
            재정렬
          </Button>
        </Tooltip>
      </div>

      {/* 표 본문에 남은 화면 높이를 전부 준다 — 헤더 행은 고정되고 본문만 스크롤된다 */}
      <div ref={tableWrapRef}>
      {rows.length === 0 ? (
        <Empty description={
          loaded
            ? (agents.length === 0
              ? '연결된 테스트 PC 없음 — ReplayKit 설정에서 관제 서버 URL 을 이 서버로 지정하세요'
              : '필터 조건에 해당하는 PC 없음')
            : '로딩 중...'
        } />
      ) : (
        <Table<Agent>
          className="fleet-table"
          rowKey="client_id"
          size="small"
          bordered
          columns={columns}
          dataSource={rows}
          pagination={false}
          // y 를 주면 헤더 행이 표 안에 고정되고 본문만 스크롤된다 (엑셀 '틀 고정').
          // 창 스크롤에 기대는 sticky 와 달리 요약/범례까지 늘 화면에 남는다.
          scroll={{ x: 1577, y: bodyHeight }}
          // 상태 틴트는 CSS 변수로 넘긴다 (활동 중인 PC 가 대기/오프라인보다 튀어 보이게).
          // 오프라인 행은 fleet-off 로 흐려질 뿐 **자리는 그대로** 둔다.
          onRow={(a) => {
            const st = stateOf(a);
            const quiet = st === 'idle' || st === 'offline';
            return {
              className: `${quiet ? '' : 'fleet-tinted'} ${a.online ? '' : 'fleet-off'}`.trim(),
              style: quiet
                ? undefined
                : ({ ['--fleet-tint' as string]: tint(STATE[st].color, 0.12) } as React.CSSProperties),
            };
          }}
          footer={() => (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {rows.length}대 표시 · 온라인 {onlineCount}대 · 오프라인 {rows.length - onlineCount}대
            </Typography.Text>
          )}
        />
      )}
      </div>
    </div>
  );
}
