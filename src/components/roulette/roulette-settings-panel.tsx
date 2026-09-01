'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RouletteImportPanel } from '@/components/roulette/roulette-import-panel';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { Checkbox } from '@/components/shared/Checkbox';
import { toRouletteItems, type RouletteImportResult } from '@/domain/roulette/roulette-import';
import { buildRouletteUrl } from '@/domain/roulette/roulette-url';
import { estimatedSpinSeconds } from '@/domain/roulette/spin';
import {
  clampDecel,
  clampWeight,
  ROULETTE_ITEM_MAX_COUNT,
  ROULETTE_LABEL_MAX_LENGTH,
  ROULETTE_WEIGHT_MAX,
  ROULETTE_WEIGHT_MIN,
  usableItems,
  type RouletteConfig,
  type RouletteItem,
} from '@/domain/roulette/wheel';
import { formatCount } from '@/lib/format';

/**
 * ルーレットの設定欄。
 *
 * サーバーへは何も保存しない。**盤面の保存先は URL**なので、
 * 「この盤面の URL をコピー」を目立つところに置いてある。
 * 貼っておけば来年も同じ盤面が開けるし、他の人へそのまま渡せる。
 *
 * 回している間は触らせない。途中で扇が増えたり減ったりすると、
 * 針の下に何があるのかが会場から見て分からなくなる。
 */

/** 減速つまみの刻み。細かすぎると合わせづらいので対数っぽく並べる。 */
const DECEL_STEPS = [0.002, 0.004, 0.006, 0.008, 0.012, 0.02, 0.04, 0.08] as const;

function newItem(): RouletteItem {
  return { id: crypto.randomUUID(), label: '', weight: 1 };
}

