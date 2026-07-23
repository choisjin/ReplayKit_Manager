import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Col, Empty, Modal, Progress, Row, Segmented, Select, Statistic, Tag, Tooltip, Typography, message } from 'antd';
import { DeleteOutlined, DesktopOutlined, PlayCircleOutlined, UserOutlined, VideoCameraOutlined } from '@ant-design/icons';
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
const MODE_COLOR: Record<string, string> = {
  test: 'purple', admin: 'orange', stats: 'cyan', normal: 'default',
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
// 상태순만 상태 변화에 따라 재정렬된다. 부서순/프로젝트순은 고정 속성(부서/프로젝트·이름)
// 기준이라 2초 폴링으로 상태가 바뀌어도 카드가 자리를 옮기지 않고 그 자리에서 상태만 갱신된다.
// (온라인↔오프라인 전환 시에만 활성/비활성 섹션 간 이동)
type SortKey = 'state' | 'team' | 'project';
const SORT_KEY = 'fleet_sort';
const SORT_OPTIONS = [
  { label: '상태순', value: 'state' },
  { label: '부서순', value: 'team' },
  { label: '프로젝트순', value: 'project' },
];
const SORT_KEYS: SortKey[] = ['state', 'team', 'project'];

function agentName(a: Agent): string {
  return a.name || a.client_id;
}

/** 부서/프로젝트 정렬 키 — 값이 없으면(미로그인) 맨 뒤로 보낸다. */
function groupKey(v: string | undefined): string {
  return v ? `0${v}` : '1';
}

/** 필터 Select 를 내용(가장 긴 옵션/placeholder)에 맞춰 폭 계산.
 *  고정폭이면 긴 부서명이 잘리므로, 글자 수 기반으로 폭을 잡고 너무 길면 상한을 둔다.
 *  (한글은 소형 폰트에서 대략 13px/자, 화살표·clear·좌우패딩에 약 52px 여유) */
function fitSelectWidth(options: string[], placeholder: string): number {
  const longest = Math.max(placeholder.length, ...options.map(o => o.length), 0);
  return Math.min(340, Math.max(96, longest * 13 + 52));
}

function sortAgents(list: Agent[], sort: SortKey): Agent[] {
  const arr = [...list];
  if (sort === 'team') {
    arr.sort((x, y) =>
      groupKey(x.user?.team).localeCompare(groupKey(y.user?.team)) ||
      agentName(x).localeCompare(agentName(y)));
  } else if (sort === 'project') {
    arr.sort((x, y) =>
      groupKey(x.user?.project).localeCompare(groupKey(y.user?.project)) ||
      agentName(x).localeCompare(agentName(y)));
  } else {
    // 상태가 같으면 이름순 — 같은 상태 안에서는 순서가 흔들리지 않는다.
    arr.sort((x, y) =>
      STATE[stateOf(x)].order - STATE[stateOf(y)].order ||
      agentName(x).localeCompare(agentName(y)));
  }
  return arr;
}

// 카드 고정 높이 — 재생 여부/디바이스 수에 따라 크기가 변하지 않게 한다.
// (사용자/부서/프로젝트 행이 추가되며 104 → 124)
const CARD_HEIGHT = 124;
// 카드 안 태그는 전부 동일한 미니 사이즈 (줄바꿈으로 높이가 늘지 않도록)
const MINI_TAG: React.CSSProperties = {
  fontSize: 10, margin: 0, padding: '0 5px', lineHeight: '17px',
};

// ── hover 상세 (카드는 미니멀하게 두고 상세는 전부 툴팁으로) ──
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
 *  100% 가 되고, antd Progress 는 100% 를 '완료(초록)' 로 칠해 카드가 늘 초록 막대로 보인다.
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

/**
 * 테스트 PC 관제 대시보드 — 각 PC(머신 UID 기준)의 실시간 재생 상태를 카드로 표시.
 * 2초마다 /api/agents 폴링. 원격제어 없이 모니터링 전용.
 */
export default function FleetPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, online: 0, playing: 0, recording: 0 });
  const [loaded, setLoaded] = useState(false);
  // 정렬 기준은 브라우저에 기억 — 관제 화면은 띄워 두고 쓰는 경우가 많다.
  // (삭제된 옵션 '연결순'/'이름순' 이 저장돼 있으면 상태순으로 대체)
  const [sort, setSort] = useState<SortKey>(() => {
    const saved = localStorage.getItem(SORT_KEY) as SortKey;
    return SORT_KEYS.includes(saved) ? saved : 'state';
  });
  // 부서/프로젝트 필터 ('' = 전체) — 로그인 사용자 정보 기준
  const [teamFilter, setTeamFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const timer = useRef<number | null>(null);

  const changeSort = (v: SortKey) => {
    setSort(v);
    localStorage.setItem(SORT_KEY, v);
  };

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

  /** 카드 1장 — 상태에 따라 크기가 변하지 않도록 **고정 높이**로 그린다.
   *  본문은 최소한만 노출하고, 상세는 각 항목 hover 툴팁으로 뺀다.
   *  상태는 태그뿐 아니라 **카드 전체 색(왼쪽 굵은 띠 + 배경 틴트)** 으로 드러낸다 —
   *  작은 태그만으로는 수십 장이 깔렸을 때 한눈에 안 들어온다. */
  const renderCard = (a: Agent) => {
    const pb = a.playback;
    const cycleTotal = pb?.total_cycles || 0;
    // 회차+스텝을 합친 실제 진행률 (회차만 쓰면 1/1 재생이 늘 100% 초록으로 보인다)
    const prog = pb ? playbackProgress(pb) : null;
    const st = stateOf(a);
    const c = STATE[st].color;
    // 대기/오프라인은 틴트를 옅게 — 활동 중인 PC 가 상대적으로 튀어 보이게 한다.
    const quiet = st === 'idle' || st === 'offline';
    return (
      <Col xs={24} sm={12} md={8} lg={6} xxl={4} key={a.client_id}>
        <Card
          size="small"
          bodyStyle={{ padding: '8px 10px' }}
          style={{
            height: CARD_HEIGHT,
            overflow: 'hidden',
            opacity: a.online ? 1 : 0.6,
            background: tint(c, quiet ? 0.05 : 0.14),
            borderColor: tint(c, quiet ? 0.25 : 0.45),
            borderLeft: `4px solid ${quiet ? tint(c, 0.5) : c}`,
            boxShadow: quiet ? undefined : `0 2px 8px ${tint(c, 0.22)}`,
          }}
        >
          {/* 1행(메인) — 상태점 + 로그인 사용자(굵게) + 프로젝트 + 삭제(오프라인만)
              로그인 정보가 관제에서 가장 먼저 찾는 값이라 호스트명 대신 맨 위에 크게 둔다. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <Badge status={a.online ? 'success' : 'default'} />
            <Tooltip title={userTooltip(a)}>
              {a.user ? (
                <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                  <UserOutlined /> {a.user.name}
                  {a.user.team && <span style={{ opacity: 0.65, fontWeight: 'normal' }}> · {a.user.team}</span>}
                </Typography.Text>
              ) : (
                <Typography.Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12, opacity: 0.45 }}>
                  <UserOutlined /> 미로그인
                </Typography.Text>
              )}
            </Tooltip>
            {a.user?.project && (
              <Tag color="blue" style={MINI_TAG}>
                {a.user.project}{a.user.model ? `·${a.user.model}` : ''}
              </Tag>
            )}
            {!a.online && (
              <Tooltip title="목록에서 제거 (다시 접속하면 재등록)">
                <Button
                  type="text" size="small" danger icon={<DeleteOutlined />}
                  style={{ width: 20, height: 20, minWidth: 20, padding: 0 }}
                  onClick={() => removeAgent(a)}
                />
              </Tooltip>
            )}
          </div>

          {/* 2행 — 활동 / 디바이스 수 / UI 모드 (상세는 모두 hover) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
            <Tooltip title={STATE[st].desc}>
              <Tag color={STATE[st].tag} style={{ ...MINI_TAG, cursor: 'default' }}>
                {STATE[st].label}
              </Tag>
            </Tooltip>
            <Tooltip title={deviceTooltip(a)}>
              <Tag style={{ ...MINI_TAG, cursor: 'default' }}>
                {a.connected_device_count}/{a.device_count}
              </Tag>
            </Tooltip>
            {a.online && a.ui?.mode && (
              <Tooltip title={modeTooltip(a)}>
                <Tag color={MODE_COLOR[a.ui.mode] || 'default'} style={{ ...MINI_TAG, cursor: 'default' }}>
                  {MODE_LABEL[a.ui.mode] || a.ui.mode}
                </Tag>
              </Tooltip>
            )}
          </div>

          {/* 3행 — PC 정보(호스트명 + OS). 메인 자리를 로그인 정보에 내주고 보조로 내려왔다. */}
          <Tooltip title={hostTooltip(a)}>
            <div style={{
              marginTop: 4, height: 17, display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 10, overflow: 'hidden', whiteSpace: 'nowrap', cursor: 'default',
            }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.75 }}>
                <DesktopOutlined /> {a.name || a.client_id}
              </span>
              {a.os && (
                <Tag color={a.os === 'Linux' ? 'gold' : 'geekblue'} style={MINI_TAG}>{a.os}</Tag>
              )}
            </div>
          </Tooltip>

          {/* 4행 — 재생 진행 (재생 여부와 무관하게 같은 높이를 차지해 카드 크기 고정) */}
          <Tooltip title={playbackTooltip(a)}>
            <div style={{ marginTop: 6, height: 20, display: 'flex', alignItems: 'center', gap: 6, cursor: 'default' }}>
              {pb && prog ? (
                <>
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
                    style={{ flex: 1, minWidth: 36, margin: 0 }}
                  />
                  {/* 회차/스텝을 한 덩어리로 — 좁은 카드에서 게이지 폭을 잡아먹지 않게 */}
                  <span style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                    {pb.current_cycle}/{cycleTotal || '?'}
                    <span style={{ opacity: 0.6 }}>·{pb.current_step}/{pb.total_steps || '?'}</span>
                  </span>
                  <span style={{ fontSize: 10, color: '#52c41a' }}>{pb.passed}</span>
                  <span style={{ fontSize: 10, color: '#ff4d4f' }}>{pb.failed}</span>
                  <span style={{ fontSize: 10, color: '#fa541c' }}>{pb.error}</span>
                </>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                  재생 중 아님 · 시나리오 {a.scenario_count}개
                </Typography.Text>
              )}
            </div>
          </Tooltip>
        </Card>
      </Col>
    );
  };

  // 부서/프로젝트 필터 옵션 — 현재 접속 이력이 있는 값들만
  const teamOptions = useMemo(
    () => Array.from(new Set(agents.map(a => a.user?.team).filter(Boolean) as string[])).sort(),
    [agents]);
  const projectOptions = useMemo(
    () => Array.from(new Set(agents.map(a => a.user?.project).filter(Boolean) as string[])).sort(),
    [agents]);

  // 2초 폴링마다 재정렬되므로 memo — agents/sort/필터가 바뀔 때만 계산한다.
  const visibleAgents = useMemo(
    () => agents.filter(a =>
      (!teamFilter || a.user?.team === teamFilter) &&
      (!projectFilter || a.user?.project === projectFilter)),
    [agents, teamFilter, projectFilter]);
  const onlineAgents = useMemo(
    () => sortAgents(visibleAgents.filter(a => a.online), sort), [visibleAgents, sort]);
  const offlineAgents = useMemo(
    () => sortAgents(visibleAgents.filter(a => !a.online), sort), [visibleAgents, sort]);
  // 범례에 상태별 대수도 같이 — 색이 무슨 뜻인지 + 지금 몇 대인지 한 줄에서 읽힌다.
  const stateCount = useMemo(() => {
    const m = {} as Record<StateKey, number>;
    agents.forEach(a => { const k = stateOf(a); m[k] = (m[k] || 0) + 1; });
    return m;
  }, [agents]);

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        <DesktopOutlined /> 테스트 PC 관제
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        각 테스트 PC 가 관제 서버(이 서버)로 보고한 실시간 재생 상태입니다. PC 식별은 하드웨어 머신 UID 기준이며,
        표시된 IP 는 참고용입니다. (2초마다 자동 갱신)
      </Typography.Paragraph>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="전체 PC" value={summary.total} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="온라인" value={summary.online} valueStyle={{ color: '#52c41a' }} /></Card></Col>
        {/* 색은 카드/범례와 같은 STATE 표에서 가져온다 — 요약과 카드 색이 어긋나지 않게. */}
        <Col xs={12} sm={6}><Card size="small"><Statistic title="재생 중" value={summary.playing} valueStyle={{ color: STATE.playing.color }} prefix={<PlayCircleOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="녹화 중" value={summary.recording} valueStyle={{ color: STATE.recording.color }} prefix={<VideoCameraOutlined />} /></Card></Col>
      </Row>

      {/* 범례(카드 색의 의미 + 상태별 대수) / 정렬 */}
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
        <Tooltip title="상태순 = 재생 중부터 위로(상태 변화 시 재정렬) · 부서/프로젝트순 = 로그인 사용자 기준 고정 배치(오프라인 전환 외에는 카드가 자리를 옮기지 않음)">
          <Segmented
            size="small"
            value={sort}
            onChange={(v) => changeSort(v as SortKey)}
            options={SORT_OPTIONS}
          />
        </Tooltip>
      </div>

      {agents.length === 0 ? (
        <Empty description={loaded ? '연결된 테스트 PC 없음 — ReplayKit 설정에서 관제 서버 URL 을 이 서버로 지정하세요' : '로딩 중...'} />
      ) : (
        <>
          {/* 활성 / 비활성을 크게 나눠 표시. 섹션 내 순서는 정렬 선택(sort)을 따른다.
              부서/프로젝트순은 고정 속성 기준이라 상태가 바뀌어도 카드가 자리를 옮기지 않는다. */}
          <Typography.Title level={5} style={{ margin: '4px 0 8px' }}>
            <Badge status="success" /> 활성 <Typography.Text type="secondary">({onlineAgents.length})</Typography.Text>
          </Typography.Title>
          {onlineAgents.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>온라인 PC 없음</Typography.Text>
          ) : (
            <Row gutter={[10, 10]}>{onlineAgents.map(renderCard)}</Row>
          )}

          <Typography.Title level={5} style={{ margin: '20px 0 8px' }}>
            <Badge status="default" /> 비활성 <Typography.Text type="secondary">({offlineAgents.length})</Typography.Text>
          </Typography.Title>
          {offlineAgents.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>오프라인 PC 없음</Typography.Text>
          ) : (
            <Row gutter={[10, 10]}>{offlineAgents.map(renderCard)}</Row>
          )}
        </>
      )}
    </div>
  );
}
