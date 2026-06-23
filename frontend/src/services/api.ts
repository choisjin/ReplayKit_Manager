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

export const chatApi = {
  rooms: () => api.get('/chat/rooms'),
  messages: (roomId: string) => api.get(`/chat/rooms/${roomId}/messages`),
  closeRoom: (roomId: string) => api.post(`/chat/rooms/${roomId}/close`),
  deleteRoom: (roomId: string) => api.delete(`/chat/rooms/${roomId}`),
};
