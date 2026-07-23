import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Progress, Row, Segmented, Select, Statistic, Table, Tooltip, Typography } from 'antd';
import { AreaChartOutlined, DatabaseOutlined, ReloadOutlined } from '@ant-design/icons';
import { agentApi } from '../services/api';
import { ACTIVE_STATES, STATE, STATE_ORDER, StateKey } from '../lib/agentState';
import StackedBars, { Bucket, StateLegend } from '../components/StackedBars';
import HistoryManageModal from '../components/HistoryManageModal';

type Counts = Partial<Record<StateKey, number>>;
interface RawBucket { t: number; ticks: number; counts: Counts }
interface RawHour { hour: number; ticks: number; counts: Counts }
interface AgentTotals {
  client_id: string; name: string; samples: number; counts: Counts;
  // 로그인 사용자 메타 (현재 값 기준 — 과거 소급 없음)
  user_name?: string; user_team?: string; project?: string;
}
interface AgentMeta { client_id: string; host: string; user_name: string; user_team: string; project: string }
interface History {
  range: string;
  since: number;
  now: number;
  bucket_sec: number;
  sample_interval_sec: number;
  total_ticks: number;
  buckets: RawBucket[];
  hours: RawHour[];
  agents: AgentTotals[];
}

/** 휠 줌 단계 — 막대 하나가 담는 시간. 백엔드 ALL_BUCKET_STEPS 와 같은 값. */
const ZOOMS = [
  { sec: 600, label: '10분' },
  { sec: 1800, label: '30분' },
  { sec: 3600, label: '1시간' },
  { sec: 3 * 3600, label: '3시간' },
  { sec: 6 * 3600, label: '6시간' },
  { sec: 12 * 3600, label: '12시간' },
  { sec: 86400, label: '1일' },
];
const BAR_W = 12;            // 막대 폭(px)
const CELL = BAR_W + 1;      // 막대 + 간격 1px
const CHUNK = 16;            // 가상 스크롤 시작 인덱스 양자화 — 스크롤 중 리렌더 억제
const BUF = 8;               // 화면 밖 여유 렌더 막대 수
// 서버(로컬 tz)와 같은 기준으로 버킷 경계를 맞추기 위한 오프셋(초)
const TZ_OFF = -new Date().getTimezoneOffset() * 60;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 버킷 크기에 맞춘 x축 라벨 — 날짜와 시각을 **함께** 표기한다.
 *  시각만 쓰면 길게 스크롤했을 때 지금 보는 구간이 며칠인지 알 수 없다. */
function bucketLabel(t: number, bucketSec: number): string {
  const d = new Date(t * 1000);
  const day = `${d.getMonth() + 1}/${d.getDate()}`;
  if (bucketSec >= 86400) return day;
  if (bucketSec < 3600) return `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${day} ${pad2(d.getHours())}시`;
}

