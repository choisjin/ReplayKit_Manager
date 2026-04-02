import { useState } from 'react';
import { App as AntdApp, Button, ConfigProvider, Layout, Menu, theme } from 'antd';
import { BulbOutlined, BulbFilled, LogoutOutlined, NotificationOutlined, MessageOutlined } from '@ant-design/icons';
import AnnouncementsPage from './pages/AnnouncementsPage';
import ChatPage from './pages/ChatPage';
import LoginPage from './pages/LoginPage';

const { Sider, Content, Header } = Layout;

function AppContent() {
  const [activeKey, setActiveKey] = useState('announcements');
  const [darkMode, setDarkMode] = useState(true);
  const [loggedIn, setLoggedIn] = useState(() => sessionStorage.getItem('logged_in') === '1');

  const handleLogout = () => {
    sessionStorage.removeItem('logged_in');
    setLoggedIn(false);
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
  return <AppContent />;
}
