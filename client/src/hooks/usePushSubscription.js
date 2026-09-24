import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../auth.js';

// PWA 通知 (Web Push) の購読管理 (plan: plan-notify-bridge, Step 5)。
//
// useNotifications.js とは別物なので注意:
//   useNotifications  ... タブが開いている間だけの前景 Notification。予約
//                         プロンプト発火 (schedule_fired) で使う既存機能。
//   このフック        ... Service Worker 経由の Web Push。タブを閉じていても
//                         端末に届く。サーバー側は notify.js の webpush
//                         チャネル。
//
// 前提と制約 (UI 側で説明する必要があるもの):
//   - Push API は secure context 必須。http://localhost は可、LAN の平文 HTTP
//     は不可。実運用は Tailscale Serve 等の HTTPS 公開が前提。
//   - iOS/iPadOS Safari は「ホーム画面に追加」した PWA でないと購読できない。
//   - 権限要求はユーザー操作起因でしか出せないので、ボタン押下から呼ぶこと。

// base64url の applicationServerKey を pushManager.subscribe が要求する
// Uint8Array へ。atob は素の base64 しか受けないので +/ に戻してから。
function urlBase64ToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function usePushSubscription({ vapidPublicKey, onChanged } = {}) {
  const [supported] = useState(() => pushSupported());
  const [permission, setPermission] = useState(() => (
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  ));
  // このブラウザが今このサーバーを購読しているか (SW に聞く)。
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      setSubscribed(!!(await reg.pushManager.getSubscription()));
      setPermission(Notification.permission);
    } catch {
      setSubscribed(false);
    }
  }, [supported]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const subscribe = useCallback(async () => {
    if (!supported || !vapidPublicKey) return;
    setBusy(true);
    setError(null);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setError(result === 'denied'
          ? 'ブラウザの通知権限がブロックされています。ブラウザ側の設定から許可してください。'
          : '通知が許可されませんでした。');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      // 既存購読があれば作り直さない: endpoint が変わるとサーバー側に
      // 死んだ行が残る (次の配信で 410 が返るまで消えない)。
      const sub = await reg.pushManager.getSubscription()
        ?? await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });
      const res = await authFetch('/api/push/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: {
            p256dh: bufferToBase64Url(sub.getKey('p256dh')),
            auth: bufferToBase64Url(sub.getKey('auth')),
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSubscribed(true);
      onChanged?.(body);
    } catch (err) {
      setError(err.message || '購読に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [supported, vapidPublicKey, onChanged]);

  // この端末の購読を解除する。サーバー側の行は、この端末からは id が
  // 分からないので消せない (endpoint は返ってこない設計) -- 設定画面の
  // 端末一覧から消す。ここでブラウザ側を解除しておけば、次の配信で
  // 410 が返りサーバー側も自動で剪定される。
  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      setSubscribed(false);
      onChanged?.(null);
    } catch (err) {
      setError(err.message || '解除に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [supported, onChanged]);

  return { supported, permission, subscribed, busy, error, subscribe, unsubscribe, refresh };
}
