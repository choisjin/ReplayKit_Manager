/**
 * 테스트 PC 상태(활동)의 **단일 정의** — 관제 카드(FleetPage)와 사용량 그래프(UsageStatsPage)가
 * 같은 색·라벨·순서를 쓰도록 여기 한 곳에서만 정의한다.
 *
 * key 는 백엔드 activity(idle/in_use/playing/recording) 에 매니저가 아는 두 가지를 얹은 것:
 * 재생 중 일시정지(paused), 상태 보고 끊김(offline).
 * ⚠️ 백엔드 agents.py 의 sample_states() 가 **같은 문자열**을 DB 에 쌓는다 — 함께 고쳐야 한다.
 */

export type StateKey = 'playing' | 'paused' | 'recording' | 'in_use' | 'idle' | 'offline';

export interface StateDef {
  label: string;
  color: string;   // hex 만 (틴트 계산에 rgba 로 변환해야 해서 antd 프리셋명은 못 쓴다)
  tag: string;     // antd Tag color
  order: number;   // '상태순' 정렬에서 위로 올라올 순서 — 지금 봐야 하는 것부터
  desc: string;
}

export const STATE: Record<StateKey, StateDef> = {
  playing:   { label: '재생 중',  color: '#1677ff', tag: 'processing', order: 0, desc: '시나리오 재생 중' },
  paused:    { label: '일시정지', color: '#faad14', tag: 'warning',    order: 1, desc: '재생 중 일시정지 상태' },
  recording: { label: '녹화 중',  color: '#ff4d4f', tag: 'error',      order: 2, desc: '시나리오 녹화 중' },
  in_use:    { label: '사용중',   color: '#52c41a', tag: 'success',    order: 3, desc: 'ReplayKit 창이 최상단 — 사람이 조작 중' },
  idle:      { label: '대기',     color: '#8c8c8c', tag: 'default',    order: 4, desc: '온라인이지만 재생·녹화·조작 없음' },
  offline:   { label: '오프라인', color: '#595959', tag: 'default',    order: 5, desc: '45초 이상 상태 보고 없음' },
};

/** 표시 순서(범례·그래프 스택·정렬 공통). */
export const STATE_ORDER: StateKey[] = ['playing', 'paused', 'recording', 'in_use', 'idle', 'offline'];

/** '가동(일하는 중)' 으로 볼 상태 — 가동률 계산 기준. */
export const ACTIVE_STATES: StateKey[] = ['playing', 'paused', 'recording', 'in_use'];

/** 카드 색·태그·정렬의 기준이 되는 단일 상태. 백엔드 sample_states() 와 같은 규칙. */
export function stateOf(a: { online: boolean; activity: string; playback?: { status?: string } | null }): StateKey {
  if (!a.online) return 'offline';
  if (a.activity === 'playing') return a.playback?.status === 'paused' ? 'paused' : 'playing';
  if (a.activity === 'recording') return 'recording';
  if (a.activity === 'in_use') return 'in_use';
  return 'idle';
}

/** #rrggbb → rgba(). 반투명 틴트라 라이트/다크 어느 테마 위에 얹혀도 그대로 읽힌다
 *  (불투명 색을 쓰면 다크 모드에서 글자가 묻힌다). */
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
