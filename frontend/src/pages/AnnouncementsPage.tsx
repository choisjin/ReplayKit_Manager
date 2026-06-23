import { useEffect, useState } from 'react';
import {
  Button, Card, Empty, Form, Image, Input, message, Modal, Segmented,
  Select, Space, Switch, Table, Tag, Typography, Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, UploadOutlined, LinkOutlined,
  ArrowUpOutlined, ArrowDownOutlined,
} from '@ant-design/icons';
import { announcementApi } from '../services/api';

const { TextArea } = Input;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB

type AnnType = 'notice' | 'guide';

interface GuideStep {
  text: string;
  text_en?: string;
  image: string | null;
}

interface Announcement {
  id: number;
  title: string;
  title_en?: string;
  content: string;
  content_en?: string;
  priority: string;
  active: number;
  type: AnnType;
  is_popup: number;
  image_data: string | null;
  images: string[];
  steps: GuideStep[];
  created_at: string;
  updated_at: string;
}

// 파일 → base64 data URL (검증 포함)
function readImage(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      message.error('이미지 파일만 첨부할 수 있습니다');
      resolve(null);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      message.error('이미지는 2MB 이하만 가능합니다');
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

const priorityColor: Record<string, string> = { urgent: 'red', important: 'orange', normal: 'blue' };
const priorityLabel: Record<string, string> = { urgent: '긴급', important: '중요', normal: '일반' };

export default function AnnouncementsPage() {
  const [data, setData] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [type, setType] = useState<AnnType>('notice');
  const [images, setImages] = useState<string[]>([]);      // 일반 공지 이미지들
  const [steps, setSteps] = useState<GuideStep[]>([]);     // 가이드 단계들
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

  const resetState = () => {
    setType('notice');
    setImages([]);
    setSteps([]);
    form.resetFields();
  };

  const openCreate = () => {
    setEditing(null);
    resetState();
    setModalOpen(true);
  };

  const openEdit = (record: Announcement) => {
    setEditing(record);
    setType(record.type || 'notice');
    setImages(record.images || []);
    setSteps(record.steps || []);
    form.setFieldsValue({
      title: record.title,
      title_en: record.title_en,
      content: record.content,
      content_en: record.content_en,
      priority: record.priority,
      is_popup: !!record.is_popup,
    });
    setModalOpen(true);
  };

  const doClose = () => {
    setModalOpen(false);
    setEditing(null);
    resetState();
  };

  // 작성 중인 내용이 있는지
  const hasContent = () => {
    const v = form.getFieldsValue();
    return !!(v.title || v.content || v.title_en || v.content_en || images.length || steps.length);
  };

  // 취소(또는 닫기) 시 작성 내용이 있으면 확인
  const handleCancel = () => {
    if (hasContent()) {
      Modal.confirm({
        title: '작성 취소',
        content: '작성 중인 내용이 사라집니다. 닫으시겠습니까?',
        okText: '닫기',
        okButtonProps: { danger: true },
        cancelText: '계속 작성',
        onOk: doClose,
      });
    } else {
      doClose();
    }
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (type === 'guide' && steps.length === 0) {
      message.error('가이드는 최소 1개의 단계가 필요합니다');
      return;
    }
    const payload = {
      title: values.title,
      title_en: values.title_en || '',
      content: values.content || '',
      content_en: values.content_en || '',
      priority: values.priority,
      type,
      is_popup: values.is_popup ? 1 : 0,
      images: type === 'notice' ? images : [],
      steps: type === 'guide'
        ? steps.map((s) => ({ text: s.text || '', text_en: s.text_en || '', image: s.image || null }))
        : [],
    };
    try {
      if (editing) {
        await announcementApi.update(editing.id, payload);
        message.success('수정 완료');
      } else {
        await announcementApi.create(payload);
        message.success('등록 완료');
      }
      doClose();
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

  // --- 일반 공지 이미지 ---
  const addNoticeImage = async (file: File) => {
    const d = await readImage(file);
    if (d) setImages((prev) => [...prev, d]);
    return false; // 자동 업로드 방지
  };
  const noticeFileList: UploadFile[] = images.map((url, i) => ({
    uid: String(i), name: `image-${i}`, status: 'done', url,
  }));

  // --- 가이드 단계 ---
  const addStep = () => setSteps((prev) => [...prev, { text: '', text_en: '', image: null }]);
  const updateStep = (i: number, patch: Partial<GuideStep>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, idx) => idx !== i));
  const moveStep = (i: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const thumbOf = (r: Announcement): string | null =>
    r.images?.[0] || r.steps?.find((s) => s.image)?.image || r.image_data || null;

  const columns = [
    {
      title: '유형',
      dataIndex: 'type',
      width: 80,
      render: (v: AnnType) =>
        v === 'guide' ? <Tag color="geekblue">가이드</Tag> : <Tag>공지</Tag>,
    },
    {
      title: '우선순위',
      dataIndex: 'priority',
      width: 90,
      render: (v: string) => <Tag color={priorityColor[v]}>{priorityLabel[v] || v}</Tag>,
    },
    {
      title: '이미지',
      width: 64,
      render: (_: unknown, r: Announcement) => {
        const t = thumbOf(r);
        return t ? (
          <Image src={t} width={40} height={40} style={{ objectFit: 'cover', borderRadius: 4 }} />
        ) : (
          <span style={{ color: '#888' }}>-</span>
        );
      },
    },
    { title: '제목', dataIndex: 'title', ellipsis: true },
    {
      title: '팝업',
      dataIndex: 'is_popup',
      width: 64,
      render: (v: number) => (v ? <Tag color="purple">팝업</Tag> : null),
    },
    {
      title: '활성',
      dataIndex: 'active',
      width: 64,
      render: (_: number, record: Announcement) => (
        <Switch checked={!!record.active} size="small" onChange={() => handleToggleActive(record)} />
      ),
    },
    {
      title: '등록일',
      dataIndex: 'created_at',
      width: 160,
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
        사용자 공개 주소:{' '}
        <Typography.Text copyable code>{publicUrl}</Typography.Text>
        {' '}— 활성 공지가 읽기 전용 게시판으로 표시되고, "팝업" 지정 시 접속 시 자동으로 떠오릅니다.
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
        onCancel={handleCancel}
        okText={editing ? '수정' : '등록'}
        cancelText="취소"
        width={680}
        maskClosable={false}
        keyboard={false}
        styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
      >
        <div style={{ marginBottom: 8 }}>
          <Segmented
            block
            value={type}
            onChange={(v) => setType(v as AnnType)}
            options={[
              { label: '일반 공지 / 안내', value: 'notice' },
              { label: '단계별 가이드', value: 'guide' },
            ]}
          />
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 16 }}>
          영문은 <b>비워두면 자동 번역</b>, 직접 입력하면 그대로 사용됩니다. (사용자 페이지에서 한/영 토글)
        </Typography.Paragraph>

        <Form form={form} layout="vertical" initialValues={{ priority: 'normal', is_popup: false }}>
          <Form.Item name="title" label="제목" rules={[{ required: true, message: '제목을 입력하세요' }]}>
            <Input placeholder={type === 'guide' ? '가이드 제목' : '공지사항 제목'} />
          </Form.Item>
          <Form.Item name="title_en" label="제목 (English · 선택)">
            <Input placeholder="비워두면 자동 번역됩니다" />
          </Form.Item>

          <Form.Item
            name="content"
            label={type === 'guide' ? '개요 (선택)' : '내용'}
            rules={type === 'notice' ? [{ required: true, message: '내용을 입력하세요' }] : []}
          >
            <TextArea
              rows={type === 'guide' ? 3 : 6}
              placeholder={type === 'guide' ? '가이드 전체 개요를 간단히 입력 (선택)' : '공지사항 내용'}
            />
          </Form.Item>
          <Form.Item name="content_en" label={(type === 'guide' ? '개요' : '내용') + ' (English · 선택)'}>
            <TextArea rows={type === 'guide' ? 2 : 4} placeholder="비워두면 자동 번역됩니다" />
          </Form.Item>

          {type === 'notice' && (
            <Form.Item label="이미지 (여러 장 가능, 각 2MB 이하)">
              <Upload
                listType="picture-card"
                multiple
                fileList={noticeFileList}
                beforeUpload={addNoticeImage}
                onRemove={(f) => setImages((prev) => prev.filter((_, i) => String(i) !== f.uid))}
                accept="image/*"
              >
                <div>
                  <UploadOutlined />
                  <div style={{ marginTop: 8 }}>업로드</div>
                </div>
              </Upload>
            </Form.Item>
          )}

          {type === 'guide' && (
            <Form.Item label="단계 (순서대로 글 + 이미지)">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {steps.length === 0 && (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="단계를 추가하세요" />
                )}
                {steps.map((step, i) => (
                  <Card
                    key={i}
                    size="small"
                    title={`단계 ${i + 1}`}
                    extra={
                      <Space size={4}>
                        <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => moveStep(i, -1)} />
                        <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)} />
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeStep(i)} />
                      </Space>
                    }
                  >
                    <TextArea
                      rows={2}
                      value={step.text}
                      onChange={(e) => updateStep(i, { text: e.target.value })}
                      placeholder={`${i + 1}단계 설명`}
                      style={{ marginBottom: 8 }}
                    />
                    <TextArea
                      rows={2}
                      value={step.text_en}
                      onChange={(e) => updateStep(i, { text_en: e.target.value })}
                      placeholder={`${i + 1}단계 설명 (English · 선택, 비우면 자동 번역)`}
                      style={{ marginBottom: 8 }}
                    />
                    <Upload
                      listType="picture-card"
                      maxCount={1}
                      fileList={step.image ? [{ uid: '0', name: 'image', status: 'done', url: step.image }] : []}
                      beforeUpload={async (file) => {
                        const d = await readImage(file);
                        if (d) updateStep(i, { image: d });
                        return false;
                      }}
                      onRemove={() => updateStep(i, { image: null })}
                      accept="image/*"
                    >
                      {step.image ? null : (
                        <div>
                          <UploadOutlined />
                          <div style={{ marginTop: 8 }}>이미지</div>
                        </div>
                      )}
                    </Upload>
                  </Card>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} onClick={addStep} block>
                  단계 추가
                </Button>
              </div>
            </Form.Item>
          )}

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
