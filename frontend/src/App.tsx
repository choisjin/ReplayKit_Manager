import { useState } from 'react';
import { App as AntdApp, ConfigProvider, Layout, Menu, theme } from 'antd';
import { NotificationOutlined, MessageOutlined } from '@ant-design/icons';
import AnnouncementsPage from './pages/AnnouncementsPage';
import ChatPage from './pages/ChatPage';

const { Sider, Content } = Layout;

function AppContent() {
  const [activeKey, setActiveKey] = useState('announcements');

  const pages: Record<string, JSX.Element> = {
    announcements: <AnnouncementsPage />,
    chat: <ChatPage />,
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={220} theme="dark">
        <div style={{ height: 48, margin: 16, color: '#fff', fontSize: 16, fontWeight: 'bold', textAlign: 'center', lineHeight: '48px' }}>
          ReplayKit Admin
        </div>
        <Menu
          theme="dark"
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
        <Content style={{ margin: 16, padding: 24, background: '#141414', borderRadius: 8, minHeight: 360 }}>
          {pages[activeKey]}
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <AntdApp>
        <AppContent />
      </AntdApp>
    </ConfigProvider>
  );
}
