import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Col, Empty, Modal, Progress, Row, Segmented, Statistic, Tag, Tooltip, Typography, message } from 'antd';
import { DeleteOutlined, DesktopOutlined, PlayCircleOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { agentApi } from '../services/api';

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
}
interface Summary { total: number; online: number; playing: number; recording: number; }

// ── 상태(활동) 단일 정의 ──
// 카드 색 / 태그 / 범례 / 정렬 순서가 **모두 이 표 하나**를 본다. 색을 바꾸려면 여기만 고친다.
//  - key 는 백엔드 activity(idle/in_use/playing/recording) 에 매니저가 아는 두 가지를
//    얹은 것: 재생 중 일시정지(paused), 상태 보고 끊김(offline).
//  - color 는 hex 만 둔다(카드 틴트 계산에 rgba 로 변환해야 해서 antd 프리셋명은 못 쓴다).
//  - order 는 '상태순' 정렬에서 위로 올라올 순서 — 지금 봐야 하는 것부터.
type StateKey = 'playing' | 'paused' | 'recording' | 'in_use' | 'idle' | 'offline';

const STATE: Record<StateKey, { label: string; color: string; tag: string; order: number; desc: string }> = {
  playing:   { label: '재생 중',  color: '#1677ff', tag: 'processing', order: 0, desc: '시나리오 재생 중' },
  paused:    { label: '일시정지', color: '#faad14', tag: 'warning',    order: 1, desc: '재생 중 일시정지 상태' },
  recording: { label: '녹화 중',  color: '#ff4d4f', tag: 'error',      order: 2, desc: '시나리오 녹화 중' },
  in_use:    { label: '사용중',   color: '#52c41a', tag: 'success',    order: 3, desc: 'ReplayKit 창이 최상단 — 사람이 조작 중' },
  idle:      { label: '대기',     color: '#8c8c8c', tag: 'default',    order: 4, desc: '온라인이지만 재생·녹화·조작 없음' },
  offline:   { label: '오프라인', color: '#595959', tag: 'default',    order: 5, desc: '45초 이상 상태 보고 없음' },
};
const LEGEND_ORDER: StateKey[] = ['playing', 'paused', 'recording', 'in_use', 'idle', 'offline'];

/** 카드 색·태그·정렬의 기준이 되는 단일 상태. */
function stateOf(a: Agent): StateKey {
  if (!a.online) return 'offline';
  if (a.activity === 'playing') return a.playback?.status === 'paused' ? 'paused' : 'playing';
  if (a.activity === 'recording') return 'recording';
  if (a.activity === 'in_use') return 'in_use';
  return 'idle';
}

/** #rrggbb → rgba(). 반투명 틴트라 라이트/다크 어느 테마 위에 얹혀도 그대로 읽힌다
 *  (불투명 색을 쓰면 다크 모드에서 글자가 묻힌다). */
function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ── 정렬 ──
// 기본값은 **연결 순서 고정**(default) — 2초마다 폴링하므로 상태순으로 두면 카드가 계속
// 자리를 옮겨 눈으로 따라가기 어렵다. 필요할 때만 상태순으로 바꿔 쓰도록 선택지로 둔다.
type SortKey = 'default' | 'state' | 'name';
const SORT_KEY = 'fleet_sort';
const SORT_OPTIONS = [
  { label: '연결순', value: 'default' },
  { label: '상태순', value: 'state' },
  { label: '이름순', value: 'name' },
];

function agentName(a: Agent): string {
  return a.name || a.client_id;
}

function sortAgents(list: Agent[], sort: SortKey): Agent[] {
  if (sort === 'default') return list;   // 원본(연결 순서) 유지
  const arr = [...list];
  if (sort === 'name') {
    arr.sort((x, y) => agentName(x).localeCompare(agentName(y)));
  } else {
    // 상태가 같으면 이름순 — 같은 상태 안에서는 순서가 흔들리지 않는다.
    arr.sort((x, y) =>
      STATE[stateOf(x)].order - STATE[stateOf(y)].order ||
      agentName(x).localeCompare(agentName(y)));
  }
  return arr;
}

// 카드 고정 높이 — 재생 여부/디바이스 수에 따라 크기가 변하지 않게 한다.
const CARD_HEIGHT = 104;
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

function playbackTooltip(a: Agent) {
  const pb = a.playback;
  if (!pb) return `재생 중 아님 · 시나리오 ${a.scenario_count}개 보유`;
  return (
    <div style={{ maxWidth: 320, fontSize: 11, lineHeight: 1.7 }}>
      <div><b>{pb.scenario_name}</b></div>
      <div>회차 {pb.current_cycle}/{pb.total_cycles || '?'} · 스텝 {pb.current_step}/{pb.total_steps}</div>
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
  const [sort, setSort] = useState<SortKey>(
    () => (localStorage.getItem(SORT_KEY) as SortKey) || 'default');
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
          저장된 함수통계 스냅샷도 함께 삭제됩니다.<br />
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
    const cyclePct = cycleTotal > 0 ? Math.round((pb!.current_cycle / cycleTotal) * 100) : 0;
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
          {/* 1행 — 상태점 + 호스트명(말줄임) + OS + 삭제(오프라인만) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <Badge status={a.online ? 'success' : 'default'} />
            <Tooltip title={hostTooltip(a)}>
              <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                {a.name || a.client_id}
              </Typography.Text>
            </Tooltip>
            {a.os && (
              <Tag color={a.os === 'Linux' ? 'gold' : 'geekblue'} style={MINI_TAG}>{a.os}</Tag>
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

          {/* 3행 — 재생 진행 (재생 여부와 무관하게 같은 높이를 차지해 카드 크기 고정) */}
          <Tooltip title={playbackTooltip(a)}>
            <div style={{ marginTop: 6, height: 20, display: 'flex', alignItems: 'center', gap: 6, cursor: 'default' }}>
              {pb ? (
                <>
                  <Progress percent={cyclePct} size="small" showInfo={false} style={{ flex: 1, margin: 0 }} />
                  <span style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{pb.current_cycle}/{cycleTotal || '?'}</span>
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

  // 2초 폴링마다 재정렬되므로 memo — agents/sort 가 바뀔 때만 계산한다.
  const onlineAgents = useMemo(
    () => sortAgents(agents.filter(a => a.online), sort), [agents, sort]);
  const offlineAgents = useMemo(
    () => sortAgents(agents.filter(a => !a.online), sort), [agents, sort]);
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 1 }}>
          {LEGEND_ORDER.map(k => (
            <Tooltip key={k} title={STATE[k].desc}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'default' }}>
                <span style={{
                  width: 10, height: 10, borderRadius: 3,
                  background: STATE[k].color, display: 'inline-block',
                }} />
                {STATE[k].label}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {stateCount[k] || 0}
                </Typography.Text>
              </span>
            </Tooltip>
          ))}
        </div>
        <Tooltip title="연결순 = 접속한 순서 고정(카드가 자리를 옮기지 않음) · 상태순 = 재생 중부터 위로">
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
          {/* 활성 / 비활성을 크게 나눠 표시. 섹션 내 순서는 정렬 선택(sort)을 따르고,
              기본값 '연결순' 에서는 온라인/오프라인이 바뀌어도 카드가 자리를 옮기지 않는다. */}
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
