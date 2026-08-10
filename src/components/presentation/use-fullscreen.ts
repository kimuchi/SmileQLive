'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 全画面表示の制御。
 *
 * - 全画面要求はブラウザの制限により **操作者のクリックイベント内** でしか通らない。
 *   非同期処理を挟んだあとに呼ぶと拒否されることがあるため、失敗しても静かに諦め、
 *   画面隅のボタンからやり直せるようにする。
 * - 投影機によっては全画面にできないこともある。できなくても投影自体は続けられる。
 */

type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenCapableDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

function currentFullscreenElement(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const target = document as FullscreenCapableDocument;
  return document.fullscreenElement ?? target.webkitFullscreenElement ?? null;
}

export type FullscreenControl = {
  isFullscreen: boolean;
  /** 全画面へ入る。クリックイベント内から呼ぶこと。 */
  request: () => void;
  exit: () => void;
  toggle: () => void;
};

export function useFullscreen(): FullscreenControl {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => {
      setIsFullscreen(currentFullscreenElement() !== null);
    };
    // 利用者が Esc で抜けた場合にも状態を合わせる。
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const request = useCallback((): void => {
    const element = document.documentElement as FullscreenCapableElement;
    try {
      const result = element.requestFullscreen
        ? element.requestFullscreen({ navigationUI: 'hide' })
        : element.webkitRequestFullscreen?.();
      if (result && typeof result === 'object' && 'catch' in result) {
        void result.catch(() => {
          // 拒否されても投影は続けられる。画面隅のボタンからやり直せる。
        });
      }
    } catch {
      // 全画面に対応していない環境。何もしない。
    }
  }, []);

  const exit = useCallback((): void => {
    const target = document as FullscreenCapableDocument;
    try {
      if (currentFullscreenElement() === null) {
        return;
      }
      const result = document.exitFullscreen
        ? document.exitFullscreen()
        : target.webkitExitFullscreen?.();
      if (result && typeof result === 'object' && 'catch' in result) {
        void result.catch(() => {
          // 失敗しても Esc で抜けられる。
        });
      }
    } catch {
      // 何もしない。
    }
  }, []);

  const toggle = useCallback((): void => {
    if (currentFullscreenElement() === null) {
      request();
      return;
    }
    exit();
  }, [exit, request]);

  return { isFullscreen, request, exit, toggle };
}
