import { useEffect, useState } from 'react';
import { Card, Checkbox, Empty, Image, Modal, Segmented, Spin, Tag, Typography } from 'antd';
import { announcementApi } from '../services/api';

type AnnType = 'notice' | 'guide';
type Lang = 'ko' | 'en';

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

const priorityColor: Record<string, string> = { urgent: 'red', important: 'orange', normal: 'blue' };

// 언어별 페이지 문구
const STR = {
  ko: { notice: '공지사항', sub: 'ReplayKit 안내 게시판', empty: '등록된 공지사항이 없습니다', guide: '가이드', dontShow: '오늘 하루 그만 보기', close: '닫기', urgent: '긴급', important: '중요', normal: '일반' },
  en: { notice: 'Notices', sub: 'ReplayKit Notice Board', empty: 'No announcements yet', guide: 'Guide', dontShow: "Don't show again today", close: 'Close', urgent: 'Urgent', important: 'Important', normal: 'Normal' },
};

const LANG_KEY = 'view_lang';
const DISMISS_KEY = 'popup_dismiss';

function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function readDismiss(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}'); } catch { return {}; }
}
// 언어별 텍스트 선택 (영문 비면 한국어 폴백)
function pick(lang: Lang, ko: string, en?: string | null): string {
  return lang === 'en' && en && en.trim() ? en : ko;
}

function StepBadge({ n }: { n: number }) {
  return (
    <div style={{
      flexShrink: 0, width: 28, height: 28, borderRadius: '50%',
      background: '#1677ff', color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 600, fontSize: 14,
    }}>{n}</div>
  );
}

function AnnouncementBody({ a, lang, popup = false }: { a: Announcement; lang: Lang; popup?: boolean }) {
  const content = pick(lang, a.content, a.content_en);
  if (a.type === 'guide') {
    return (
      <Image.PreviewGroup>
        {content && (
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>
            {content}
          </Typography.Paragraph>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {(a.steps || []).map((step, i) => {
            const text = pick(lang, step.text, step.text_en);
            return (
              <div key={i} style={{ display: 'flex', gap: 12 }}>
                <StepBadge n={i + 1} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {text && (
                    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: '2px 0 8px' }}>
                      {text}
                    </Typography.Paragraph>
                  )}
                  {step.image && (
                    <Image src={step.image} style={{ borderRadius: 8, border: '1px solid rgba(140,140,140,0.2)' }} preview={!popup} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Image.PreviewGroup>
    );
  }

  const imgs = a.images && a.images.length > 0 ? a.images : (a.image_data ? [a.image_data] : []);
  return (
    <>
      {content && (
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: imgs.length ? 16 : 0 }}>
          {content}
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
              <Image key={i} src={src} style={{ borderRadius: 8, border: '1px solid rgba(140,140,140,0.2)', objectFit: 'cover' }} preview={!popup} />
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
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ko'));

  const t = STR[lang];
  const priorityLabel: Record<string, string> = { urgent: t.urgent, important: t.important, normal: t.normal };

  const changeLang = (v: Lang) => {
    setLang(v);
    localStorage.setItem(LANG_KEY, v);
  };

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
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Segmented
          value={lang}
          onChange={(v) => changeLang(v as Lang)}
          options={[{ label: '한국어', value: 'ko' }, { label: 'English', value: 'en' }]}
        />
      </div>
      <Typography.Title level={2} style={{ textAlign: 'center', marginBottom: 4 }}>
        {t.notice}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginBottom: 36 }}>
        {t.sub}
      </Typography.Paragraph>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : list.length === 0 ? (
        <Empty description={t.empty} style={{ marginTop: 80 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {list.map((a) => (
            <Card key={a.id} styles={{ body: { padding: 24 } }} style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <Tag color={priorityColor[a.priority]} style={{ margin: 0 }}>{priorityLabel[a.priority] || a.priority}</Tag>
                {a.type === 'guide' && <Tag color="geekblue" style={{ margin: 0 }}>{t.guide}</Tag>}
                <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>{pick(lang, a.title, a.title_en)}</Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {new Date(a.created_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'ko-KR')}
                </Typography.Text>
              </div>
              <AnnouncementBody a={a} lang={lang} />
            </Card>
          ))}
        </div>
      )}

      <Modal open={popups.length > 0} onCancel={closePopups} footer={null} closable={false} width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxHeight: '68vh', overflowY: 'auto', paddingRight: 4 }}>
          {popups.map((p) => (
            <div key={p.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <Tag color={priorityColor[p.priority]} style={{ margin: 0 }}>{priorityLabel[p.priority] || p.priority}</Tag>
                {p.type === 'guide' && <Tag color="geekblue" style={{ margin: 0 }}>{t.guide}</Tag>}
                <Typography.Title level={4} style={{ margin: 0 }}>{pick(lang, p.title, p.title_en)}</Typography.Title>
              </div>
              <AnnouncementBody a={p} lang={lang} popup />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, paddingTop: 12, borderTop: '1px solid rgba(140,140,140,0.2)' }}>
          <Checkbox checked={dontShowToday} onChange={(e) => setDontShowToday(e.target.checked)}>
            {t.dontShow}
          </Checkbox>
          <a onClick={closePopups} style={{ cursor: 'pointer' }}>{t.close}</a>
        </div>
      </Modal>
    </div>
  );
}
