import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Progress, Row, Segmented, Statistic, Table, Tooltip, Typography } from 'antd';
import { AreaChartOutlined, DatabaseOutlined, ReloadOutlined } from '@ant-design/icons';
import { agentApi } from '../services/api';
import { ACTIVE_STATES, STATE, STATE_ORDER, StateKey } from '../lib/agentState';
import StackedBars, { Bucket, StateLegend } from '../components/StackedBars';
import HistoryManageModal from '../components/HistoryManageModal';

type Counts = Partial<Record<StateKey, number>>;
interface RawBucket { t: number; ticks: number; counts: Counts }
interface RawHour { hour: number; ticks: number; counts: Counts }
interface AgentTotals { client_id: string; name: string; samples: number; counts: Counts }
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

type RangeKey = '1d' | '7d' | '30d';
const RANGE_OPTIONS = [
  { label: '1일', value: '1d' },
  { label: '7일', value: '7d' },
  { label: '한달', value: '30d' },
];
const RANGE_LABEL: Record<string, string> = { '1d': '최근 24시간', '7d': '최근 7일', '30d': '최근 30일' };

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 버킷 크기에 맞춘 x축 라벨. 1시간 버킷은 "14시", 6시간은 "3일 12시", 1일은 "3/14". */
function bucketLabel(t: number, bucketSec: number): string {
  const d = new Date(t * 1000);
  if (bucketSec >= 86400) return `${d.getMonth() + 1}/${d.getDate()}`;
  if (bucketSec >= 6 * 3600) return d.getHours() === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : `${pad2(d.getHours())}시`;
  return `${pad2(d.getHours())}시`;
}

function bucketTip(t: number, bucketSec: number): string {
  const s = new Date(t * 1000);
  const e = new Date((t + bucketSec) * 1000);
  const day = `${s.getMonth() + 1}/${s.getDate()}`;
  if (bucketSec >= 86400) return `${day} (하루)`;
  return `${day} ${pad2(s.getHours())}:00 ~ ${pad2(e.getHours())}:00`;
}

/** 라벨이 겹치지 않도록 대략 12개만 남기고 솎아낸다. */
function thinLabels(n: number): number {
  return Math.max(1, Math.ceil(n / 12));
}

function sum(c: Counts, keys: StateKey[] = STATE_ORDER): number {
  return keys.reduce((s, k) => s + (c[k] || 0), 0);
}

/**
 * 사용량 통계 — 테스트 PC 들이 시간대별로 어떤 상태였는지 그래프로 본다.
 * 원본은 매니저가 60초마다 찍는 상태 샘플(agent_state_samples)이라,
 * **매니저를 켜 둔 시점부터** 데이터가 쌓인다(과거 소급 없음).
 */
export default function UsageStatsPage() {
  const [range, setRange] = useState<RangeKey>('1d');
  const [mode, setMode] = useState<'avg' | 'pct'>('avg');
  const [data, setData] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const load = async (r: RangeKey) => {
    setLoading(true);
    try {
      const res = await agentApi.stateHistory(r);
      setData(res.data);
    } catch {
      /* 폴링 중 일시 실패 무시 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(range);
    // 1분에 한 번만 — 원본 샘플이 60초 주기라 더 자주 받아도 그림이 안 바뀐다.
    timer.current = window.setInterval(() => load(range), 60000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [range]);

  const timeline: Bucket[] = useMemo(() => {
    if (!data) return [];
    const step = thinLabels(data.buckets.length);
    return data.buckets.map((b, i) => ({
      key: String(b.t),
      label: i % step === 0 ? bucketLabel(b.t, data.bucket_sec) : '',
      tipTitle: bucketTip(b.t, data.bucket_sec),
      ticks: b.ticks,
      counts: b.counts,
    }));
  }, [data]);

  const hourly: Bucket[] = useMemo(() => {
    if (!data) return [];
    return data.hours.map(h => ({
      key: String(h.hour),
      label: h.hour % 2 === 0 ? `${h.hour}시` : '',
      tipTitle: `${pad2(h.hour)}:00 ~ ${pad2((h.hour + 1) % 24)}:00 (기간 평균)`,
      ticks: h.ticks,
      counts: h.counts,
    }));
  }, [data]);

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

  const columns = [
    {
      title: 'PC', dataIndex: 'name', key: 'name', width: 160, ellipsis: true,
      sorter: (a: AgentTotals, b: AgentTotals) => a.name.localeCompare(b.name),
      render: (v: string, r: AgentTotals) => <Tooltip title={r.client_id}><span>{v}</span></Tooltip>,
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

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        <AreaChartOutlined /> 사용량 통계
        <Button size="small" icon={<ReloadOutlined />} onClick={() => load(range)} loading={loading} style={{ marginLeft: 12 }}>
          새로고침
        </Button>
        <Button size="small" icon={<DatabaseOutlined />} onClick={() => setManageOpen(true)} style={{ marginLeft: 8 }}>
          이력 관리
        </Button>
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        관제 서버가 {data?.sample_interval_sec ?? 60}초마다 기록한 전 PC 의 상태를 시간대별로 집계합니다.
        기록은 <b>매니저가 켜져 있는 동안만</b> 쌓이고, <b>자동 삭제 없이 무기한 보관</b>됩니다
        (정리는 <b>이력 관리</b>에서 직접). 막대에 마우스를 올리면 상세가 보입니다.
      </Typography.Paragraph>

      <HistoryManageModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onChanged={() => load(range)}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <Segmented value={range} onChange={(v) => setRange(v as RangeKey)} options={RANGE_OPTIONS} />
        <Tooltip title="대수 = 평균 동시 PC 수 · 비율 = 상태 구성비(막대 높이 고정)">
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'avg' | 'pct')}
            options={[{ label: '대수', value: 'avg' }, { label: '비율', value: 'pct' }]}
          />
        </Tooltip>
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

      <Card size="small" style={{ marginBottom: 16 }}
        title={<span style={{ fontSize: 13 }}>{RANGE_LABEL[range]} 상태 추이</span>}
        extra={<StateLegend />}
      >
        {timeline.length === 0 ? <Empty description="데이터 없음" /> : <StackedBars data={timeline} mode={mode} />}
      </Card>

      <Card size="small" style={{ marginBottom: 16 }}
        title={<span style={{ fontSize: 13 }}>시간대별 평균 (0~23시, 기간 전체를 하루로 접음)</span>}
        extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>몇 시에 가장 많이 쓰는지</Typography.Text>}
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
