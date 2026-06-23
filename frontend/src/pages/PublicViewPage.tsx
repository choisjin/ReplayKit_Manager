import { useEffect, useState } from 'react';
import { Card, Checkbox, Empty, Image, Modal, Spin, Tag, Typography } from 'antd';
import { announcementApi } from '../services/api';

type AnnType = 'notice' | 'guide';

interface GuideStep {
  text: string;
  image: string | null;
}

interface Announcement {
  id: number;
  title: string;
  content: string;
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

const priorityColor: Record<string, string> = { urgent: 'red', important: 'orange', normal: 'blue' };
const priorityLabel: Record<string, string> = { urgent: '긴급', important: '중요', normal: '일반' };

const DISMISS_KEY = 'popup_dismiss'; // { [id]: 'YYYY-MM-DD' }

function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function readDismiss(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
  } catch {
    return {};
  }
}

// 단계 번호 뱃지
function StepBadge({ n }: { n: number }) {
  return (
    <div style={{
      flexShrink: 0,
      width: 28, height: 28, borderRadius: '50%',
      background: '#1677ff', color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 600, fontSize: 14,
    }}>
      {n}
    </div>
  );
}

// 공지/가이드 본문 렌더러 (게시판·팝업 공용)
function AnnouncementBody({ a, popup = false }: { a: Announcement; popup?: boolean }) {
  if (a.type === 'guide') {
    return (
      <Image.PreviewGroup>
        {a.content && (
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>
            {a.content}
          </Typography.Paragraph>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {(a.steps || []).map((step, i) => (
            <div key={i} style={{ display: 'flex', gap: 12 }}>
              <StepBadge n={i + 1} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {step.text && (
                  <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: '2px 0 8px' }}>
                    {step.text}
                  </Typography.Paragraph>
                )}
                {step.image && (
                  <Image
                    src={step.image}
                    style={{ borderRadius: 8, border: '1px solid rgba(140,140,140,0.2)' }}
                    preview={!popup}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </Image.PreviewGroup>
    );
  }

  // 일반 공지/안내
  const imgs = a.images && a.images.length > 0 ? a.images : (a.image_data ? [a.image_data] : []);
  return (
    <>
      {a.content && (
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: imgs.length ? 16 : 0 }}>
          {a.content}
        </Typography.Paragraph>
      )}
      {imgs.length > 0 && (
        <Image.PreviewGroup>
          <div style={{
            display: 'grid',
            gridTemplateColumns: imgs.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 8,
          }}>
            {imgs.map((src, i) => (
              <Image
                key={i}
                src={src}
                style={{ borderRadius: 8, border: '1px solid rgba(140,140,140,0.2)', objectFit: 'cover' }}
                preview={!popup}
              />
            ))}
          </div>
        </Image.PreviewGroup>
      )}
    </>
  );
}

export default function PublicViewPage() {
  const [list, setList] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [popups, setPopups] = useState<Announcement[]>([]);
  const [dontShowToday, setDontShowToday] = useState(false);

  const applyData = (items: Announcement[]) => {
    setList(items);
    const dismiss = readDismiss();
    const today = todayStr();
    setPopups(items.filter((a) => a.is_popup && dismiss[a.id] !== today));
  };

  const fetchData = async () => {
    try {
      const res = await announcementApi.list(true);
      applyData(res.data);
    } catch {
      // 무시
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/announcements`);
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'announcements' && Array.isArray(data.announcements)) {
          setList(data.announcements);
        }
      } catch {
        // 무시
      }
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closePopups = () => {
    if (dontShowToday) {
      const dismiss = readDismiss();
      const today = todayStr();
      popups.forEach((p) => { dismiss[p.id] = today; });
      localStorage.setItem(DISMISS_KEY, JSON.stringify(dismiss));
    }
    setPopups([]);
  };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '40px 16px' }}>
      <Typography.Title level={2} style={{ textAlign: 'center', marginBottom: 4 }}>
        공지사항
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginBottom: 36 }}>
        ReplayKit 안내 게시판
      </Typography.Paragraph>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : list.length === 0 ? (
        <Empty description="등록된 공지사항이 없습니다" style={{ marginTop: 80 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {list.map((a) => (
            <Card
              key={a.id}
              styles={{ body: { padding: 24 } }}
              style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <Tag color={priorityColor[a.priority]} style={{ margin: 0 }}>{priorityLabel[a.priority] || a.priority}</Tag>
                {a.type === 'guide' && <Tag color="geekblue" style={{ margin: 0 }}>가이드</Tag>}
                <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>{a.title}</Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {new Date(a.created_at).toLocaleDateString('ko-KR')}
                </Typography.Text>
              </div>
              <AnnouncementBody a={a} />
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={popups.length > 0}
        onCancel={closePopups}
        footer={null}
        closable={false}
        width={560}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxHeight: '68vh', overflowY: 'auto', paddingRight: 4 }}>
          {popups.map((p) => (
            <div key={p.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <Tag color={priorityColor[p.priority]} style={{ margin: 0 }}>{priorityLabel[p.priority] || p.priority}</Tag>
                {p.type === 'guide' && <Tag color="geekblue" style={{ margin: 0 }}>가이드</Tag>}
                <Typography.Title level={4} style={{ margin: 0 }}>{p.title}</Typography.Title>
              </div>
              <AnnouncementBody a={p} popup />
            </div>
          ))}
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginTop: 20, paddingTop: 12, borderTop: '1px solid rgba(140,140,140,0.2)',
        }}>
          <Checkbox checked={dontShowToday} onChange={(e) => setDontShowToday(e.target.checked)}>
            오늘 하루 그만 보기
          </Checkbox>
          <a onClick={closePopups} style={{ cursor: 'pointer' }}>닫기</a>
        </div>
      </Modal>
    </div>
  );
}
