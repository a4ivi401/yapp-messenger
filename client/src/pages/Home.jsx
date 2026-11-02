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
import Logo from '../components/Logo.jsx';

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

// Градієнти Telegram-стилю для міні-аватарів у реакціях та списку
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #f97316, #ea580c)', // orange
  'linear-gradient(135deg, #06b6d4, #0891b2)', // cyan
  'linear-gradient(135deg, #10b981, #059669)', // emerald
  'linear-gradient(135deg, #8b5cf6, #7c3aed)', // purple
  'linear-gradient(135deg, #ec4899, #db2777)', // pink
  'linear-gradient(135deg, #3b82f6, #2563eb)', // blue
  'linear-gradient(135deg, #eab308, #ca8a04)', // amber
  'linear-gradient(135deg, #14b8a6, #0d9488)', // teal
];

function getAvatarGradient(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_GRADIENTS.length;
  return AVATAR_GRADIENTS[index];
}

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
  const { user, logout, updateUser } = useAuth();

  // Список реальних діалогів
  const [conversations, setConversations] = useState([]);
  const [contactsCount, setContactsCount] = useState(0);
  const [matchesCount, setMatchesCount] = useState(0);

  // Активний чат: null | { id, type: 'direct' | 'stranger', title, otherUser, status }
  const [activeChat, setActiveChat] = useState(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  // Редагування власного профілю (день 12)
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editBio, setEditBio] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const avatarFileInputRef = useRef(null);

  // Перегляд профілю співрозмовника (день 12)
  const [viewingPartnerId, setViewingPartnerId] = useState(null);
  const [partnerProfileData, setPartnerProfileData] = useState(null);
  const [isLoadingPartnerProfile, setIsLoadingPartnerProfile] = useState(false);
  const [partnerProfileError, setPartnerProfileError] = useState(null);

  // Пошук
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  // Повідомлення відкритого чату
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  // Підсвітка повідомлення, до якого перейшли зі пошуку
  const [highlightMessageId, setHighlightMessageId] = useState(null);

  // Контекстне меню повідомлення: { msg, x, y } | null. Позиція вже обрізана до вікна.
  const [contextMenu, setContextMenu] = useState(null);
  // Режим редагування: id повідомлення, що редагується (null = звичайне надсилання)
  const [editingMessageId, setEditingMessageId] = useState(null);
  const editingMessageIdRef = useRef(null);

  // Режим відповіді (reply) та свайп повідомлень
  const [replyingTo, setReplyingTo] = useState(null);
  const [swipingMessage, setSwipingMessage] = useState(null); // { id, offset }
  const swipingMessageRef = useRef(null);
  swipingMessageRef.current = swipingMessage;
  const [deleteMessageTarget, setDeleteMessageTarget] = useState(null);
  const [deleteConversationTarget, setDeleteConversationTarget] = useState(null);
  const textInputRef = useRef(null);
  const touchStateRef = useRef({
    startX: 0,
    startY: 0,
    msgId: null,
    isSwiping: false,
    timer: null,
    hapticFired: false,
  });

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

  // Модальне вікно скарги / блокування (день 11)
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [reportReason, setReportReason] = useState('spam');
  const [reportDetails, setReportDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportError, setReportError] = useState(null);
  const [rateLimitNotice, setRateLimitNotice] = useState(null);
  const rateLimitNoticeTimerRef = useRef(null);

  const showRateLimitNotice = useCallback((msg) => {
    if (!msg) return;
    setRateLimitNotice(msg);
    clearTimeout(rateLimitNoticeTimerRef.current);
    rateLimitNoticeTimerRef.current = setTimeout(() => {
      setRateLimitNotice(null);
    }, 4500);
  }, []);

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

  // Перехід до повідомлення зі пошуку: очікуваний id (поки сторінка не завантажена)
  // та таймер скидання підсвітки
  const pendingFocusRef = useRef(null);
  const highlightTimerRef = useRef(null);

  // Таймери «друкує…». Refs, а не state: вони не впливають на рендер.
  const typingStopTimerRef = useRef(null);
  const typingHideTimerRef = useRef(null);
  const typingSentAtRef = useRef(0); // 0 = сигнал «друкую» зараз не активний

  // Автоскрол до останнього повідомлення
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Перехід до знайденого зі пошуку повідомлення: чекаємо, поки ціль опиниться в
  // завантаженій сторінці, потім скрол up-center + підсвітка. Мусить іти після
  // автоскролу (вище), щоб перехід до цілі виграв у черзі плавних скролів.
  useEffect(() => {
    const targetId = pendingFocusRef.current;
    if (!targetId || isLoadingMessages || !messages.some((m) => m.id === targetId)) {
      return undefined;
    }
    pendingFocusRef.current = null;
    scrollAndHighlight(targetId);
    return undefined;
  }, [messages, isLoadingMessages]);

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
    setReplyingTo(null);
    if (editingMessageIdRef.current) {
      setEditingMessageId(null);
      editingMessageIdRef.current = null;
      // Скидання перед першим рендером нового чата — inputText чиститься вручну нижче
      setInputText('');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [activeChat?.id]);

  // Закриття контекстного меню та модальних вікон: Esc, клік будь-де, скрол чата.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (contextMenu) setContextMenu(null);
        if (replyingTo) setReplyingTo(null);
        if (deleteMessageTarget) setDeleteMessageTarget(null);
        if (deleteConversationTarget) setDeleteConversationTarget(null);
      }
    };
    const onMouseDown = () => {
      if (contextMenu) setContextMenu(null);
    };
    const onScroll = () => {
      if (contextMenu) setContextMenu(null);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('wheel', onScroll, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('wheel', onScroll);
    };
  }, [contextMenu, replyingTo, deleteMessageTarget, deleteConversationTarget]);

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

  // Скрол до повідомлення (у центр вікна) + підсвітка на кілька секунд.
  // Повертає false, якщо елемента немає у DOM (цільова ще не завантажена).
  const scrollAndHighlight = useCallback((messageId) => {
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightMessageId(messageId);
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightMessageId(null), 2600);
    return true;
  }, []);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Відкриття прямого діалогу. focusMessageId — перейти до конкретного повідомлення
  // зі пошуку: історію завантажуємо вікном навколо нього (`?around=...`)
  const openDirectConversation = useCallback(
    (conv, focusMessageId = null) => {
      const prevChat = activeChatRef.current;
      if (prevChat?.id === conv.id) {
        if (!focusMessageId) return;
        // Той самий чат уже відкритий: підсвічуємо ціль, якщо вона вже у вікні
        // (messagesRef — свіжий стан без перестворення колбека), інакше
        // перечитуємо історію навколо неї — ціль старіша за завантажене вікно.
        if (!scrollAndHighlight(focusMessageId)) {
          pendingFocusRef.current = focusMessageId;
          setIsLoadingMessages(true);
          api
            .listMessages(conv.id, { around: focusMessageId })
            .then((res) => setMessages(res.messages || []))
            .catch((err) => {
              console.error('Failed to load messages:', err);
              pendingFocusRef.current = null;
            })
            .finally(() => setIsLoadingMessages(false));
        }
        return;
      }

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
        title: conv.otherUser?.displayName || `@${conv.otherUser.username}`,
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
      // З цільовим повідомленням (пошук → чат): вікно навколо нього замість
      // найсвіжішої сторінки, щоб ціль гарантовано була в списку. Фолбек на
      // звичайну сторінку захищає від недоступної цілі (видалено без tombstone).
      if (focusMessageId) pendingFocusRef.current = focusMessageId;
      const initialLoad = focusMessageId
        ? api
            .listMessages(conv.id, { around: focusMessageId })
            .catch(() => api.listMessages(conv.id))
        : api.listMessages(conv.id);

      initialLoad
        .then((res) => {
          setMessages(res.messages || []);
          // Фолбек-сторінка може не містити цілі (наприклад, tombstone пішов
          // із БД) — тоді очікування фокусу знімаємо, скрол не чекає вічно.
          if (focusMessageId && !(res.messages || []).some((m) => m.id === focusMessageId)) {
            pendingFocusRef.current = null;
          }
        })
        .catch((err) => {
          console.error('Failed to load messages:', err);
          pendingFocusRef.current = null;
        })
        .finally(() => {
          setIsLoadingMessages(false);
        });

      if (socketRef.current) {
        socketRef.current.emit('conversation:join', { conversationId: conv.id });
      }
    },
    [stopTyping, scrollAndHighlight],
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

    socket.on('conversation:deleted', ({ conversationId }) => {
      if (!conversationId) return;
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeChatRef.current?.id === conversationId) {
        setActiveChat(null);
      }
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
        reason === 'blocked'
          ? 'Співрозмовник заблокував цей діалог.'
          : reason === 'next'
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
        prev && prev.type === 'stranger'
          ? { ...prev, status: reason === 'blocked' ? 'заблоковано' : 'розмову завершено' }
          : prev,
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

    // Оновлення профілю користувача в реальному часі (день 12)
    socket.on('user:updated', ({ user: updatedUser }) => {
      if (!updatedUser) return;
      if (updatedUser.id === user.id) {
        updateUser(updatedUser);
      }
      setConversations((prev) =>
        prev.map((c) =>
          c.otherUser?.id === updatedUser.id
            ? {
                ...c,
                otherUser: {
                  ...c.otherUser,
                  username: updatedUser.username,
                  displayName: updatedUser.displayName,
                  avatarUrl: updatedUser.avatarUrl,
                },
              }
            : c,
        ),
      );
      setActiveChat((prev) => {
        if (prev?.otherUser?.id === updatedUser.id) {
          return {
            ...prev,
            title: updatedUser.displayName || `@${updatedUser.username}`,
            otherUser: {
              ...prev.otherUser,
              username: updatedUser.username,
              displayName: updatedUser.displayName,
              avatarUrl: updatedUser.avatarUrl,
            },
          };
        }
        return prev;
      });
      setPartnerProfileData((prev) =>
        prev?.id === updatedUser.id
          ? {
              ...prev,
              username: updatedUser.username,
              displayName: updatedUser.displayName,
              avatarUrl: updatedUser.avatarUrl,
            }
          : prev,
      );
    });

    return () => {
      socket.disconnect();
    };
  }, [user.id, openDirectConversation, loadInitialData, markActiveChatRead, stopTyping, syncPresence, updateUser]);

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
            (c.username || '').toLowerCase().includes(clean.toLowerCase()) ||
            (c.displayName || '').toLowerCase().includes(clean.toLowerCase()),
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

  // Клік по результату пошуку в повідомленнях: відкрити той діалог, прокрутити
  // до знайденого повідомлення і підсвітити його
  const openFromMessageResult = async (item) => {
    const convId = item.message.conversationId;
    const focusId = item.message.id;
    const existing = conversations.find((c) => c.id === convId);
    if (existing) {
      openDirectConversation(existing, focusId);
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
        openDirectConversation(res.conversation, focusId);
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
  const dispatchMessage = async (text, attachment, replyToId = null) => {
    if (!activeChat) return;
    stopTyping();

    if (activeChat.type === 'stranger') {
      const sessionId = strangerSessionRef.current?.sessionId || activeChat.id;
      if (socketRef.current?.connected) {
        socketRef.current.emit(
          'stranger:message',
          { sessionId, body: text, attachment, replyToId },
          (res) => {
            if (!res?.ok) {
              console.error('Failed to send stranger message:', res?.error);
              if (res?.error && res.error.includes('Забагато')) {
                showRateLimitNotice(res.error);
              }
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
        { conversationId: activeChat.id, body: text, attachment, replyToId },
        (res) => {
          if (!res?.ok) {
            console.error('Failed to send message via socket:', res?.error);
            if (res?.error && (res.error.includes('Забагато') || res.error.includes('заблоковано'))) {
              showRateLimitNotice(res.error);
            } else {
              // Фолбек на REST у разі помилки сокета
              api.sendMessage(activeChat.id, { body: text, attachment, replyToId }).catch(console.error);
            }
          }
        },
      );
    } else {
      // Фолбек на REST, якщо сокет тимчасово від'єднано
      try {
        await api.sendMessage(activeChat.id, { body: text, attachment, replyToId });
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

    const replyToId = replyingTo?.id || null;
    setReplyingTo(null);
    setInputText('');
    setStagedAttachment(null);
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    dispatchMessage(text, attachment, replyToId);
  };

  // ============ Контекстне меню, реакції, редагування/видалення (день 10) ============

  // Відкриття контекстного меню з обчисленням координат у межах вікна
  const openMessageContextMenu = (clientX, clientY, msg) => {
    if (msg.type === 'system' || msg.deleted) return;
    const CONTEXT_MENU_W = 220;
    const CONTEXT_MENU_H = 220;
    const pad = 12;

    const x = Math.max(
      pad,
      Math.min(clientX - CONTEXT_MENU_W / 2, window.innerWidth - CONTEXT_MENU_W - pad),
    );
    const y = Math.max(
      pad,
      Math.min(clientY - 50, window.innerHeight - CONTEXT_MENU_H - pad),
    );
    setContextMenu({ msg, x, y });
  };

  const handleOpenContextMenu = (e, msg) => {
    if (msg.type === 'system' || msg.deleted) return; // tombstone та системні — без дій
    e.preventDefault();
    openMessageContextMenu(e.clientX, e.clientY, msg);
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleStartReply = (msg) => {
    if (!msg || msg.deleted || msg.type === 'system') return;
    if (editingMessageIdRef.current) cancelEditMessage();
    setReplyingTo(msg);
    setTimeout(() => {
      textInputRef.current?.focus();
    }, 50);
  };

  const handleJumpToMessage = (targetMessageId) => {
    if (!targetMessageId) return;
    if (!scrollAndHighlight(targetMessageId)) {
      if (activeChat?.type === 'direct') {
        openDirectConversation(activeChat, targetMessageId);
      }
    }
  };

  // Тач-жести на повідомленнях: затискання (меню) та свайп вліво (відповідь)
  const handleMessageTouchStart = (e, msg) => {
    if (msg.type === 'system' || msg.deleted) return;
    const touch = e.touches[0];
    const state = touchStateRef.current;
    if (state.timer) clearTimeout(state.timer);

    state.startX = touch.clientX;
    state.startY = touch.clientY;
    state.msgId = msg.id;
    state.isSwiping = false;
    state.hapticFired = false;

    state.timer = setTimeout(() => {
      if (state.isSwiping) return;
      if (navigator.vibrate) navigator.vibrate(40);
      openMessageContextMenu(state.startX, state.startY, msg);
      state.timer = null;
    }, 450);
  };

  const handleMessageTouchMove = (e, msg) => {
    const state = touchStateRef.current;
    if (state.msgId !== msg.id) return;

    const touch = e.touches[0];
    const diffX = touch.clientX - state.startX;
    const diffY = touch.clientY - state.startY;

    if (Math.hypot(diffX, diffY) > 10 && state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (diffX < -10 && Math.abs(diffX) > Math.abs(diffY)) {
      state.isSwiping = true;
      const offset = Math.max(-75, diffX);
      setSwipingMessage({ id: msg.id, offset });

      if (offset <= -50 && !state.hapticFired) {
        state.hapticFired = true;
        if (navigator.vibrate) navigator.vibrate(25);
      }
    } else if (state.isSwiping && diffX >= 0) {
      setSwipingMessage(null);
    }
  };

  const handleMessageTouchEnd = (e, msg) => {
    const state = touchStateRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (state.msgId === msg.id && state.isSwiping) {
      if (swipingMessageRef.current?.id === msg.id && swipingMessageRef.current.offset <= -50) {
        handleStartReply(msg);
      }
    }

    state.msgId = null;
    state.isSwiping = false;
    state.hapticFired = false;
    setSwipingMessage(null);
  };

  const handleMessageTouchCancel = () => {
    const state = touchStateRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.msgId = null;
    state.isSwiping = false;
    state.hapticFired = false;
    setSwipingMessage(null);
  };

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

  // Отримуємо дані для відображення аватара користувача в реакції
  const getReactionUserInfo = useCallback(
    (uid) => {
      const isMe = uid === user.id;

      if (activeChat?.type === 'stranger') {
        if (isMe) {
          return {
            isAnon: true,
            content: strangerSession?.myAnon?.anonAvatar || '🎭',
            title: 'Ви',
          };
        }
        return {
          isAnon: true,
          content: strangerSession?.partner?.anonAvatar || '🎲',
          title: strangerSession?.partner?.anonName || 'Співрозмовник',
        };
      }

      // Прямий діалог (direct chat)
      let username = '';
      if (isMe) {
        username = user.username;
      } else if (activeChat?.otherUser?.id === uid) {
        username = activeChat.otherUser.username;
      } else {
        const conv = conversations.find((c) => c.otherUser?.id === uid);
        username = conv?.otherUser?.username || '';
      }

      const initial = username ? username.slice(0, 1).toUpperCase() : '👤';
      return {
        isAnon: false,
        content: initial,
        title: isMe ? 'Ви' : username ? `@${username}` : 'Співрозмовник',
        gradient: getAvatarGradient(username || uid),
      };
    },
    [user.id, user.username, activeChat, strangerSession, conversations],
  );

  // Підказка (tooltip) реакції українською
  const formatReactionTitle = useCallback(
    (emoji, userIds, isMine) => {
      if (activeChat?.type === 'stranger') {
        if (userIds.length > 1) {
          return `${emoji} · Ви та співрозмовник (${isMine ? 'натисніть, щоб прибрати свою' : 'натисніть, щоб додати'})`;
        }
        if (isMine) {
          return `${emoji} · Ваша реакція (натисніть, щоб прибрати)`;
        }
        return `${emoji} · Реакція співрозмовника (натисніть, щоб поставити таку саму)`;
      }

      const names = userIds.map((uid) => {
        if (uid === user.id) return 'Ви';
        if (activeChat?.otherUser?.id === uid) return `@${activeChat.otherUser.username}`;
        const conv = conversations.find((c) => c.otherUser?.id === uid);
        return conv?.otherUser?.username ? `@${conv.otherUser.username}` : 'Співрозмовник';
      });

      const joinedNames = names.join(', ');
      const action = isMine ? 'натисніть, щоб прибрати' : 'натисніть, щоб поставити таку саму';
      return `${emoji} · ${joinedNames} (${action})`;
    },
    [user.id, activeChat, conversations],
  );

  // Дія з меню: реакція / відповідь / копіювання / редагування / видалення
  const handleMenuAction = (action, emoji) => {
    if (!contextMenu) return;
    const msg = contextMenu.msg;
    closeContextMenu();

    if (action === 'react') {
      dispatchToggleReaction(msg, emoji, Boolean(msg.reactions?.[emoji]?.userIds?.includes(user.id)));
      return;
    }

    if (action === 'reply') {
      handleStartReply(msg);
      return;
    }

    if (action === 'copy') {
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
      setDeleteMessageTarget(msg);
    }
  };

  // Підтверджене видалення повідомлення
  const handleDeleteMessageConfirmed = () => {
    if (!deleteMessageTarget) return;
    const msg = deleteMessageTarget;
    setDeleteMessageTarget(null);
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
  };

  // Підтверджене видалення діалогу
  const handleDeleteConversationConfirmed = async () => {
    if (!deleteConversationTarget) return;
    const convId = deleteConversationTarget.id;
    setDeleteConversationTarget(null);
    try {
      await api.deleteConversation(convId);
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (activeChat?.id === convId) {
        setActiveChat(null);
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      alert(err.message || 'Не вдалося видалити діалог');
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
        const replyToId = replyingTo?.id || null;
        setReplyingTo(null);
        dispatchMessage('', res.attachment, replyToId);
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
          if (res?.error) showRateLimitNotice(res.error);
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
          if (res?.error) showRateLimitNotice(res.error);
        }
      });
    }
  };

  // Надсилання скарги на співрозмовника
  const handleSubmitReport = (e) => {
    e.preventDefault();
    const sessionId = strangerSessionRef.current?.sessionId || activeChat?.id;
    if (!sessionId || !socketRef.current?.connected) return;

    setIsSubmittingReport(true);
    setReportError(null);

    socketRef.current.emit(
      'stranger:report',
      {
        sessionId,
        reason: reportReason,
        details: reportDetails.trim(),
        block: alsoBlock,
      },
      (res) => {
        setIsSubmittingReport(false);
        if (res?.ok) {
          setIsReportModalOpen(false);
          setStrangerState('ended');
          setStrangerEndReason('blocked');
          setMessages((prev) => [
            ...prev,
            {
              id: `sys-report-${Date.now()}`,
              type: 'system',
              body: alsoBlock
                ? '🛡️ Скаргу надіслано. Співрозмовника заблоковано — ви більше не зустрінетесь.'
                : '🛡️ Скаргу надіслано модераторам. Дякуємо за допомогу!',
              createdAt: new Date().toISOString(),
            },
          ]);
          setActiveChat((prev) =>
            prev && prev.type === 'stranger'
              ? { ...prev, status: alsoBlock ? 'заблоковано' : 'розмову завершено' }
              : prev,
          );
        } else {
          setReportError(res?.error || 'Не вдалося надіслати скаргу');
        }
      },
    );
  };

  // Швидке блокування без скарги
  const handleQuickBlock = () => {
    const sessionId = strangerSessionRef.current?.sessionId || activeChat?.id;
    if (!sessionId || !socketRef.current?.connected) return;

    setIsSubmittingReport(true);
    setReportError(null);

    socketRef.current.emit('stranger:block', { sessionId }, (res) => {
      setIsSubmittingReport(false);
      if (res?.ok) {
        setIsReportModalOpen(false);
        setStrangerState('ended');
        setStrangerEndReason('blocked');
        setMessages((prev) => [
          ...prev,
          {
            id: `sys-block-${Date.now()}`,
            type: 'system',
            body: '🚫 Співрозмовника заблоковано. Ви більше не зустрінетесь у чаті.',
            createdAt: new Date().toISOString(),
          },
        ]);
        setActiveChat((prev) =>
          prev && prev.type === 'stranger' ? { ...prev, status: 'заблоковано' } : prev,
        );
      } else {
        setReportError(res?.error || 'Не вдалося заблокувати співрозмовника');
      }
    });
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

  // ── Керування профілем (день 12) ───────────────────────────────────────────

  const handleStartEditingProfile = () => {
    setEditDisplayName(user.displayName || '');
    setEditUsername(user.username || '');
    setEditBio(user.bio || '');
    setProfileError(null);
    setIsEditingProfile(true);
  };

  const handleSaveProfile = async (e) => {
    e?.preventDefault();
    setIsSavingProfile(true);
    setProfileError(null);
    try {
      const res = await api.updateProfile({
        displayName: editDisplayName.trim() || null,
        username: editUsername.trim(),
        bio: editBio.trim() || null,
      });
      if (res.user) {
        updateUser(res.user);
        setIsEditingProfile(false);
      }
    } catch (err) {
      setProfileError(err.message || 'Не вдалося зберегти профіль');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleAvatarFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setProfileError('Будь ласка, оберіть файл зображення (JPEG, PNG, WebP тощо)');
      return;
    }
    setIsUploadingAvatar(true);
    setProfileError(null);
    try {
      const uploadRes = await api.uploadFile(file);
      if (uploadRes?.attachment?.url) {
        const updateRes = await api.updateProfile({ avatarUrl: uploadRes.attachment.url });
        if (updateRes.user) {
          updateUser(updateRes.user);
        }
      }
    } catch (err) {
      setProfileError(err.message || 'Помилка завантаження фото');
    } finally {
      setIsUploadingAvatar(false);
      if (avatarFileInputRef.current) avatarFileInputRef.current.value = '';
    }
  };

  const handleRemoveAvatar = async () => {
    setIsUploadingAvatar(true);
    setProfileError(null);
    try {
      const updateRes = await api.updateProfile({ avatarUrl: null });
      if (updateRes.user) {
        updateUser(updateRes.user);
      }
    } catch (err) {
      setProfileError(err.message || 'Помилка видалення фото');
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleOpenPartnerProfile = async (targetUserId) => {
    if (!targetUserId) return;
    setViewingPartnerId(targetUserId);
    setIsLoadingPartnerProfile(true);
    setPartnerProfileError(null);
    try {
      const res = await api.getProfile(targetUserId);
      setPartnerProfileData(res.user);
      if (res.user) {
        syncPresence([res.user]);
      }
    } catch (err) {
      setPartnerProfileError(err.message || 'Не вдалося завантажити профіль');
    } finally {
      setIsLoadingPartnerProfile(false);
    }
  };

  const handleAddContactFromProfile = async (partnerId) => {
    try {
      const res = await api.addContact({ userId: partnerId });
      if (res.contact) {
        setPartnerProfileData((prev) => (prev ? { ...prev, isContact: true } : prev));
        setContactsCount((prev) => prev + 1);
      }
    } catch (err) {
      console.error('Failed to add contact from profile:', err);
    }
  };

  const handleStartChatWithPartner = async (partnerUser) => {
    setViewingPartnerId(null);
    const existing = conversations.find((c) => c.otherUser?.id === partnerUser.id);
    if (existing) {
      openDirectConversation(existing);
      return;
    }
    try {
      const res = await api.createConversation(partnerUser.username);
      if (res.conversation) {
        setConversations((prev) => {
          if (prev.some((c) => c.id === res.conversation.id)) return prev;
          return [res.conversation, ...prev];
        });
        openDirectConversation(res.conversation);
      }
    } catch (err) {
      console.error('Failed to start chat from profile:', err);
    }
  };

  // Фільтрація існуючих діалогів при пошуку
  const trimmedSearch = searchQuery.trim();
  const cleanSearch = trimmedSearch.replace(/^@+/, '').toLowerCase();
  const filteredConversations = cleanSearch
    ? conversations.filter((c) => {
        const usernameMatch = c.otherUser?.username?.toLowerCase().includes(cleanSearch);
        const displayNameMatch = c.otherUser?.displayName?.toLowerCase().includes(cleanSearch);
        const lastMsgMatch =
          c.lastMessage?.body?.toLowerCase().includes(trimmedSearch.toLowerCase()) ||
          c.lastMessage?.attachment?.name?.toLowerCase().includes(trimmedSearch.toLowerCase());
        return usernameMatch || displayNameMatch || lastMsgMatch;
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
            onClick={() => {
              setIsEditingProfile(false);
              setProfileError(null);
              setIsProfileOpen(true);
            }}
            title="Меню та профіль"
            aria-label="Меню"
          >
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="menu-btn-avatar" />
            ) : (
              '☰'
            )}
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
                    const initials = (conv.otherUser?.displayName || conv.otherUser?.username || '')
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
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDeleteConversationTarget(conv);
                        }}
                      >
                        <div className="chat-row-avatar">
                          {conv.otherUser?.avatarUrl ? (
                            <img src={conv.otherUser.avatarUrl} alt="" className="avatar-img" />
                          ) : (
                            initials
                          )}
                          {presenceOf(conv.otherUser, presence).isOnline && (
                            <span className="presence-dot" aria-label="У мережі" />
                          )}
                        </div>
                        <div className="chat-row-body">
                          <div className="chat-row-line1">
                            <div className="chat-row-title-wrap">
                              <span className="chat-row-name">
                                {conv.otherUser?.displayName || `@${conv.otherUser?.username}`}
                              </span>
                              {conv.otherUser?.displayName && (
                                <span className="chat-row-subname">@{conv.otherUser.username}</span>
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
                    const initials = (contact.displayName || contact.username || '').slice(0, 2).toUpperCase();
                    const isActive = activeChat?.otherUser?.id === contact.id;
                    return (
                      <div
                        key={contact.id}
                        className={`chat-row ${isActive ? 'active' : ''}`}
                        onClick={() => openFromContactResult(contact)}
                        style={{ cursor: 'pointer' }}
                      >
                        <div className="chat-row-avatar">
                          {contact.avatarUrl ? (
                            <img src={contact.avatarUrl} alt="" className="avatar-img" />
                          ) : (
                            initials
                          )}
                          {presenceOf(contact, presence).isOnline && (
                            <span className="presence-dot" aria-label="У мережі" />
                          )}
                        </div>
                        <div className="chat-row-body">
                          <div className="chat-row-line1">
                            <div className="chat-row-title-wrap">
                              <span className="chat-row-name">
                                {contact.displayName || `@${contact.username}`}
                              </span>
                              {contact.displayName && (
                                <span className="chat-row-subname">@{contact.username}</span>
                              )}
                            </div>
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
                  const initials = (targetUser.displayName || targetUser.username || '')
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
                        {targetUser.avatarUrl ? (
                          <img src={targetUser.avatarUrl} alt="" className="avatar-img" />
                        ) : (
                          initials
                        )}
                        {presenceOf(targetUser, presence).isOnline && (
                          <span className="presence-dot" aria-label="У мережі" />
                        )}
                      </div>
                      <div className="chat-row-body">
                        <div className="chat-row-line1">
                          <div className="chat-row-title-wrap">
                            <span className="chat-row-name">
                              {targetUser.displayName || `@${targetUser.username}`}
                            </span>
                            {targetUser.displayName && (
                              <span className="chat-row-subname">@{targetUser.username}</span>
                            )}
                          </div>
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
                  <div className="search-empty-state">
                    <span className="search-empty-icon">🔍</span>
                    <p>
                      {!cleanSearch ? (
                        'Введіть імʼя або нікнейм після символу @ для пошуку.'
                      ) : cleanSearch === user?.username?.toLowerCase() ? (
                        `Це ваш власний акаунт (@${user.username}). Пошук знаходить інших користувачів.`
                      ) : (
                        `Нічого не знайдено за запитом «${searchQuery.trim()}».`
                      )}
                    </p>
                    <span className="search-empty-subtext">
                      Перевірте правильність написання нікнейму чи імені
                    </span>
                  </div>
                )
              )}
            </>
          ) : (
            /* Звичайний режим: список діалогів із бази даних */
            <>
              {conversations.length === 0 ? (
                <div className="empty-state-card">
                  <div className="empty-state-icon">💬</div>
                  <h4>У вас поки немає діалогів</h4>
                  <p>
                    Знаходьте співрозмовників через пошук за нікнеймом або спробуйте анонімну рулетку!
                  </p>
                  <button
                    type="button"
                    className="empty-state-action-btn"
                    onClick={startStrangerSearch}
                  >
                    🎲 Знайти співрозмовника
                  </button>
                </div>
              ) : (
                conversations.map((conv) => {
                  const isActive = activeChat?.id === conv.id;
                  const unread = unreadCounts[conv.id] || 0;
                  const initials = (conv.otherUser.displayName || conv.otherUser.username || '')
                    .slice(0, 2)
                    .toUpperCase();
                  return (
                    <button
                      key={conv.id}
                      className={`chat-row ${isActive ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}`}
                      onClick={() => openDirectConversation(conv)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDeleteConversationTarget(conv);
                      }}
                    >
                      <div className="chat-row-avatar">
                        {conv.otherUser.avatarUrl ? (
                          <img src={conv.otherUser.avatarUrl} alt="" className="avatar-img" />
                        ) : (
                          initials
                        )}
                        {presenceOf(conv.otherUser, presence).isOnline && (
                          <span className="presence-dot" aria-label="У мережі" />
                        )}
                      </div>
                      <div className="chat-row-body">
                        <div className="chat-row-line1">
                          <div className="chat-row-title-wrap">
                            <span className="chat-row-name">
                              {conv.otherUser.displayName || `@${conv.otherUser.username}`}
                            </span>
                            {conv.otherUser.displayName && (
                              <span className="chat-row-subname">@{conv.otherUser.username}</span>
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
              <div
                className={`chat-target-info-wrap ${activeChat.type === 'direct' ? 'is-clickable' : ''}`}
                onClick={() => {
                  if (activeChat.type === 'direct' && activeChat.otherUser?.id) {
                    handleOpenPartnerProfile(activeChat.otherUser.id);
                  }
                }}
                title={activeChat.type === 'direct' ? 'Переглянути профіль співрозмовника' : ''}
              >
                <div className="chat-target-avatar">
                  {activeChat.type === 'stranger' ? (
                    strangerSession?.partner?.anonAvatar || '🎲'
                  ) : activeChat.otherUser?.avatarUrl ? (
                    <img src={activeChat.otherUser.avatarUrl} alt="" className="avatar-img" />
                  ) : (
                    (activeChat.otherUser?.displayName || activeChat.otherUser?.username || '').slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="chat-target-meta">
                  <h2>
                    <span className="chat-target-name">{activeChat.title}</span>
                    {activeChat.type === 'direct' && activeChat.otherUser?.displayName && (
                      <span className="chat-target-subusername">@{activeChat.otherUser.username}</span>
                    )}
                  </h2>
                  <span
                    className={`chat-target-status ${partnerTyping ? 'is-typing' : ''} ${
                      headerIsOffline ? 'is-offline' : ''
                    }`}
                  >
                    {partnerTyping ? 'друкує…' : headerStatus}
                  </span>
                </div>
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
                {activeChat.type === 'stranger' && (strangerState === 'matched' || strangerState === 'ended') && (
                  <button
                    type="button"
                    className="report-stranger-btn"
                    onClick={() => {
                      setReportError(null);
                      setIsReportModalOpen(true);
                    }}
                    title="Поскаржитися або заблокувати співрозмовника"
                    aria-label="Скарга або блок"
                  >
                    🚫 Скарга / Блок
                  </button>
                )}
                {activeChat.type === 'direct' && (
                  <button
                    type="button"
                    className="chat-header-delete-btn"
                    onClick={() => setDeleteConversationTarget(activeChat)}
                    title="Видалити діалог"
                    aria-label="Видалити діалог"
                  >
                    🗑
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
                    activeChat.type === 'direct' ? (
                      <div className="chat-empty-welcome-card">
                        <div className="chat-welcome-avatar">
                          {activeChat.otherUser?.avatarUrl ? (
                            <img src={activeChat.otherUser.avatarUrl} alt="" className="avatar-img" />
                          ) : (
                            (activeChat.otherUser?.displayName || activeChat.otherUser?.username || '').slice(0, 2).toUpperCase()
                          )}
                        </div>
                        <h3>{activeChat.otherUser?.displayName || activeChat.title}</h3>
                        <p className="chat-welcome-username">@{activeChat.otherUser?.username}</p>
                        <p className="chat-welcome-prompt">
                          Це початок вашого спілкування. Напишіть перше повідомлення або надішліть привітання! 👋
                        </p>
                      </div>
                    ) : (
                      <div className="chat-empty-hint">
                        <span className="chat-empty-icon">✍️</span>
                        <p>Почніть розмову — надішліть перше повідомлення.</p>
                      </div>
                    )
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
                      const isSwiping = swipingMessage?.id === msg.id;
                      const swipeOffset = isSwiping ? swipingMessage.offset : 0;
                      return (
                        <div
                          key={msg.id}
                          className={`message-row ${isMe ? 'message-out' : 'message-in'} ${
                            msg.id === highlightMessageId ? 'is-highlighted' : ''
                          }`}
                          data-message-id={msg.id}
                          onContextMenu={(e) => handleOpenContextMenu(e, msg)}
                          onTouchStart={(e) => handleMessageTouchStart(e, msg)}
                          onTouchMove={(e) => handleMessageTouchMove(e, msg)}
                          onTouchEnd={(e) => handleMessageTouchEnd(e, msg)}
                          onTouchCancel={(e) => handleMessageTouchCancel(e, msg)}
                        >
                          {isSwiping && (
                            <div
                              className={`message-swipe-indicator ${
                                swipeOffset <= -50 ? 'is-ready' : ''
                              }`}
                            >
                              <span>↩</span>
                            </div>
                          )}
                          <div
                            className="message-bubble"
                            style={{
                              transform: isSwiping ? `translateX(${swipeOffset}px)` : 'translateX(0)',
                              transition: isSwiping ? 'none' : 'transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1)',
                            }}
                          >
                            {msg.replyTo && (
                              <div
                                className="message-reply-quote"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleJumpToMessage(msg.replyTo.id);
                                }}
                                title="Перейти до повідомлення"
                              >
                                <div className="message-reply-quote-bar" />
                                <div className="message-reply-quote-content">
                                  <div className="message-reply-quote-author">
                                    {msg.replyTo.senderId === user.id
                                      ? 'Ви'
                                      : msg.replyTo.senderDisplayName ||
                                        msg.replyTo.senderUsername ||
                                        msg.replyTo.senderAnonName ||
                                        'Співрозмовник'}
                                  </div>
                                  <div className="message-reply-quote-text">
                                    {msg.replyTo.deleted
                                      ? 'Повідомлення видалено'
                                      : msg.replyTo.body ||
                                        (msg.replyTo.attachmentType === 'image'
                                          ? '📷 Фото'
                                          : msg.replyTo.attachmentType === 'audio'
                                            ? '🎤 Голосове'
                                            : '📎 Файл')}
                                  </div>
                                </div>
                              </div>
                            )}
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
                            <div className="message-footer">
                              {/* Капсульні чипси реакцій (стиль Telegram з аватаром) */}
                              {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                                <div className="message-reactions">
                                  {Object.entries(msg.reactions).map(
                                    ([emoji, { count, userIds }]) => {
                                      const isMine = userIds.includes(user.id);
                                      const title = formatReactionTitle(emoji, userIds, isMine);
                                      return (
                                        <button
                                          key={emoji}
                                          type="button"
                                          className={`message-reaction-chip ${isMine ? 'is-mine' : ''}`}
                                          title={title}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            dispatchToggleReaction(msg, emoji, isMine);
                                          }}
                                        >
                                          <span className="message-reaction-emoji">{emoji}</span>
                                          <span className="message-reaction-avatars">
                                            {userIds && userIds.length > 0 ? (
                                              userIds.map((uid) => {
                                                const info = getReactionUserInfo(uid);
                                                return (
                                                  <span
                                                    key={uid}
                                                    className={`message-reaction-avatar ${info.isAnon ? 'is-anon' : ''}`}
                                                    style={info.isAnon ? {} : { background: info.gradient }}
                                                    title={info.title}
                                                  >
                                                    {info.content}
                                                  </span>
                                                );
                                              })
                                            ) : (
                                              count > 1 && <span className="message-reaction-count">{count}</span>
                                            )}
                                          </span>
                                        </button>
                                      );
                                    },
                                  )}
                                </div>
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
                    {/* Плашка перевищення rate-limit або обмеження */}
                    {rateLimitNotice && (
                      <div className="rate-limit-banner" role="alert">
                        <span>⏳ {rateLimitNotice}</span>
                        <button
                          type="button"
                          className="staging-clear-btn"
                          onClick={() => setRateLimitNotice(null)}
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
                        {/* Рядок-підказка режиму відповіді */}
                        {replyingTo && (
                          <div className="reply-mode-bar">
                            <div className="reply-mode-bar-content">
                              <span className="reply-mode-bar-title">
                                ↩ Відповідь{' '}
                                <strong>
                                  {replyingTo.senderId === user.id
                                    ? 'собі'
                                    : replyingTo.senderDisplayName ||
                                      replyingTo.senderUsername ||
                                      replyingTo.senderAnonName ||
                                      'співрозмовнику'}
                                </strong>
                              </span>
                              <span className="reply-mode-bar-snippet">
                                {replyingTo.deleted
                                  ? 'Повідомлення видалено'
                                  : replyingTo.body ||
                                    (replyingTo.attachment?.type === 'image'
                                      ? '📷 Фото'
                                      : replyingTo.attachment?.type === 'audio'
                                        ? '🎤 Голосове повідомлення'
                                        : '📎 Файл')}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="staging-clear-btn"
                              onClick={() => setReplyingTo(null)}
                              title="Скасувати відповідь"
                              aria-label="Скасувати відповідь"
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
                          ref={textInputRef}
                          type="text"
                          placeholder={
                            editingMessageId
                              ? 'Редагуєте повідомлення...'
                              : replyingTo
                                ? 'Ваша відповідь...'
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
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                <Logo size={72} />
              </div>
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
              <h3>{isEditingProfile ? 'Редагування профілю' : 'Мій профіль'}</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => {
                  setIsEditingProfile(false);
                  setIsProfileOpen(false);
                }}
                title="Закрити"
              >
                ✕
              </button>
            </div>
            <div className="drawer-body">
              {profileError && (
                <div className="profile-error-banner" role="alert">
                  ⚠️ {profileError}
                </div>
              )}

              {isEditingProfile ? (
                <form onSubmit={handleSaveProfile} className="profile-edit-form">
                  <div className="profile-avatar-edit-wrap">
                    <div className="large-avatar">
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className="avatar-img" />
                      ) : (
                        (user.displayName || user.username || '?').slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div className="profile-avatar-actions">
                      <input
                        type="file"
                        ref={avatarFileInputRef}
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleAvatarFileSelect}
                      />
                      <button
                        type="button"
                        className="profile-upload-avatar-btn"
                        onClick={() => avatarFileInputRef.current?.click()}
                        disabled={isUploadingAvatar}
                      >
                        {isUploadingAvatar ? '⏳ Завантаження…' : '📷 Змінити фото'}
                      </button>
                      {user.avatarUrl && (
                        <button
                          type="button"
                          className="profile-remove-avatar-btn"
                          onClick={handleRemoveAvatar}
                          disabled={isUploadingAvatar}
                        >
                          🗑 Видалити фото
                        </button>
                      )}
                    </div>
                  </div>

                  <label className="profile-form-label">
                    <span>Відображуване імʼя:</span>
                    <input
                      type="text"
                      className="profile-input"
                      placeholder="Ваше імʼя (наприклад, Олексій)"
                      value={editDisplayName}
                      onChange={(e) => setEditDisplayName(e.target.value)}
                      maxLength={50}
                    />
                  </label>

                  <label className="profile-form-label">
                    <span>Нікнейм (@username):</span>
                    <input
                      type="text"
                      className="profile-input"
                      placeholder="username"
                      value={editUsername}
                      onChange={(e) => setEditUsername(e.target.value)}
                      maxLength={20}
                      required
                    />
                  </label>

                  <label className="profile-form-label">
                    <span>Про себе (біографія):</span>
                    <textarea
                      className="profile-textarea"
                      placeholder="Розкажіть трохи про себе…"
                      rows={3}
                      value={editBio}
                      onChange={(e) => setEditBio(e.target.value)}
                      maxLength={300}
                    />
                  </label>

                  <div className="profile-edit-actions">
                    <button
                      type="button"
                      className="profile-cancel-btn"
                      onClick={() => setIsEditingProfile(false)}
                      disabled={isSavingProfile}
                    >
                      Скасувати
                    </button>
                    <button
                      type="submit"
                      className="profile-save-btn"
                      disabled={isSavingProfile}
                    >
                      {isSavingProfile ? 'Збереження…' : 'Зберегти зміни'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="profile-hero">
                    <div className="large-avatar-wrap">
                      <div className="large-avatar">
                        {user.avatarUrl ? (
                          <img src={user.avatarUrl} alt="" className="avatar-img" />
                        ) : (
                          (user.displayName || user.username || '?').slice(0, 2).toUpperCase()
                        )}
                      </div>
                      <input
                        type="file"
                        ref={avatarFileInputRef}
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleAvatarFileSelect}
                      />
                      <button
                        type="button"
                        className="avatar-quick-edit-btn"
                        onClick={() => avatarFileInputRef.current?.click()}
                        title="Змінити аватарку"
                        disabled={isUploadingAvatar}
                      >
                        📷
                      </button>
                    </div>

                    <h3 className="profile-hero-name">
                      {user.displayName || user.username}
                    </h3>
                    <p className="profile-hero-username">@{user.username}</p>
                    <span className="online-indicator">В мережі</span>

                    <button
                      type="button"
                      className="profile-edit-trigger-btn"
                      onClick={handleStartEditingProfile}
                    >
                      ✏️ Редагувати профіль
                    </button>
                  </div>

                  {user.bio && (
                    <div className="profile-bio-card">
                      <span className="profile-card-label">Про себе</span>
                      <p>{user.bio}</p>
                    </div>
                  )}

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
                      type="button"
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
                    <button type="button" className="drawer-item" onClick={startStrangerSearch}>
                      <span>🎲 Знайти співрозмовника</span>
                      <span>→</span>
                    </button>
                  </div>

                  <div className="drawer-footer">
                    <button type="button" className="logout-btn" onClick={logout}>
                      Вийти з акаунту
                    </button>
                    <div className="drawer-brand-footnote">
                      <Logo size={20} />
                      <span>Yapp Messenger</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* БІЧНА ПАНЕЛЬ ПЕРЕГЛЯДУ ПРОФІЛЮ СПІВРОЗМОВНИКА (ДЕНЬ 12) */}
      {viewingPartnerId && (
        <div className="drawer-overlay" onClick={() => setViewingPartnerId(null)}>
          <div className="drawer-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h3>Профіль користувача</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => setViewingPartnerId(null)}
                title="Закрити"
              >
                ✕
              </button>
            </div>

            <div className="drawer-body">
              {isLoadingPartnerProfile ? (
                <div className="profile-loading-state">
                  <div className="profile-spinner" />
                  <p>Завантаження профілю…</p>
                </div>
              ) : partnerProfileError ? (
                <div className="report-error-banner" role="alert">
                  ⚠️ {partnerProfileError}
                </div>
              ) : partnerProfileData ? (
                <>
                  <div className="profile-hero">
                    <div className="large-avatar">
                      {partnerProfileData.avatarUrl ? (
                        <img
                          src={partnerProfileData.avatarUrl}
                          alt={partnerProfileData.displayName || partnerProfileData.username}
                          className="avatar-img"
                        />
                      ) : (
                        (partnerProfileData.displayName || partnerProfileData.username || '?')
                          .slice(0, 2)
                          .toUpperCase()
                      )}
                    </div>
                    <h3 className="profile-hero-name">
                      {partnerProfileData.displayName || partnerProfileData.username}
                    </h3>
                    <p className="profile-hero-username">@{partnerProfileData.username}</p>
                    <span
                      className={`profile-presence-tag ${
                        presenceOf(partnerProfileData, presence).isOnline ? 'is-online' : 'is-offline'
                      }`}
                    >
                      {presenceOf(partnerProfileData, presence).isOnline
                        ? '🟢 В мережі'
                        : formatLastSeen(presenceOf(partnerProfileData, presence).lastSeenAt, nowMs)}
                    </span>
                  </div>

                  {partnerProfileData.bio && (
                    <div className="profile-bio-card">
                      <span className="profile-card-label">Про себе</span>
                      <p>{partnerProfileData.bio}</p>
                    </div>
                  )}

                  <div className="profile-details-list">
                    <div className="profile-detail-row">
                      <span className="detail-icon">📅</span>
                      <div className="detail-text">
                        <span className="detail-label">У Yapp з</span>
                        <span className="detail-value">
                          {partnerProfileData.createdAt
                            ? new Date(partnerProfileData.createdAt).toLocaleDateString('uk-UA', {
                                month: 'long',
                                year: 'numeric',
                              })
                            : 'Невідомо'}
                        </span>
                      </div>
                    </div>

                    <div className="profile-detail-row">
                      <span className="detail-icon">🤝</span>
                      <div className="detail-text">
                        <span className="detail-label">Статус знайомства</span>
                        <span className="detail-value">
                          {partnerProfileData.isContact ? 'У ваших контактах' : 'Не в контактах'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="drawer-menu">
                    {!partnerProfileData.isContact && (
                      <button
                        type="button"
                        className="drawer-item"
                        onClick={() => handleAddContactFromProfile(partnerProfileData.id)}
                      >
                        <span>➕ Додати в контакти</span>
                        <span>→</span>
                      </button>
                    )}

                    {activeChat?.otherUser?.id !== partnerProfileData.id && (
                      <button
                        type="button"
                        className="drawer-item"
                        onClick={() => handleStartChatWithPartner(partnerProfileData)}
                      >
                        <span>💬 Відкрити діалог</span>
                        <span>→</span>
                      </button>
                    )}
                  </div>
                </>
              ) : null}
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
      {/* КОНТЕКСТНЕ МЕНЮ ПОВІДОМЛЕННЯ (right-click / довгий тап) */}
      {contextMenu && (
        <>
          <div
            className="context-menu-backdrop"
            onClick={closeContextMenu}
            onTouchStart={closeContextMenu}
          />
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            // Стоп-продаж обом фазам: тільки так глобальний mousedown-closer
            // не закриє меню перед тим, як клік по пункту встигне відпрацювати
            onMouseDown={(e) => e.stopPropagation()}
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
            <button
              type="button"
              className="context-menu-item"
              onClick={() => handleMenuAction('reply')}
            >
              ↩ Відповісти
            </button>
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
        </>
      )}

      {/* МОДАЛЬНЕ ВІКНО ПІДТВЕРДЖЕННЯ ВИДАЛЕННЯ ПОВІДОМЛЕННЯ */}
      {deleteMessageTarget && (
        <div
          className="confirm-modal-overlay"
          onClick={() => setDeleteMessageTarget(null)}
        >
          <div className="confirm-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-modal-icon is-danger">🗑</div>
            <h3>Видалити повідомлення?</h3>
            <p>Це повідомлення буде видалено для всіх учасників діалогу.</p>
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="confirm-modal-cancel-btn"
                onClick={() => setDeleteMessageTarget(null)}
              >
                Скасувати
              </button>
              <button
                type="button"
                className="confirm-modal-delete-btn"
                onClick={handleDeleteMessageConfirmed}
              >
                Видалити
              </button>
            </div>
          </div>
        </div>
      )}

      {/* МОДАЛЬНЕ ВІКНО ПІДТВЕРДЖЕННЯ ВИДАЛЕННЯ ДІАЛОГУ */}
      {deleteConversationTarget && (
        <div
          className="confirm-modal-overlay"
          onClick={() => setDeleteConversationTarget(null)}
        >
          <div className="confirm-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-modal-icon is-danger">🗑</div>
            <h3>Видалити діалог?</h3>
            <p>
              Видалити діалог з{' '}
              <strong>
                {deleteConversationTarget.otherUser?.displayName ||
                  (deleteConversationTarget.otherUser?.username
                    ? `@${deleteConversationTarget.otherUser.username}`
                    : deleteConversationTarget.title || 'співрозмовником')}
              </strong>
              ? Всі повідомлення та медіафайли буде видалено назавжди для обох учасників.
            </p>
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="confirm-modal-cancel-btn"
                onClick={() => setDeleteConversationTarget(null)}
              >
                Скасувати
              </button>
              <button
                type="button"
                className="confirm-modal-delete-btn"
                onClick={handleDeleteConversationConfirmed}
              >
                Видалити діалог
              </button>
            </div>
          </div>
        </div>
      )}

      {/* МОДАЛЬНЕ ВІКНО СКАРГИ / БЛОКУВАННЯ (ДЕНЬ 11) */}
      {isReportModalOpen && (
        <div
          className="report-modal-overlay"
          onClick={() => !isSubmittingReport && setIsReportModalOpen(false)}
        >
          <div className="report-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="report-modal-header">
              <div className="report-modal-title-wrap">
                <span className="report-modal-icon">🛡️</span>
                <div>
                  <h3>Скарга на співрозмовника</h3>
                  <p className="report-modal-subtitle">
                    {strangerSession?.partner
                      ? `${strangerSession.partner.anonAvatar} ${strangerSession.partner.anonName}`
                      : 'Анонімний співрозмовник'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="close-btn"
                onClick={() => !isSubmittingReport && setIsReportModalOpen(false)}
                title="Закрити"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitReport} className="report-modal-body">
              {reportError && (
                <div className="report-error-banner" role="alert">
                  ⚠️ {reportError}
                </div>
              )}

              <label className="report-field-label">Оберіть причину скарги:</label>
              <div className="report-reasons-group">
                {[
                  { id: 'spam', label: 'Спам або реклама', icon: '📢' },
                  { id: 'abuse', label: 'Образи або токсична поведінка', icon: '🤬' },
                  { id: 'inappropriate', label: 'Неприйнятний або небажаний контент', icon: '🔞' },
                  { id: 'other', label: 'Інше порушення правил', icon: '⚠️' },
                ].map((item) => (
                  <label
                    key={item.id}
                    className={`report-reason-option ${reportReason === item.id ? 'is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="reportReason"
                      value={item.id}
                      checked={reportReason === item.id}
                      onChange={(e) => setReportReason(e.target.value)}
                    />
                    <span className="report-reason-icon">{item.icon}</span>
                    <span className="report-reason-text">{item.label}</span>
                  </label>
                ))}
              </div>

              <label className="report-field-label" htmlFor="report-details-input">
                Додатковий коментар (необов'язково):
              </label>
              <textarea
                id="report-details-input"
                className="report-details-textarea"
                rows={3}
                placeholder="Опишіть, що саме сталося…"
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                maxLength={1000}
              />

              <label className="report-checkbox-label">
                <input
                  type="checkbox"
                  checked={alsoBlock}
                  onChange={(e) => setAlsoBlock(e.target.checked)}
                />
                <span>Заблокувати цього користувача (ви більше ніколи не зустрінетесь у чаті)</span>
              </label>

              <div className="report-modal-actions">
                <button
                  type="button"
                  className="report-quick-block-btn"
                  onClick={handleQuickBlock}
                  disabled={isSubmittingReport}
                  title="Швидко заблокувати без надсилання звіту"
                >
                  🚫 Лише заблокувати
                </button>
                <div className="report-primary-actions">
                  <button
                    type="button"
                    className="report-cancel-btn"
                    onClick={() => setIsReportModalOpen(false)}
                    disabled={isSubmittingReport}
                  >
                    Скасувати
                  </button>
                  <button
                    type="submit"
                    className="report-submit-btn"
                    disabled={isSubmittingReport}
                  >
                    {isSubmittingReport ? 'Надсилання…' : 'Надіслати скаргу'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
