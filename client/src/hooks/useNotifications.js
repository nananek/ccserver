import { useState, useCallback } from 'react';

const STORAGE_KEY = 'ccserver-notifications-enabled';

export function useNotifications() {
  const [enabled, setEnabled] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });

  const [permission, setPermission] = useState(() => {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });

  const toggle = useCallback(async () => {
    if (!('Notification' in window)) return;

    if (!enabled) {
      if (Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        setPermission(result);
        if (result !== 'granted') return;
      } else if (Notification.permission === 'denied') {
        return;
      }
      localStorage.setItem(STORAGE_KEY, 'true');
      setEnabled(true);
    } else {
      localStorage.setItem(STORAGE_KEY, 'false');
      setEnabled(false);
    }
  }, [enabled]);

  const notify = useCallback(
    (title, options) => {
      if (!enabled) return;
      if (Notification.permission !== 'granted') return;
      if (document.hasFocus()) return;

      return new Notification(title, options);
    },
    [enabled]
  );

  return { enabled, permission, toggle, notify };
}
