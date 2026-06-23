import { useEffect, useState } from 'react';
import { Button, Form, Image, Input, message, Modal, Select, Space, Switch, Table, Tag, Typography, Upload } from 'antd';
import type { UploadFile } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, UploadOutlined, LinkOutlined } from '@ant-design/icons';
import { announcementApi } from '../services/api';

const { TextArea } = Input;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB

interface Announcement {
  id: number;
  title: string;
  content: string;
  priority: string;
  active: number;
  image_data: string | null;
  is_popup: number;
  created_at: string;
  updated_at: string;
}

export default function AnnouncementsPage() {
  const [data, setData] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [imageData, setImageData] = useState<string | null>(null);
  const [form] = Form.useForm();

  const publicUrl = `${window.location.origin}/view`;

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

  const openCreate = () => {
    setEditing(null);
    setImageData(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (record: Announcement) => {
    setEditing(record);
    setImageData(record.image_data || null);
    form.setFieldsValue({
      title: record.title,
      content: record.content,
      priority: record.priority,
      is_popup: !!record.is_popup,
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    setImageData(null);
    form.resetFields();
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const payload = {
      title: values.title,
      content: values.content,
      priority: values.priority,
      is_popup: values.is_popup ? 1 : 0,
      image_data: imageData ?? '', // '' = 이미지 제거
    };
    try {
      if (editing) {
        await announcementApi.update(editing.id, payload);
        message.success('수정 완료');
      } else {
        await announcementApi.create(payload);
        message.success('등록 완료');
      }
      closeModal();
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

  // 파일 선택 → base64 변환 (자동 업로드 막고 클라이언트에서 인코딩)
  const beforeUpload = (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error('이미지 파일만 첨부할 수 있습니다');
      return Upload.LIST_IGNORE;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      message.error('이미지는 2MB 이하만 가능합니다');
      return Upload.LIST_IGNORE;
    }
    const reader = new FileReader();
    reader.onload = () => setImageData(reader.result as string);
    reader.readAsDataURL(file);
    return false;
  };

  const uploadList: UploadFile[] = imageData
    ? [{ uid: '-1', name: 'image', status: 'done', url: imageData }]
    : [];

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
    {
      title: '이미지',
      dataIndex: 'image_data',
      width: 70,
      render: (v: string | null) =>
        v ? <Image src={v} width={40} height={40} style={{ objectFit: 'cover', borderRadius: 4 }} /> : <span style={{ color: '#888' }}>-</span>,
    },
    { title: '제목', dataIndex: 'title', ellipsis: true },
    { title: '내용', dataIndex: 'content', ellipsis: true },
    {
      title: '팝업',
      dataIndex: 'is_popup',
      width: 70,
      render: (v: number) => (v ? <Tag color="purple">팝업</Tag> : null),
    },
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
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>공지사항 관리</Typography.Title>
        <Space>
          <Button icon={<LinkOutlined />} onClick={() => window.open(publicUrl, '_blank')}>
            공개 페이지 열기
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            새 공지 등록
          </Button>
        </Space>
      </div>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        사용자에게 보여줄 공개 주소:{' '}
        <Typography.Text copyable code>{publicUrl}</Typography.Text>
        {' '}— 활성화된 공지가 읽기 전용 게시판으로 표시되고, "팝업" 지정 시 사용자 접속 시 자동으로 떠오릅니다.
      </Typography.Paragraph>

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
        onCancel={closeModal}
        okText={editing ? '수정' : '등록'}
        cancelText="취소"
        width={600}
      >
        <Form form={form} layout="vertical" initialValues={{ priority: 'normal', is_popup: false }}>
          <Form.Item name="title" label="제목" rules={[{ required: true, message: '제목을 입력하세요' }]}>
            <Input placeholder="공지사항 제목" />
          </Form.Item>
          <Form.Item name="content" label="내용" rules={[{ required: true, message: '내용을 입력하세요' }]}>
            <TextArea rows={6} placeholder="공지사항 내용" />
          </Form.Item>
          <Form.Item label="이미지 (선택, 2MB 이하)">
            <Upload
              listType="picture-card"
              fileList={uploadList}
              beforeUpload={beforeUpload}
              onRemove={() => setImageData(null)}
              maxCount={1}
              accept="image/*"
            >
              {imageData ? null : (
                <div>
                  <UploadOutlined />
                  <div style={{ marginTop: 8 }}>업로드</div>
                </div>
              )}
            </Upload>
          </Form.Item>
          <Form.Item name="priority" label="우선순위">
            <Select>
              <Select.Option value="normal">일반</Select.Option>
              <Select.Option value="important">중요</Select.Option>
              <Select.Option value="urgent">긴급</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="is_popup" label="사용자 접속 시 팝업으로 표시" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
