'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveState } from '@/components/shared/SaveStatus';
import { formatClockTime } from '@/lib/format';

/**
 * 入力の自動保存。
 *
 * 方針:
 * - 入力停止から 800ms 後に保存する（打鍵ごとに API を叩かない）。
 * - 保存中に新しい変更が来たら「もう 1 回だけ」積む。連打で保存要求を増やさない。
 * - 失敗しても入力内容には触れない。状態を error にして利用者へ知らせるだけにする。
 * - 画面遷移や重要操作の直前は flush() で確実に書き込む。
 */

export const AUTOSAVE_DEBOUNCE_MS = 800;

export type AutosaveController = {
  status: SaveState;
  /** 最終保存時刻の表示（例: 12:34）。 */
  savedAtLabel: string | undefined;
  error: unknown;
  /** 変更があったことを通知する。debounce 後に保存される。 */
  schedule: () => void;
  /** 予約済みの保存を今すぐ実行して待つ。 */
  flush: () => Promise<void>;
  /** 予約を取り消す（入力が保存対象外になったとき）。 */
  cancel: () => void;
  /** debounce を挟まず直ちに保存する（画像アップロード直後など）。 */
  saveNow: () => Promise<void>;
  /** 未保存の変更を抱えているか。 */
  hasPendingChanges: () => boolean;
};

export function useAutosave(
  save: () => Promise<void>,
  delayMs: number = AUTOSAVE_DEBOUNCE_MS,
): AutosaveController {
  const [status, setStatus] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<unknown>(null);

  const saveRef = useRef(save);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);
  const queuedRef = useRef(false);
  const runningRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const run = useCallback(async (): Promise<void> => {
    const running = runningRef.current;
    if (running) {
      queuedRef.current = true;
      await running;
      return;
    }

    const promise = (async () => {
      do {
        queuedRef.current = false;
        pendingRef.current = false;
        setStatus('saving');
        try {
          await saveRef.current();
          if (!mountedRef.current) {
            return;
          }
          setError(null);
          setSavedAt(new Date());
          setStatus('saved');
        } catch (caught) {
          if (!mountedRef.current) {
            return;
          }
          setError(caught);
          setStatus('error');
          // 失敗したら連続実行しない。入力内容はそのまま残す。
          return;
        }
      } while (queuedRef.current && mountedRef.current);
    })();

    runningRef.current = promise;
    try {
      await promise;
    } finally {
      runningRef.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    clearTimer();
    pendingRef.current = true;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void run();
    }, delayMs);
  }, [clearTimer, delayMs, run]);

  const flush = useCallback(async (): Promise<void> => {
    clearTimer();
    if (pendingRef.current) {
      await run();
      return;
    }
    const running = runningRef.current;
    if (running) {
      await running;
    }
  }, [clearTimer, run]);

  const cancel = useCallback(() => {
    clearTimer();
    pendingRef.current = false;
  }, [clearTimer]);

  const saveNow = useCallback(async (): Promise<void> => {
    clearTimer();
    pendingRef.current = true;
    await run();
  }, [clearTimer, run]);

  const hasPendingChanges = useCallback(() => pendingRef.current, []);

  return {
    status,
    savedAtLabel: savedAt ? formatClockTime(savedAt, { withSeconds: false }) : undefined,
    error,
    schedule,
    flush,
    cancel,
    saveNow,
    hasPendingChanges,
  };
}
