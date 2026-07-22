import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Empty, Image, Spin, Table, Tabs, Tag, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { bugReportApi } from '../services/api';

const { Text, Paragraph } = Typography;

export interface BugReport {
  id: number;
  title: string;
  description: string;
  reporter: string;
  version: string;
  boot_id: string;
  platform: string;
  hostname: string;
  client_created_at: string;
  received_at: string;
  file_name: string;
  file_size: number;
  status: 'new' | 'reviewed';
}

interface ZipFileEntry {
  path: string; // ZIP 안 전체 경로 (루트 폴더 포함)
  rel: string;  // 루트 폴더 제외 상대경로
  size: number;
}

interface StepTestRecord {
  ts: string;
  scenario: string;
  step_index: number;
  step_type: string;
  status: string;
  similarity_score: number | null;
  command: string;
  message: string;
  images: Record<string, string>; // {field: "shots/<dir>/<name>"}
}

interface PlaybackStep {
  step_id: number;
  status: string;
  timestamp?: string;
  command?: string;
  similarity_score?: number | null;
  message?: string;
  actual_image?: string | null;
  diff_image?: string | null;
  expected_image?: string | null;
}

interface Contents {
  files: ZipFileEntry[];
  report: {
    description?: string;
    env?: Record<string, string>;
    devices?: { id: string; type: string; name: string; model: string; status: string }[];
    log_windows?: { label: string; from: string; to: string }[];
  } | null;
  step_tests: StepTestRecord[] | null;
  playback: Record<string, PlaybackStep[]>;
}

const STATUS_COLOR: Record<string, string> = {
  pass: 'green', fail: 'red', error: 'volcano', warning: 'orange',
};

function fmtSize(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fmtTime(iso?: string): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('ko-KR', { hour12: false });
  } catch {
    return iso;
  }
}

function StatusTag({ status, similarity }: { status: string; similarity?: number | null }) {
  return (
    <Tag color={STATUS_COLOR[status] || 'default'} style={{ marginRight: 0 }}>
      {status}{similarity != null ? ` ${(similarity * 100).toFixed(0)}%` : ''}
    </Tag>
  );
}

/** 이미지 필드 라벨 (판독 편의) */
const IMG_LABEL: Record<string, string> = {
  expected_image: 'expected',
  expected_annotated_image: 'expected(주석)',
  actual_image: 'actual',
  actual_annotated_image: 'actual(주석)',
  diff_image: 'diff',
};

function Thumb({ src, label }: { src: string; label: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <Image src={src} width={130} style={{ objectFit: 'contain', maxHeight: 100 }} />
      <div><Text type="secondary" style={{ fontSize: 11 }}>{label}</Text></div>
    </div>
  );
}

// ── 로그 탭: 파일 목록 + 클릭 시 tail 512KB 지연 로드 ──
const LOG_TAIL_BYTES = 512 * 1024;

function LogsTab({ reportId, files }: { reportId: number; files: ZipFileEntry[] }) {
  const logFiles = files.filter((f) => f.rel.startsWith('logs/'));
  const [active, setActive] = useState<string>('');
  const [text, setText] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    fetch(bugReportApi.fileUrl(reportId, active, LOG_TAIL_BYTES))
      .then(async (res) => {
        setTruncated(res.headers.get('X-Truncated') === '1');
        setText(await res.text());
      })
      .catch(() => setText('(로드 실패)'))
      .finally(() => setLoading(false));
  }, [reportId, active]);

  useEffect(() => {
    // 첫 로그 파일 자동 선택
    if (!active && logFiles.length > 0) setActive(logFiles[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logFiles.length]);

  if (logFiles.length === 0) return <Empty description="로그 파일 없음" />;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {logFiles.map((f) => (
          <Button
            key={f.path}
            size="small"
            type={active === f.path ? 'primary' : 'default'}
            onClick={() => setActive(f.path)}
          >
            {f.rel.replace('logs/', '')} ({fmtSize(f.size)})
          </Button>
        ))}
      </div>
      {truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`파일이 커서 마지막 ${fmtSize(LOG_TAIL_BYTES)}만 표시합니다 — 전체는 ZIP 다운로드로 확인하세요`}
        />
      )}
      <Spin spinning={loading}>
        <pre style={{
          maxHeight: 460, overflow: 'auto', fontSize: 11, lineHeight: 1.5,
          background: 'rgba(128,128,128,0.08)', padding: 12, borderRadius: 6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0,
        }}>{text}</pre>
      </Spin>
    </div>
  );
}

