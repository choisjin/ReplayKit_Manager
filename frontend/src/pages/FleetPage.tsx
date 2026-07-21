import { useEffect, useRef, useState } from 'react';
import { Badge, Card, Col, Empty, Progress, Row, Statistic, Tag, Tooltip, Typography } from 'antd';
import { DesktopOutlined, PlayCircleOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { agentApi } from '../services/api';

interface DeviceInfo {
  device_id: string; name: string; module?: string;
  category?: string; type: string; status: string;
}

/** 디바이스 표시명.
 *  - auxiliary(모듈·시리얼): 연결된 **모듈명**을 표시. Common/OCR/Frame_Check 는 name 이
 *    전부 "Common" 이라 구분이 안 되므로 module(CMD·SHELL·OCR·Frame_Check…)을 쓴다.
 *  - primary(ADB/에이전트 등 물리 디바이스): name 이 곧 식별자이므로 **이름을 그대로** 표시.
 *    (여기에 module 을 우선하면 주 디바이스 이름이 엉뚱하게 바뀐다) */
function deviceLabel(d: DeviceInfo): string {
  if (d.category === 'auxiliary' && d.module) return d.module;
  return d.name || d.module || d.device_id;
}
interface Playback {
  scenario_name: string;
  current_cycle: number;
  total_cycles: number;
  current_step: number;
  total_steps: number;
  status: string;
  passed: number;
  failed: number;
  warning: number;
  error: number;
  error_message?: string;
}
interface Agent {
  client_id: string;
  name: string;
  ip: string;
  version: string;
  online: boolean;
  last_seen: string;
  activity: string;
  devices: DeviceInfo[];
  device_count: number;
  connected_device_count: number;
  playback: Playback | null;
  scenario_count: number;
}
interface Summary { total: number; online: number; playing: number; recording: number; }

const ACTIVITY_LABEL: Record<string, string> = { idle: '대기', in_use: '사용중', playing: '재생 중', recording: '녹화 중' };
const ACTIVITY_COLOR: Record<string, string> = { idle: 'default', in_use: 'blue', playing: 'processing', recording: 'error' };

function relTime(iso?: string): string {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '-';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 5) return '방금';
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  return `${Math.floor(sec / 3600)}시간 전`;
}

/**
 * 테스트 PC 관제 대시보드 — 각 PC(머신 UID 기준)의 실시간 재생 상태를 카드로 표시.
 * 2초마다 /api/agents 폴링. 원격제어 없이 모니터링 전용.
 */
export default function FleetPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, online: 0, playing: 0, recording: 0 });
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | null>(null);

  const load = async () => {
    try {
      const res = await agentApi.list();
      setAgents(res.data.agents || []);
      setSummary(res.data.summary || { total: 0, online: 0, playing: 0, recording: 0 });
      setLoaded(true);
    } catch {
      /* 폴링 중 일시 실패 무시 */
    }
  };

  useEffect(() => {
    load();
    timer.current = window.setInterval(load, 2000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        <DesktopOutlined /> 테스트 PC 관제
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        각 테스트 PC 가 관제 서버(이 서버)로 보고한 실시간 재생 상태입니다. PC 식별은 하드웨어 머신 UID 기준이며,
        표시된 IP 는 참고용입니다. (2초마다 자동 갱신)
      </Typography.Paragraph>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="전체 PC" value={summary.total} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="온라인" value={summary.online} valueStyle={{ color: '#52c41a' }} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="재생 중" value={summary.playing} valueStyle={{ color: '#1677ff' }} prefix={<PlayCircleOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="녹화 중" value={summary.recording} valueStyle={{ color: '#cf1322' }} prefix={<VideoCameraOutlined />} /></Card></Col>
      </Row>

      {agents.length === 0 ? (
        <Empty description={loaded ? '연결된 테스트 PC 없음 — ReplayKit 설정에서 관제 서버 URL 을 이 서버로 지정하세요' : '로딩 중...'} />
      ) : (
        <Row gutter={[12, 12]}>
          {agents.map(a => {
            const pb = a.playback;
            const cycleTotal = pb?.total_cycles || 0;
            const cyclePct = cycleTotal > 0 ? Math.round(((pb!.current_cycle) / cycleTotal) * 100) : 0;
            return (
              <Col xs={24} sm={12} lg={8} key={a.client_id}>
                <Card
                  size="small"
                  title={
                    <span>
                      <Badge status={a.online ? 'success' : 'default'} />
                      <Typography.Text strong>{a.name || a.client_id}</Typography.Text>
                    </span>
                  }
                  extra={<Tag color={ACTIVITY_COLOR[a.activity] || 'default'}>{ACTIVITY_LABEL[a.activity] || a.activity}</Tag>}
                  style={{ opacity: a.online ? 1 : 0.6 }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#888' }}>
                      <Tooltip title={`머신 UID: ${a.client_id}`}><span>IP {a.ip || '-'}</span></Tooltip>
                      <span>{a.online ? '온라인' : `오프라인 · ${relTime(a.last_seen)}`}</span>
                    </div>

                    {/* 연결 디바이스 */}
                    <div>
                      <Typography.Text type="secondary">디바이스 </Typography.Text>
                      <Tag>{a.connected_device_count}/{a.device_count} 연결</Tag>
                      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 3, marginTop: 3 }}>
                        {a.devices.map(d => (
                          <Tooltip key={d.device_id} title={`${d.device_id} · ${d.type} · ${d.status}`}>
                            <Tag color={d.status === 'connected' ? 'green' : 'default'} style={{ fontSize: 10, margin: 0 }}>
                              {deviceLabel(d)}
                            </Tag>
                          </Tooltip>
                        ))}
                      </span>
                    </div>

                    {/* 재생 상태 */}
                    {pb ? (
                      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 6 }}>
                        <div style={{ marginBottom: 4 }}>
                          <PlayCircleOutlined style={{ color: '#1677ff' }} />{' '}
                          <Typography.Text strong>{pb.scenario_name}</Typography.Text>{' '}
                          {pb.status === 'paused' && <Tag color="orange">일시정지</Tag>}
                          {pb.status === 'error' && <Tag color="red">에러</Tag>}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Typography.Text type="secondary" style={{ minWidth: 42 }}>회차</Typography.Text>
                          <div style={{ flex: 1 }}><Progress percent={cyclePct} size="small" showInfo={false} /></div>
                          <Typography.Text strong>{pb.current_cycle}/{cycleTotal || '?'}</Typography.Text>
                        </div>
                        <div style={{ marginTop: 2, color: '#888' }}>
                          스텝 {pb.current_step}/{pb.total_steps}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <Tag color="green">PASS {pb.passed}</Tag>
                          <Tag color="red">FAIL {pb.failed}</Tag>
                          {pb.warning > 0 && <Tag color="orange">WARN {pb.warning}</Tag>}
                          <Tag color="volcano">ERROR {pb.error}</Tag>
                        </div>
                        {pb.error_message && (
                          <Typography.Paragraph type="danger" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }} ellipsis={{ rows: 2, tooltip: pb.error_message }}>
                            {pb.error_message}
                          </Typography.Paragraph>
                        )}
                      </div>
                    ) : (
                      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 6, color: '#aaa' }}>
                        재생 중 아님 · 시나리오 {a.scenario_count}개 보유
                      </div>
                    )}
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}
    </div>
  );
}
