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

export const translateApi = {
  toEn: (texts: string[]) => api.post('/translate', { texts }),
};

export const agentApi = {
  list: () => api.get('/agents'),
  functionStats: () => api.get('/agents/function-stats'),
  // 사용량 통계 그래프 — range: '1d' | '7d' | '30d'
  stateHistory: (range: string) => api.get('/agents/state-history', { params: { range } }),
  // 상태 이력 보관 현황 / 수동 삭제 (보관은 무기한 — 자동 삭제 없음)
  stateHistoryInfo: () => api.get('/agents/state-history/info'),
  stateHistoryDelete: (params: { before?: number; client_id?: string; vacuum?: boolean }) =>
    api.delete('/agents/state-history', { params }),
  detail: (clientId: string) => api.get(`/agents/${encodeURIComponent(clientId)}`),
  remove: (clientId: string) => api.delete(`/agents/${encodeURIComponent(clientId)}`),
};

export const chatApi = {
  rooms: () => api.get('/chat/rooms'),
  messages: (roomId: string) => api.get(`/chat/rooms/${roomId}/messages`),
  closeRoom: (roomId: string) => api.post(`/chat/rooms/${roomId}/close`),
  deleteRoom: (roomId: string) => api.delete(`/chat/rooms/${roomId}`),
};
