import { useCallback, useEffect, useState } from 'react';
import { Button, Descriptions, Modal, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { bugReportApi } from '../services/api';

const { Text, Paragraph } = Typography;

interface BugReport {
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

function fmtSize(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fmtTime(iso: string): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('ko-KR', { hour12: false });
  } catch {
    return iso;
  }
}

export default function BugReportsPage() {
  const [reports, setReports] = useState<BugReport[]>([]);
  const [loading, setLoading] = useState(false);
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
    { title: '제보자', dataIndex: 'reporter', width: 140, ellipsis: true },
    { title: '호스트', dataIndex: 'hostname', width: 130, ellipsis: true },
    { title: '버전', dataIndex: 'version', width: 90 },
    { title: '수신 시각', dataIndex: 'received_at', width: 170, render: fmtTime },
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
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>새로고침</Button>
      </div>

      <Table
        rowKey="id"
        dataSource={reports}
        columns={columns}
        loading={loading}
        size="middle"
        pagination={{ pageSize: 20, showSizeChanger: false }}
      />

      <Modal
        title={detail?.title}
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={[
          <Button key="dl" type="primary" icon={<DownloadOutlined />} href={detail ? bugReportApi.downloadUrl(detail.id) : '#'} target="_blank">
            ZIP 다운로드 ({fmtSize(detail?.file_size || 0)})
          </Button>,
          <Button key="close" onClick={() => setDetail(null)}>닫기</Button>,
        ]}
        width={640}
      >
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="제보자">{detail.reporter || '-'}</Descriptions.Item>
              <Descriptions.Item label="호스트">{detail.hostname || '-'}</Descriptions.Item>
              <Descriptions.Item label="버전">{detail.version || '-'}</Descriptions.Item>
              <Descriptions.Item label="플랫폼">{detail.platform || '-'}</Descriptions.Item>
              <Descriptions.Item label="클라이언트 생성">{fmtTime(detail.client_created_at)}</Descriptions.Item>
              <Descriptions.Item label="서버 수신">{fmtTime(detail.received_at)}</Descriptions.Item>
            </Descriptions>
            <Text strong>증상 설명</Text>
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
              {detail.description || <Text type="secondary">(설명 없음)</Text>}
            </Paragraph>
          </>
        )}
      </Modal>
    </div>
  );
}
