import { Tooltip, Typography } from 'antd';
import { STATE, STATE_ORDER, StateKey, tint } from '../lib/agentState';

/** 한 막대 = 한 시간 버킷.
 *  - counts : 상태별 **샘플 수** (버킷 안에서 상태별로 몇 번 찍혔는지)
 *  - ticks  : 그 버킷의 샘플 tick 수. counts/ticks = 그 구간의 평균 PC 대수.
 *             ticks=0 이면 그 시간엔 매니저가 꺼져 있었다는 뜻 → '데이터 없음'으로 비운다
 *             (0 대기와 구분하지 않으면 서버 다운을 '전부 놀았다'로 오독하게 된다). */
export interface Bucket {
  key: string;          // React key
  label: string;        // x축 라벨 (빈 문자열이면 라벨 생략 — 조밀할 때 솎아내기)
  tipTitle: string;     // hover 툴팁 제목
  ticks: number;
  counts: Partial<Record<StateKey, number>>;
}

interface Props {
  data: Bucket[];
  /** avg = 평균 PC 대수(막대 높이가 절대량), pct = 비율(막대 높이 100% 고정) */
  mode: 'avg' | 'pct';
  height?: number;
  /** 지정 시: 막대가 고정폭이 되어 부모의 가로 스크롤 컨테이너 안에서 흐른다.
   *  미지정: 기존처럼 flex 균등폭(한 화면에 모두 맞춤). */
  barWidth?: number;
  /** 가상 스크롤용 — 렌더에서 잘라낸 앞/뒤 구간을 픽셀 폭으로 채워
   *  전체 콘텐츠 폭(= 전체 버킷 수 × 막대폭)을 유지한다. */
  padLeft?: number;
  padRight?: number;
  /** avg 모드 세로축 최대값 override — 가상 스크롤로 일부만 렌더할 때
   *  전체 데이터 기준 스케일을 고정하기 위해 부모가 계산해 넘긴다. */
  max?: number;
}

