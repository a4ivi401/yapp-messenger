import { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { playNotificationSound } from '../utils/sound.js';
import {
  requestNotificationPermission,
  showBrowserNotification,
} from '../utils/notifications.js';

function formatTimestamp(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

export default function Home() {
  const { user, logout } = useAuth();

  // Список реальних діалогів
  const [conversations, setConversations] = useState([]);
  const [contactsCount, setContactsCount] = useState(0);
  const [matchesCount, setMatchesCount] = useState(0);

  // Активний чат: null | { id, type: 'direct' | 'stranger', title, otherUser, status }
  const [activeChat, setActiveChat] = useState(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  // Пошук
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  // Повідомлення відкритого чату
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  // Стан анонімного чату
  const [strangerState, setStrangerState] = useState('idle'); // 'idle' | 'searching' | 'matched' | 'ended'
  const [strangerSession, setStrangerSession] = useState(null); // { sessionId, myAnon, partner }
  const [matchRequested, setMatchRequested] = useState(false);
  const [partnerMatchRequested, setPartnerMatchRequested] = useState(false);
  const [strangerEndReason, setStrangerEndReason] = useState(null); // 'left' | 'next' | 'disconnected'

  // Refs для уникнення stale closures у слухачах Socket.IO
  const activeChatRef = useRef(activeChat);
  activeChatRef.current = activeChat;

  const strangerStateRef = useRef(strangerState);
  strangerStateRef.current = strangerState;

  const strangerSessionRef = useRef(strangerSession);
  strangerSessionRef.current = strangerSession;

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Автоскрол до останнього повідомлення
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Завантаження діалогів та статистики профілю при першому вході
  const loadInitialData = useCallback(async () => {
    try {
      const [convsRes, statsRes] = await Promise.all([
        api.listConversations(),
        api.matchStats().catch(() => ({ matchesCount: 0, contactsCount: 0 })),
      ]);
      setConversations(convsRes.conversations || []);
      setContactsCount(statsRes.contactsCount || 0);
      setMatchesCount(statsRes.matchesCount || 0);
    } catch (err) {
      console.error('Помилка завантаження даних:', err);
    }
  }, []);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Запит дозволу на браузерні сповіщення при завантаженні сторінки
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Відкриття прямого діалогу
  const openDirectConversation = useCallback((conv) => {
    const prevChat = activeChatRef.current;
    if (prevChat?.id === conv.id) return;

    if (prevChat?.type === 'direct' && socketRef.current) {
      socketRef.current.emit('conversation:leave', { conversationId: prevChat.id });
    }
    if (prevChat?.type === 'stranger' && socketRef.current) {
      if (strangerStateRef.current === 'searching') {
        socketRef.current.emit('stranger:cancel');
      } else if (strangerStateRef.current === 'matched') {
        socketRef.current.emit('stranger:leave');
      }
      setStrangerState('idle');
      setStrangerSession(null);
      setMatchRequested(false);
      setPartnerMatchRequested(false);
      setStrangerEndReason(null);
    }

    setActiveChat({
      id: conv.id,
      type: 'direct',
      title: `@${conv.otherUser.username}`,
      otherUser: conv.otherUser,
      status: conv.isMatch ? 'знайомство з випадкового чату' : 'в мережі',
      isMatch: Boolean(conv.isMatch),
    });

    setIsLoadingMessages(true);
    api
      .listMessages(conv.id)
      .then((res) => {
        setMessages(res.messages || []);
      })
      .catch((err) => {
        console.error('Помилка завантаження повідомлень:', err);
      })
      .finally(() => {
        setIsLoadingMessages(false);
      });

    if (socketRef.current) {
      socketRef.current.emit('conversation:join', { conversationId: conv.id });
    }
  }, []);

  // Підключення та обробка Socket.IO
  useEffect(() => {
    const socket = io({
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      // Якщо вже відкритий чат, повторно приєднуємося до кімнати
      if (activeChatRef.current?.type === 'direct') {
        socket.emit('conversation:join', { conversationId: activeChatRef.current.id });
      }
    });

    // Отримання нового повідомлення в реальному часі
    socket.on('message:new', ({ message }) => {
      if (!message) return;

      const currentChat = activeChatRef.current;
      const isIncoming = message.senderId !== user.id;

      // Звукове сповіщення та браузерне повідомлення
      if (isIncoming) {
        playNotificationSound();

        const isUnfocused =
          typeof document !== 'undefined' &&
          (document.hidden || currentChat?.id !== message.conversationId);

        if (isUnfocused) {
          const senderName = message.senderUsername || 'Співрозмовник';
          showBrowserNotification({
            title: `@${senderName}`,
            body: message.body,
            onClick: () => {
              // Знаходимо діалог і перемикаємося на нього
              const targetConv = conversationsRef.current.find(
                (c) => c.id === message.conversationId,
              );
              if (targetConv) {
                openDirectConversation(targetConv);
              }
            },
          });
        }
      }

      // Якщо повідомлення належить поточному відкритому діалогу — додаємо до списку
      if (currentChat?.id === message.conversationId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev;
          return [...prev, message];
        });
      }

      // Оновлюємо сайдбар: змінюємо lastMessage та переміщуємо діалог на перше місце
      setConversations((prev) => {
        const index = prev.findIndex((c) => c.id === message.conversationId);
        if (index !== -1) {
          const updated = {
            ...prev[index],
            lastMessage: {
              id: message.id,
              body: message.body,
              senderId: message.senderId,
              createdAt: message.createdAt,
            },
          };
          const nextList = [...prev];
          nextList.splice(index, 1);
          return [updated, ...nextList];
        } else {
          // Якщо діалогу ще не було у списку (перше вхідне від нового користувача)
          api
            .getConversation(message.conversationId)
            .then((res) => {
              if (res.conversation) {
                setConversations((curr) => {
                  if (curr.some((c) => c.id === res.conversation.id)) return curr;
                  return [res.conversation, ...curr];
                });
              }
            })
            .catch(() => {});
          return prev;
        }
      });
    });

    // ==========================================
    // Випадковий анонімний співрозмовник (Stranger)
    // ==========================================

    // Підбір співрозмовника
    socket.on('stranger:matched', ({ sessionId, myAnon, partner }) => {
      setStrangerState('matched');
      setStrangerSession({ sessionId, myAnon, partner });
      setMatchRequested(false);
      setPartnerMatchRequested(false);
      setStrangerEndReason(null);

      setActiveChat({
        id: sessionId,
        type: 'stranger',
        title: `${partner.anonAvatar} ${partner.anonName}`,
        avatar: partner.anonAvatar,
        status: 'в мережі',
      });

      setMessages([
        {
          id: `sys-${Date.now()}`,
          type: 'system',
          body: `Співрозмовника знайдено! Ви — ${myAnon.anonAvatar} ${myAnon.anonName}, співрозмовник — ${partner.anonAvatar} ${partner.anonName}.`,
          createdAt: new Date().toISOString(),
        },
      ]);

      playNotificationSound();
      showBrowserNotification({
        title: 'Yapp: Співрозмовника знайдено!',
        body: `Ваш співрозмовник — ${partner.anonAvatar} ${partner.anonName}`,
      });
    });

    // Отримання анонімного повідомлення
    socket.on('stranger:message', ({ message }) => {
      if (!message) return;

      const currentChat = activeChatRef.current;
      const currentStranger = strangerSessionRef.current;

      if (
        currentChat?.type === 'stranger' &&
        (currentChat.id === message.sessionId || currentStranger?.sessionId === message.sessionId)
      ) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev;
          return [...prev, message];
        });
      }

      if (message.senderId !== user.id) {
        playNotificationSound();

        const isUnfocused =
          typeof document !== 'undefined' &&
          (document.hidden || currentChat?.id !== message.sessionId);

        if (isUnfocused) {
          const senderLabel = message.senderAnonName
            ? `${message.senderAnonAvatar || '🎭'} ${message.senderAnonName}`
            : 'Анонім';
          showBrowserNotification({
            title: senderLabel,
            body: message.body,
          });
        }
      }
    });

    // Партнер надіслав запит на додавання в контакти
    socket.on('stranger:match-invited', () => {
      setPartnerMatchRequested(true);
      playNotificationSound();
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-invite-${Date.now()}`,
          type: 'system',
          body: '🤝 Співрозмовник хоче відкрити контакти! Натисніть «Додати в контакти», щоб познайомитись.',
          createdAt: new Date().toISOString(),
        },
      ]);
      showBrowserNotification({
        title: 'Yapp: Запит на знайомство!',
        body: 'Співрозмовник запропонував додати один одного в контакти.',
      });
    });

    // Обопільна згода — розкриття нікнеймів та конвертація у постійний чат
    socket.on('stranger:revealed', async ({ conversationId, partner }) => {
      playNotificationSound();
      setStrangerState('idle');
      setStrangerSession(null);
      setMatchRequested(false);
      setPartnerMatchRequested(false);
      setStrangerEndReason(null);

      // Встановлюємо активний direct чат
      setActiveChat({
        id: conversationId,
        type: 'direct',
        title: `@${partner.username}`,
        otherUser: partner,
        status: 'знайомство з випадкового чату',
        isMatch: true,
      });

      // Приєднуємо сокет до постійної кімнати діалогу
      if (socketRef.current) {
        socketRef.current.emit('conversation:join', { conversationId });
      }

      // Отримуємо збережені повідомлення (включаючи ті, що були ефемерними)
      try {
        const res = await api.listMessages(conversationId);
        setMessages([
          ...(res.messages || []),
          {
            id: `sys-reveal-${Date.now()}`,
            type: 'system',
            success: true,
            body: `🎉 Взаємна згода! Нікнейми відкрито: @${partner.username}. Діалог збережено в контактах.`,
            createdAt: new Date().toISOString(),
          },
        ]);
      } catch (err) {
        console.error('Помилка завантаження повідомлень після розкриття:', err);
      }

      // Оновлюємо список діалогів і контактів у сайдбарі
      loadInitialData();

      showBrowserNotification({
        title: 'Yapp: Взаємний контакт! 🎉',
        body: `Ви та @${partner.username} обмінялися контактами!`,
      });
    });

    // Співрозмовник завершив розмову
    socket.on('stranger:left', ({ reason }) => {
      setStrangerState('ended');
      setStrangerEndReason(reason || 'left');

      const reasonText =
        reason === 'next'
          ? 'Співрозмовник перейшов до іншого.'
          : reason === 'disconnected'
          ? 'Співрозмовник від’єднався.'
          : 'Співрозмовник залишив чат.';

      setMessages((prev) => [
        ...prev,
        {
          id: `sys-left-${Date.now()}`,
          type: 'system',
          body: `${reasonText} Ви більше не зустрінетесь із ним у цій сесії.`,
          createdAt: new Date().toISOString(),
        },
      ]);

      setActiveChat((prev) =>
        prev && prev.type === 'stranger' ? { ...prev, status: 'розмову завершено' } : prev,
      );
    });

    // Сповіщення про новий контакт
    socket.on('contact:new', () => {
      setContactsCount((prev) => prev + 1);
      loadInitialData();
    });

    // Сповіщення про новий метч — оновлюємо лічильник у профілі
    socket.on('match:new', () => {
      setMatchesCount((prev) => prev + 1);
    });

    return () => {
      socket.disconnect();
    };
  }, [user.id, openDirectConversation, loadInitialData]);

  // Глобальний пошук користувачів із дебаунсом 250 мс
  useEffect(() => {
    const clean = searchQuery.trim().replace(/^@+/, '');
    if (!clean) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timeout = setTimeout(() => {
      api
        .searchUsers(clean)
        .then((res) => {
          setSearchResults(res.users || []);
        })
        .catch((err) => {
          console.error('Помилка пошуку:', err);
        })
        .finally(() => {
          setIsSearching(false);
        });
    }, 250);

    return () => clearTimeout(timeout);
  }, [searchQuery]);

  // Початок діалогу із знайденим користувачем
  const handleSelectFoundUser = async (targetUser) => {
    // Перевіряємо, чи є вже діалог із цим користувачем
    const existing = conversations.find((c) => c.otherUser?.id === targetUser.id);
    if (existing) {
      openDirectConversation(existing);
      setSearchQuery('');
      setSearchResults([]);
      return;
    }

    // Створюємо новий або отримуємо існуючий діалог через API
    try {
      const res = await api.createConversation(targetUser.username);
      if (res.conversation) {
        setConversations((prev) => {
          if (prev.some((c) => c.id === res.conversation.id)) return prev;
          return [res.conversation, ...prev];
        });
        openDirectConversation(res.conversation);
      }
    } catch (err) {
      console.error('Не вдалося створити діалог:', err);
    } finally {
      setSearchQuery('');
      setSearchResults([]);
    }
  };

  // Додавання користувача в контакти з результатів пошуку
  const handleAddContactFromSearch = async (e, targetUser) => {
    e.stopPropagation();
    try {
      await api.addContact({ userId: targetUser.id });
      setSearchResults((prev) =>
        prev.map((u) => (u.id === targetUser.id ? { ...u, isContact: true } : u)),
      );
      setContactsCount((prev) => prev + 1);
    } catch (err) {
      console.error('Помилка додавання контакту:', err);
    }
  };

  // Відправка повідомлення
  const handleSendMessage = async (e) => {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || !activeChat) return;

    setInputText('');

    if (activeChat.type === 'stranger') {
      const sessionId = strangerSessionRef.current?.sessionId || activeChat.id;
      if (socketRef.current?.connected) {
        socketRef.current.emit(
          'stranger:message',
          { sessionId, body: text },
          (res) => {
            if (!res?.ok) {
              console.error('Помилка відправки повідомлення незнайомцю:', res?.error);
            }
          },
        );
      }
      return;
    }

    // Відправка через Socket.IO з ack-відповіддю
    if (socketRef.current?.connected) {
      socketRef.current.emit(
        'message:send',
        { conversationId: activeChat.id, body: text },
        (res) => {
          if (!res?.ok) {
            console.error('Помилка відправки через сокет:', res?.error);
            // Фолбек на REST у разі помилки сокета
            api.sendMessage(activeChat.id, text).catch(console.error);
          }
        },
      );
    } else {
      // Фолбек на REST, якщо сокет тимчасово від'єднано
      try {
        await api.sendMessage(activeChat.id, text);
      } catch (err) {
        console.error('Помилка відправки через REST:', err);
      }
    }
  };

  // Початок пошуку випадкового співрозмовника
  const startStrangerSearch = () => {
    const prevChat = activeChatRef.current;
    if (prevChat?.type === 'direct' && socketRef.current) {
      socketRef.current.emit('conversation:leave', { conversationId: prevChat.id });
    }

    setStrangerState('searching');
    setStrangerSession(null);
    setMatchRequested(false);
    setPartnerMatchRequested(false);
    setStrangerEndReason(null);
    setMessages([]);
    setIsProfileOpen(false);

    setActiveChat({
      id: 'stranger-pending',
      type: 'stranger',
      title: 'Випадковий співрозмовник',
      status: 'пошук співрозмовника...',
    });

    if (socketRef.current?.connected) {
      socketRef.current.emit('stranger:search', (res) => {
        if (!res?.ok) {
          console.error('Помилка початку пошуку:', res?.error);
        }
      });
    }
  };

  // Скасування пошуку
  const handleCancelSearch = () => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('stranger:cancel');
    }
    setStrangerState('idle');
    setStrangerSession(null);
    setMatchRequested(false);
    setPartnerMatchRequested(false);
    setStrangerEndReason(null);
    setActiveChat(null);
  };

  // Перехід до наступного співрозмовника («🎲 Інший»)
  const handleNextStranger = () => {
    setStrangerState('searching');
    setStrangerSession(null);
    setMatchRequested(false);
    setPartnerMatchRequested(false);
    setStrangerEndReason(null);
    setMessages([]);

    setActiveChat({
      id: 'stranger-pending',
      type: 'stranger',
      title: 'Випадковий співрозмовник',
      status: 'пошук співрозмовника...',
    });

    if (socketRef.current?.connected) {
      socketRef.current.emit('stranger:next', (res) => {
        if (!res?.ok) {
          console.error('Помилка переходу до наступного:', res?.error);
        }
      });
    }
  };

  // Запит або підтвердження додавання в контакти («🤝 Додати в контакти»)
  const handleRequestMatch = () => {
    if (matchRequested) return;
    const sessionId = strangerSessionRef.current?.sessionId || activeChat?.id;
    if (!sessionId) return;

    setMatchRequested(true);
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-req-${Date.now()}`,
        type: 'system',
        body: 'Запит на контакт надіслано. Коли співрозмовник підтвердить — ваші нікнейми відкриються!',
        createdAt: new Date().toISOString(),
      },
    ]);

    if (socketRef.current?.connected) {
      socketRef.current.emit('stranger:match-request', { sessionId }, (res) => {
        if (!res?.ok) {
          console.error('Помилка запиту на контакт:', res?.error);
        }
      });
    }
  };

  // Завершення розмови зі сторони користувача
  const handleLeaveStranger = () => {
    if (socketRef.current?.connected) {
      if (strangerStateRef.current === 'searching') {
        socketRef.current.emit('stranger:cancel');
      } else {
        socketRef.current.emit('stranger:leave');
      }
    }
    setStrangerState('idle');
    setStrangerSession(null);
    setMatchRequested(false);
    setPartnerMatchRequested(false);
    setStrangerEndReason(null);
    setActiveChat(null);
  };

  const handleBackToList = () => {
    if (activeChat?.type === 'direct' && socketRef.current) {
      socketRef.current.emit('conversation:leave', { conversationId: activeChat.id });
      setActiveChat(null);
    } else if (activeChat?.type === 'stranger') {
      handleLeaveStranger();
    } else {
      setActiveChat(null);
    }
  };

  // Фільтрація існуючих діалогів при пошуку
  const trimmedSearch = searchQuery.trim();
  const cleanSearch = trimmedSearch.replace(/^@+/, '').toLowerCase();
  const filteredConversations = cleanSearch
    ? conversations.filter((c) => {
        const usernameMatch = c.otherUser?.username?.toLowerCase().includes(cleanSearch);
        const lastMsgMatch = c.lastMessage?.body?.toLowerCase().includes(trimmedSearch.toLowerCase());
        return usernameMatch || lastMsgMatch;
      })
    : conversations;

  return (
    <div className="messenger-root">
      {/* САЙДБАР / СПИСОК ЧАТІВ ТА ПОШУК */}
      <aside className={`messenger-sidebar ${activeChat ? 'mobile-hidden' : ''}`}>
        {/* Шапка сайдбару */}
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
              placeholder="Пошук людей та діалогів"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearchQuery('')}
                title="Очистити пошук"
                aria-label="Очистити"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Список діалогів та результатів пошуку */}
        <div className="sidebar-chat-list">
          {/* Кнопка запуску анонімного чату з незнайомцем (тільки коли не ведеться пошук) */}
          {!searchQuery.trim() && (
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
          )}

          {/* Режим пошуку: показуємо знайдені діалоги та глобальний пошук користувачів */}
          {searchQuery.trim() ? (
            <>
              {filteredConversations.length > 0 && (
                <>
                  <div className="search-section-header">Ваші діалоги</div>
                  {filteredConversations.map((conv) => {
                    const isActive = activeChat?.id === conv.id;
                    const initials = (conv.otherUser?.username || '')
                      .slice(0, 2)
                      .toUpperCase();
                    return (
                      <button
                        key={conv.id}
                        className={`chat-row ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          openDirectConversation(conv);
                          setSearchQuery('');
                        }}
                      >
                        <div className="chat-row-avatar">{initials}</div>
                        <div className="chat-row-body">
                          <div className="chat-row-line1">
                            <div className="chat-row-title-wrap">
                              <span className="chat-row-name">
                                @{conv.otherUser?.username}
                              </span>
                              {conv.isMatch && (
                                <span className="match-badge" title="Знайдено у випадковому чаті">
                                  🎲 Метч
                                </span>
                              )}
                            </div>
                            <span className="chat-row-time">
                              {formatTimestamp(
                                conv.lastMessage?.createdAt || conv.createdAt,
                              )}
                            </span>
                          </div>
                          <div className="chat-row-line2">
                            <span className="chat-row-preview">
                              {conv.lastMessage?.body || 'Діалог створено'}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </>
              )}

              <div className="search-section-header">
                Глобальний пошук {isSearching ? '⏳' : ''}
              </div>

              {searchResults.length > 0 ? (
                searchResults.map((targetUser) => {
                  const initials = (targetUser.username || '')
                    .slice(0, 2)
                    .toUpperCase();
                  const isActive = activeChat?.otherUser?.id === targetUser.id;
                  return (
                    <div
                      key={targetUser.id}
                      className={`chat-row ${isActive ? 'active' : ''}`}
                      onClick={() => handleSelectFoundUser(targetUser)}
                      style={{ cursor: 'pointer' }}
                    >
                      <div className="chat-row-avatar">{initials}</div>
                      <div className="chat-row-body">
                        <div className="chat-row-line1">
                          <span className="chat-row-name">
                            @{targetUser.username}
                          </span>
                          {targetUser.isContact ? (
                            <span className="chat-row-badge">Контакт</span>
                          ) : (
                            <button
                              type="button"
                              className="chat-row-action-btn"
                              onClick={(e) => handleAddContactFromSearch(e, targetUser)}
                              title="Додати в контакти"
                            >
                              + Додати
                            </button>
                          )}
                        </div>
                        <div className="chat-row-line2">
                          <span className="chat-row-preview">
                            Натисніть, щоб почати діалог
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                !isSearching && (
                  <div className="search-empty-hint">
                    {!cleanSearch ? (
                      'Введіть нікнейм після символу @ для пошуку.'
                    ) : cleanSearch === user?.username?.toLowerCase() ? (
                      `Це ваш власний акаунт (@${user.username}). Пошук знаходить інших користувачів.`
                    ) : (
                      `Користувачів із ніком «${searchQuery.trim()}» не знайдено.`
                    )}
                  </div>
                )
              )}
            </>
          ) : (
            /* Звичайний режим: список діалогів із бази даних */
            <>
              {conversations.length === 0 ? (
                <div className="list-hint">
                  Діалогів поки немає. Знайдіть користувача через пошук або познайомтеся у випадковому чаті!
                </div>
              ) : (
                conversations.map((conv) => {
                  const isActive = activeChat?.id === conv.id;
                  const initials = (conv.otherUser.username || '')
                    .slice(0, 2)
                    .toUpperCase();
                  return (
                    <button
                      key={conv.id}
                      className={`chat-row ${isActive ? 'active' : ''}`}
                      onClick={() => openDirectConversation(conv)}
                    >
                      <div className="chat-row-avatar">{initials}</div>
                      <div className="chat-row-body">
                        <div className="chat-row-line1">
                          <div className="chat-row-title-wrap">
                            <span className="chat-row-name">
                              @{conv.otherUser.username}
                            </span>
                            {conv.isMatch && (
                              <span className="match-badge" title="Знайдено у випадковому чаті">
                                🎲 Метч
                              </span>
                            )}
                          </div>
                          <span className="chat-row-time">
                            {formatTimestamp(
                              conv.lastMessage?.createdAt || conv.createdAt,
                            )}
                          </span>
                        </div>
                        <div className="chat-row-line2">
                          <span className="chat-row-preview">
                            {conv.lastMessage?.body || 'Немає повідомлень'}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </>
          )}
        </div>

        {/* Кнопка на мобільних пристроях */}
        <button
          className="mobile-fab"
          onClick={startStrangerSearch}
          title="Почати випадковий чат"
          aria-label="Випадковий співрозмовник"
        >
          🎲
        </button>
      </aside>

      {/* ГОЛОВНА ОБЛАСТЬ ЧАТУ */}
      <main className={`messenger-chat-area ${!activeChat ? 'mobile-hidden' : ''}`}>
        {activeChat ? (
          <div className="chat-screen">
            {/* Шапка активного чату */}
            <div className="chat-screen-header">
              <button
                className="chat-back-btn"
                onClick={handleBackToList}
                title="Назад до списку"
              >
                ←
              </button>
              <div className="chat-target-avatar">
                {activeChat.type === 'stranger'
                  ? (strangerSession?.partner?.anonAvatar || '🎲')
                  : (activeChat.otherUser?.username || '').slice(0, 2).toUpperCase()}
              </div>
              <div className="chat-target-meta">
                <h2>
                  <span className="chat-target-name">{activeChat.title}</span>
                  {activeChat.isMatch && (
                    <span className="match-badge" title="Знайдено у випадковому чаті">
                      🎲 Метч
                    </span>
                  )}
                </h2>
                <span className="chat-target-status">{activeChat.status}</span>
              </div>
              <div className="chat-header-actions">
                {activeChat.type === 'stranger' && strangerState === 'matched' && (
                  <>
                    <button
                      className={`match-action-btn ${matchRequested ? 'is-pending' : ''} ${
                        partnerMatchRequested ? 'is-invited' : ''
                      }`}
                      onClick={handleRequestMatch}
                      title="Відкрити нікнейми та додати один одного в контакти"
                    >
                      {matchRequested
                        ? '⏳ Запит надіслано'
                        : partnerMatchRequested
                          ? '🤝 Партнер чекає на вас!'
                          : '🤝 Додати в контакти'}
                    </button>
                    <button
                      className="next-stranger-btn"
                      onClick={handleNextStranger}
                      title="Перейти до наступного співрозмовника"
                    >
                      🎲 Інший
                    </button>
                  </>
                )}
                {activeChat.type === 'stranger' && strangerState === 'ended' && (
                  <button
                    className="next-stranger-btn"
                    onClick={handleNextStranger}
                    title="Знайти нового співрозмовника"
                  >
                    🎲 Новий пошук
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

            {/* Нагадування правил для випадкового чату */}
            {activeChat.type === 'stranger' && strangerState === 'matched' && (
              <div className="stranger-rule-bar">
                <span>
                  🎭 Ви спілкуєтесь анонімно. Натисніть <strong>«Додати в контакти»</strong> — якщо співрозмовник зробить те саме, ваші нікнейми відкриються!
                </span>
              </div>
            )}

            {/* Контент екрану чату */}
            {activeChat.type === 'stranger' && strangerState === 'searching' ? (
              <div className="stranger-searching-pane">
                <div className="searching-radar-wrap">
                  <div className="radar-pulse-ring" />
                  <div className="radar-pulse-ring delay-1" />
                  <div className="radar-pulse-ring delay-2" />
                  <div className="radar-center-icon">🎲</div>
                </div>
                <h3>Шукаємо випадкового співрозмовника...</h3>
                <p>
                  Підбираємо пару серед активних користувачів. Ви спілкуватиметесь під анонімними образами українських тварин.
                </p>
                <button
                  type="button"
                  className="cancel-search-btn"
                  onClick={handleCancelSearch}
                >
                  Скасувати пошук
                </button>
              </div>
            ) : (
              <>
                {/* Область повідомлень */}
                <div className="chat-messages-scroll">
                  {isLoadingMessages ? (
                    <div className="chat-empty-hint">
                      <p>Завантаження повідомлень...</p>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="chat-empty-hint">
                      <span className="chat-empty-icon">✍️</span>
                      <p>Почніть розмову — надішліть перше повідомлення.</p>
                    </div>
                  ) : (
                    messages.map((msg) => {
                      if (msg.type === 'system') {
                        return (
                          <div key={msg.id} className="system-bubble">
                            <span>{msg.body}</span>
                          </div>
                        );
                      }
                      const isMe = msg.senderId === user.id;
                      return (
                        <div
                          key={msg.id}
                          className={`message-row ${isMe ? 'message-out' : 'message-in'}`}
                        >
                          <div className="message-bubble">
                            {activeChat.type === 'stranger' && !isMe && msg.senderAnonName && (
                              <div
                                style={{
                                  fontSize: '11.5px',
                                  fontWeight: 600,
                                  color: 'var(--accent)',
                                  marginBottom: '3px',
                                }}
                              >
                                {msg.senderAnonAvatar} {msg.senderAnonName}
                              </div>
                            )}
                            <div className="message-text">{msg.body}</div>
                            <div className="message-meta">
                              <span className="message-time">
                                {formatTimestamp(msg.createdAt)}
                              </span>
                              {isMe && <span className="message-ticks">✓</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Нижня панель: поле вводу або панель завершеного чату */}
                {activeChat.type === 'stranger' && strangerState === 'ended' ? (
                  <div className="stranger-ended-panel">
                    <span>Співрозмовник залишив чат або перейшов до іншого.</span>
                    <button
                      type="button"
                      className="primary-pill-btn"
                      onClick={handleNextStranger}
                    >
                      🎲 Знайти нового співрозмовника
                    </button>
                  </div>
                ) : (
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
                )}
              </>
            )}
          </div>
        ) : (
          /* Вітальний екран на десктопі */
          <div className="desktop-welcome-pane">
            <div className="welcome-box">
              <div className="welcome-icon">🎲</div>
              <h2>Ласкаво просимо до Yapp</h2>
              <p>
                Оберіть діалог зі списку зліва, знайдіть користувача за ніком або познайомтесь із випадковою людиною в анонімному режимі.
              </p>
              <button className="primary-pill-btn pulse" onClick={startStrangerSearch}>
                🎲 Знайти випадкового співрозмовника
              </button>
            </div>
          </div>
        )}
      </main>

      {/* БІЧНА ПАНЕЛЬ ПРОФІЛЮ (DRAWER) */}
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
                  <strong>{contactsCount}</strong>
                  <span>контактів</span>
                </div>
                <div className="stat-box">
                  <strong>{matchesCount}</strong>
                  <span>метчів</span>
                </div>
              </div>

              <div className="drawer-menu">
                <button
                  className="drawer-item"
                  onClick={async () => {
                    const perm = await requestNotificationPermission();
                    if (perm === 'granted') {
                      playNotificationSound();
                      showBrowserNotification({
                        title: 'Yapp',
                        body: 'Сповіщення успішно налаштовано!',
                      });
                    }
                  }}
                >
                  <span>🔔 Перевірити сповіщення</span>
                  <span>→</span>
                </button>
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
