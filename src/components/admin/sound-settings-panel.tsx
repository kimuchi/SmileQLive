'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { Spinner } from '@/components/shared/Spinner';
import { uploadAdminSound } from '@/components/admin/upload-sound';
import { MAX_SOUND_UPLOAD_BYTES, SOUND_FILE_ACCEPT } from '@/domain/media/sound-policy';
import {
  SOUND_DESCRIPTIONS,
  SOUND_LABELS,
  SOUND_NAMES,
  type SoundName,
} from '@/domain/sound/sound-catalog';
import { apiDelete, apiGet } from '@/lib/client/api-client';
import { toAdminErrorMessage } from '@/lib/client/error-text';
import type { SoundSettingsResponse, SoundSlot } from '@/types/api';

/**
 * 効果音の差し替え。
 *
 * **デプロイし直さずに会場の音を変えられる**ことがこの画面の目的。
 * 同梱しているのは仮の音で、本番では効果音ラボなどの素材へ差し替えて使う。
 *
 * この画面は音を `<audio>` 要素で試聴するだけで、投影画面の再生の仕組み
 * (Web Audio) は使わない。音を鳴らす仕組みを持ってよいのは投影画面だけという
 * 決まりを、ここでも崩さない。
 */

/** 何バイトか読める形にする。差し替えた素材が重すぎないかを見るためだけ。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SoundSettingsPanel() {
  const [slots, setSlots] = useState<SoundSlot[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busyName, setBusyName] = useState<SoundName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiGet<SoundSettingsResponse>('/api/sound-settings');
        if (!cancelled) {
          setSlots(response.sounds);
        }
      } catch (caught) {
        if (!cancelled) {
          setLoadError(caught);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUpload = useCallback(async (name: SoundName, file: File) => {
    setActionError(null);
    setNotice(null);
    setBusyName(name);
    try {
      const response = await uploadAdminSound({ name, file });
      setSlots(response.sounds);
      setNotice(`「${SOUND_LABELS[name]}」を差し替えました。`);
    } catch (caught) {
      setActionError(toAdminErrorMessage(caught));
    } finally {
      setBusyName(null);
    }
  }, []);

  const handleReset = useCallback(async (name: SoundName) => {
    setActionError(null);
    setNotice(null);
    setBusyName(name);
    try {
      const response = await apiDelete<SoundSettingsResponse>(`/api/sound-settings/${name}`);
      setSlots(response.sounds);
      setNotice(`「${SOUND_LABELS[name]}」を同梱の音へ戻しました。`);
    } catch (caught) {
      setActionError(toAdminErrorMessage(caught));
    } finally {
      setBusyName(null);
    }
  }, []);

  if (loadError !== null) {
    return <ErrorMessage error={loadError} />;
  }

  if (slots === null) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-slate-600">
        <Spinner size="sm" decorative />
        読み込んでいます
      </span>
    );
  }

  const byName = new Map(slots.map((slot) => [slot.name, slot]));
  const customCount = slots.filter((slot) => slot.source === 'custom').length;

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info" title="ここで差し替えた音は、次に投影画面を開いたときから鳴ります">
        <p>
          デプロイし直す必要はありません。会の途中で差し替えたときは、投影画面を再読み込みして
          ください。
        </p>
        <p className="mt-2">
          同梱しているのは仮の音です。効果音ラボなどから落とした素材へ差し替えて使ってください。
          差し替えた音はリポジトリではなく保存先（Cloud Storage）へ置かれます。
        </p>
      </Alert>

      {notice !== null ? <Alert variant="success">{notice}</Alert> : null}
      {actionError !== null ? <Alert variant="error">{actionError}</Alert> : null}

      <p className="text-sm text-slate-600">
        {customCount === 0
          ? `${SOUND_NAMES.length} 音すべて同梱の音です。`
          : `${SOUND_NAMES.length} 音のうち ${customCount} 音を差し替えています。`}
      </p>

      {SOUND_NAMES.map((name) => {
        const slot = byName.get(name);
        if (!slot) {
          return null;
        }
        return (
          <SoundRow
            key={name}
            slot={slot}
            busy={busyName === name}
            disabled={busyName !== null && busyName !== name}
            onUpload={handleUpload}
            onReset={handleReset}
          />
        );
      })}
    </div>
  );
}

function SoundRow({
  slot,
  busy,
  disabled,
  onUpload,
  onReset,
}: {
  slot: SoundSlot;
  busy: boolean;
  disabled: boolean;
  onUpload: (name: SoundName, file: File) => void | Promise<void>;
  onReset: (name: SoundName) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isCustom = slot.source === 'custom';

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      // 同じファイルを選び直せるよう、値は毎回空にする。
      event.currentTarget.value = '';
      if (file) {
        void onUpload(slot.name, file);
      }
    },
    [onUpload, slot.name],
  );

  return (
    <Card
      title={SOUND_LABELS[slot.name]}
      description={SOUND_DESCRIPTIONS[slot.name]}
      actions={
        <Badge variant={isCustom ? 'brand' : 'neutral'}>
          {isCustom ? '差し替え済み' : '同梱の音'}
        </Badge>
      }
    >
      <div className="flex flex-col gap-3">
        {isCustom ? (
          <p className="text-sm break-all text-slate-700">
            {slot.originalName}
            <span className="ml-2 text-slate-500 tabular-nums">{formatBytes(slot.byteSize)}</span>
          </p>
        ) : null}

        {/*
          試聴。投影画面と同じ URL をそのまま鳴らすので、
          「管理画面では鳴るのに会場で鳴らない」が起きにくい。
        */}
        <audio src={slot.url} controls preload="none" className="w-full max-w-md">
          お使いのブラウザは音声の再生に対応していません。
        </audio>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={SOUND_FILE_ACCEPT}
            className="sr-only"
            onChange={handleChange}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={disabled}
            onClick={() => {
              inputRef.current?.click();
            }}
          >
            {isCustom ? '別の音に差し替える' : '音を差し替える'}
          </Button>
          {isCustom ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || disabled}
              onClick={() => {
                void onReset(slot.name);
              }}
            >
              同梱の音へ戻す
            </Button>
          ) : null}
          <span className="text-xs text-slate-600">
            MP3・WAV・OGG・M4A・AAC / {Math.round(MAX_SOUND_UPLOAD_BYTES / (1024 * 1024))}MB まで
          </span>
        </div>
      </div>
    </Card>
  );
}
