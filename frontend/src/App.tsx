import { useState } from 'react';
import { App as AntdApp, Button, ConfigProvider, Layout, Menu, message, Modal, theme } from 'antd';
import { BulbOutlined, BulbFilled, LogoutOutlined, NotificationOutlined, MessageOutlined, SyncOutlined, DesktopOutlined, BarChartOutlined, AreaChartOutlined } from '@ant-design/icons';
import AnnouncementsPage from './pages/AnnouncementsPage';
import ChatPage from './pages/ChatPage';
import LoginPage from './pages/LoginPage';
import PublicViewPage from './pages/PublicViewPage';
import FleetPage from './pages/FleetPage';
import FunctionStatsPage from './pages/FunctionStatsPage';
import UsageStatsPage from './pages/UsageStatsPage';
import { systemApi } from './services/api';

const { Sider, Content, Header } = Layout;

// 로그인 없이 접근하는 공개 경로
function isPublicView() {
  return window.location.pathname.replace(/\/+$/, '') === '/view';
}

function AppContent() {
  const [activeKey, setActiveKey] = useState('fleet');
  const [darkMode, setDarkMode] = useState(false);
  const [loggedIn, setLoggedIn] = useState(() => sessionStorage.getItem('logged_in') === '1');

  const [updating, setUpdating] = useState(false);

  const handleLogout = () => {
    sessionStorage.removeItem('logged_in');
    setLoggedIn(false);
  };

  const handleUpdate = () => {
    Modal.confirm({
      title: '업데이트',
      content: '최신 코드를 받아 서버를 재시작합니다. 진행하시겠습니까?',
      okText: '업데이트',
      cancelText: '취소',
      onOk: async () => {
        setUpdating(true);
        try {
          await systemApi.update();
        } catch {
          // 재시작 과정에서 응답이 끊길 수 있음 — 무시하고 복귀를 폴링
        }
        message.loading({ content: '서버 재시작 중... 잠시만 기다려 주세요', key: 'update', duration: 0 });
        const startedAt = Date.now();
        const poll = async () => {
          try {
            const res = await fetch('/health', { cache: 'no-store' });
            if (res.ok) {
              message.destroy('update');
              message.success('업데이트 완료 — 새로고침합니다');
              setTimeout(() => window.location.reload(), 600);
              return;
            }
          } catch {
            // 아직 재시작 중
          }
          if (Date.now() - startedAt < 60000) {
            setTimeout(poll, 1500);
          } else {
            message.destroy('update');
            message.error('재시작 확인 실패 — 잠시 후 수동으로 새로고침해 주세요');
            setUpdating(false);
          }
        };
        // 재시작이 시작될 시간을 준 뒤 폴링 시작
        setTimeout(poll, 3000);
      },
    });
  };

  if (!loggedIn) {
    return (
      <ConfigProvider theme={{ algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <AntdApp>
          <LoginPage onLogin={() => setLoggedIn(true)} />
        </AntdApp>
      </ConfigProvider>
    );
  }

  const pages: Record<string, JSX.Element> = {
    fleet: <FleetPage />,
    usageStats: <UsageStatsPage />,
    functionStats: <FunctionStatsPage />,
    announcements: <AnnouncementsPage />,
    chat: <ChatPage />,
  };

  return (
    <ConfigProvider theme={{ algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <AntdApp>
        <Layout style={{ minHeight: '100vh' }}>
          <Sider width={220} theme={darkMode ? 'dark' : 'light'}>
            <div style={{ height: 48, margin: 16, color: darkMode ? '#fff' : '#000', fontSize: 16, fontWeight: 'bold', textAlign: 'center', lineHeight: '48px' }}>
              ReplayKit Admin
            </div>
            <Menu
              theme={darkMode ? 'dark' : 'light'}
              mode="inline"
              selectedKeys={[activeKey]}
              onClick={({ key }) => setActiveKey(key)}
              items={[
                { key: 'fleet', icon: <DesktopOutlined />, label: '테스트 PC 관제' },
                { key: 'usageStats', icon: <AreaChartOutlined />, label: '사용량 통계' },
                { key: 'functionStats', icon: <BarChartOutlined />, label: '함수 사용통계' },
                { key: 'announcements', icon: <NotificationOutlined />, label: '공지사항 관리' },
                { key: 'chat', icon: <MessageOutlined />, label: '채팅 문의 관리' },
              ]}
            />
          </Sider>
          <Layout>
            <Header style={{
              padding: '0 24px',
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: 8,
              background: darkMode ? '#141414' : '#fff',
              borderBottom: `1px solid ${darkMode ? '#303030' : '#f0f0f0'}`,
            }}>
              <Button
                type="text"
                icon={<SyncOutlined spin={updating} />}
                loading={false}
                onClick={handleUpdate}
                disabled={updating}
              >
                업데이트
              </Button>
              <Button
                type="text"
                icon={darkMode ? <BulbOutlined /> : <BulbFilled />}
                onClick={() => setDarkMode(!darkMode)}
              >
                {darkMode ? 'Light' : 'Dark'}
              </Button>
              <Button
                type="text"
                danger
                icon={<LogoutOutlined />}
                onClick={handleLogout}
              >
                로그아웃
              </Button>
            </Header>
            <Content style={{
              margin: 16,
              padding: 24,
              background: darkMode ? '#141414' : '#fff',
              borderRadius: 8,
              minHeight: 360,
            }}>
              {pages[activeKey]}
            </Content>
          </Layout>
        </Layout>
      </AntdApp>
    </ConfigProvider>
  );
}

export default function App() {
  // 공개 읽기 전용 페이지: 로그인 불필요, 밝은 테마
  if (isPublicView()) {
    return (
      <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
        <AntdApp>
          <PublicViewPage />
        </AntdApp>
      </ConfigProvider>
    );
  }
  return <AppContent />;
}
