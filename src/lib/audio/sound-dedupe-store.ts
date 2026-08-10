/**
 * 効果音の二重再生防止。
 *
 * 投影画面は Snapshot を何度も取り直す（再接続・タブ復帰・イベント欠落の補正）。
 * そのたびに同じ状態へ反応して鳴らすと、会場で同じ音が連続して鳴ってしまう。
 *
 * そこで「この出来事の音はもう鳴らした」という印を `${stateVersion}:${soundName}` の形で残す。
 * ページを再読込しても印が残るよう sessionStorage を使い、
 * タブを閉じれば消えるようにして端末へ長く残さない（localStorage は使わない）。
 *
 * 記録するのは状態番号と音の名前だけ。参加トークン・正解情報は一切書き込まない。
 */

const STORAGE_KEY_PREFIX = 'smileq.sound.played.';

/** 1 ルームあたりに保持する印の上限（古いものから捨てる）。 */
const MAX_KEYS = 400;

export interface SoundDedupeStore {
  /**
   * まだ再生していなければ `true` を返し、同時に「再生済み」として記録する。
   * すでに記録済みなら `false`（＝鳴らしてはいけない）。
   */
  claim(key: string): boolean;
  /** 記録をすべて捨てる（別ルームへ切り替えたときなど）。 */
  clear(): void;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // プライベートブラウズなどで参照できないことがある。
    // 記録できなくても進行は続けられるため、メモリ上の集合だけで動かす。
    return null;
  }
}

function loadKeys(storageKey: string): string[] {
  try {
    const raw = storage()?.getItem(storageKey);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function saveKeys(storageKey: string, keys: readonly string[]): void {
  try {
    storage()?.setItem(storageKey, JSON.stringify(keys));
  } catch {
    // 容量超過などは無視する。メモリ上の集合が残っていれば同一セッション内では十分機能する。
  }
}

/**
 * @param namespace ルーム ID など、記録を分ける単位。空文字なら共有領域を使う。
 */
export function createSoundDedupeStore(namespace: string): SoundDedupeStore {
  const storageKey = `${STORAGE_KEY_PREFIX}${namespace}`;
  const order: string[] = loadKeys(storageKey);
  const seen = new Set<string>(order);

  return {
    claim(key: string): boolean {
      if (key.length === 0) {
        return true;
      }
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      order.push(key);
      while (order.length > MAX_KEYS) {
        const oldest = order.shift();
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
      saveKeys(storageKey, order);
      return true;
    },

    clear(): void {
      seen.clear();
      order.length = 0;
      try {
        storage()?.removeItem(storageKey);
      } catch {
        // 失敗しても実害はない。
      }
    },
  };
}
