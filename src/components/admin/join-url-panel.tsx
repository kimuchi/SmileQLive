'use client';

import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { QrCode } from '@/components/shared/QrCode';
import { CopyButton } from '@/components/admin/copy-button';
import { cn } from '@/lib/client/cn';

/**
 * 参加 URL と二次元コードの表示。
 *
 * 重要:
 * - 参加はこの二次元コード（URL 直行）だけ。ルームコードの入力欄も案内も存在しない。
 * - 平文トークンを含む URL は API 応答からしか得られない。
 *   画面を離れて失った場合は再発行する（旧 URL は失効する）。
 */

export type JoinUrlPanelProps = {
  joinUrl: string | null;
  /** 二次元コードの一辺 (px)。会場掲示は 320 以上を推奨。 */
  qrSize?: number;
  rotating?: boolean;
  onRotate?: () => void;
  className?: string;
};

export function JoinUrlPanel({
  joinUrl,
  qrSize = 240,
  rotating = false,
  onRotate,
  className,
}: JoinUrlPanelProps) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {joinUrl === null ? (
        <Alert variant="warning" title="参加URLは表示できません">
          <p>
            参加URLはルーム作成・再発行のときだけ表示されます。会場で提示するものが手元にない場合は、
            「参加URLを再発行」してください。
          </p>
          <p className="mt-1">再発行すると、以前の参加URLと二次元コードは使えなくなります。</p>
        </Alert>
      ) : (
        <div className="flex flex-col items-start gap-4 sm:flex-row">
          <QrCode
            value={joinUrl}
            size={qrSize}
            caption="スマートフォンで読み取ると参加できます"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-700">参加URL</p>
            <p className="mt-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm break-all text-slate-800">
              {joinUrl}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <CopyButton value={joinUrl} label="参加URLをコピー" />
            </div>
            <p className="mt-3 text-xs text-slate-600">
              このURLには参加用の鍵が含まれます。掲示・配布以外の用途で共有しないでください。
            </p>
          </div>
        </div>
      )}

      {onRotate !== undefined ? (
        <div>
          <Button variant="secondary" size="sm" loading={rotating} onClick={onRotate}>
            参加URLを再発行
          </Button>
          <p className="mt-1 text-xs text-slate-600">
            再発行すると以前のURL・二次元コードは無効になります。掲示物の貼り替えが必要です。
          </p>
        </div>
      ) : null}
    </div>
  );
}
