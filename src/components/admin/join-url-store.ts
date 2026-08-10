'use client';

/**
 * 参加 URL（平文トークン付き）の一時保管。
 *
 * 平文トークンはルーム作成・再発行の API 応答でしか手に入らない。
 * 端末に長く残さないため localStorage は使わず、タブを閉じれば消える sessionStorage だけを使う。
 * ログ・解析・Referer へは絶対に渡さない。
 */

const KEY_PREFIX = 'smileq.joinUrl.';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // プライベートブラウズなどで参照できないことがある。保管できなくても進行は続けられる。
    return null;
  }
}

export function rememberJoinUrl(roomId: string, joinUrl: string): void {
  try {
    storage()?.setItem(`${KEY_PREFIX}${roomId}`, joinUrl);
  } catch {
    // 容量超過などは無視する（再発行で作り直せる）。
  }
}

export function recallJoinUrl(roomId: string): string | null {
  try {
    return storage()?.getItem(`${KEY_PREFIX}${roomId}`) ?? null;
  } catch {
    return null;
  }
}

export function forgetJoinUrl(roomId: string): void {
  try {
    storage()?.removeItem(`${KEY_PREFIX}${roomId}`);
  } catch {
    // 失敗しても実害はない。
  }
}