function bucketTip(t: number, bucketSec: number): string {
  const s = new Date(t * 1000);
  const e = new Date((t + bucketSec) * 1000);
  const day = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  if (bucketSec > 86400) return `${day(s)} ~ ${day(e)}`;
  if (bucketSec === 86400) return `${day(s)} (하루)`;
  const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${day(s)} ${hm(s)} ~ ${hm(e)}`;
}

/** 라벨 간격(버킷 수) — 라벨끼리 최소 ~90px 은 떨어지도록(날짜+시각을 함께 쓰므로
 *  라벨이 길다). 정각/자정 등 '깔끔한' 시각에 라벨이 붙게 시간 기준으로 거른다. */
function labelStep(): number {
  const need = Math.ceil(90 / CELL);
  return [1, 2, 3, 4, 6, 8, 12, 24, 48].find(s => s >= need) ?? 48;
}

function fmtDay(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 기간 표기는 날짜만이 아니라 시각까지 — "언제부터 언제까지"가 정확히 보이게.
function fmtDayTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${fmtDay(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function sum(c: Counts, keys: StateKey[] = STATE_ORDER): number {
  return keys.reduce((s, k) => s + (c[k] || 0), 0);
}

/** 서버가 준 세밀한 버킷을 목표 스케일로 재집계. counts/ticks 는 단순 합산이 정확 —
 *  버킷들이 시간을 빈틈없이 분할하므로 tick(=DISTINCT ts) 수도 그대로 더해진다. */
function rebucket(buckets: RawBucket[], baseSec: number, targetSec: number): RawBucket[] {
  if (targetSec <= baseSec) return buckets;
  const floorT = (t: number) => Math.floor((t + TZ_OFF) / targetSec) * targetSec - TZ_OFF;
  const out: RawBucket[] = [];
  let cur: RawBucket | null = null;
  for (const b of buckets) {
    const t = floorT(b.t);
    if (!cur || cur.t !== t) {
      cur = { t, ticks: 0, counts: {} };
      out.push(cur);
    }
    cur.ticks += b.ticks;
    for (const k of STATE_ORDER) {
      const v = b.counts[k];
      if (v) cur.counts[k] = (cur.counts[k] || 0) + v;
    }
  }
  return out;
}

/**
 * 사용량 통계 — 테스트 PC 들이 시간대별로 어떤 상태였는지 그래프로 본다.
 * 원본은 매니저가 60초마다 찍는 상태 샘플(agent_state_samples)이라,
 * **매니저를 켜 둔 시점부터** 데이터가 쌓인다(과거 소급 없음).
 *
 * 그래프는 전체 이력을 한 번에 받아 두고, 휠로 스케일(막대당 시간)을 바꾸고
 * 가로 스크롤로 기간을 오간다. 막대가 수천 개가 될 수 있어 화면에 보이는
 * 구간만 렌더한다(가상 스크롤 — 앞뒤는 폭만 유지하는 스페이서).
 */
export default function UsageStatsPage() {
  const [zoomSec, setZoomSec] = useState(3600);
  const [mode, setMode] = useState<'avg' | 'pct'>('avg');
  const [data, setData] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  // 부서/프로젝트 필터 ('' = 전체) — 서버가 해당 PC 들만 집계해 내려준다
  const [teamFilter, setTeamFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  // 시간대별 그래프의 대상 날짜 ('' = 기간 전체 평균, 그 외 = 그 날 0시 epoch 초)
  const [hourlyDay, setHourlyDay] = useState('');
  const [meta, setMeta] = useState<AgentMeta[]>([]);
  const [view, setView] = useState({ start: 0, count: 160 });
  const timer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 줌 직후 스크롤 위치 복원용 — 커서(또는 화면 중앙) 아래 시각을 고정한다.
  const anchorRef = useRef<{ time: number; vx: number } | null>(null);
  // 오른쪽 끝(최신)에 붙어 있으면 새 데이터가 와도 계속 최신을 따라간다.
  const stickRightRef = useRef(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await agentApi.stateHistory('all', {
        team: teamFilter || undefined,
        project: projectFilter || undefined,
      });
      setData(res.data);
    } catch {
      /* 폴링 중 일시 실패 무시 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // 1분에 한 번만 — 원본 샘플이 60초 주기라 더 자주 받아도 그림이 안 바뀐다.
    timer.current = window.setInterval(load, 60000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamFilter, projectFilter]);

  // 필터 옵션 원본 — 전체 PC 메타 (필터와 무관하게 항상 전체 목록에서 뽑는다)
  useEffect(() => {
    agentApi.meta().then(r => setMeta(r.data.agents || [])).catch(() => {});
  }, []);
  const teamOptions = useMemo(
    () => Array.from(new Set(meta.map(m => m.user_team).filter(Boolean))).sort(), [meta]);
  const projectOptions = useMemo(
    () => Array.from(new Set(meta.map(m => m.project).filter(Boolean))).sort(), [meta]);

  // 서버 기본 버킷보다 세밀한 줌은 불가 — 이력이 아주 길면 최소 단계가 올라간다.
  const levels = useMemo(
    () => ZOOMS.filter(z => z.sec >= (data?.bucket_sec ?? ZOOMS[0].sec)),
    [data?.bucket_sec],
  );
  const zoom = (levels.find(z => z.sec >= zoomSec) ?? levels[levels.length - 1]).sec;

  const rebucketed = useMemo(
    () => (data ? rebucket(data.buckets, data.bucket_sec, zoom) : []),
    [data, zoom],
  );

  const timeline: Bucket[] = useMemo(() => {
    const every = zoom * labelStep();
    return rebucketed.map(b => ({
      key: String(b.t),
      label: (b.t + TZ_OFF) % every === 0 ? bucketLabel(b.t, zoom) : '',
      tipTitle: bucketTip(b.t, zoom),
      ticks: b.ticks,
      counts: b.counts,
    }));
  }, [rebucketed, zoom]);

  // avg 모드 세로축 최대 — 보이는 구간만 렌더해도 스케일은 전체 기준으로 고정.
  const chartMax = useMemo(() => {
    let m = 1;
    for (const b of rebucketed) {
      if (b.ticks > 0) m = Math.max(m, sum(b.counts) / b.ticks);
    }
    return m;
  }, [rebucketed]);

  const updateView = () => {
    const el = scrollRef.current;
    if (!el) return;
    const raw = Math.max(0, Math.floor(el.scrollLeft / CELL) - BUF);
    const start = Math.floor(raw / CHUNK) * CHUNK;
    const count = Math.ceil(el.clientWidth / CELL) + BUF * 2 + CHUNK;
    setView(v => (v.start === start && v.count === count ? v : { start, count }));
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRightRef.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - CELL * 2;
    updateView();
  };

  // 데이터/줌이 바뀐 직후: 앵커 시각을 같은 화면 위치로 되돌리거나, 최신 끝에 붙인다.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const a = anchorRef.current;
    if (a) {
      anchorRef.current = null;
      const idx = rebucketed.findIndex(b => b.t <= a.time && a.time < b.t + zoom);
      if (idx >= 0) el.scrollLeft = Math.max(0, idx * CELL + CELL / 2 - a.vx);
    } else if (stickRightRef.current) {
      el.scrollLeft = el.scrollWidth;
    }
    updateView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebucketed]);

  // 휠 = 줌 (Shift+휠 = 브라우저 기본 가로 스크롤). preventDefault 가 필요해서
  // React 합성 이벤트 대신 non-passive 리스너를 직접 단다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || e.deltaY === 0) return;
      e.preventDefault();
      const li = levels.findIndex(z => z.sec === zoom);
      const ni = Math.min(levels.length - 1, Math.max(0, li + (e.deltaY > 0 ? 1 : -1)));
      if (ni === li) return;
      const vx = e.clientX - el.getBoundingClientRect().left;
      const idx = Math.min(rebucketed.length - 1, Math.max(0, Math.floor((el.scrollLeft + vx) / CELL)));
      const b = rebucketed[idx];
      if (b) anchorRef.current = { time: b.t + zoom / 2, vx };
      setZoomSec(levels[ni].sec);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [levels, zoom, rebucketed]);

  useEffect(() => {
    window.addEventListener('resize', updateView);
    return () => window.removeEventListener('resize', updateView);
  }, []);

  /** 줌 버튼 선택 — 화면 중앙 시각을 앵커로 잡고 스케일만 바꾼다. */
  const onZoomSelect = (sec: number) => {
    const el = scrollRef.current;
    if (el && rebucketed.length) {
      const vx = el.clientWidth / 2;
      const idx = Math.min(rebucketed.length - 1, Math.max(0, Math.floor((el.scrollLeft + vx) / CELL)));
      anchorRef.current = { time: rebucketed[idx].t + zoom / 2, vx };
    }
    setZoomSec(sec);
  };

  // 시간대별 그래프에서 선택 가능한 날짜들 — 데이터가 있는 날만 (로컬 tz 기준 그 날 0시)
  const dayOptions = useMemo(() => {
    if (!data) return [] as number[];
    const days = new Set<number>();
    for (const b of data.buckets) {
      if (b.ticks > 0) days.add(Math.floor((b.t + TZ_OFF) / 86400) * 86400 - TZ_OFF);
    }
    return Array.from(days).sort((x, y) => x - y);
  }, [data]);

  const hourly: Bucket[] = useMemo(() => {
    if (!data) return [];
    let hrs: RawHour[];
    let tipSuffix = '(기간 평균)';
    if (hourlyDay) {
      // 특정 날짜 — 서버의 hours 는 기간 전체 평균뿐이라, 원본 버킷을 그 날의
      // 시(hour)별로 직접 재집계한다. 0~23시를 전부 채워 축이 흔들리지 않게 한다.
      const day = Number(hourlyDay);
      const acc: RawHour[] = Array.from({ length: 24 }, (_, hour) => ({ hour, ticks: 0, counts: {} }));
      for (const b of data.buckets) {
        if (b.t < day || b.t >= day + 86400) continue;
        const h = acc[new Date(b.t * 1000).getHours()];
        h.ticks += b.ticks;
        for (const k of STATE_ORDER) {
          const v = b.counts[k];
          if (v) h.counts[k] = (h.counts[k] || 0) + v;
        }
      }
      hrs = acc;
      tipSuffix = `(${fmtDay(day)})`;
    } else {
      hrs = data.hours;
    }
    return hrs.map(h => ({
      key: String(h.hour),
      label: h.hour % 2 === 0 ? `${h.hour}시` : '',
      tipTitle: `${pad2(h.hour)}:00 ~ ${pad2((h.hour + 1) % 24)}:00 ${tipSuffix}`,
      ticks: h.ticks,
      counts: h.counts,
    }));
  }, [data, hourlyDay]);

  // 기간 전체 합계 — 가동률/평균 대수 계산의 분모.
  const total = useMemo(() => {
    const c: Counts = {};
    (data?.agents || []).forEach(a => {
      STATE_ORDER.forEach(k => { c[k] = (c[k] || 0) + (a.counts[k] || 0); });
    });
    return c;
  }, [data]);

  const totalSamples = sum(total);
  const activeSamples = sum(total, ACTIVE_STATES);
  const onlineSamples = totalSamples - (total.offline || 0);
  const ticks = data?.total_ticks || 0;
  // 평균 동시 재생 대수 = 재생/일시정지 샘플 수 ÷ tick 수
  const avgPlaying = ticks > 0 ? ((total.playing || 0) + (total.paused || 0)) / ticks : 0;
  const avgOnline = ticks > 0 ? onlineSamples / ticks : 0;
  const utilization = onlineSamples > 0 ? (activeSamples / onlineSamples) * 100 : 0;

  /** 그래프 자동 해석 — 숫자를 문장으로 풀어 요약한다.
   *  피크 탐색은 줌과 무관하게 **1시간 스케일 고정**으로 계산한다(줌을 바꿀 때마다
   *  요약이 달라지면 해석이 아니라 화면 설명이 되어 버린다). */
  const summaryLines = useMemo(() => {
    if (!data || ticks === 0) return [];
    const lines: string[] = [];

    // 기간 길이
    const spanSec = Math.max(0, data.now - data.since);
    const spanTxt = spanSec < 86400
      ? `약 ${(spanSec / 3600).toFixed(1)}시간`
      : `약 ${(spanSec / 86400).toFixed(1)}일`;
    lines.push(
      `${fmtDayTime(data.since)} ~ ${fmtDayTime(data.now)} (${spanTxt}) 동안 평균 ${avgOnline.toFixed(1)}대가 온라인이었고, `
      + `온라인 시간의 ${utilization.toFixed(1)}% 를 재생·녹화·조작에 사용했습니다.`);

    // 동시 재생 피크 (1시간 버킷 기준)
    const hourSec = Math.max(3600, data.bucket_sec);
    let peak: { t: number; v: number } | null = null;
    for (const b of rebucket(data.buckets, data.bucket_sec, hourSec)) {
      if (b.ticks === 0) continue;
      const v = ((b.counts.playing || 0) + (b.counts.paused || 0)) / b.ticks;
      if (v > 0 && (!peak || v > peak.v)) peak = { t: b.t, v };
    }
    if (peak) {
      lines.push(
        `동시 재생이 가장 많았던 때는 ${bucketLabel(peak.t, hourSec)} 로, 평균 ${peak.v.toFixed(1)}대가 재생 중이었습니다.`);
    } else {
      lines.push('집계 기간 동안 시나리오 재생 기록이 없습니다.');
    }

    // 하루 중 가장 많이 쓰는 시간대 (기간 전체를 하루로 접은 평균)
    const hourAvg = data.hours
      .filter(h => h.ticks > 0)
      .map(h => ({ hour: h.hour, v: sum(h.counts, ACTIVE_STATES) / h.ticks }));
    const busiest = hourAvg.reduce<{ hour: number; v: number } | null>(
      (a, b) => (b.v > (a?.v ?? 0) ? b : a), null);
    if (busiest && busiest.v > 0) {
      lines.push(`하루 중에는 ${busiest.hour}시대 사용이 가장 많습니다 (기간 평균 ${busiest.v.toFixed(1)}대 가동).`);
    }
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ticks, avgOnline, utilization]);

  const columns = [
    {
      title: 'PC', dataIndex: 'name', key: 'name', width: 160, ellipsis: true,
      sorter: (a: AgentTotals, b: AgentTotals) => a.name.localeCompare(b.name),
      render: (v: string, r: AgentTotals) => <Tooltip title={r.client_id}><span>{v}</span></Tooltip>,
    },
    {
      title: '사용자', dataIndex: 'user_name', key: 'user_name', width: 90, ellipsis: true,
      sorter: (a: AgentTotals, b: AgentTotals) => (a.user_name || '').localeCompare(b.user_name || ''),
      render: (v: string) => v || <span style={{ opacity: 0.4 }}>-</span>,
    },
    {
      title: '부서', dataIndex: 'user_team', key: 'user_team', width: 140, ellipsis: true,
      sorter: (a: AgentTotals, b: AgentTotals) => (a.user_team || '').localeCompare(b.user_team || ''),
      render: (v: string) => v || <span style={{ opacity: 0.4 }}>-</span>,
    },
    {
      title: '프로젝트', dataIndex: 'project', key: 'project', width: 90, ellipsis: true,
      sorter: (a: AgentTotals, b: AgentTotals) => (a.project || '').localeCompare(b.project || ''),
      render: (v: string) => v || <span style={{ opacity: 0.4 }}>-</span>,
    },
    {
      title: '가동률', key: 'util', width: 130,
      defaultSortOrder: 'descend' as const,
      sorter: (a: AgentTotals, b: AgentTotals) => utilOf(a) - utilOf(b),
      render: (_: unknown, r: AgentTotals) => (
        <Tooltip title="온라인이었던 시간 중 재생·녹화·조작 상태였던 비율">
          <Progress
            percent={Math.round(utilOf(r))} size="small"
            strokeColor={STATE.playing.color}
            format={(p) => <span style={{ fontSize: 11 }}>{p}%</span>}
          />
        </Tooltip>
      ),
    },
    {
      title: '상태 분포', key: 'dist',
      render: (_: unknown, r: AgentTotals) => {
        const t = sum(r.counts) || 1;
        return (
          <Tooltip title={
            <div style={{ fontSize: 11, lineHeight: 1.7 }}>
              {STATE_ORDER.filter(k => (r.counts[k] || 0) > 0).map(k => (
                <div key={k}>
                  <span style={{ color: STATE[k].color }}>■</span> {STATE[k].label}{' '}
                  {Math.round(((r.counts[k] || 0) / t) * 100)}%
                  {' '}({hoursOf(r.counts[k] || 0, data?.sample_interval_sec || 60)})
                </div>
              ))}
            </div>
          }>
            <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', cursor: 'default' }}>
              {STATE_ORDER.map(k => {
                const v = r.counts[k] || 0;
                if (!v) return null;
                return <div key={k} style={{ width: `${(v / t) * 100}%`, background: STATE[k].color }} />;
              })}
            </div>
          </Tooltip>
        );
      },
    },
  ];

  const noData = !!data && ticks === 0;

  // 가상 스크롤 — 보이는 구간만 잘라 렌더, 앞뒤는 스페이서로 폭만 유지.
  const sliceStart = Math.min(view.start, Math.max(0, timeline.length - 1));
  const slice = timeline.slice(sliceStart, sliceStart + view.count);
  const padLeft = sliceStart * CELL;
  const padRight = Math.max(0, (timeline.length - sliceStart - slice.length) * CELL);

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        <AreaChartOutlined /> 사용량 통계
        <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading} style={{ marginLeft: 12 }}>
          새로고침
        </Button>
        <Button size="small" icon={<DatabaseOutlined />} onClick={() => setManageOpen(true)} style={{ marginLeft: 8 }}>
          이력 관리
        </Button>
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        관제 서버가 {data?.sample_interval_sec ?? 60}초마다 기록한 전 PC 의 상태를 <b>전체 기간</b>에 대해 집계합니다.
        그래프 위에서 <b>마우스 휠 = 확대/축소</b>, <b>Shift+휠 또는 스크롤바 = 기간 이동</b>입니다.
        기록은 매니저가 켜져 있는 동안만 쌓이고, 자동 삭제 없이 무기한 보관됩니다
        (정리는 <b>이력 관리</b>에서 직접). 막대에 마우스를 올리면 상세가 보입니다.
      </Typography.Paragraph>

      <HistoryManageModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onChanged={load}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <Tooltip title="막대 하나가 담는 시간 — 그래프 위에서 휠로도 바뀝니다">
          <Segmented
            value={zoom}
            onChange={(v) => onZoomSelect(v as number)}
            options={levels.map(z => ({ label: z.label, value: z.sec }))}
          />
        </Tooltip>
        <Tooltip title="대수 = 평균 동시 PC 수 · 비율 = 상태 구성비(막대 높이 고정)">
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'avg' | 'pct')}
            options={[{ label: '대수', value: 'avg' }, { label: '비율', value: 'pct' }]}
          />
        </Tooltip>
        {/* 부서/프로젝트 필터 — 해당 사용자가 로그인한 PC 들만 집계 (현재 값 기준) */}
        <Select
          style={{ minWidth: 140 }} allowClear
          placeholder="부서 전체"
          value={teamFilter || undefined}
          onChange={(v) => setTeamFilter(v || '')}
          options={teamOptions.map(t => ({ label: t, value: t }))}
          showSearch optionFilterProp="label"
        />
        <Select
          style={{ minWidth: 120 }} allowClear
          placeholder="프로젝트 전체"
          value={projectFilter || undefined}
          onChange={(v) => setProjectFilter(v || '')}
          options={projectOptions.map(p => ({ label: p, value: p }))}
          showSearch optionFilterProp="label"
        />
        {(teamFilter || projectFilter) && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            필터는 <b>현재</b> 로그인 사용자 기준입니다 (과거 소급 없음)
          </Typography.Text>
        )}
      </div>

      {noData && (
        <Alert
          type="info" showIcon style={{ marginBottom: 16 }}
          message="아직 집계된 사용 이력이 없습니다"
          description="이 기능은 관제 서버가 기록을 시작한 이후부터 쌓입니다. 서버를 켜 둔 채로 잠시 기다린 뒤 다시 확인하세요."
        />
      )}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="평균 가동률" value={utilization} precision={1} suffix="%"
              valueStyle={{ color: STATE.playing.color }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title="평균 동시 재생" value={avgPlaying} precision={1} suffix="대" /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title="평균 온라인" value={avgOnline} precision={1} suffix="대" /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Tooltip title="기간 내 전 PC 의 재생 시간 합계 (PC 2대가 1시간씩 돌면 2시간)">
            <Card size="small">
              <Statistic title="총 재생 시간 (전 PC 합)"
                value={hoursOf((total.playing || 0) + (total.paused || 0), data?.sample_interval_sec || 60)} />
            </Card>
          </Tooltip>
        </Col>
      </Row>

      {/* 그래프 해석 요약 — 그래프에서 읽어야 할 결론을 문장으로 먼저 보여준다 */}
      {summaryLines.length > 0 && (
        <Card size="small" style={{ marginBottom: 16 }}
          title={<span style={{ fontSize: 13 }}>요약 — 그래프 해석</span>}
        >
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 2.1 }}>
            {summaryLines.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </Card>
      )}

      <Card size="small" style={{ marginBottom: 16 }}
        title={
          <span style={{ fontSize: 13 }}>
            상태 추이{data ? ` (${fmtDayTime(data.since)} ~ ${fmtDayTime(data.now)})` : ''}
          </span>
        }
        extra={<StateLegend />}
      >
        {timeline.length === 0 ? <Empty description="데이터 없음" /> : (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            style={{ overflowX: 'auto', overflowY: 'hidden', paddingBottom: 4 }}
          >
            <StackedBars
              data={slice} mode={mode}
              barWidth={BAR_W} padLeft={padLeft} padRight={padRight}
              max={mode === 'avg' ? chartMax : undefined}
            />
          </div>
        )}
      </Card>

      <Card size="small" style={{ marginBottom: 16 }}
        title={
          <span style={{ fontSize: 13 }}>
            시간대별 평균 (0~23시{hourlyDay ? ` — ${fmtDay(Number(hourlyDay))} 하루` : ', 기간 전체를 하루로 접음'})
          </span>
        }
        extra={
          // 날짜별 보기 — '기간 전체' 는 전 기간을 하루로 접은 평균, 날짜 선택 시 그 날만
          <Select
            size="small" style={{ width: 110 }}
            value={hourlyDay}
            onChange={(v) => setHourlyDay(v)}
            options={[
              { label: '기간 전체', value: '' },
              ...dayOptions.map(d => ({ label: fmtDay(d), value: String(d) })),
            ]}
          />
        }
      >
        {hourly.length === 0 ? <Empty description="데이터 없음" /> : <StackedBars data={hourly} mode={mode} height={140} />}
      </Card>

      <Card size="small" title={<span style={{ fontSize: 13 }}>PC별 가동률</span>}>
        <Table
          size="small"
          rowKey="client_id"
          dataSource={data?.agents || []}
          columns={columns}
          pagination={false}
          scroll={{ y: 320 }}
          locale={{ emptyText: '데이터 없음' }}
        />
      </Card>
    </div>
  );

  /** 온라인이었던 표본 중 '가동' 상태 비율(%). 오프라인 시간은 분모에서 뺀다 —
   *  꺼 둔 PC 가 가동률 0% 로 잡히면 실제 활용도를 못 본다. */
  function utilOf(a: AgentTotals): number {
    const online = sum(a.counts) - (a.counts.offline || 0);
    return online > 0 ? (sum(a.counts, ACTIVE_STATES) / online) * 100 : 0;
  }
}

/** 샘플 수 → 사람이 읽는 시간. (샘플 1개 = sample_interval_sec 초) */
function hoursOf(samples: number, intervalSec: number): string {
  const min = (samples * intervalSec) / 60;
  if (min < 60) return `${Math.round(min)}분`;
  const h = min / 60;
  return h < 24 ? `${h.toFixed(1)}시간` : `${(h / 24).toFixed(1)}일`;
}
