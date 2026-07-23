import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Tag, Typography, message } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { loginSettingsApi } from '../services/api';

/**
 * 설정 — ReplayKit 로그인(사용자 식별)용 Jira 계정 관리.
 *
 * 각 ReplayKit 은 시작 시 이 서버의 /api/login-config 에서 Jira 계정을 받아
 * 유저 검색(이름/아이디/조직명)에 쓴다. 비밀번호는 저장 후 되돌려주지 않으며
 * (마스킹), 변경할 때만 새로 입력한다. 프로젝트/모델 선택지는 각 ReplayKit 의
 * 주 디바이스 카탈로그에서 오므로 여기서 관리하지 않는다.
 */
export default function SettingsPage() {
  const [form] = Form.useForm();
  const [pwSet, setPwSet] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await loginSettingsApi.get();
      form.setFieldsValue({
        jira_server: res.data.jira_server || '',
        jira_id: res.data.jira_id || '',
        jira_pw: '',
      });
      setPwSet(!!res.data.jira_pw_set);
    } catch {
      message.error('설정을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const res = await loginSettingsApi.save({
        jira_server: v.jira_server,
        jira_id: v.jira_id,
        // 빈 값이면 서버가 기존 비밀번호를 유지한다
        jira_pw: v.jira_pw || undefined,
      });
      setPwSet(!!res.data.jira_pw_set);
      form.setFieldValue('jira_pw', '');
      message.success('저장했습니다 — 각 ReplayKit 은 시작 시(또는 5분 캐시 만료 후) 반영됩니다');
    } catch {
      message.error('저장 실패');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        <SettingOutlined /> 설정
      </Typography.Title>

      <Card
        size="small"
        title="ReplayKit 로그인용 Jira 계정"
        style={{ maxWidth: 560 }}
        loading={loading}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          각 테스트 PC(ReplayKit)가 시작할 때 이 계정을 받아 Jira 유저 검색(로그인 화면)에
          사용합니다. 계정은 ReplayKit <b>백엔드에만</b> 전달되고 사용자 브라우저에는
          노출되지 않습니다. 프로젝트/모델 선택지는 각 PC 의 주 디바이스 카탈로그를 따릅니다.
        </Typography.Paragraph>

        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="Jira 서버" name="jira_server"
            rules={[{ required: true, message: 'Jira 서버 주소를 입력하세요' }]}>
            <Input placeholder="http://vlm.lge.com/issue" />
          </Form.Item>
          <Form.Item label="Jira ID" name="jira_id"
            rules={[{ required: true, message: 'Jira 계정 ID 를 입력하세요' }]}>
            <Input placeholder="jira 계정 ID" autoComplete="off" />
          </Form.Item>
          <Form.Item
            label={
              <span>
                비밀번호{' '}
                {pwSet
                  ? <Tag color="green" style={{ fontSize: 10 }}>저장됨</Tag>
                  : <Tag color="red" style={{ fontSize: 10 }}>미설정</Tag>}
              </span>
            }
            name="jira_pw"
            extra="변경할 때만 입력하세요 — 비워 두면 기존 비밀번호가 유지됩니다."
          >
            <Input.Password placeholder={pwSet ? '(변경 시에만 입력)' : 'Jira 비밀번호'} autoComplete="new-password" />
          </Form.Item>
        </Form>

        {!pwSet && (
          <Alert
            type="warning" showIcon style={{ marginBottom: 12 }}
            message="비밀번호가 아직 설정되지 않아 ReplayKit 로그인(유저 검색)이 동작하지 않습니다."
          />
        )}

        <Button type="primary" onClick={save} loading={saving}>저장</Button>
      </Card>
    </div>
  );
}
