import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../auth.jsx';

export default function Home() {
  const { user, logout } = useAuth();

  // UI navigation state
  const [activeChat, setActiveChat] = useState(null); // null | { id, type, title, status }
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Stranger session state (local-only; realtime wiring comes in Day 2)
  const [matchRequested, setMatchRequested] = useState(false);

  // Chat messages (local echo only — no backend yet)
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef(null);

  // Auto-scroll to the latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const now = () =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Open a random-stranger session.
  // TODO (Day 2): emit Socket.IO 'stranger:search', wait for 'stranger:matched'
  // before switching the header to a live partner.
  const startStrangerSearch = () => {
    setActiveChat({
      id: 'stranger-session',
      type: 'stranger',
      title: 'Анонімний співрозмовник',
      status: 'очікування підключення',
    });
    setMatchRequested(false);
    setMessages([]);
  };

  // TODO (Day 2): emit 'stranger:next' to leave current partner and search again.
  const handleNextStranger = () => {
    startStrangerSearch();
  };

  // TODO (Day 2): emit 'match:request'. The real match happens only when BOTH
  // sides request it — the server then reveals usernames and persists the chat.
  const handleRequestMatch = () => {
    if (matchRequested) return;
    setMatchRequested(true);
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-${Date.now()}`,
        type: 'system',
        text: 'Запит на контакт надіслано. Коли співрозмовник підтвердить — нікнейми відкриються.',
        time: now(),
      },
    ]);
  };

  // TODO (Day 2): emit 'message:send' over Socket.IO instead of local echo.
  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    setMessages((prev) => [
      ...prev,
      { id: `my-${Date.now()}`, sender: 'me', text: inputText.trim(), time: now() },
    ]);
    setInputText('');
  };

  const handleBackToList = () => {
    setActiveChat(null);
  };

  return (
    <div className="messenger-root">
      {/* SIDEBAR / CHATS LIST */}
      <aside className={`messenger-sidebar ${activeChat ? 'mobile-hidden' : ''}`}>
        {/* Header: menu + search (Telegram-style) */}
        <div className="sidebar-top">
          <button
            className="menu-btn"
            onClick={() => setIsProfileOpen(true)}
            title="Меню та профіль"
            aria-label="Меню"
          >
            ☰
          </button>
          <div className="header-search">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="Пошук"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Chat list */}
        <div className="sidebar-chat-list">
          {/* Random stranger — rendered as a normal chat row */}
          <button
            className={`chat-row ${activeChat?.type === 'stranger' ? 'active' : ''}`}
            onClick={startStrangerSearch}
          >
            <div className="chat-row-avatar stranger-avatar">🎲</div>
            <div className="chat-row-body">
              <div className="chat-row-line1">
                <span className="chat-row-name">Випадковий співрозмовник</span>
                <span className="status-dot" title="Доступний" />
              </div>
              <div className="chat-row-line2">
                <span className="chat-row-preview">
                  Анонімний чат — натисніть, щоб почати
                </span>
              </div>
            </div>
          </button>

          {/* Saved contacts will appear here after a match */}
          <div className="list-hint">
            Контактів поки немає. Вони зʼявляться після метчу у випадковому чаті.
          </div>
        </div>

        {/* Mobile FAB */}
        <button
          className="mobile-fab"
          onClick={startStrangerSearch}
          title="Почати випадковий чат"
          aria-label="Випадковий співрозмовник"
        >
          🎲
        </button>
      </aside>

      {/* MAIN CHAT AREA */}
      <main className={`messenger-chat-area ${!activeChat ? 'mobile-hidden' : ''}`}>
        {activeChat ? (
          <div className="chat-screen">
            {/* Chat header */}
            <div className="chat-screen-header">
              <button
                className="chat-back-btn"
                onClick={handleBackToList}
                title="Назад до списку"
              >
                ←
              </button>
              <div className="chat-target-avatar">
                {activeChat.type === 'stranger' ? '🎲' : '💬'}
              </div>
              <div className="chat-target-meta">
                <h2>{activeChat.title}</h2>
                <span className="chat-target-status">{activeChat.status}</span>
              </div>
              <div className="chat-header-actions">
                {activeChat.type === 'stranger' && (
                  <button
                    className={`match-action-btn ${matchRequested ? 'is-pending' : ''}`}
                    onClick={handleRequestMatch}
                  >
                    {matchRequested ? '⏳ Запит надіслано' : '🤝 Додати в контакти'}
                  </button>
                )}
                {activeChat.type === 'stranger' && (
                  <button
                    className="next-stranger-btn"
                    onClick={handleNextStranger}
                    title="Наступний співрозмовник"
                  >
                    🎲 Інший
                  </button>
                )}
                <button
                  className="leave-chat-btn"
                  onClick={handleBackToList}
                  title="Закрити чат"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Stranger rule reminder */}
            {activeChat.type === 'stranger' && (
              <div className="stranger-rule-bar">
                <span>
                  🎭 Ви спілкуєтесь анонімно. Натисніть <strong>«Додати в контакти»</strong> — якщо співрозмовник зробить те саме, ваші нікнейми відкриються!
                </span>
              </div>
            )}

            {/* Messages */}
            <div className="chat-messages-scroll">
              {messages.length === 0 ? (
                <div className="chat-empty-hint">
                  <span className="chat-empty-icon">✍️</span>
                  <p>Почніть розмову — надішліть перше повідомлення.</p>
                  <span className="muted">
                    Повідомлення співрозмовника зʼявляться тут після підключення realtime.
                  </span>
                </div>
              ) : (
                messages.map((msg) => {
                  if (msg.type === 'system') {
                    return (
                      <div key={msg.id} className="system-bubble">
                        <span>{msg.text}</span>
                      </div>
                    );
                  }
                  const isMe = msg.sender === 'me';
                  return (
                    <div
                      key={msg.id}
                      className={`message-row ${isMe ? 'message-out' : 'message-in'}`}
                    >
                      <div className="message-bubble">
                        <div className="message-text">{msg.text}</div>
                        <div className="message-meta">
                          <span className="message-time">{msg.time}</span>
                          {isMe && <span className="message-ticks">✓</span>}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form className="chat-input-bar" onSubmit={handleSendMessage}>
              <button type="button" className="attach-btn" title="Прикріпити медіа">
                📎
              </button>
              <input
                type="text"
                placeholder="Напишіть повідомлення..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                autoFocus
              />
              <button
                type="submit"
                className="send-btn"
                disabled={!inputText.trim()}
                title="Надіслати"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </form>
          </div>
        ) : (
          /* Desktop welcome pane */
          <div className="desktop-welcome-pane">
            <div className="welcome-box">
              <div className="welcome-icon">🎲</div>
              <h2>Ласкаво просимо до Yapp</h2>
              <p>
                Оберіть діалог зі списку зліва або почніть знайомство з випадковою людиною в анонімному режимі.
              </p>
              <button className="primary-pill-btn pulse" onClick={startStrangerSearch}>
                🎲 Знайти випадкового співрозмовника
              </button>
            </div>
          </div>
        )}
      </main>

      {/* PROFILE DRAWER */}
      {isProfileOpen && (
        <div className="drawer-overlay" onClick={() => setIsProfileOpen(false)}>
          <div className="drawer-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h3>Профіль</h3>
              <button className="close-btn" onClick={() => setIsProfileOpen(false)}>
                ✕
              </button>
            </div>
            <div className="drawer-body">
              <div className="profile-hero">
                <div className="large-avatar">
                  {user.username.slice(0, 2).toUpperCase()}
                </div>
                <h3>@{user.username}</h3>
                <span className="online-indicator">В мережі</span>
              </div>

              <div className="profile-stats">
                <div className="stat-box">
                  <strong>0</strong>
                  <span>контактів</span>
                </div>
                <div className="stat-box">
                  <strong>0</strong>
                  <span>метчів</span>
                </div>
              </div>

              <div className="drawer-menu">
                <button className="drawer-item" onClick={startStrangerSearch}>
                  <span>🎲 Знайти співрозмовника</span>
                  <span>→</span>
                </button>
              </div>

              <div className="drawer-footer">
                <button className="logout-btn" onClick={logout}>
                  Вийти з акаунту
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
