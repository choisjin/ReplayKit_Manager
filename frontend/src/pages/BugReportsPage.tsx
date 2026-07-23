import { useCallback, useEffect, useState } from 'react';
import { Button, Popconfirm, Space, Table, Tag, Tooltip, Typography, Upload, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, ImportOutlined, ReloadOutlined } from '@ant-design/icons';
import { bugReportApi } from '../services/api';
import BugReportViewer, { type BugReport } from '../components/BugReportViewer';

function fmtSize(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// "2026. 07. 22." / "15:05:05" — 목록에서는 2줄로 표시
function fmtDateTimeParts(iso: string): [string, string] | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return [
    `${d.getFullYear()}. ${p(d.getMonth() + 1)}. ${p(d.getDate())}.`,
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  ];
}

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
    // 열람 시 자동으로 reviewed 처리
    if (r.status === 'new') {
      try {
        const res = await bugReportApi.updateStatus(r.id, 'reviewed');
        setReports((prev) => prev.map((p) => (p.id === r.id ? res.data : p)));
      } catch { /* 상태 갱신 실패는 무시 */ }
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
      title: '상태', dataIndex: 'status', width: 80,
      render: (v: string) => v === 'new'
        ? <Tag color="red">신규</Tag>
        : <Tag color="default">확인됨</Tag>,
    },
    {
      title: '제목', dataIndex: 'title', ellipsis: true,
      render: (v: string, r: BugReport) => <a onClick={() => openDetail(r)}>{v}</a>,
    },
    {
      title: '제보자', dataIndex: 'reporter', width: 120, ellipsis: true,
      render: (v: string, r: BugReport) => r.user_name || v || '-',
    },
    {
      title: '부서', dataIndex: 'user_team', width: 130, ellipsis: true,
      render: (v: string) => v || '-',
    },
    {
      title: '프로젝트', dataIndex: 'project', width: 90, ellipsis: true,
      render: (v: string) => v || '-',
    },
    { title: '호스트', dataIndex: 'hostname', width: 130, ellipsis: true },
    { title: '버전', dataIndex: 'version', width: 90 },
    {
      title: '수신 시각', dataIndex: 'received_at', width: 120,
      render: (v: string) => {
        const parts = fmtDateTimeParts(v);
        return parts ? (
          <div style={{ lineHeight: 1.4 }}>
            <div>{parts[0]}</div>
            <div>{parts[1]}</div>
          </div>
        ) : '-';
      },
    },
    { title: '크기', dataIndex: 'file_size', width: 90, render: fmtSize },
    {
      title: '', key: 'actions', width: 110,
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
        size="middle"
        pagination={{ pageSize: 20, showSizeChanger: false }}
      />

      <BugReportViewer report={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
