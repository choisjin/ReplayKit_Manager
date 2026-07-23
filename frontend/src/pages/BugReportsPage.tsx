import { useCallback, useEffect, useState } from 'react';
import { Button, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, Upload, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, ImportOutlined, ReloadOutlined } from '@ant-design/icons';
import { bugReportApi } from '../services/api';
import BugReportViewer, { type BugReport, type BugStatus } from '../components/BugReportViewer';

// 처리 상태 — 신규 → 처리중 → 확인됨. label/color 를 한 곳에서 관리한다.
const STATUS_OPTIONS: { value: BugStatus; label: string; color: string }[] = [
  { value: 'new', label: '신규', color: 'red' },
  { value: 'in_progress', label: '처리중', color: 'gold' },
  { value: 'reviewed', label: '확인됨', color: 'green' },
  { value: 'done', label: '처리완료', color: 'blue' },
];

// "2026. 07. 22. 15:05:05" — 한 줄로 표시
function fmtDateTime(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}. ${p(d.getMonth() + 1)}. ${p(d.getDate())}. ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 모든 열의 헤더를 가운데 정렬 (본문 정렬은 각 열이 정함)
const centerHeader = () => ({ style: { textAlign: 'center' as const } });
// 본문 셀을 한 줄로 — 말줄임(...) 없이 전체 값이 보이도록 (넘치면 표가 가로 스크롤)
const nowrapCell = () => ({ style: { whiteSpace: 'nowrap' as const } });

export default function BugReportsPage() {
  const [reports, setReports] = useState<BugReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detail, setDetail] = useState<BugReport | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await bugReportApi.list();
      setReports(res.data);
    } catch {
      message.error('버그 리포트 목록을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (r: BugReport) => {
    setDetail(r);
    // 열람 시 신규 → 처리중으로 자동 전환 (읽었지만 아직 확인 완료 전).
    // 확인 완료는 사용자가 상태 드롭다운에서 직접 '확인됨' 으로 바꾼다.
    if (r.status === 'new') {
      try {
        const res = await bugReportApi.updateStatus(r.id, 'in_progress');
        setReports((prev) => prev.map((p) => (p.id === r.id ? res.data : p)));
      } catch { /* 상태 갱신 실패는 무시 */ }
    }
  };

  // 상태 드롭다운에서 직접 변경
  const changeStatus = async (r: BugReport, status: BugStatus) => {
    try {
      const res = await bugReportApi.updateStatus(r.id, status);
      setReports((prev) => prev.map((p) => (p.id === r.id ? res.data : p)));
    } catch {
      message.error('상태 변경 실패');
    }
  };

  // 로컬 폴백 ZIP 수동 등록 (다중 선택 가능) — 메타는 서버가 report.json 에서 추출
  const importFiles = async (files: File[]) => {
    setImporting(true);
    let ok = 0;
    for (const f of files) {
      try {
        await bugReportApi.importZip(f);
        ok += 1;
      } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } }).response?.data?.detail;
        message.error(`${f.name}: ${detail || '가져오기 실패'}`);
      }
    }
    setImporting(false);
    if (ok > 0) {
      message.success(`${ok}건 가져왔습니다`);
      load();
    }
  };

  const remove = async (id: number) => {
    try {
      await bugReportApi.delete(id);
      setReports((prev) => prev.filter((p) => p.id !== id));
      message.success('삭제했습니다');
    } catch {
      message.error('삭제 실패');
    }
  };

  const columns = [
    {
      title: '상태', dataIndex: 'status', align: 'center' as const,
      onHeaderCell: centerHeader, onCell: nowrapCell,
      render: (v: BugStatus, r: BugReport) => (
        <Select<BugStatus>
          size="small"
          variant="borderless"
          value={v}
          onChange={(val) => changeStatus(r, val)}
          style={{ width: 112 }}
          options={STATUS_OPTIONS.map((o) => ({
            value: o.value,
            label: <Tag color={o.color} style={{ marginRight: 0 }}>{o.label}</Tag>,
          }))}
        />
      ),
    },
    {
      title: '수신 시각', dataIndex: 'received_at', align: 'center' as const,
      onHeaderCell: centerHeader, onCell: nowrapCell,
      render: (v: string) => fmtDateTime(v),
    },
    {
      title: '제목', dataIndex: 'title',
      onHeaderCell: centerHeader, onCell: nowrapCell,
      render: (v: string, r: BugReport) => <a onClick={() => openDetail(r)}>{v}</a>,
    },
    {
      title: '제보자', dataIndex: 'reporter',
      onHeaderCell: centerHeader, onCell: nowrapCell,
      render: (v: string, r: BugReport) => r.user_name || v || '-',
    },
    {
      title: '부서', dataIndex: 'user_team',
      onHeaderCell: centerHeader, onCell: nowrapCell,
      render: (v: string) => v || '-',
    },
    {
      title: '프로젝트', dataIndex: 'project',
      onHeaderCell: centerHeader, onCell: nowrapCell,
      render: (v: string) => v || '-',
    },
    {
      title: '호스트', dataIndex: 'hostname',
      onHeaderCell: centerHeader, onCell: nowrapCell,
    },
    {
      title: '버전', dataIndex: 'version', align: 'center' as const,
      onHeaderCell: centerHeader, onCell: nowrapCell,
    },
    {
      title: '', key: 'actions', align: 'center' as const, width: 110,
      onHeaderCell: centerHeader, onCell: nowrapCell,
      render: (_: unknown, r: BugReport) => (
        <Space>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            href={bugReportApi.downloadUrl(r.id)}
            target="_blank"
          />
          <Popconfirm title="이 리포트를 삭제할까요? (ZIP 파일도 함께 삭제)" onConfirm={() => remove(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          버그 리포트
          {reports.some((r) => r.status === 'new') && (
            <Tag color="red" style={{ marginLeft: 8 }}>신규 {reports.filter((r) => r.status === 'new').length}건</Tag>
          )}
        </Typography.Title>
        <Space>
          <Tooltip title="서버에 접근하지 못한 유저가 로컬로 저장한 버그 리포트 ZIP을 등록합니다">
            <Upload
              accept=".zip"
              multiple
              showUploadList={false}
              beforeUpload={(file, fileList) => {
                // 다중 선택 시 파일마다 호출되므로 첫 파일에서 배치 전체를 1회만 처리
                if (file === fileList[0]) importFiles(fileList as unknown as File[]);
                return false; // 자동 업로드 차단 — importFiles 가 직접 전송
              }}
            >
              <Button icon={<ImportOutlined />} loading={importing}>ZIP 가져오기</Button>
            </Upload>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>새로고침</Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        dataSource={reports}
        columns={columns}
        loading={loading}
        size="small"
        // 한 줄 셀이 넘칠 때 잘리지 않고 가로 스크롤로 전체가 보이도록
        scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
      />

      <BugReportViewer report={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
