import { useEffect, useState } from 'react';
import { Button, Card, Form, Input, message, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { announcementApi } from '../services/api';

const { TextArea } = Input;

interface Announcement {
  id: number;
  title: string;
  content: string;
  priority: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export default function AnnouncementsPage() {
  const [data, setData] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await announcementApi.list();
      setData(res.data);
    } catch {
      message.error('공지사항을 불러올 수 없습니다');
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (editing) {
        await announcementApi.update(editing.id, values);
        message.success('수정 완료');
      } else {
        await announcementApi.create(values);
        message.success('등록 완료');
      }
      setModalOpen(false);
      form.resetFields();
      setEditing(null);
      fetchData();
    } catch {
      message.error('저장 실패');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await announcementApi.delete(id);
      message.success('삭제 완료');
      fetchData();
    } catch {
      message.error('삭제 실패');
    }
  };

  const handleToggleActive = async (record: Announcement) => {
    await announcementApi.update(record.id, { active: record.active ? 0 : 1 });
    fetchData();
  };

  const priorityColor: Record<string, string> = {
    urgent: 'red',
    important: 'orange',
    normal: 'blue',
  };
  const priorityLabel: Record<string, string> = {
    urgent: '긴급',
    important: '중요',
    normal: '일반',
  };

  const columns = [
    {
      title: '우선순위',
      dataIndex: 'priority',
      width: 90,
      render: (v: string) => <Tag color={priorityColor[v]}>{priorityLabel[v] || v}</Tag>,
    },
    { title: '제목', dataIndex: 'title', ellipsis: true },
    { title: '내용', dataIndex: 'content', ellipsis: true },
    {
      title: '활성',
      dataIndex: 'active',
      width: 70,
      render: (_: number, record: Announcement) => (
        <Switch checked={!!record.active} size="small" onChange={() => handleToggleActive(record)} />
      ),
    },
    {
      title: '등록일',
      dataIndex: 'created_at',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString('ko-KR'),
    },
    {
      title: '',
      width: 100,
      render: (_: unknown, record: Announcement) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => {
            setEditing(record);
            form.setFieldsValue(record);
            setModalOpen(true);
          }} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => {
            Modal.confirm({
              title: '삭제 확인',
              content: `"${record.title}" 공지를 삭제하시겠습니까?`,
              onOk: () => handleDelete(record.id),
            });
          }} />
        </Space>
      ),
    },
  ];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>공지사항 관리</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => {
          setEditing(null);
          form.resetFields();
          setModalOpen(true);
        }}>
          새 공지 등록
        </Button>
      </div>

      <Table
        dataSource={data}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        size="middle"
      />

      <Modal
        title={editing ? '공지사항 수정' : '새 공지사항 등록'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => { setModalOpen(false); setEditing(null); form.resetFields(); }}
        okText={editing ? '수정' : '등록'}
        cancelText="취소"
        width={600}
      >
        <Form form={form} layout="vertical" initialValues={{ priority: 'normal' }}>
          <Form.Item name="title" label="제목" rules={[{ required: true, message: '제목을 입력하세요' }]}>
            <Input placeholder="공지사항 제목" />
          </Form.Item>
          <Form.Item name="content" label="내용" rules={[{ required: true, message: '내용을 입력하세요' }]}>
            <TextArea rows={6} placeholder="공지사항 내용" />
          </Form.Item>
          <Form.Item name="priority" label="우선순위">
            <Select>
              <Select.Option value="normal">일반</Select.Option>
              <Select.Option value="important">중요</Select.Option>
              <Select.Option value="urgent">긴급</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
