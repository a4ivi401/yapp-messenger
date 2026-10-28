async function request(path, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = { ...options.headers };
  if (!isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    ...options,
    headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 413) {
      throw new Error('Файл завеликий (перевищено ліміт 100 МБ)');
    }
    const message = body?.error || (res.status >= 500 ? 'Помилка сервера' : 'Помилка запиту');
    throw new Error(message);
  }
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
  sendMessage: (id, body, attachment = null) => {
    const payload =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? body
        : { body: body || '', attachment };
    return request(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Медіа та завантаження файлів
  uploadFile: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return request('/api/uploads', {
      method: 'POST',
      body: formData,
    });
  },

  // Користувачі та пошук
  searchUsers: (q) => request(`/api/users/search?q=${encodeURIComponent(q)}`),
  searchMessages: (q) => request(`/api/messages/search?q=${encodeURIComponent(q)}`),

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