function fmt(n: number): string {
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

/**
 * 의존성 없는 스택 막대 그래프 (div + flex).
 * 차트 라이브러리를 추가하면 번들이 수백 KB 늘어나는데, 여기서 필요한 건
 * '상태별 스택 막대 + hover' 뿐이라 직접 그린다. 색은 STATE 표를 그대로 쓴다.
 */
export default function StackedBars({ data, mode, height = 170, barWidth, padLeft = 0, padRight = 0, max: maxProp }: Props) {
  // 막대 높이의 기준 — 평균 대수 모드에선 전체 최대값에 맞춘다.
  const avgOf = (b: Bucket, k: StateKey) => (b.ticks > 0 ? (b.counts[k] || 0) / b.ticks : 0);
  const totalOf = (b: Bucket) => STATE_ORDER.reduce((s, k) => s + avgOf(b, k), 0);
  const max = maxProp ?? Math.max(1, ...data.map(totalOf));

  const fixed = barWidth != null;
  // 고정폭 모드는 gap 대신 셀 내부 paddingRight 로 1px 간격을 만든다 —
  // 스페이서(padLeft/padRight) 폭 계산이 '셀 수 × 셀 폭'으로 딱 떨어지게.
  const cellStyle = fixed
    ? { width: barWidth! + 1, flex: '0 0 auto' as const, paddingRight: 1, boxSizing: 'border-box' as const }
    : { flex: 1, minWidth: 0 };
  const rowStyle = fixed
    ? { gap: 0, width: 'max-content' as const }
    : { gap: 1 };

  const spacer = (w: number) => (w > 0 ? <div style={{ width: w, flex: '0 0 auto' }} /> : null);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'stretch', height, position: 'relative', ...rowStyle }}>
        {/* 기준선(최대/절반) — 눈금 대신 옅은 가로선만 */}
        {[0, 0.5, 1].map(f => (
          <div key={f} style={{
            position: 'absolute', left: 0, right: 0, bottom: `${f * 100}%`,
            borderTop: '1px dashed rgba(140,140,140,0.25)', pointerEvents: 'none',
          }} />
        ))}
        {spacer(padLeft)}
        {data.map(b => {
          const total = totalOf(b);
          const barPct = b.ticks === 0 ? 0 : (mode === 'pct' ? 100 : (total / max) * 100);
          return (
            <Tooltip
              key={b.key}
              title={
                <div style={{ fontSize: 11, lineHeight: 1.7 }}>
                  <div><b>{b.tipTitle}</b></div>
                  {b.ticks === 0 ? (
                    <div style={{ opacity: 0.8 }}>데이터 없음 (관제 서버 미가동)</div>
                  ) : (
                    <>
                      {STATE_ORDER.filter(k => (b.counts[k] || 0) > 0).map(k => (
                        <div key={k}>
                          <span style={{ color: STATE[k].color }}>■</span> {STATE[k].label}{' '}
                          {fmt(avgOf(b, k))}대
                          <span style={{ opacity: 0.6 }}>
                            {' '}({Math.round((avgOf(b, k) / (total || 1)) * 100)}%)
                          </span>
                        </div>
                      ))}
                      <div style={{ opacity: 0.6 }}>평균 {fmt(total)}대 · 표본 {b.ticks}회</div>
                    </>
                  )}
                </div>
              }
            >
              <div style={{
                ...cellStyle, display: 'flex', flexDirection: 'column',
                justifyContent: 'flex-end', cursor: 'default',
              }}>
                {b.ticks === 0 ? (
                  // 데이터 없음 — 바닥에 옅은 점선만 남겨 '0대'와 구분한다
                  <div style={{ height: 3, background: 'rgba(140,140,140,0.25)' }} />
                ) : (
                  // column-reverse — STATE_ORDER 첫 항목(재생 중)이 **바닥**에 오게 한다.
                  // 스택 막대는 바닥 계열이 가장 비교하기 쉬워서, 제일 궁금한 값을 아래 둔다.
                  <div style={{ height: `${barPct}%`, display: 'flex', flexDirection: 'column-reverse' }}>
                    {STATE_ORDER.map(k => {
                      const v = avgOf(b, k);
                      if (v <= 0) return null;
                      const share = (v / (total || 1)) * 100;
                      return (
                        <div key={k} style={{ height: `${share}%`, background: STATE[k].color }} />
                      );
                    })}
                  </div>
                )}
              </div>
            </Tooltip>
          );
        })}
        {spacer(padRight)}
      </div>

      {/* x축 라벨 — 막대와 같은 flex 격자라 위치가 어긋나지 않는다 */}
      <div style={{ display: 'flex', marginTop: 4, ...rowStyle }}>
        {spacer(padLeft)}
        {data.map(b => (
          <div key={b.key} style={{
            ...cellStyle, fontSize: 10, opacity: 0.65,
            textAlign: 'center', whiteSpace: 'nowrap', overflow: 'visible',
          }}>
            {b.label}
          </div>
        ))}
        {spacer(padRight)}
      </div>

      {mode === 'avg' && (
        // 고정폭(스크롤) 모드에선 sticky 로 왼쪽에 고정 — 스크롤해도 축 설명이 보인다.
        <Typography.Text type="secondary" style={{ fontSize: 11, position: 'sticky', left: 0, display: 'inline-block' }}>
          세로축: 평균 PC 대수 (최대 {fmt(max)}대)
        </Typography.Text>
      )}
    </div>
  );
}

/** 범례 — 그래프/카드에서 같은 색표를 쓰므로 공용. */
export function StateLegend({ counts }: { counts?: Partial<Record<StateKey, number>> }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {STATE_ORDER.map(k => (
        <Tooltip key={k} title={STATE[k].desc}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'default' }}>
            <span style={{
              width: 10, height: 10, borderRadius: 3,
              background: STATE[k].color, display: 'inline-block',
              boxShadow: `0 0 0 2px ${tint(STATE[k].color, 0.18)}`,
            }} />
            {STATE[k].label}
            {counts && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {counts[k] || 0}
              </Typography.Text>
            )}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
