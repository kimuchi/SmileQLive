'use client';

/**
 * ルーレットの盤面を、その端末へ覚えておく。
 *
 * この画面はサーバーへ何も保存しない。盤面の置き場所は URL だが、
 * **URL を控えずに閉じてしまう**ことは会場でふつうに起きる。
 * そのとき次に `/roulette` を開いて空欄が並ぶと、作り直しになる。
 *
 * そこで、
 *   1. 触るたびにアドレス欄の URL を書き換える（読み込み直しても戻る・そのまま渡せる）
 *   2. 同じ中身をこの端末にも控える（URL を持たずに開いたときの戻り先）
 * の 2 段構えにする。どちらも中身は同じ JSON で、`domain/roulette/roulette-url.ts` が作る。
 *
 * **サーバーへは送らない。** 控えるのはブラウザの中だけ。
 */

import { parseRouletteJson, toRouletteJson } from '@/domain/roulette/roulette-url';
import { usableItems, type RouletteConfig } from '@/domain/roulette/wheel';

const STORAGE_KEY = 'smileq.roulette.board';

/**
 * 控えても意味がある盤面か。
 *
 * 項目が 1 つも無い盤面を控えると、次に開いたときに
 * 「読み取れませんでした」と出る（空の JSON は読めないため）。
 */
export function isWorthSaving(config: RouletteConfig): boolean {
  return usableItems(config).length > 0;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // プライベートウィンドウや設定で使えないことがある。使えなくても画面は動く。
    return null;
  }
}

/** いまの盤面をこの端末へ控える。 */
export function saveRouletteBoard(config: RouletteConfig): void {
  if (!isWorthSaving(config)) {
    return;
  }
  try {
    storage()?.setItem(STORAGE_KEY, toRouletteJson(config));
  } catch {
    // 容量切れなど。控えられなくても URL 側に残るので進行はできる。
  }
}

/** 控えてある盤面を読む。無ければ null。 */
export function readSavedRouletteBoard(makeId: () => string): RouletteConfig | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }

  const parsed = parseRouletteJson(raw, makeId);
  return parsed.ok ? parsed.config : null;
}

export function clearSavedRouletteBoard(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // 消せなくても実害は無い。
  }
}

/**
 * アドレス欄の URL をいまの盤面に合わせる。
 *
 * `pushState` ではなく `replaceState` を使う。積むと、戻るボタンが
 * 打鍵の履歴を 1 つずつ遡ることになり、会場で押した人が戻れなくなる。
 *
 * 項目が空のときは `?json=` を落とす。空の盤面を載せた URL は読めず、
 * 読み込み直したときに「読み取れませんでした」と出てしまう。
 */
export function syncRouletteUrl(config: RouletteConfig): void {
  try {
    const url = new URL(window.location.href);
    if (isWorthSaving(config)) {
      url.searchParams.set('json', toRouletteJson(config));
    } else {
      url.searchParams.delete('json');
    }
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // URL を書き換えられなくても、盤面そのものは動く。
  }
}