export function RouletteSettingsPanel({
  config,
  onChange,
  disabled,
  onClose,
}: {
  config: RouletteConfig;
  onChange: (next: RouletteConfig) => void;
  /** 回している間は true。 */
  disabled: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  /*
    共有 URL の起点。

    サーバー側の描画では window が無く、レンダー中に読むと
    サーバーとブラウザで中身が食い違う。生成後に一度だけ入れる
    （use-projector-audio が保存済み設定を読むのと同じやり方）。
    会場では社内の名前で開いていることがあるので、
    サーバーの設定した正式ドメインではなく**いま開いている起点**を使う。
  */
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- window はレンダー中に読めないため */
    setOrigin(window.location.origin);
  }, []);

  const usable = usableItems(config);

  const updateItem = useCallback(
    (id: string, patch: Partial<Pick<RouletteItem, 'label' | 'weight'>>) => {
      onChange({
        ...config,
        items: config.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      });
      setCopied(false);
    },
    [config, onChange],
  );

  const removeItem = useCallback(
    (id: string) => {
      onChange({ ...config, items: config.items.filter((item) => item.id !== id) });
      setCopied(false);
    },
    [config, onChange],
  );

  const addItem = useCallback(() => {
    if (config.items.length >= ROULETTE_ITEM_MAX_COUNT) {
      return;
    }
    onChange({ ...config, items: [...config.items, newItem()] });
    setCopied(false);
  }, [config, onChange]);

  const handleImport = useCallback(
    (result: RouletteImportResult, mode: 'replace' | 'append') => {
      const imported = toRouletteItems(result, () => crypto.randomUUID());
      const base = mode === 'append' ? config.items.filter((item) => item.label.length > 0) : [];
      onChange({ ...config, items: [...base, ...imported].slice(0, ROULETTE_ITEM_MAX_COUNT) });
      setImportOpen(false);
      setCopied(false);
    },
    [config, onChange],
  );

  const handleCopyUrl = useCallback(async () => {
    // origin は画面から取る。会場では社内の名前で開いていることがあり、
    // サーバーの設定した正式ドメインを返すとその場で開けない URL を配ってしまう。
    const url = buildRouletteUrl(window.location.origin, config);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // クリップボードを使えないブラウザ・文脈がある。その場合は下の欄から手で選んでもらう。
      setCopied(false);
    }
  }, [config]);

  const shareUrl = usable.length > 0 && origin.length > 0 ? buildRouletteUrl(origin, config) : '';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-slate-900">設定</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          閉じる
        </Button>
      </div>

      {disabled ? (
        <Alert variant="info">回っている間は変えられません。止まるまでお待ちください。</Alert>
      ) : null}

      {/* --- 項目 --- */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">項目</h3>
          <span className="text-xs text-slate-600">
            {formatCount(usable.length, '件')} / 最大 {ROULETTE_ITEM_MAX_COUNT} 件
          </span>
        </div>

        <ul className="flex flex-col gap-2">
          {config.items.map((item, index) => (
            <li key={item.id} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-right text-xs text-slate-500">{index + 1}</span>
              <input
                type="text"
                value={item.label}
                maxLength={ROULETTE_LABEL_MAX_LENGTH}
                disabled={disabled}
                placeholder="項目名"
                aria-label={`${String(index + 1)}番目の項目名`}
                onChange={(event) => {
                  // 打っている途中で前後の空白を落とさない。落とすと
                  // 「山田 太郎」の空白が打った端から消えて先へ進めなくなる。
                  // 前後の空白は盤面へ出すときと URL へ書き出すときに落とす。
                  updateItem(item.id, {
                    label: event.currentTarget.value.slice(0, ROULETTE_LABEL_MAX_LENGTH),
                  });
                }}
                className="focus:border-brand-500 min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 outline-none disabled:bg-slate-100"
              />
              <input
                type="number"
                value={item.weight}
                min={ROULETTE_WEIGHT_MIN}
                max={ROULETTE_WEIGHT_MAX}
                step={1}
                disabled={disabled}
                aria-label={`${String(index + 1)}番目の重み`}
                onChange={(event) => {
                  updateItem(item.id, { weight: clampWeight(Number(event.currentTarget.value)) });
                }}
                className="focus:border-brand-500 min-h-11 w-16 shrink-0 rounded-lg border border-slate-300 px-2 text-sm text-slate-900 outline-none disabled:bg-slate-100"
              />
              <button
                type="button"
                disabled={disabled}
                aria-label={`${String(index + 1)}番目を削除`}
                onClick={() => {
                  removeItem(item.id);
                }}
                className="min-h-11 shrink-0 rounded-lg px-2 text-sm text-slate-500 hover:bg-slate-100 hover:text-red-600 disabled:opacity-40"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || config.items.length >= ROULETTE_ITEM_MAX_COUNT}
            onClick={addItem}
          >
            項目を追加
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setImportOpen((previous) => !previous);
            }}
          >
            {importOpen ? '取り込みを閉じる' : '貼り付け・CSVで入れる'}
          </Button>
        </div>

        <p className="text-xs text-slate-600">
          重みが大きいほど扇が広くなり、当たりやすくなります（2 なら 2 倍）。
        </p>
      </section>

      {importOpen ? (
        <section className="rounded-xl border border-slate-200 p-3">
          <RouletteImportPanel currentItemCount={usable.length} onImport={handleImport} />
        </section>
      ) : null}

      {/* --- 見た目と回り方 --- */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-bold text-slate-900">見た目と回り方</h3>

        <Checkbox
          label="扇の中に項目名を出す"
          hint="項目が多くて読めないときは外してください。"
          checked={config.showLabels}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...config, showLabels: event.currentTarget.checked });
            setCopied(false);
          }}
        />

        <div className="flex flex-col gap-1">
          <label htmlFor="roulette-decel" className="text-sm font-bold text-slate-800">
            回る長さ（減速）
          </label>
          <input
            id="roulette-decel"
            type="range"
            min={0}
            max={DECEL_STEPS.length - 1}
            step={1}
            disabled={disabled}
            value={nearestDecelStep(config.decel)}
            onChange={(event) => {
              const step = DECEL_STEPS[Number(event.currentTarget.value)] ?? config.decel;
              onChange({ ...config, decel: clampDecel(step) });
              setCopied(false);
            }}
            className="h-11 w-full"
          />
          <p className="text-xs text-slate-600">
            およそ{' '}
            <strong className="font-bold">{estimatedSpinSeconds(config.decel).toFixed(1)}</strong>{' '}
            秒で止まります（減速 {config.decel}）。 左へ動かすほど長く回ります。
          </p>
        </div>
      </section>

      {/* --- 共有 --- */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-bold text-slate-900">この盤面を保存する</h3>
        <p className="text-xs leading-relaxed text-slate-600">
          サーバーには何も保存していません。
          <strong className="font-bold">この URL が保存先です。</strong>
          貼っておけば同じ盤面をいつでも開けます。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={usable.length === 0} onClick={() => void handleCopyUrl()}>
            URLをコピー
          </Button>
          {copied ? (
            <span className="self-center text-xs font-bold text-emerald-700">コピーしました</span>
          ) : null}
        </div>
        <textarea
          readOnly
          rows={3}
          value={shareUrl}
          aria-label="この盤面のURL"
          className="w-full rounded-lg border border-slate-300 bg-slate-50 p-2 font-mono text-[11px] break-all text-slate-700"
        />
        <p className="text-xs text-slate-500">
          この形式は配布されているルーレット（tanidaiz 版）と同じです。あちらの URL
          もそのまま開けます。
        </p>
      </section>

      <p className="text-xs text-slate-600">
        効果音は{' '}
        <Link href="/sounds" className="text-brand-700 font-bold underline">
          効果音の設定
        </Link>{' '}
        で差し替えられます（ログイン不要・すべての催しで鳴ります）。
      </p>
    </div>
  );
}

/** つまみの位置。いまの値にいちばん近い刻みを選ぶ。 */
function nearestDecelStep(decel: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, step] of DECEL_STEPS.entries()) {
    const distance = Math.abs(step - decel);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
