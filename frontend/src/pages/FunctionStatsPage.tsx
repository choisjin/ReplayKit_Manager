import { useEffect, useRef, useState } from 'react';
import { Card, Col, Empty, Input, Progress, Row, Statistic, Table, Tag, Typography } from 'antd';
import { BarChartOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { agentApi } from '../services/api';

interface FuncAgg { function: string; count: number; pc_count: number; hosts: string[]; }
interface ModuleAgg { module: string; count: number; pc_count: number; function_count: number; functions: FuncAgg[]; }
interface StepTypeAgg { type: string; count: number; }
interface FleetUnused { module: string; function: string; }
interface AggStats {
  generated_at: string;
  contributor_count: number;
  contributors: { client_id: string; host: string }[];
  step_types: StepTypeAgg[];
  modules: ModuleAgg[];
  fleet_unused: FleetUnused[];
  available_function_count: number;
  used_function_count: number;
}

/**
 * PC 간 모듈/함수 사용통계 집계 페이지.
 * 모든 테스트 PC 가 보고한 usage-stats 를 합산해, 전사 함수 사용 빈도와
 * '전 PC 어디서도 안 쓰이는 함수(fleet_unused)' = 개선/삭제 최우선 후보를 보여준다.
 */
export default function FunctionStatsPage() {
  const [stats, setStats] = useState<AggStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [unusedFilter, setUnusedFilter] = useState('');
  const timer = useRef<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await agentApi.functionStats();
      setStats(res.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    timer.current = window.setInterval(load, 5000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  const maxModuleCount = stats?.modules[0]?.count || 1;
  const filteredUnused = (stats?.fleet_unused || []).filter(u =>
    !unusedFilter ||
    u.module.toLowerCase().includes(unusedFilter.toLowerCase()) ||
    u.function.toLowerCase().includes(unusedFilter.toLowerCase())
  );
  const unusedByModule: Record<string, number> = {};
  (stats?.fleet_unused || []).forEach(u => { unusedByModule[u.module] = (unusedByModule[u.module] || 0) + 1; });

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        <BarChartOutlined /> 함수 사용통계 (전 PC 집계)
        <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading} style={{ marginLeft: 12 }}>새로고침</Button>
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        모든 테스트 PC 가 보고한 시나리오 모듈/함수 사용량을 합산합니다. 오프라인 PC 는 마지막 스냅샷(DB)으로 보강됩니다.
        <b> 전 PC 어디서도 안 쓰이는 함수</b>는 하단 표에서 개선/삭제 최우선 후보로 확인하세요.
        {stats?.generated_at && <span> · 집계: {new Date(stats.generated_at).toLocaleString()}</span>}
      </Typography.Paragraph>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="집계 PC 수" value={stats?.contributor_count ?? 0} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="사용 함수"
          value={stats?.used_function_count ?? 0}
          suffix={<span style={{ fontSize: 12, color: '#888' }}>/ {stats?.available_function_count ?? 0}</span>} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="사용 모듈" value={stats?.modules.length ?? 0} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="전 PC 미사용 함수"
          value={stats?.fleet_unused.length ?? 0} prefix={<WarningOutlined />}
          valueStyle={{ color: (stats?.fleet_unused.length || 0) > 0 ? '#fa8c16' : undefined }} /></Card></Col>
      </Row>

      {/* 모듈 · 함수 사용량 */}
      <Card size="small" title="모듈 · 함수 사용량 (전 PC 합산)" style={{ marginBottom: 16 }}
        extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>행을 펼치면 함수별 상세</Typography.Text>}>
        {!stats || stats.modules.length === 0 ? (
          <Empty description={loading ? '로딩 중...' : '보고된 모듈 사용 없음'} />
        ) : (
          <Table
            size="small" rowKey="module" pagination={false}
            dataSource={stats.modules}
            expandable={{
              expandedRowRender: (m: ModuleAgg) => (
                <Table
                  size="small" rowKey="function" pagination={false}
                  dataSource={m.functions}
                  columns={[
                    { title: '함수', dataIndex: 'function', key: 'function',
                      render: (f: string) => <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{f}</Typography.Text> },
                    { title: '총 사용 횟수', dataIndex: 'count', key: 'count', width: 120,
                      render: (c: number) => <Typography.Text strong>{c}</Typography.Text> },
                    { title: 'PC 수', dataIndex: 'pc_count', key: 'pc', width: 90, render: (n: number) => <Tag>{n}</Tag> },
                    { title: '사용 PC', dataIndex: 'hosts', key: 'hosts',
                      render: (arr: string[]) => (
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {arr.map(h => <Tag key={h} style={{ fontSize: 10, margin: 0 }}>{h}</Tag>)}
                        </span>
                      ) },
                  ]}
                />
              ),
            }}
            columns={[
              { title: '모듈', dataIndex: 'module', key: 'module',
                render: (m: string) => <Tag color="blue" style={{ fontFamily: 'monospace' }}>{m}</Tag> },
              { title: '총 사용 횟수', dataIndex: 'count', key: 'count', width: 280,
                defaultSortOrder: 'descend', sorter: (a: ModuleAgg, b: ModuleAgg) => a.count - b.count,
                render: (c: number) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1 }}><Progress percent={Math.round((c / maxModuleCount) * 100)} showInfo={false} size="small" /></div>
                    <Typography.Text strong style={{ minWidth: 44, textAlign: 'right' }}>{c}</Typography.Text>
                  </div>
                ) },
              { title: '함수 종류', dataIndex: 'function_count', key: 'fc', width: 100, render: (n: number) => <Tag>{n}</Tag> },
              { title: 'PC 수', dataIndex: 'pc_count', key: 'pc', width: 90, render: (n: number) => <Tag>{n}</Tag> },
            ]}
          />
        )}
      </Card>

      {/* 전 PC 미사용 함수 */}
      <Card size="small"
        title={<span><WarningOutlined style={{ color: '#fa8c16' }} /> 전 PC 미사용 함수 (삭제 최우선 후보)</span>}
        extra={<Input.Search allowClear placeholder="모듈/함수 검색" size="small" style={{ width: 200 }}
          value={unusedFilter} onChange={(e) => setUnusedFilter(e.target.value)} />}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 8 }}>
          어떤 테스트 PC 의 시나리오에서도 module_command 로 한 번도 호출되지 않은 함수입니다.
          대조 카탈로그는 <b>각 PC 에서 활성화된(디바이스로 등록된) 모듈</b>만 모은 것이라,
          어느 PC 에도 장비가 없는 모듈은 애초에 여기 올라오지 않습니다.
          (전용 스텝 타입으로 제공되는 tap/swipe 등, <code>#test</code> 전용 실험 모듈도 제외.)
        </Typography.Paragraph>
        {Object.keys(unusedByModule).length > 0 && (
          <div style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.entries(unusedByModule).sort((a, b) => b[1] - a[1]).map(([mod, n]) => (
              <Tag key={mod} color="orange" style={{ cursor: 'pointer' }} onClick={() => setUnusedFilter(mod)}>{mod}: {n}</Tag>
            ))}
          </div>
        )}
        {!stats || stats.fleet_unused.length === 0 ? (
          <Empty description={loading ? '로딩 중...' : (stats ? '전 PC 미사용 함수 없음' : '데이터 없음')} />
        ) : (
          <Table
            size="small" rowKey={(r: FleetUnused) => `${r.module}.${r.function}`}
            pagination={{ pageSize: 20, size: 'small', showSizeChanger: true }}
            dataSource={filteredUnused}
            columns={[
              { title: '모듈', dataIndex: 'module', key: 'module', width: 200,
                render: (m: string) => <Tag color="blue" style={{ fontFamily: 'monospace' }}>{m}</Tag>,
                sorter: (a: FleetUnused, b: FleetUnused) => a.module.localeCompare(b.module) },
              { title: '함수', dataIndex: 'function', key: 'function',
                render: (f: string) => <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{f}</Typography.Text>,
                sorter: (a: FleetUnused, b: FleetUnused) => a.function.localeCompare(b.function) },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
