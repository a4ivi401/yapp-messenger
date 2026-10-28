import { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { playNotificationSound } from '../utils/sound.js';
import {
  requestNotificationPermission,
  showBrowserNotification,
} from '../utils/notifications.js';
import { startVoiceRecording } from '../utils/voice.js';
import VoicePlayer from '../components/VoicePlayer.jsx';
import VoiceRecordingBar from '../components/VoiceRecordingBar.jsx';

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

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMessagePreview(lastMessage, fallback = 'Немає повідомлень') {
  if (!lastMessage) return fallback;
  // Tombstone (власне видалення повідомлення): фіксований текст замість тіла
  if (lastMessage.deleted) return 'Повідомлення видалено';
  if (lastMessage.body && lastMessage.body.trim()) {
    if (lastMessage.attachment) {
      const prefix = lastMessage.attachment.type === 'image' ? '📷 ' : '📎 ';
      return `${prefix}${lastMessage.body}`;
    }
    return lastMessage.body;
  }
  if (lastMessage.attachment) {
    if (lastMessage.attachment.type === 'image') return '📷 Фото';
    if (lastMessage.attachment.type === 'audio') return '🎤 Голосове';
    if (lastMessage.attachment.type === 'video') return '🎥 Відео';
    return `📎 ${lastMessage.attachment.name || 'Файл'}`;
  }
  return fallback;
}

// Тайминги індикатора «друкує…»
const TYPING_THROTTLE_MS = 2000; // не частіше одного сигналу «друкую» за 2 с
const TYPING_STOP_MS = 3000; // стільки тиші — і на сервер іде isTyping: false
const TYPING_HIDE_MS = 4000; // стільки показуємо «друкує…» без нових сигналів

const TICK_GLYPH = { sent: '✓', delivered: '✓✓', read: '✓✓' };
const TICK_TITLE = { sent: 'Надіслано', delivered: 'Доставлено', read: 'Прочитано' };

// Емодзі-рядок реакцій у контекстному меню (дзеркало REACTION_EMOJIS на сервері)
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// Приблизні габарити меню (клампінг позиції до країв вікна)
const CONTEXT_MENU_W = 240;
const CONTEXT_MENU_H = 260;

function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

/**
 * Статус власного повідомлення за watermark-ами співрозмовника.
 * read ⊃ delivered ⊃ sent: водяний знак «прочитано» покриває всі старіші повідомлення,
 * тому порівнюємо саме час, а не id (UUID v4 не впорядковані).
 */
function outgoingStatus(message, receipt) {
  if (!receipt || !message?.createdAt) return 'sent';
  const ts = new Date(message.createdAt).getTime();
  if (receipt.lastReadAt && ts <= new Date(receipt.lastReadAt).getTime()) return 'read';
  if (receipt.lastDeliveredAt && ts <= new Date(receipt.lastDeliveredAt).getTime()) {
    return 'delivered';
  }
  return 'sent';
}

// ── Присутність та файли ──────────────────────────────────────────────────

// Максимальний розмір файлу для завантаження (100 МБ)
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Як часто перераховуємо відносний час («5 хв тому») для офлайн-співрозмовника
const PRESENCE_TICK_MS = 30_000;

/**
 * Людський опис останньої появи в мережі.
 * Стать користувача невідома, тому формулювання нейтральне («востаннє …»).
 */
function formatLastSeen(iso, nowMs = Date.now()) {
  if (!iso) return 'не в мережі';

  const then = new Date(iso);
  const thenMs = then.getTime();
  if (Number.isNaN(thenMs)) return 'не в мережі';

  const minutes = Math.floor((nowMs - thenMs) / 60_000);
  if (minutes < 1) return 'щойно в мережі';
  if (minutes < 60) return `востаннє ${minutes} хв тому`;

  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date(nowMs).toDateString();
  const yesterday = new Date(nowMs - 86_400_000).toDateString();

  if (then.toDateString() === today) return `востаннє о ${time}`;
  if (then.toDateString() === yesterday) return `востаннє вчора о ${time}`;
  return `востаннє ${then.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} о ${time}`;
}

/**
 * Актуальний стан присутності користувача.
 * Live-мапа з подій socket має приоритет; дані з REST — початкове значення
 * для тих, про кого подій ще не було.
 */
function presenceOf(user, presenceMap) {
  if (!user) return { isOnline: false, lastSeenAt: null };
  const live = presenceMap[user.id];
  if (live) return live;
  return { isOnline: Boolean(user.isOnline), lastSeenAt: user.lastSeenAt || null };
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

  // Контекстне меню повідомлення: { msg, x, y } | null. Позиція вже обрізана до вікна.
  const [contextMenu, setContextMenu] = useState(null);
  // Режим редагування: id повідомлення, що редагується (null = звичайне надсилання)
  const [editingMessageId, setEditingMessageId] = useState(null);
  const editingMessageIdRef = useRef(null);

  // Результати пошуку по тілах повідомлень та по контактах (день 10)
  const [searchMessageResults, setSearchMessageResults] = useState([]);
  const [searchContacts, setSearchContacts] = useState([]);

  // Прикріплення медіа (файл/фото)
  const [stagedAttachment, setStagedAttachment] = useState(null);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [lightboxImage, setLightboxImage] = useState(null);
  const fileInputRef = useRef(null);

  // Голосовий запис: рекордер у ref — MediaStream лежить поза реакт-станом,
  // стани лише керують UI (панель запису / надсилання / плашка помилки)
  const [isRecording, setIsRecording] = useState(false);
  const [isSendingVoice, setIsSendingVoice] = useState(false);
  const [voiceError, setVoiceError] = useState(null);
  const recorderRef = useRef(null);

  // Watermark-и співрозмовника по діалогах: { [conversationId]: { lastReadAt, lastDeliveredAt } }.
  // За ними виводиться статус власних повідомлень (✓ / ✓✓ / ✓✓ прочитано).
  const [receipts, setReceipts] = useState({});

  // Лічильники непрочитаних для сайдбара: { [conversationId]: count }.
  // Сесійні (скидаються на перезавантаженні): рахуємо лише вхідні, що прийшли,
  // поки діалог не відкритий або вкладка згорнута; відкриття чату обнуляє лічильник.
  const [unreadCounts, setUnreadCounts] = useState({});

  // Співрозмовник у активній розмові друкує
  const [partnerTyping, setPartnerTyping] = useState(false);

  // Присутність: { [userId]: { isOnline, lastSeenAt } }.
  // Єдине джерело істини для UI; REST-відповіді лише наповнюють її початковими значеннями.
  const [presence, setPresence] = useState({});

  // Поточний час для відносних підписів «востаннє 5 хв тому»: оновлюється таймером,
  // поки в заголовку показується офлайн-співрозмовник
  const [nowMs, setNowMs] = useState(() => Date.now());

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

  // Прапорець «першого» connect: лише на реконнектах оновлюємо список з REST
  const hasConnectedRef = useRef(false);

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Таймери «друкує…». Refs, а не state: вони не впливають на рендер.
  const typingStopTimerRef = useRef(null);
  const typingHideTimerRef = useRef(null);
  const typingSentAtRef = useRef(0); // 0 = сигнал «друкую» зараз не активний

  // Автоскрол до останнього повідомлення
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Закриття перегляду фото на Esc
  useEffect(() => {
    if (!lightboxImage) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setLightboxImage(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightboxImage]);

  // Розмонтування сторінки під час запису: мікрофон слід звільнити обов'язково
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
    },
    [],
  );

  // Очищення черги вкладення при зміні активного чату
  useEffect(() => {
    setStagedAttachment(null);
    setUploadError(null);
    setContextMenu(null);
    if (editingMessageIdRef.current) {
      setEditingMessageId(null);
      editingMessageIdRef.current = null;
      // Скидання قبل першого рендеру нового чата — inputText чиститься вручну нижче
      setInputText('');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [activeChat?.id]);

  // Закриття контекстного меню: Esc, клік будь-де, скрол чата.
  // Внутрішні кліки меню зупиняються stopPropagation, тож глобальний mousedown їх не бачить.
  useEffect(() => {
    if (!contextMenu) return undefined;

    const onKeyDown = (e) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    const onMouseDown = () => setContextMenu(null);
    const onScroll = () => setContextMenu(null);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('wheel', onScroll, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('wheel', onScroll);
    };
  }, [contextMenu]);

  // Зливає присутність із REST-відповідей у live-мапу.
  // Потрібно після перепідключення: сервер міг перезапуститися, і в мапі
  // лишився б застарілий «онлайн», який уже ніколи не оновиться подією.
  const syncPresence = useCallback((users) => {
    const list = (users || []).filter(
      (u) => u && u.id && typeof u.isOnline === 'boolean',
    );
    if (list.length === 0) return;

    setPresence((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const u of list) {
        const lastSeenAt = u.lastSeenAt || null;
        const current = next[u.id];
        if (
          !current ||
          current.isOnline !== u.isOnline ||
          current.lastSeenAt !== lastSeenAt
        ) {
          next[u.id] = { isOnline: u.isOnline, lastSeenAt };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Завантаження діалогів та статистики профілю при першому вході
  const loadInitialData = useCallback(async () => {
    try {
      const [convsRes, statsRes] = await Promise.all([
        api.listConversations(),
        api.matchStats().catch(() => ({ matchesCount: 0, contactsCount: 0 })),
      ]);
      const loaded = convsRes.conversations || [];
      setConversations(loaded);
      // Персистентні непрочитані: початкові значення з БД (watermark «прочитано»)
      setUnreadCounts(
        Object.fromEntries(loaded.map((conv) => [conv.id, conv.unreadCount || 0])),
      );
      syncPresence(loaded.map((conv) => conv.otherUser));
      setContactsCount(statsRes.contactsCount || 0);
      setMatchesCount(statsRes.matchesCount || 0);
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  }, [syncPresence]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Запит дозволу на браузерні сповіщення при завантаженні сторінки
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // ── «Друкує…»: надсилання сигналів ──────────────────────────────────────────

  // Сигнал «друкую» / «перестав друкувати» в активний чат
  const emitTyping = useCallback((isTyping) => {
    const socket = socketRef.current;
    const chat = activeChatRef.current;
    if (!socket?.connected || !chat) return;

    if (chat.type === 'direct') {
      socket.emit('typing', { conversationId: chat.id, isTyping });
      return;
    }

    const sessionId = strangerSessionRef.current?.sessionId;
    if (chat.type === 'stranger' && sessionId) {
      socket.emit('stranger:typing', { sessionId, isTyping });
    }
  }, []);

  // Гасить сигнал, лише якщо він був активний — щоб не плодити зайвих подій
  const stopTyping = useCallback(() => {
    clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = null;
    if (typingSentAtRef.current === 0) return;
    typingSentAtRef.current = 0;
    emitTyping(false);
  }, [emitTyping]);

  // Викликається на кожне натискання: тротлить старт і перезапускає таймер зупинки
  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - typingSentAtRef.current >= TYPING_THROTTLE_MS) {
      typingSentAtRef.current = now;
      emitTyping(true);
    }
    clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(stopTyping, TYPING_STOP_MS);
  }, [emitTyping, stopTyping]);

  // Позначає відкритий діалог прочитаним. Тротлінг не потрібен: сервер сам пропускає
  // UPDATE, якщо нових вхідних немає, тож повторні події коштують один індексний запит
  // і нічого не розсилають. Натомість будь-яке вхідне в відкритому чаті гарантовано
  // стає прочитаним — без «завислих» ✓✓ через вікно тротлінгу.
  const markActiveChatRead = useCallback(() => {
    const socket = socketRef.current;
    const chat = activeChatRef.current;
    if (!socket?.connected || chat?.type !== 'direct') return;
    if (typeof document !== 'undefined' && document.hidden) return;

    socket.emit('conversation:read', { conversationId: chat.id });
  }, []);

  // Таймери «друкує…» не мають пережити розмонтування компонента
  useEffect(
    () => () => {
      clearTimeout(typingStopTimerRef.current);
      clearTimeout(typingHideTimerRef.current);
    },
    [],
  );

  // Відкриття прямого діалогу
  const openDirectConversation = useCallback(
    (conv) => {
      const prevChat = activeChatRef.current;
      if (prevChat?.id === conv.id) return;

      stopTyping();

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
        // Бейдж «🎲 Метч» прибрано з UI: isMatch лишається в даних під окремий
        // акцент у майбутньому. Підпис у заголовку тепер береться з присутності.
        isMatch: Boolean(conv.isMatch),
      });

      // Чат відкритий — непрочитані в ньому переглянуті
      setUnreadCounts((prev) =>
        prev[conv.id] ? { ...prev, [conv.id]: 0 } : prev,
      );

      // Стартові watermark-и співрозмовника, щоб тіки були коректними до першої події
      setReceipts((prev) => ({
        ...prev,
        [conv.id]: {
          lastDeliveredAt: conv.otherUser?.lastDeliveredAt || null,
          lastReadAt: conv.otherUser?.lastReadAt || null,
        },
      }));

      setIsLoadingMessages(true);
      api
        .listMessages(conv.id)
        .then((res) => {
          setMessages(res.messages || []);
        })
        .catch((err) => {
          console.error('Failed to load messages:', err);
        })
        .finally(() => {
          setIsLoadingMessages(false);
        });

      if (socketRef.current) {
        socketRef.current.emit('conversation:join', { conversationId: conv.id });
      }
    },
    [stopTyping],
  );

  // Підключення та обробка Socket.IO
  useEffect(() => {
    const socket = io({
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      // Якщо вже відкритий чат, повторно приєднуємося до кімнати
      const chat = activeChatRef.current;
      if (chat?.type !== 'direct') return;

      socket.emit('conversation:join', { conversationId: chat.id });

      // Перепідключення (не перший connect): за час офлайну в інші діалоги могли
      // прийти повідомлення, які сокет не повторює. Оновлюємо список з REST —
      // серверні лічильники непрочитаних дружать стан із БД.
      const isFirstConnect = hasConnectedRef.current;
      hasConnectedRef.current = true;
      if (!isFirstConnect) {
        loadInitialData().then(() => {
          // Активний чат позначається прочитаним поруч — бейдж не повинен блимати
          setUnreadCounts((prev) =>
            prev[chat.id] ? { ...prev, [chat.id]: 0 } : prev,
          );
        });
      }

      // Поки сокет був відключений, співрозмовник міг прочитати діалог —
      // тому перечитуємо watermark-и з REST, а не покладаємось лише на події
      api
        .getConversation(chat.id)
        .then((res) => {
          const other = res.conversation?.otherUser;
          if (!other) return;
          setReceipts((prev) => ({
            ...prev,
            [chat.id]: {
              lastDeliveredAt: other.lastDeliveredAt || null,
              lastReadAt: other.lastReadAt || null,
            },
          }));
          // Онлайн-стан теж міг застаріти, поки сокет був відключений
          syncPresence([other]);
        })
        .catch(() => {});
      // Позначаємо прочитаним ще раз — вхідні за час відключення могли не потрапити у watermark
      markActiveChatRead();
    });

    // Отримання нового повідомлення в реальному часі
    socket.on('message:new', ({ message }) => {
      if (!message) return;

      const currentChat = activeChatRef.current;
      const isIncoming = message.senderId !== user.id;

      // Підтверджуємо доставку — завдяки цьому у відправника з'являється ✓✓,
      // навіть якщо одержувач сидить в іншому діалозі
      if (isIncoming) {
        socket.emit('message:delivered', { messageId: message.id });
      }

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
            body: formatMessagePreview(message, 'Надіслано повідомлення'),
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

        // Бейдж непрочитаних у списку чатів: той самий критерій, що й для сповіщення —
        // діалог не відкритий або вкладка згорнута
        if (isUnfocused) {
          setUnreadCounts((prev) => ({
            ...prev,
            [message.conversationId]: (prev[message.conversationId] || 0) + 1,
          }));
        }
      }

      // Будь-яка активність від співрозмовника свідчить, що він прямо зараз онлайн
      if (isIncoming && message.senderId) {
        setPresence((prev) => ({
          ...prev,
          [message.senderId]: { isOnline: true, lastSeenAt: null },
        }));
      }

      // Якщо повідомлення належить поточному відкритому діалогу — додаємо до списку
      if (currentChat?.id === message.conversationId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev;
          return [...prev, message];
        });

        // Чат відкритий і вкладка видима — повідомлення одразу стає прочитаним
        if (isIncoming) markActiveChatRead();
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
              attachment: message.attachment,
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
    // Квитанції: прочитано / доставлено
    // ==========================================

    // Співрозмовник прочитав діалог. «Прочитано» завжди покриває «доставлено»,
    // тому піднімаємо обидва watermark-и — стан «прочитано, але не доставлено» неможливий.
    socket.on('message:read', ({ conversationId, lastReadAt }) => {
      if (!conversationId || !lastReadAt) return;

      const conv = conversationsRef.current.find((c) => c.id === conversationId);
      const partnerId = conv?.otherUser?.id || (activeChatRef.current?.id === conversationId ? activeChatRef.current?.otherUser?.id : null);
      if (partnerId) {
        setPresence((prev) => ({
          ...prev,
          [partnerId]: { isOnline: true, lastSeenAt: null },
        }));
      }

      setReceipts((prev) => {
        const current = prev[conversationId] || {};
        const readAt = laterIso(current.lastReadAt, lastReadAt);
        return {
          ...prev,
          [conversationId]: {
            lastReadAt: readAt,
            lastDeliveredAt: laterIso(current.lastDeliveredAt, readAt),
          },
        };
      });
    });

    // Співрозмовник отримав повідомлення на свій пристрій
    socket.on('message:delivered', ({ conversationId, lastDeliveredAt }) => {
      if (!conversationId || !lastDeliveredAt) return;

      const conv = conversationsRef.current.find((c) => c.id === conversationId);
      const partnerId = conv?.otherUser?.id || (activeChatRef.current?.id === conversationId ? activeChatRef.current?.otherUser?.id : null);
      if (partnerId) {
        setPresence((prev) => ({
          ...prev,
          [partnerId]: { isOnline: true, lastSeenAt: null },
        }));
      }

      setReceipts((prev) => {
        const current = prev[conversationId] || {};
        return {
          ...prev,
          [conversationId]: {
            ...current,
            lastDeliveredAt: laterIso(current.lastDeliveredAt, lastDeliveredAt),
          },
        };
      });
    });

    // ==========================================
    // Індикатор «друкує…»
    // ==========================================

    // Сервер не зберігає стан індикатора, тому гасимо його самі за таймаутом:
    // втрачена подія isTyping: false залишить «друкує…» максимум на TYPING_HIDE_MS.
    const showPartnerTyping = (chatId, isTyping) => {
      if (activeChatRef.current?.id !== chatId) return;

      clearTimeout(typingHideTimerRef.current);
      typingHideTimerRef.current = null;

      if (!isTyping) {
        setPartnerTyping(false);
        return;
      }

      setPartnerTyping(true);
      typingHideTimerRef.current = setTimeout(() => setPartnerTyping(false), TYPING_HIDE_MS);
    };

    socket.on('typing', ({ conversationId, isTyping }) => {
      showPartnerTyping(conversationId, isTyping);
      if (isTyping) {
        const conv = conversationsRef.current.find((c) => c.id === conversationId);
        const partnerId = conv?.otherUser?.id || (activeChatRef.current?.id === conversationId ? activeChatRef.current?.otherUser?.id : null);
        if (partnerId) {
          setPresence((prev) => ({
            ...prev,
            [partnerId]: { isOnline: true, lastSeenAt: null },
          }));
        }
      }
    });

    socket.on('stranger:typing', ({ sessionId, isTyping }) => {
      showPartnerTyping(sessionId, isTyping);
    });

    // ==========================================
    // Реакції та правки повідомлень (день 10)
    // ==========================================

    // Агрегат реакцій конкретного повідомлення (toggle сервера вже відбувся)
    const applyReactionUpdate = (chatId, messageId, reactions) => {
      if (activeChatRef.current?.id !== chatId) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
      );
    };

    socket.on('message:reaction', ({ conversationId, messageId, reactions }) => {
      if (conversationId && messageId && reactions) {
        applyReactionUpdate(conversationId, messageId, reactions);
      }
    });

    socket.on('stranger:reaction', ({ sessionId, messageId, reactions }) => {
      if (sessionId && messageId && reactions) {
        applyReactionUpdate(sessionId, messageId, reactions);
      }
    });

    // Редагування (edited_at) і tombstone: замінюємо локальний об'єкт повідомлення.
    // Сайдбар-прев'ю оновлюємо теж — відредаговане тіло впливає на його текст.
    const applyMessageUpdate = (message) => {
      if (!message) return;

      if (activeChatRef.current?.id === message.conversationId) {
        setMessages((prev) =>
          prev.some((m) => m.id === message.id)
            ? prev.map((m) => (m.id === message.id ? message : m))
            : prev,
        );
      }

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.lastMessage?.id !== message.id) return conv;
          return {
            ...conv,
            lastMessage: {
              ...conv.lastMessage,
              body: message.body,
              deleted: Boolean(message.deleted),
              attachment: message.attachment,
            },
          };
        }),
      );
    };

    socket.on('message:updated', ({ message }) => applyMessageUpdate(message));

    // Tombstone (видалення): клієнт сам збирає tombstone — подія несе лише id
    const applyMessageDelete = (conversationId, messageId) => {
      if (activeChatRef.current?.id === conversationId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, body: '', attachment: null, deleted: true, editedAt: null, reactions: {} }
              : m,
          ),
        );
      }

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.lastMessage?.id !== messageId) return conv;
          return {
            ...conv,
            lastMessage: {
              ...conv.lastMessage,
              body: '',
              attachment: null,
              deleted: true,
            },
          };
        }),
      );
    };

    socket.on('message:deleted', ({ conversationId, messageId }) => {
      if (conversationId && messageId) applyMessageDelete(conversationId, messageId);
    });

    socket.on('stranger:updated', ({ message }) => {
      if (!message) return;
      const chat = activeChatRef.current;
      const sameChat =
        chat?.id === message.sessionId || strangerSessionRef.current?.sessionId === message.sessionId;
      if (!sameChat) return;

      setMessages((prev) =>
        prev.some((m) => m.id === message.id)
          ? prev.map((m) => (m.id === message.id ? message : m))
          : prev,
      );
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
        (currentChat.id === message.sessionId ||
          currentStranger?.sessionId === message.sessionId ||
          currentChat.id === 'stranger-pending')
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
            body: formatMessagePreview(message, 'Надіслано повідомлення'),
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
    socket.on('stranger:revealed', async ({ conversationId, conversation, partner }) => {
      playNotificationSound();
      stopTyping();
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
        // Бейдж «🎲 Метч» прибрано з UI (isMatch лишається в даних);
        // підпис у заголовку береться з присутності, а не з цього поля
        isMatch: true,
      });

      // Стартові watermark-и співрозмовника для тіків
      setReceipts((prev) => ({
        ...prev,
        [conversationId]: {
          lastDeliveredAt: conversation?.otherUser?.lastDeliveredAt || null,
          lastReadAt: conversation?.otherUser?.lastReadAt || null,
        },
      }));

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
        console.error('Failed to load messages after match reveal:', err);
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

    // Присутність: сервер надсилає подію лише тим, кому видно цього користувача
    // (спільні діалоги та контакти), тому тут не потрібна жодна фільтрація
    socket.on('presence:update', ({ userId, isOnline, lastSeenAt }) => {
      setPresence((prev) => ({
        ...prev,
        [userId]: { isOnline, lastSeenAt: lastSeenAt || null },
      }));
    });

    return () => {
      socket.disconnect();
    };
  }, [user.id, openDirectConversation, loadInitialData, markActiveChatRead, stopTyping, syncPresence]);

  // Позначаємо відкритий діалог прочитаним при відкритті та поверненні фокусу у вкладку
  useEffect(() => {
    if (activeChat?.type !== 'direct') return undefined;

    markActiveChatRead();

    // Повернення до відкритого чату: непрочитані в ньому вже переглянуті
    const clearActiveUnread = () => {
      setUnreadCounts((prev) =>
        prev[activeChat.id] ? { ...prev, [activeChat.id]: 0 } : prev,
      );
    };

    const onFocus = () => {
      markActiveChatRead();
      clearActiveUnread();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) {
        markActiveChatRead();
        clearActiveUnread();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeChat?.id, activeChat?.type, markActiveChatRead]);

  // Перемикання чату скидає індикатор «друкує…» попереднього співрозмовника
  useEffect(() => {
    setPartnerTyping(false);
    clearTimeout(typingHideTimerRef.current);
    typingHideTimerRef.current = null;
  }, [activeChat?.id]);

  // ── Присутність: похідні значення для рендеру ────────────────────────────

  const activePresence = presenceOf(activeChat?.otherUser, presence);

  // Підпис у заголовку. Для прямого діалогу це реальний онлайн-стан із сокета
  // (або «востаннє …»). Для анонімного — стан сесії, який уже веде існуючий код:
  // «пошук співрозмовника…», «в мережі», «розмову завершено».
  let headerStatus = '';

  if (activeChat?.type === 'direct') {
    headerStatus = activePresence.isOnline
      ? 'в мережі'
      : formatLastSeen(activePresence.lastSeenAt, nowMs);
  } else if (activeChat) {
    headerStatus = activeChat.status || '';
  }

  const headerIsOffline = activeChat?.type === 'direct' && !activePresence.isOnline;

  // Відносний час має «тікати» сам, але перерендер потрібен лише тоді,
  // коли в заголовку справді показаний офлайн-співрозмовник
  useEffect(() => {
    if (!headerIsOffline || activeChat?.type !== 'direct') return undefined;

    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), PRESENCE_TICK_MS);
    return () => clearInterval(timer);
  }, [headerIsOffline, activeChat?.type, activeChat?.id]);

  // Глобальний пошук користувачів із дебаунсом 250 мс: люди + тіла
  // повідомлень у всіх діалогах + фільтр контактів (день 10)
  useEffect(() => {
    const clean = searchQuery.trim().replace(/^@+/, '');
    if (!clean) {
      setSearchResults([]);
      setSearchMessageResults([]);
      setSearchContacts([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timeout = setTimeout(() => {
      // Контакти тягнемо цілком і фільтруємо клієнтськи: список малий,
      // а вважати окремий ІЛайк для нього на сервері зайвий ендпоінт
      const messagesPromise = api
        .searchMessages(searchQuery.trim())
        .then((res) => res.messages || [])
        .catch((err) => {
          console.error('Message search error:', err);
          return [];
        });
      const contactsPromise = api
        .listContacts()
        .then((res) =>
          (res.contacts || []).filter((c) =>
            (c.username || '').toLowerCase().includes(clean.toLowerCase()),
          ),
        )
        .catch((err) => {
          console.error('Contacts search error:', err);
          return [];
        });

      api
        .searchUsers(clean)
        .then((res) => {
          setSearchResults(res.users || []);
          syncPresence(res.users || []);
        })
        .catch((err) => {
          console.error('Search error:', err);
        });

      messagesPromise.then(setSearchMessageResults);
      contactsPromise.then(setSearchContacts);
      setIsSearching(false);
    }, 250);

    return () => clearTimeout(timeout);
  }, [searchQuery, syncPresence]);

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
      console.error('Failed to create conversation:', err);
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
      console.error('Failed to add contact:', err);
    }
  };

  // Клік по результату пошуку в повідомленнях: відкрити той діалог
  const openFromMessageResult = async (item) => {
    const convId = item.message.conversationId;
    const existing = conversations.find((c) => c.id === convId);
    if (existing) {
      openDirectConversation(existing);
      setSearchQuery('');
      return;
    }

    try {
      const res = await api.getConversation(convId);
      if (res.conversation) {
        setConversations((prev) => {
          if (prev.some((c) => c.id === res.conversation.id)) return prev;
          return [res.conversation, ...prev];
        });
        openDirectConversation(res.conversation);
      }
    } catch (err) {
      console.error('Failed to open conversation from search:', err);
    } finally {
      setSearchQuery('');
    }
  };

  // Захід у чат із контакту в результатах пошуку
  // (контакт не обов'язково має діалог — тоді він створиться)
  const openFromContactResult = (contact) => {
    handleSelectFoundUser({ id: contact.id, username: contact.username });
  };

  // Введення тексту: оновлює поле і сигналізує співрозмовнику «друкує…»
  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputText(value);

    if (value.trim()) {
      notifyTyping();
    } else {
      stopTyping();
    }
  };

  // Завантаження файлу в чергу вкладення
  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(`Файл завеликий (${formatFileSize(file.size)}). Максимальний розмір — 100 МБ.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsUploadingAttachment(true);
    setUploadError(null);

    try {
      const res = await api.uploadFile(file);
      if (res?.attachment) {
        setStagedAttachment(res.attachment);
      }
    } catch (err) {
      console.error('Failed to upload file:', err);
      setUploadError(err.message || 'Не вдалося завантажити файл');
    } finally {
      setIsUploadingAttachment(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Скасування прикріпленого файлу
  const handleCancelAttachment = () => {
    setStagedAttachment(null);
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Спільна відправка для тексту з вкладенням і для голосових: сокет з ack, фолбек REST.
  // Текст може бути порожнім — сервер (Zod-схема) приймає вкладення без тіла.
  const dispatchMessage = async (text, attachment) => {
    if (!activeChat) return;
    stopTyping();

    if (activeChat.type === 'stranger') {
      const sessionId = strangerSessionRef.current?.sessionId || activeChat.id;
      if (socketRef.current?.connected) {
        socketRef.current.emit(
          'stranger:message',
          { sessionId, body: text, attachment },
          (res) => {
            if (!res?.ok) {
              console.error('Failed to send stranger message:', res?.error);
            } else if (res?.message) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === res.message.id)) return prev;
                return [...prev, res.message];
              });
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
        { conversationId: activeChat.id, body: text, attachment },
        (res) => {
          if (!res?.ok) {
            console.error('Failed to send message via socket:', res?.error);
            // Фолбек на REST у разі помилки сокета
            api.sendMessage(activeChat.id, text, attachment).catch(console.error);
          }
        },
      );
    } else {
      // Фолбек на REST, якщо сокет тимчасово від'єднано
      try {
        await api.sendMessage(activeChat.id, text, attachment);
      } catch (err) {
        console.error('Failed to send message via REST:', err);
      }
    }
  };

  // Відправка повідомлення
  const handleSendMessage = async (e) => {
    e.preventDefault();
    const text = inputText.trim();
    const attachment = stagedAttachment;
    if ((!text && !attachment) || !activeChat || isUploadingAttachment) return;

    // Режим редагування: подія message:edit / stranger:edit замість нового повідомлення
    if (editingMessageIdRef.current) {
      const messageId = editingMessageIdRef.current;
      setEditingMessageId(null);
      editingMessageIdRef.current = null;
      setInputText('');

      const socketFn = activeChat.type === 'stranger' ? 'stranger:edit' : 'message:edit';
      const payload =
        activeChat.type === 'stranger'
          ? {
              sessionId: strangerSessionRef.current?.sessionId || activeChat.id,
              messageId,
              body: text,
            }
          : { messageId, body: text };

      if (socketRef.current?.connected) {
        socketRef.current.emit(socketFn, payload, (res) => {
          if (!res?.ok) {
            console.error('Failed to edit message:', res?.error);
          }
        });
      }
      return;
    }

    setInputText('');
    setStagedAttachment(null);
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    dispatchMessage(text, attachment);
  };

  // ============ Контекстне меню, реакції, редагування/видалення (день 10) ============

  // Відкриття меню на повідомленні: позиція обрізається до країв вікна
  const handleOpenContextMenu = (e, msg) => {
    if (msg.type === 'system' || msg.deleted) return; // tombstone та системні — без дій
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - CONTEXT_MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - CONTEXT_MENU_H - 8);

    setContextMenu({ msg, x, y });
  };

  const closeContextMenu = () => setContextMenu(null);

  const cancelEditMessage = () => {
    setEditingMessageId(null);
    editingMessageIdRef.current = null;
    setInputText('');
  };

  const isMessageMine = (msg) => msg.senderId === user.id;

  // Toggle реакції з чипса: своя реакція — знімаємо, чужа/відсутня — ставимо
  const dispatchToggleReaction = (msg, emoji, isMine) => {
    if (!activeChat) return;
    const socketFn = activeChat.type === 'stranger' ? 'stranger:react' : 'message:react';
    const idPayload =
      activeChat.type === 'stranger'
        ? { sessionId: strangerSessionRef.current?.sessionId || activeChat.id, messageId: msg.id }
        : { messageId: msg.id };
    if (socketRef.current?.connected) {
      socketRef.current.emit(socketFn, { ...idPayload, emoji: isMine ? null : emoji }, (res) => {
        if (!res?.ok) console.error('Failed to toggle reaction:', res?.error);
      });
    }
  };

  // Дія з меню: реакція / копіювання / редагування / видалення
  const handleMenuAction = (action, emoji) => {
    if (!contextMenu) return;
    const msg = contextMenu.msg;
    closeContextMenu();

    if (action === 'react') {
      dispatchToggleReaction(msg, emoji, Boolean(msg.reactions?.[emoji]?.userIds?.includes(user.id)));
      return;
    }

    if (action === 'copy') {
      // navigator.clipboard вимагає secure context; fallback — ручне виділення
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(msg.body).catch(() => {});
      } else {
        window.prompt('Скопіюйте текст повідомлення:', msg.body);
      }
      return;
    }

    if (action === 'edit') {
      setEditingMessageId(msg.id);
      editingMessageIdRef.current = msg.id;
      setInputText(msg.body);
      return;
    }

    if (action === 'delete') {
      const socketFn = activeChat.type === 'stranger' ? 'stranger:delete' : 'message:delete';
      const idPayload =
        activeChat.type === 'stranger'
          ? {
              sessionId: strangerSessionRef.current?.sessionId || activeChat.id,
              messageId: msg.id,
            }
          : { messageId: msg.id };
      if (socketRef.current?.connected) {
        socketRef.current.emit(socketFn, idPayload, (res) => {
          if (!res?.ok) console.error('Failed to delete message:', res?.error);
        });
      }
    }
  };

  // ============ Голосові повідомлення (день 9) ============

  // Натискання на мікрофон: запит дозволу через getUserMedia. Якщо доступ раніше
  // заборонено — нічого не записуємо, показуємо плашку; після дозволу запис
  // стартує одразу, без другого кліка.
  const handleMicClick = async () => {
    if (isRecording || isSendingVoice) return;
    try {
      recorderRef.current = await startVoiceRecording();
      setVoiceError(null);
      setIsRecording(true);
    } catch (err) {
      console.error('Voice recording failed:', err);
      setVoiceError(
        err.code === 'denied'
          ? 'Доступ до мікрофона заборонено. Дозвольте його у налаштуваннях сайту та спробуйте знову.'
          : err.code === 'no-mic'
            ? 'Мікрофон не знайдено.'
            : err.code === 'unsupported'
              ? 'Ваш браузер не підтримує запис голосу.'
              : err.code === 'busy'
                ? 'Мікрофон зайнятий іншою програмою.'
                : 'Не вдалося почати запис голосового.',
      );
    }
  };

  const teardownRecorder = () => {
    recorderRef.current = null;
    setIsRecording(false);
  };

  // Скасування запису: звук викидається, мікрофон звільняється
  const handleVoiceCancel = () => {
    recorderRef.current?.cancel();
    teardownRecorder();
  };

  // Зупинка запису → завантаження файлу → миттєва відправка як вкладення
  const handleVoiceSend = async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    teardownRecorder();

    const { blob, extension } = await recorder.stop();
    if (!blob) return;

    setIsSendingVoice(true);
    setVoiceError(null);
    try {
      const file = new File([blob], `voice${extension || '.webm'}`, {
        type: blob.type,
      });
      const res = await api.uploadFile(file);
      if (res?.attachment) {
        dispatchMessage('', res.attachment);
      }
    } catch (err) {
      console.error('Failed to send voice message:', err);
      setVoiceError(err.message || 'Не вдалося надіслати голосове');
    } finally {
      setIsSendingVoice(false);
    }
  };

  // Початок пошуку випадкового співрозмовника
  const startStrangerSearch = () => {
    stopTyping();
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
          console.error('Failed to start stranger search:', res?.error);
        }
      });
    }
  };

  // Скасування пошуку
  const handleCancelSearch = () => {
    stopTyping();
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
    stopTyping();
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
          console.error('Failed to switch to next stranger:', res?.error);
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
          console.error('Failed to request contact match:', res?.error);
        }
      });
    }
  };

  // Завершення розмови зі сторони користувача
  const handleLeaveStranger = () => {
    stopTyping();
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
    stopTyping();
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
        const lastMsgMatch =
          c.lastMessage?.body?.toLowerCase().includes(trimmedSearch.toLowerCase()) ||
          c.lastMessage?.attachment?.name?.toLowerCase().includes(trimmedSearch.toLowerCase());
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
              placeholder="Пошук людей, діалогів та повідомлень"
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
                        <div className="chat-row-avatar">
                          {initials}
                          {presenceOf(conv.otherUser, presence).isOnline && (
                            <span className="presence-dot" aria-label="У мережі" />
                          )}
                        </div>
                        <div className="chat-row-body">
                          <div className="chat-row-line1">
                            <div className="chat-row-title-wrap">
                              <span className="chat-row-name">
                                @{conv.otherUser?.username}
                              </span>
                            </div>
                            <span className="chat-row-time">
                              {formatTimestamp(
                                conv.lastMessage?.createdAt || conv.createdAt,
                              )}
                            </span>
                          </div>
                          <div className="chat-row-line2">
                            <span className="chat-row-preview">
                              {formatMessagePreview(conv.lastMessage, 'Діалог створено')}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </>
              )}

              {searchContacts.length > 0 && (
                <>
                  <div className="search-section-header">Контакти</div>
                  {searchContacts.map((contact) => {
                    const initials = (contact.username || '').slice(0, 2).toUpperCase();
                    const isActive = activeChat?.otherUser?.id === contact.id;
                    return (
                      <div
                        key={contact.id}
                        className={`chat-row ${isActive ? 'active' : ''}`}
                        onClick={() => openFromContactResult(contact)}
                        style={{ cursor: 'pointer' }}
                      >
                        <div className="chat-row-avatar">
                          {initials}
                          {presenceOf(contact, presence).isOnline && (
                            <span className="presence-dot" aria-label="У мережі" />
                          )}
                        </div>
                        <div className="chat-row-body">
                          <div className="chat-row-line1">
                            <span className="chat-row-name">@{contact.username}</span>
                            <span className="chat-row-badge">Контакт</span>
                          </div>
                          <div className="chat-row-line2">
                            <span className="chat-row-preview">Натисніть, щоб відкрити діалог</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {searchMessageResults.length > 0 && (
                <>
                  <div className="search-section-header">З повідомлень</div>
                  {searchMessageResults.map((item) => {
                    const initials = (item.otherUsername || '')
                      .slice(0, 2)
                      .toUpperCase();
                    const body = item.message.body || '';
                    const snippet =
                      body.length > 80 ? `${body.slice(0, 80)}…` : body;
                    const senderLabel =
                      item.message.senderId === user.id
                        ? 'Ви'
                        : `@${item.message.senderUsername || 'співрозмовник'}`;
                    return (
                      <button
                        key={item.message.id}
                        className="chat-row search-message-row"
                        onClick={() => openFromMessageResult(item)}
                        title="Натисніть, щоб відкрити діалог"
                      >
                        <div className="chat-row-avatar">{initials}</div>
                        <div className="chat-row-body">
                          <div className="chat-row-line1">
                            <span className="chat-row-name">@{item.otherUsername}</span>
                            <span className="chat-row-time">
                              {formatTimestamp(item.message.createdAt)}
                            </span>
                          </div>
                          <div className="chat-row-line2">
                            <span className="chat-row-preview">
                              <span className="search-message-sender">{senderLabel}: </span>
                              {snippet}
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
                      <div className="chat-row-avatar">
                        {initials}
                        {presenceOf(targetUser, presence).isOnline && (
                          <span className="presence-dot" aria-label="У мережі" />
                        )}
                      </div>
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
                  const unread = unreadCounts[conv.id] || 0;
                  const initials = (conv.otherUser.username || '')
                    .slice(0, 2)
                    .toUpperCase();
                  return (
                    <button
                      key={conv.id}
                      className={`chat-row ${isActive ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}`}
                      onClick={() => openDirectConversation(conv)}
                    >
                      <div className="chat-row-avatar">
                        {initials}
                        {presenceOf(conv.otherUser, presence).isOnline && (
                          <span className="presence-dot" aria-label="У мережі" />
                        )}
                      </div>
                      <div className="chat-row-body">
                        <div className="chat-row-line1">
                          <div className="chat-row-title-wrap">
                            <span className="chat-row-name">
                              @{conv.otherUser.username}
                            </span>
                            {/* Бейдж «🎲 Метч» прибрано зі списку чатів: isMatch лишається
                                в даних і повернеться окремим акцентом поза рядком діалогу. */}
                          </div>
                          <span className="chat-row-time">
                            {formatTimestamp(
                              conv.lastMessage?.createdAt || conv.createdAt,
                            )}
                          </span>
                        </div>
                        <div className="chat-row-line2">
                          <span className="chat-row-preview">
                            {formatMessagePreview(conv.lastMessage, 'Немає повідомлень')}
                          </span>
                          {unread > 0 && (
                            <span
                              className="chat-row-unread"
                              title={`${unread} нових повідомлень`}
                            >
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
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
                </h2>
                <span
                  className={`chat-target-status ${partnerTyping ? 'is-typing' : ''} ${
                    headerIsOffline ? 'is-offline' : ''
                  }`}
                >
                  {partnerTyping ? 'друкує…' : headerStatus}
                </span>
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
                      // Статус показуємо лише для власних повідомлень у прямому діалозі:
                      // в анонімному чаті повідомлення ефемерні й квитанцій не мають
                      const tickStatus =
                        isMe && activeChat.type === 'direct'
                          ? outgoingStatus(msg, receipts[activeChat.id])
                          : null;
                      return (
                        <div
                          key={msg.id}
                          className={`message-row ${isMe ? 'message-out' : 'message-in'}`}
                          onContextMenu={(e) => handleOpenContextMenu(e, msg)}
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
                            {msg.attachment && (
                              <div className="message-attachment">
                                {msg.attachment.type === 'image' ? (
                                  <div
                                    className="attachment-image-wrap"
                                    onClick={() => setLightboxImage(msg.attachment.url)}
                                    title="Натисніть для перегляду"
                                  >
                                    <img
                                      src={msg.attachment.url}
                                      alt={msg.attachment.name || 'Фото'}
                                      className="attachment-image-thumb"
                                      loading="lazy"
                                    />
                                  </div>
                                ) : msg.attachment.type === 'video' ? (
                                  <div className="attachment-video-wrap">
                                    <video
                                      controls
                                      preload="metadata"
                                      className="attachment-video-player"
                                      src={msg.attachment.url}
                                    />
                                  </div>
                                ) : msg.attachment.type === 'audio' ? (
                                  /* Голосове: щира хвиля (WebAudio) + плеер */
                                  <VoicePlayer attachment={msg.attachment} />
                                ) : (
                                  <a
                                    href={`/api/uploads/download/${msg.attachment.url.split('/').pop()}?name=${encodeURIComponent(msg.attachment.name || 'file')}`}
                                    className="attachment-file-card"
                                    download={msg.attachment.name || 'file'}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Завантажити файл"
                                  >
                                    <div className="attachment-file-icon">
                                      {msg.attachment.type === 'audio'
                                        ? '🎵'
                                        : msg.attachment.type === 'video'
                                          ? '🎥'
                                          : '📄'}
                                    </div>
                                    <div className="attachment-file-info">
                                      <span className="attachment-file-name" title={msg.attachment.name}>
                                        {msg.attachment.name || 'Файл'}
                                      </span>
                                      <span className="attachment-file-size">
                                        {formatFileSize(msg.attachment.size)}
                                      </span>
                                    </div>
                                    <div className="attachment-file-download-btn" aria-label="Завантажити">
                                      ⬇
                                    </div>
                                  </a>
                                )}
                              </div>
                            )}
                            {!msg.deleted && msg.body && msg.body.trim() && (
                              <div className="message-text">{msg.body}</div>
                            )}
                            {msg.deleted && (
                              <div className="message-text is-deleted">Повідомлення видалено</div>
                            )}
                            <div className="message-meta">
                              <span className="message-time">
                                {formatTimestamp(msg.createdAt)}
                                {msg.editedAt && !msg.deleted && (
                                  <span className="message-edited"> · редаговано</span>
                                )}
                              </span>
                              {tickStatus && (
                                <span
                                  className={`message-ticks is-${tickStatus}`}
                                  title={TICK_TITLE[tickStatus]}
                                  aria-label={TICK_TITLE[tickStatus]}
                                >
                                  {TICK_GLYPH[tickStatus]}
                                </span>
                              )}
                            </div>
                          </div>
                          {/* Чипси реакцій під бульбашкою (агрегат із сервера) */}
                          {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                            <div className="message-reactions">
                              {Object.entries(msg.reactions).map(
                                ([emoji, { count, userIds }]) => {
                                  const isMine = userIds.includes(user.id);
                                  return (
                                    <button
                                      key={emoji}
                                      type="button"
                                      className={`message-reaction-chip ${isMine ? 'is-mine' : ''}`}
                                      title={isMine ? 'Прибрати реакцію' : 'Поставити таку саму'}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        dispatchToggleReaction(msg, emoji, isMine);
                                      }}
                                    >
                                      {emoji}
                                      {count > 1 ? ` ${count}` : ''}
                                    </button>
                                  );
                                },
                              )}
                            </div>
                          )}
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
                  <>
                    {/* Черга прикріпленого файлу / статус завантаження */}
                    {(stagedAttachment || isUploadingAttachment || uploadError) && (
                      <div className="attachment-staging-bar">
                        {isUploadingAttachment && (
                          <div className="staging-loading">
                            <span className="staging-spinner">⏳</span>
                            <span>Завантаження вкладення...</span>
                          </div>
                        )}
                        {uploadError && (
                          <div className="staging-error">
                            <span>⚠️ {uploadError}</span>
                            <button
                              type="button"
                              className="staging-clear-btn"
                              onClick={handleCancelAttachment}
                              title="Закрити"
                            >
                              ✕
                            </button>
                          </div>
                        )}
                        {stagedAttachment && !isUploadingAttachment && (
                          <div className="staging-preview">
                            {stagedAttachment.type === 'image' ? (
                              <div className="staging-thumb-wrap">
                                <img
                                  src={stagedAttachment.url}
                                  alt={stagedAttachment.name}
                                  className="staging-thumb"
                                />
                              </div>
                            ) : (
                              <div className="staging-icon">
                                {stagedAttachment.type === 'audio'
                                  ? '🎵'
                                  : stagedAttachment.type === 'video'
                                    ? '🎥'
                                    : '📄'}
                              </div>
                            )}
                            <div className="staging-info">
                              <span className="staging-name" title={stagedAttachment.name}>
                                {stagedAttachment.name}
                              </span>
                              <span className="staging-size">
                                {formatFileSize(stagedAttachment.size)}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="staging-remove-btn"
                              onClick={handleCancelAttachment}
                              title="Видалити вкладення"
                              aria-label="Видалити вкладення"
                            >
                              ✕
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {/* Плашка помилки голосового запису/надсилання */}
                    {voiceError && (
                      <div className="voice-error" role="alert">
                        <span>🎤 {voiceError}</span>
                        <button
                          type="button"
                          className="staging-clear-btn"
                          onClick={() => setVoiceError(null)}
                          title="Закрити"
                          aria-label="Закрити"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    {isRecording ? (
                      /* Панель запису замінює поле вводу, поки йде запис */
                      <VoiceRecordingBar
                        recorder={recorderRef.current}
                        onSend={handleVoiceSend}
                        onCancel={handleVoiceCancel}
                      />
                    ) : (
                      <>
                        {/* Рядок-підказка режиму редагування */}
                        {editingMessageId && (
                          <div className="edit-mode-bar">
                            <span>✏️ Редагування — Enter, щоб зберегти</span>
                            <button
                              type="button"
                              className="staging-clear-btn"
                              onClick={cancelEditMessage}
                              title="Скасувати редагування"
                              aria-label="Скасувати редагування"
                            >
                              ✕
                            </button>
                          </div>
                        )}
                        <form className="chat-input-bar" onSubmit={handleSendMessage}>
                        <input
                          ref={fileInputRef}
                          type="file"
                          style={{ display: 'none' }}
                          onChange={handleFileSelect}
                        />
                        <button
                          type="button"
                          className="attach-btn"
                          title="Прикріпити медіа або файл"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isUploadingAttachment || Boolean(editingMessageId)}
                        >
                          📎
                        </button>
                        <button
                          type="button"
                          className="mic-btn"
                          title="Голосове повідомлення"
                          aria-label="Записати голосове повідомлення"
                          onClick={handleMicClick}
                          disabled={isSendingVoice || Boolean(editingMessageId)}
                        >
                          🎤
                        </button>
                        <input
                          type="text"
                          placeholder={
                            editingMessageId
                              ? 'Редагуєте повідомлення...'
                              : stagedAttachment
                                ? 'Додайте підпис або надішліть...'
                                : 'Напишіть повідомлення...'
                          }
                          value={inputText}
                          onChange={handleInputChange}
                          autoFocus
                        />
                        <button
                          type="submit"
                          className="send-btn"
                          disabled={(!inputText.trim() && !stagedAttachment) || isUploadingAttachment}
                          title="Надіслати"
                        >
                          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                          </svg>
                        </button>
                        </form>
                      </>
                    )}
                  </>
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

      {/* ПЕРЕГЛЯД ЗОБРАЖЕНЬ (LIGHTBOX) */}
      {lightboxImage && (
        <div className="lightbox-overlay" onClick={() => setLightboxImage(null)}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="lightbox-close-btn"
              onClick={() => setLightboxImage(null)}
              title="Закрити (Esc)"
              aria-label="Закрити"
            >
              ✕
            </button>
            <img src={lightboxImage} alt="Перегляд фото" className="lightbox-img" />
            <div className="lightbox-actions">
              <a
                href={lightboxImage}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="lightbox-download-link"
              >
                ⬇ Завантажити оригінал
              </a>
            </div>
          </div>
        </div>
      )}
      {/* КОНТЕКСТНЕ МЕНЮ ПОВІДОМЛЕННЯ (right-click) */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu(null);
          }}
        >
          <div className="context-menu-actions">
            {REACTION_EMOJIS.map((emoji) => {
              const isMine = Boolean(
                contextMenu.msg.reactions?.[emoji]?.userIds?.includes(user.id),
              );
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`context-menu-reaction ${isMine ? 'is-mine' : ''}`}
                  onClick={() => handleMenuAction('react', emoji)}
                  title={isMine ? 'Прибрати реакцію' : 'Поставити реакцію'}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
          <button type="button" className="context-menu-item" onClick={() => handleMenuAction('copy')}>
            📋 Копіювати
          </button>
          {isMessageMine(contextMenu.msg) && contextMenu.msg.body?.trim() && (
            <button
              type="button"
              className="context-menu-item"
              onClick={() => handleMenuAction('edit')}
            >
              ✏️ Редагувати
            </button>
          )}
          {isMessageMine(contextMenu.msg) && (
            <button
              type="button"
              className="context-menu-item is-danger"
              onClick={() => handleMenuAction('delete')}
            >
              🗑 Видалити
            </button>
          )}
        </div>
      )}
    </div>
  );
}
