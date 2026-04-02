import { useEffect, useState } from 'react';
import { MessageOutlined, CloseOutlined } from '@ant-design/icons';

export interface NotificationItem {
  id: number;
  userName: string;
  content: string;
  roomId: string;
}

interface Props {
  notifications: NotificationItem[];
  onClose: (id: number) => void;
  onClick: (roomId: string) => void;
}

function BannerItem({ item, onClose, onClick }: { item: NotificationItem; onClose: () => void; onClick: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        background: '#1677ff',
        color: '#fff',
        borderRadius: 8,
        cursor: 'pointer',
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        transform: visible ? 'translateX(0)' : 'translateX(120%)',
        opacity: visible ? 1 : 0,
        transition: 'all 0.3s ease',
        maxWidth: 360,
      }}
    >
      <MessageOutlined style={{ fontSize: 20, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{item.userName}</div>
        <div style={{ fontSize: 12, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.content}
        </div>
      </div>
      <CloseOutlined
        style={{ fontSize: 12, opacity: 0.7, flexShrink: 0 }}
        onClick={(e) => {
          e.stopPropagation();
          setVisible(false);
          setTimeout(onClose, 300);
        }}
      />
    </div>
  );
}

export default function NotificationBanner({ notifications, onClose, onClick }: Props) {
  if (notifications.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 16,
      right: 16,
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      {notifications.map((n) => (
        <BannerItem
          key={n.id}
          item={n}
          onClose={() => onClose(n.id)}
          onClick={() => {
            onClick(n.roomId);
            onClose(n.id);
          }}
        />
      ))}
    </div>
  );
}