export default function BugReportViewer({ report, onClose }: { report: BugReport | null; onClose: () => void }) {
  const [contents, setContents] = useState<Contents | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!report) { setContents(null); setError(''); return; }
    setLoading(true);
    setError('');
    bugReportApi.contents(report.id)
      .then((res) => setContents(res.data))
      .catch((e) => setError(e?.response?.data?.detail || 'ZIP 내용을 읽지 못했습니다'))
      .finally(() => setLoading(false));
  }, [report]);

  // rel 경로 → ZIP 전체 경로 (이미지 src 계산용)
  const fileByRel = useMemo(() => {
    const m = new Map<string, string>();
    contents?.files.forEach((f) => m.set(f.rel, f.path));
    return m;
  }, [contents]);

  const imgSrc = (rel: string): string | null => {
    if (!report) return null;
    const full = fileByRel.get(rel);
    return full ? bugReportApi.fileUrl(report.id, full) : null;
  };

  /** 재생 스텝의 이미지 필드값(원본 상대경로) → ZIP 내 스크린샷 rel 찾기 */
  const findPlaybackImage = (run: string, fieldValue?: string | null): string | null => {
    if (!fieldValue) return null;
    const base = fieldValue.replace(/\\/g, '/').split('/').pop();
    if (!base) return null;
    const prefix = `results/${run}/screenshots/`;
    for (const [rel] of fileByRel) {
      if (rel.startsWith(prefix) && rel.endsWith(`/${base}`)) return rel;
      if (rel === prefix + base) return rel;
    }
    return null;
  };

  const items = [];
  const rj = contents?.report;

  // ── 개요 ──
  items.push({
    key: 'overview',
    label: '개요',
    children: report && (
      <div>
        <Descriptions column={2} size="small" bordered style={{ marginBottom: 12 }}>
          <Descriptions.Item label="제보자">{report.reporter || '-'}</Descriptions.Item>
          <Descriptions.Item label="호스트">{report.hostname || '-'}</Descriptions.Item>
          <Descriptions.Item label="버전">{report.version || '-'}</Descriptions.Item>
          <Descriptions.Item label="플랫폼">{report.platform || '-'}</Descriptions.Item>
          <Descriptions.Item label="클라이언트 생성">{fmtTime(report.client_created_at)}</Descriptions.Item>
          <Descriptions.Item label="서버 수신">{fmtTime(report.received_at)}</Descriptions.Item>
        </Descriptions>
        <Text strong>증상 설명</Text>
        <Paragraph style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
          {report.description || <Text type="secondary">(설명 없음)</Text>}
        </Paragraph>
        {rj?.devices && rj.devices.length > 0 && (
          <>
            <Text strong>연결 디바이스</Text>
            <Table
              size="small"
              rowKey="id"
              dataSource={rj.devices}
              pagination={false}
              style={{ marginTop: 4, marginBottom: 12 }}
              columns={[
                { title: 'ID', dataIndex: 'id', ellipsis: true },
                { title: '타입', dataIndex: 'type', width: 90 },
                { title: '이름', dataIndex: 'name', ellipsis: true },
                { title: '모델', dataIndex: 'model', ellipsis: true },
                { title: '상태', dataIndex: 'status', width: 100 },
              ]}
            />
          </>
        )}
        {rj?.log_windows && rj.log_windows.length > 0 && (
          <>
            <Text strong>수집 시간창</Text>
            <div style={{ marginTop: 4 }}>
              {rj.log_windows.map((w, i) => (
                <div key={i}><Text code style={{ fontSize: 12 }}>{w.label}</Text> <Text type="secondary" style={{ fontSize: 12 }}>{w.from} ~ {w.to}</Text></div>
              ))}
            </div>
          </>
        )}
      </div>
    ),
  });

  // ── 스텝 테스트 ──
  const stepTests = contents?.step_tests || [];
  if (stepTests.length > 0) {
    items.push({
      key: 'stepTests',
      label: `스텝 테스트 (${stepTests.length})`,
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {stepTests.map((r, i) => (
            <div key={i} style={{ border: '1px solid rgba(128,128,128,0.25)', borderRadius: 6, padding: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <StatusTag status={r.status} similarity={r.similarity_score} />
                <Text style={{ fontSize: 12 }}>{fmtTime(r.ts)}</Text>
                <Text strong style={{ fontSize: 12 }}>{r.scenario} #{(r.step_index ?? 0) + 1}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{r.command}</Text>
              </div>
              {r.message && <Paragraph style={{ fontSize: 12, margin: '6px 0 0' }}>{r.message}</Paragraph>}
              {r.images && Object.keys(r.images).length > 0 && (
                <Image.PreviewGroup>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    {Object.entries(r.images).map(([field, rel]) => {
                      const src = imgSrc(`step_tests/${rel}`);
                      return src ? <Thumb key={field} src={src} label={IMG_LABEL[field] || field} /> : null;
                    })}
                  </div>
                </Image.PreviewGroup>
              )}
            </div>
          ))}
        </div>
      ),
    });
  }

  // ── 재생 구간 (run 별) ──
  Object.entries(contents?.playback || {}).forEach(([run, steps]) => {
    items.push({
      key: `run:${run}`,
      label: `재생 ${run.length > 24 ? run.slice(0, 24) + '…' : run} (${steps.length})`,
      children: (
        <div>
          <Table
            size="small"
            rowKey={(_, i) => String(i)}
            dataSource={steps}
            pagination={false}
            scroll={{ y: 280 }}
            style={{ marginBottom: 12 }}
            rowClassName={(r) => (r.status === 'fail' || r.status === 'error' ? 'bug-report-fail-row' : '')}
            columns={[
              { title: '#', dataIndex: 'step_id', width: 50 },
              {
                title: '판정', dataIndex: 'status', width: 90,
                render: (v: string, r: PlaybackStep) => <StatusTag status={v} similarity={r.similarity_score} />,
              },
              { title: '동작', dataIndex: 'command', ellipsis: true },
              { title: '메시지', dataIndex: 'message', ellipsis: true },
              { title: '시각', dataIndex: 'timestamp', width: 160, render: fmtTime },
            ]}
            expandable={{
              rowExpandable: (r) => !!(r.actual_image || r.diff_image || r.expected_image),
              expandedRowRender: (r) => (
                <Image.PreviewGroup>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(['expected_image', 'actual_image', 'diff_image'] as const).map((field) => {
                      const rel = findPlaybackImage(run, r[field]);
                      const src = rel ? imgSrc(rel) : null;
                      return src ? <Thumb key={field} src={src} label={IMG_LABEL[field]} /> : null;
                    })}
                  </div>
                </Image.PreviewGroup>
              ),
            }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>fail/error 행을 펼치면 스크린샷이 표시됩니다</Text>
        </div>
      ),
    });
  });

  // ── 로그 ──
  if (contents && contents.files.some((f) => f.rel.startsWith('logs/'))) {
    items.push({
      key: 'logs',
      label: '로그',
      children: report && <LogsTab reportId={report.id} files={contents.files} />,
    });
  }

  return (
    <Drawer
      title={report?.title}
      open={!!report}
      onClose={onClose}
      width={900}
      extra={report && (
        <Button type="primary" icon={<DownloadOutlined />} href={bugReportApi.downloadUrl(report.id)} target="_blank">
          ZIP 다운로드 ({fmtSize(report.file_size)})
        </Button>
      )}
    >
      {/* fail 행 강조 (AntD row 커스텀) */}
      <style>{'.bug-report-fail-row td { background: rgba(255,77,79,0.08) !important; }'}</style>
      {loading && <Spin style={{ display: 'block', margin: '40px auto' }} />}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {!loading && !error && contents && <Tabs items={items} />}
    </Drawer>
  );
}
