import { useEffect, useState } from 'react';
import { Card, Checkbox, Empty, Image, Modal, Spin, Tag, Typography } from 'antd';
import { announcementApi } from '../services/api';

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

const DISMISS_KEY = 'popup_dismiss'; // { [id]: 'YYYY-MM-DD' }

function todayStr(): string {
  // 로컬 기준 YYYY-MM-DD
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

export default function PublicViewPage() {
  const [list, setList] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [popups, setPopups] = useState<Announcement[]>([]);
  const [dontShowToday, setDontShowToday] = useState(false);

  const applyData = (items: Announcement[]) => {
    setList(items);
    // 오늘 그만 보기로 닫지 않은 팝업만 표시
    const dismiss = readDismiss();
    const today = todayStr();
    const toShow = items.filter((a) => a.is_popup && dismiss[a.id] !== today);
    setPopups(toShow);
  };

  const fetchData = async () => {
    try {
      const res = await announcementApi.list(true);
      applyData(res.data);
    } catch {
      // 무시 (빈 화면 표시)
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();

    // 공지 실시간 갱신 구독 (관리자가 변경하면 자동 반영)
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
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 16px' }}>
      <Typography.Title level={2} style={{ textAlign: 'center', marginBottom: 4 }}>
        공지사항
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginBottom: 32 }}>
        ReplayKit 안내 게시판
      </Typography.Paragraph>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : list.length === 0 ? (
        <Empty description="등록된 공지사항이 없습니다" style={{ marginTop: 80 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {list.map((a) => (
            <Card key={a.id} size="small">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Tag color={priorityColor[a.priority]}>{priorityLabel[a.priority] || a.priority}</Tag>
                <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>{a.title}</Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {new Date(a.created_at).toLocaleDateString('ko-KR')}
                </Typography.Text>
              </div>
              {a.image_data && (
                <div style={{ marginBottom: 12, textAlign: 'center' }}>
                  <Image src={a.image_data} style={{ maxWidth: '100%', borderRadius: 8 }} />
                </div>
              )}
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {a.content}
              </Typography.Paragraph>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={popups.length > 0}
        onCancel={closePopups}
        onOk={closePopups}
        footer={null}
        closable={false}
        width={520}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '70vh', overflowY: 'auto' }}>
          {popups.map((p) => (
            <div key={p.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Tag color={priorityColor[p.priority]}>{priorityLabel[p.priority] || p.priority}</Tag>
                <Typography.Title level={4} style={{ margin: 0 }}>{p.title}</Typography.Title>
              </div>
              {p.image_data && (
                <div style={{ marginBottom: 12, textAlign: 'center' }}>
                  <Image src={p.image_data} style={{ maxWidth: '100%', borderRadius: 8 }} preview={false} />
                </div>
              )}
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {p.content}
              </Typography.Paragraph>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, paddingTop: 12, borderTop: '1px solid rgba(140,140,140,0.2)' }}>
          <Checkbox checked={dontShowToday} onChange={(e) => setDontShowToday(e.target.checked)}>
            오늘 하루 그만 보기
          </Checkbox>
          <a onClick={closePopups} style={{ cursor: 'pointer' }}>닫기</a>
        </div>
      </Modal>
    </div>
  );
}
