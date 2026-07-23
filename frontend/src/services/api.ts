import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export const authApi = {
  login: (username: string, password: string) =>
    api.post('/login', { username, password }),
};

export const announcementApi = {
  list: (activeOnly = false) => api.get('/announcements', { params: { active_only: activeOnly } }),
  create: (data: Record<string, unknown>) => api.post('/announcements', data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/announcements/${id}`, data),
  delete: (id: number) => api.delete(`/announcements/${id}`),
};

export const systemApi = {
  update: () => api.post('/update'),
};

// 로그인(사용자 식별) 설정 — ReplayKit 이 유저 검색에 쓸 Jira 계정 관리
export const loginSettingsApi = {
  get: () => api.get('/settings/login'),
  save: (data: { jira_server?: string; jira_id?: string; jira_pw?: string }) =>
    api.put('/settings/login', data),
};

export const translateApi = {
  toEn: (texts: string[]) => api.post('/translate', { texts }),
};

export const agentApi = {
  list: () => api.get('/agents'),
  functionStats: () => api.get('/agents/function-stats'),
  // PC별 메타(호스트명·사용자·부서·프로젝트) — 통계 필터 옵션의 원본
  meta: () => api.get('/agents/meta'),
  // 사용량 통계 그래프 — range: '1d'|'7d'|'30d'|'all', team/project 로 필터 가능
  stateHistory: (range: string, filters?: { team?: string; project?: string }) =>
    api.get('/agents/state-history', { params: { range, ...(filters || {}) } }),
  // 상태 이력 보관 현황 / 수동 삭제 (보관은 무기한 — 자동 삭제 없음)
  stateHistoryInfo: () => api.get('/agents/state-history/info'),
  stateHistoryDelete: (params: { before?: number; client_id?: string; vacuum?: boolean }) =>
    api.delete('/agents/state-history', { params }),
  detail: (clientId: string) => api.get(`/agents/${encodeURIComponent(clientId)}`),
  remove: (clientId: string) => api.delete(`/agents/${encodeURIComponent(clientId)}`),
};

export const bugReportApi = {
  list: () => api.get('/bug-reports'),
  updateStatus: (id: number, status: 'new' | 'in_progress' | 'reviewed' | 'done') =>
    api.put(`/bug-reports/${id}`, { status }),
  delete: (id: number) => api.delete(`/bug-reports/${id}`),
  downloadUrl: (id: number) => `/api/bug-reports/${id}/download`,
  // 로컬 폴백 ZIP 수동 등록 — 메타는 ZIP 안 report.json 에서 서버가 추출
  importZip: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/bug-reports/import', fd);
  },
  // ZIP 을 서버가 열어 뷰어용 구조(report/step_tests/playback/files)로 반환
  contents: (id: number) => api.get(`/bug-reports/${id}/contents`),
  // ZIP 안 개별 파일 (이미지 src / 로그 텍스트). maxBytes 지정 시 tail 만
  fileUrl: (id: number, path: string, maxBytes?: number) =>
    `/api/bug-reports/${id}/file?path=${encodeURIComponent(path)}${maxBytes ? `&max_bytes=${maxBytes}` : ''}`,
};
