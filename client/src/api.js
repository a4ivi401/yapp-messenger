async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Помилка запиту');
  return body;
}

export const api = {
  register: (username, password) =>
    request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),

  // Діалоги та повідомлення
  listConversations: () => request('/api/conversations'),
  createConversation: (username) =>
    request('/api/conversations', { method: 'POST', body: JSON.stringify({ username }) }),
  getConversation: (id) => request(`/api/conversations/${id}`),
  listMessages: (id, { limit, before } = {}) => {
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', limit);
    if (before) params.set('before', before);
    const qs = params.toString();
    return request(`/api/conversations/${id}/messages${qs ? `?${qs}` : ''}`);
  },
  sendMessage: (id, body) =>
    request(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),

  // Користувачі та пошук
  searchUsers: (q) => request(`/api/users/search?q=${encodeURIComponent(q)}`),

  // Контакти
  listContacts: () => request('/api/contacts'),
  addContact: (data) =>
    request('/api/contacts', { method: 'POST', body: JSON.stringify(data) }),
  removeContact: (userId) =>
    request(`/api/contacts/${userId}`, { method: 'DELETE' }),

  // Метчі (взаємні знайомства у випадковому чаті)
  listMatches: ({ limit } = {}) => {
    const qs = limit != null ? `?limit=${limit}` : '';
    return request(`/api/matches${qs}`);
  },
  matchStats: () => request('/api/matches/stats'),
};
