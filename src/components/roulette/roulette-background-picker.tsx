'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { TextInput } from '@/components/shared/TextInput';
import {
  normalizeBackgroundUrl,
  ROULETTE_BACKGROUND_URL_MAX_LENGTH,
} from '@/domain/roulette/wheel';

/**
 * 投影の背景に敷く画像を選ぶ。
 *
 * 選び方は 2 つあり、**それぞれ性質が違う**ので分けて出す。
 *
 *   画像の URL を入れる … 盤面の URL に載る。渡した相手の画面にも出る。
 *   手元のファイルを選ぶ … その端末・そのタブの中だけ。
 *                          読み込み直すと消えるし、URL を渡しても相手には出ない。
 *
 * 手元のファイルをそのまま URL へ埋め込む（data: にする）ことはしない。
 * 画像 1 枚で URL が数 MB になり、貼れなくなるうえに開けもしない。
 *
 * ファイルはサーバーへ送らない。この画面はサーバーへ何も保存しない。
 */

/** 手元のファイルの上限。これを超えると投影の読み込みが目に見えて遅くなる。 */
const MAX_LOCAL_FILE_BYTES = 8 * 1024 * 1024;

export function RouletteBackgroundPicker({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value !== null && !isLocal(value) ? value : '');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /*
    手元のファイルから作った一時的な URL は、使い終わったら解放する。
    解放しないと、選び直すたびにその画像がブラウザの中に残り続ける。
  */
  const localUrlRef = useRef<string | null>(null);
  const releaseLocal = useCallback(() => {
    if (localUrlRef.current !== null) {
      URL.revokeObjectURL(localUrlRef.current);
      localUrlRef.current = null;
    }
  }, []);
  useEffect(() => releaseLocal, [releaseLocal]);

  const applyUrl = useCallback(() => {
    const normalized = normalizeBackgroundUrl(draft);
    if (draft.trim().length > 0 && normalized === null) {
      setError('http:// または https:// で始まる画像の URL を入れてください。');
      return;
    }
    releaseLocal();
    setError(null);
    onChange(normalized);
  }, [draft, onChange, releaseLocal]);

  const handleFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      // 同じファイルを選び直せるよう、値は毎回空にする。
      event.currentTarget.value = '';
      if (!file) {
        return;
      }
      if (!file.type.startsWith('image/')) {
        setError('画像のファイルを選んでください。');
        return;
      }
      if (file.size > MAX_LOCAL_FILE_BYTES) {
        setError('画像が大きすぎます（8MB まで）。');
        return;
      }

      releaseLocal();
      const objectUrl = URL.createObjectURL(file);
      localUrlRef.current = objectUrl;
      setDraft('');
      setError(null);
      onChange(objectUrl);
    },
    [onChange, releaseLocal],
  );

  const clear = useCallback(() => {
    releaseLocal();
    setDraft('');
    setError(null);
    onChange(null);
  }, [onChange, releaseLocal]);

  const usingLocal = value !== null && isLocal(value);

  return (
    <div className="flex flex-col gap-3">
      <TextInput
        label="画像の URL"
        type="url"
        inputMode="url"
        value={draft}
        maxLength={ROULETTE_BACKGROUND_URL_MAX_LENGTH}
        disabled={disabled}
        placeholder="https://example.com/haikei.jpg"
        hint="盤面の URL に載ります。渡した相手の画面にも出ます。"
        error={error ?? undefined}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError(null);
        }}
        onBlur={applyUrl}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={disabled} onClick={applyUrl}>
          この URL を使う
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={handleFile}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            fileInputRef.current?.click();
          }}
        >
          手元のファイルを選ぶ
        </Button>
        {value !== null ? (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={clear}>
            背景を外す
          </Button>
        ) : null}
      </div>

      {usingLocal ? (
        <Alert variant="warning">
          手元のファイルを背景にしています。<strong className="font-bold">この端末だけ</strong>
          で、画面を読み込み直すと消えます。人に渡したいときは画像の URL を入れてください。
        </Alert>
      ) : null}

      {value !== null ? (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          {/*
            下見。next/image を使わないのは、外部の任意の URL と blob: を
            そのまま出すため（配信元を設定に登録できない）。
          */}
          {/* eslint-disable-next-line @next/next/no-img-element -- 任意の外部 URL と blob: を出すため */}
          <img
            src={value}
            alt=""
            className="h-24 w-full bg-slate-900 object-cover"
            onError={() => {
              setError('この URL からは画像を読み込めませんでした。');
            }}
          />
        </div>
      ) : null}

      <p className="text-xs leading-relaxed text-slate-500">
        文字が読めなくならないよう、背景の上には暗い膜を重ねます。
      </p>
    </div>
  );
}

function isLocal(url: string): boolean {
  return url.toLowerCase().startsWith('blob:');
}
