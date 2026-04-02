import { useEffect, useRef, useState, useCallback } from 'react';
import { Badge, Button, Card, Empty, Input, List, message, Modal, Space, Tag, Typography } from 'antd';
import { CloseCircleOutlined, DeleteOutlined, SendOutlined, UserOutlined } from '@ant-design/icons';
import { chatApi } from '../services/api';

interface ChatRoom {
  id: string;
  user_name: string;
  department: string;
  status: string;
  unread_count: number;
  created_at: string;
  last_message: string | null;
  last_message_at: string | null;
}

interface ChatMessage {
  id: number;
  room_id: string;
  sender: string;
  content: string;
  created_at: string;
  user_name?: string;
}

// 알림 사운드 생성 (beep)
function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // AudioContext not available
  }
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showBrowserNotification(title: string, body: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico' });
  }
}

export default function ChatPage() {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputVal, setInputVal] = useState('');
  const [userTyping, setUserTyping] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>();
  const activeRoomRef = useRef<string | null>(null);

  // activeRoom ref 동기화 (WebSocket 콜백에서 최신 값 참조)
  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  // 알림 권한 요청
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // WebSocket 연결
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/admin/chat`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      switch (data.type) {
        case 'room_list':
          setRooms(data.rooms);
          break;
        case 'new_message': {
          // 현재 보고있는 방의 메시지면 추가
          setMessages(prev => {
            if (prev.length > 0 && prev[0]?.room_id === data.room_id) {
              return [...prev, data.message];
            }
            return prev;
          });
          // 다른 방이거나 유저 메시지면 알림
          if (data.message?.sender === 'user') {
            const userName = data.message.user_name || '유저';
            playNotificationSound();
            if (activeRoomRef.current !== data.room_id) {
              showBrowserNotification(
                `새 메시지 - ${userName}`,
                data.message.content,
              );
            }
          }
          break;
        }
        case 'room_messages':
          if (data.messages) {
            setMessages(data.messages);
          }
          break;
        case 'user_typing':
          setUserTyping(true);
          clearTimeout(typingTimeout.current);
          typingTimeout.current = setTimeout(() => setUserTyping(false), 2000);
          break;
        case 'user_disconnected':
          break;
      }
    };

    ws.onclose = () => {
      console.log('Admin WS closed');
    };

    return () => {
      ws.close();
    };
  }, []);

  // 메시지 스크롤
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSelectRoom = (roomId: string) => {
    setActiveRoom(roomId);
    setMessages([]);
    setUserTyping(false);
    wsRef.current?.send(JSON.stringify({ type: 'join_room', room_id: roomId }));
  };

  const handleSend = () => {
    if (!inputVal.trim() || !activeRoom) return;
    wsRef.current?.send(JSON.stringify({
      type: 'message',
      room_id: activeRoom,
      content: inputVal.trim(),
    }));
    setMessages(prev => [...prev, {
      id: Date.now(),
      room_id: activeRoom,
      sender: 'admin',
      content: inputVal.trim(),
      created_at: new Date().toISOString(),
    }]);
    setInputVal('');
  };

  const handleCloseRoom = async (roomId: string) => {
    try {
      await chatApi.closeRoom(roomId);
      message.success('채팅방 종료');
      if (activeRoom === roomId) {
        setActiveRoom(null);
        setMessages([]);
      }
    } catch {
      message.error('종료 실패');
    }
  };

  const handleDeleteRoom = useCallback(async (roomId: string) => {
    try {
      await chatApi.deleteRoom(roomId);
      message.success('채팅방 삭제 완료');
      if (activeRoom === roomId) {
        setActiveRoom(null);
        setMessages([]);
      }
    } catch {
      message.error('삭제 실패');
    }
  }, [activeRoom]);

  const activeRoomData = rooms.find(r => r.id === activeRoom);

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 120px)' }}>
      {/* 채팅방 목록 */}
      <Card
        title="채팅 목록"
        size="small"
        style={{ width: 320, flexShrink: 0, overflow: 'auto' }}
        bodyStyle={{ padding: 0 }}
      >
        <List
          dataSource={rooms}
          locale={{ emptyText: <Empty description="채팅 문의가 없습니다" /> }}
          renderItem={(room) => (
            <List.Item
              key={room.id}
              onClick={() => handleSelectRoom(room.id)}
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                background: activeRoom === room.id ? 'rgba(22,119,255,0.15)' : undefined,
              }}
              extra={
                <Space size={4}>
                  {room.status === 'active' ? (
                    <Badge count={room.unread_count} size="small" />
                  ) : (
                    <Tag color="default">종료</Tag>
                  )}
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      Modal.confirm({
                        title: '채팅방 삭제',
                        content: `${room.user_name} (${room.department}) 채팅을 삭제하시겠습니까?`,
                        okText: '삭제',
                        okButtonProps: { danger: true },
                        cancelText: '취소',
                        onOk: () => handleDeleteRoom(room.id),
                      });
                    }}
                  />
                </Space>
              }
            >
              <List.Item.Meta
                avatar={<UserOutlined style={{ fontSize: 20, color: room.status === 'active' ? '#1677ff' : '#666' }} />}
                title={
                  <span>
                    {room.user_name}
                    <span style={{ fontSize: 12, color: '#888', marginLeft: 6 }}>{room.department}</span>
                  </span>
                }
                description={
                  <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                    {room.last_message || '새 문의'}
                  </Typography.Text>
                }
              />
            </List.Item>
          )}
        />
      </Card>

      {/* 채팅 영역 */}
      <Card
        title={
          activeRoomData ? (
            <Space>
              <span>{activeRoomData.user_name}</span>
              <Tag>{activeRoomData.department}</Tag>
              {activeRoomData.status === 'active' && (
                <Button size="small" danger icon={<CloseCircleOutlined />} onClick={() => handleCloseRoom(activeRoom!)}>
                  종료
                </Button>
              )}
            </Space>
          ) : '채팅방을 선택하세요'
        }
        size="small"
        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
      >
        {/* 메시지 목록 */}
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {!activeRoom ? (
            <Empty description="좌측에서 채팅방을 선택하세요" style={{ marginTop: 80 }} />
          ) : messages.length === 0 ? (
            <Empty description="메시지가 없습니다" style={{ marginTop: 80 }} />
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  justifyContent: msg.sender === 'admin' ? 'flex-end' : 'flex-start',
                  marginBottom: 8,
                }}
              >
                <div style={{
                  maxWidth: '70%',
                  padding: '8px 12px',
                  borderRadius: 12,
                  background: msg.sender === 'admin' ? '#1677ff' : '#303030',
                  color: '#fff',
                }}>
                  <div style={{ fontSize: 13 }}>{msg.content}</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 2, textAlign: 'right' }}>
                    {new Date(msg.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))
          )}
          {userTyping && (
            <div style={{ fontSize: 12, color: '#888', padding: '4px 0' }}>상대방이 입력 중...</div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 입력 영역 */}
        {activeRoom && activeRoomData?.status === 'active' && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid #303030', display: 'flex', gap: 8 }}>
            <Input
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onPressEnter={handleSend}
              placeholder="메시지를 입력하세요..."
              autoFocus
            />
            <Button type="primary" icon={<SendOutlined />} onClick={handleSend} disabled={!inputVal.trim()}>
              전송
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
