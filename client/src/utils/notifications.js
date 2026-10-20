/**
 * Запитує дозвіл на системні сповіщення браузера.
 */
export async function requestNotificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch (err) {
      console.debug('Notification permission request error:', err);
      return 'denied';
    }
  }
  return Notification.permission;
}

/**
 * Показує системне сповіщення браузера про нове повідомлення.
 *
 * @param {object} options
 * @param {string} options.title - Заголовок сповіщення (наприклад, нікнейм відправника)
 * @param {string} options.body - Текст повідомлення
 * @param {string} [options.icon] - Іконка сповіщення
 * @param {Function} [options.onClick] - Колбек при кліку по сповіщенню
 */
export function showBrowserNotification({ title, body, icon = '/vite.svg', onClick } = {}) {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }

  if (Notification.permission !== 'granted') {
    return null;
  }

  try {
    const notification = new Notification(title, {
      body,
      icon,
      badge: icon,
      silent: true, // Звук генеруємо окремо через Web Audio API для однакового тону
    });

    notification.onclick = (event) => {
      try {
        window.focus();
      } catch {}
      if (typeof onClick === 'function') {
        onClick(event);
      }
      notification.close();
    };

    return notification;
  } catch (err) {
    console.debug('Failed to create notification:', err);
    return null;
  }
}
