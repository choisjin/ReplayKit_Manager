import { useEffect, useState } from 'react';
import { App, Button, Checkbox, DatePicker, Descriptions, Modal, Radio, Table, Tooltip, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { agentApi } from '../services/api';

interface PerAgent {
  client_id: string;
  name: string;
  rows: number;
  oldest_ts: number | null;
  newest_ts: number | null;
}
export interface HistoryInfo {
  rows: number;
  ticks: number;
  agents: number;
  oldest_ts: number | null;
  newest_ts: number | null;
  approx_bytes: number;
  db_bytes: number;
  per_agent: PerAgent[];
}

// 삭제 기준 — '전체' 만 기간 제한이 없다(= 전부 삭제).
type Scope = '30d' | '90d' | '365d' | 'date' | 'all';
const SCOPE_DAYS: Record<string, number> = { '30d': 30, '90d': 90, '365d': 365 };

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtTs(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString() : '-';
}
function daysBetween(a: number | null, b: number | null): string {
  if (!a || !b) return '-';
  const d = (b - a) / 86400;
  return d < 1 ? `${Math.round(d * 24)}시간` : `${d.toFixed(1)}일`;
}

/**
 * 사용 이력(상태 샘플) 관리 — 보관은 **무기한**이라 정리는 전적으로 여기서 수동으로 한다.
 * 기간 기준 삭제 / PC 단위 삭제 / 전체 삭제를 제공하고, 삭제 후 파일 공간 회수(VACUUM)를 고른다.
 */
export default function HistoryManageModal(
  { open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void },
) {
  const { message, modal } = App.useApp();
  const [info, setInfo] = useState<HistoryInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<Scope>('90d');
  const [date, setDate] = useState<{ valueOf(): number } | null>(null);   // dayjs (타입만 최소로)
  const [vacuum, setVacuum] = useState(true);

  const loadInfo = async () => {
    setLoading(true);
    try {
      const res = await agentApi.stateHistoryInfo();
      setInfo(res.data);
    } catch (e: any) {
      message.error('보관 현황을 불러오지 못했습니다: ' + (e?.message || ''));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) loadInfo(); /* eslint-disable-next-line */ }, [open]);

  /** 실제 삭제 — 되돌릴 수 없으므로 항상 확인창을 한 번 더 띄운다. */
  const run = async (params: { before?: number; client_id?: string }, what: string, rows?: number) => {
    modal.confirm({
      title: '사용 이력 삭제',
      okText: '삭제', okType: 'danger', cancelText: '취소',
      content: (
        <div style={{ fontSize: 12, lineHeight: 1.9 }}>
          <b>{what}</b> 를 삭제합니다.
          {rows !== undefined && <> (약 {rows.toLocaleString()}행)</>}<br />
          <span style={{ color: '#ff4d4f' }}>삭제한 이력은 복구할 수 없습니다.</span><br />
          <span style={{ color: '#888' }}>
            그래프는 남은 기간만 표시됩니다. 앞으로의 기록은 계속 쌓입니다.
          </span>
        </div>
      ),
      onOk: async () => {
        try {
          const res = await agentApi.stateHistoryDelete({ ...params, vacuum });
          message.success(`${(res.data.deleted || 0).toLocaleString()}행 삭제되었습니다`);
          await loadInfo();
          onChanged();
        } catch (e: any) {
          message.error('삭제 실패: ' + (e?.response?.data?.detail || e?.message || ''));
        }
      },
    });
  };

  const onDeleteByScope = () => {
    if (scope === 'all') {
      return run({}, '전체 사용 이력', info?.rows);
    }
    if (scope === 'date') {
      if (!date) {
        message.warning('기준 날짜를 선택하세요');
        return;
      }
      const before = Math.floor(date.valueOf() / 1000);
      return run({ before }, `${new Date(before * 1000).toLocaleDateString()} 이전 이력`);
    }
    const days = SCOPE_DAYS[scope];
    const before = Math.floor(Date.now() / 1000) - days * 86400;
    return run({ before }, `${days}일 이전 이력`);
  };

  const columns = [
    { title: 'PC', dataIndex: 'name', key: 'name', ellipsis: true,
      render: (v: string, r: PerAgent) => <Tooltip title={r.client_id}><span>{v}</span></Tooltip> },
    { title: '행', dataIndex: 'rows', key: 'rows', width: 90,
      render: (v: number) => v.toLocaleString(),
      sorter: (a: PerAgent, b: PerAgent) => a.rows - b.rows, defaultSortOrder: 'descend' as const },
    { title: '기간', key: 'span', width: 190,
      render: (_: unknown, r: PerAgent) => (
        <Tooltip title={`${fmtTs(r.oldest_ts)} ~ ${fmtTs(r.newest_ts)}`}>
          <span style={{ fontSize: 12 }}>{daysBetween(r.oldest_ts, r.newest_ts)}</span>
        </Tooltip>
      ) },
    { title: '', key: 'del', width: 50,
      render: (_: unknown, r: PerAgent) => (
        <Tooltip title="이 PC 의 이력만 삭제">
          <Button size="small" type="text" danger icon={<DeleteOutlined />}
            onClick={() => run({ client_id: r.client_id }, `${r.name} 의 이력`, r.rows)} />
        </Tooltip>
      ) },
  ];

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={720} title="사용 이력 관리">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        상태 이력은 <b>자동으로 삭제하지 않고 무기한 보관</b>합니다. 용량이 부담되면 여기서 직접 정리하세요.
      </Typography.Paragraph>

      <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="보관 행 수">{(info?.rows ?? 0).toLocaleString()}</Descriptions.Item>
        <Descriptions.Item label="PC 수">{info?.agents ?? 0}</Descriptions.Item>
        <Descriptions.Item label="최초 기록">{fmtTs(info?.oldest_ts ?? null)}</Descriptions.Item>
        <Descriptions.Item label="최근 기록">{fmtTs(info?.newest_ts ?? null)}</Descriptions.Item>
        <Descriptions.Item label="이력 용량(추정)">약 {fmtBytes(info?.approx_bytes ?? 0)}</Descriptions.Item>
        <Descriptions.Item label="DB 파일 전체">{fmtBytes(info?.db_bytes ?? 0)}</Descriptions.Item>
      </Descriptions>

      <Typography.Text strong style={{ fontSize: 13 }}>기간 기준 삭제</Typography.Text>
      <div style={{ margin: '8px 0 16px' }}>
        <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)} style={{ marginBottom: 8 }}>
          <Radio.Button value="30d">30일 이전</Radio.Button>
          <Radio.Button value="90d">90일 이전</Radio.Button>
          <Radio.Button value="365d">1년 이전</Radio.Button>
          <Radio.Button value="date">날짜 지정</Radio.Button>
          <Radio.Button value="all" style={{ color: '#ff4d4f' }}>전체</Radio.Button>
        </Radio.Group>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {scope === 'date' && (
            <DatePicker
              placeholder="이 날짜 이전 삭제"
              onChange={(d) => setDate(d as unknown as { valueOf(): number } | null)}
            />
          )}
          <Button danger icon={<DeleteOutlined />} onClick={onDeleteByScope}>
            {scope === 'all' ? '전체 이력 삭제' : '삭제'}
          </Button>
          <Tooltip title="끄면 삭제는 되지만 DB 파일 크기는 줄지 않습니다 (다음 기록에 재사용)">
            <Checkbox checked={vacuum} onChange={(e) => setVacuum(e.target.checked)}>
              파일 공간 회수(VACUUM)
            </Checkbox>
          </Tooltip>
        </div>
      </div>

      <Typography.Text strong style={{ fontSize: 13 }}>PC별 보관 현황</Typography.Text>
      <Table
        size="small" rowKey="client_id" style={{ marginTop: 8 }}
        loading={loading}
        dataSource={info?.per_agent || []}
        columns={columns}
        pagination={false}
        scroll={{ y: 240 }}
        locale={{ emptyText: '보관된 이력 없음' }}
      />
    </Modal>
  );
}
