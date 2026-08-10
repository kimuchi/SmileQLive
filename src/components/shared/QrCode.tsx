'use client';

import { QRCodeSVG } from 'qrcode.react';
import { cn } from '@/lib/client/cn';

/**
 * 参加用の二次元コード。
 *
 * 会場のスクリーンに投影して数十メートル先から読み取るため:
 * - 誤り訂正レベルは 'M'（読み取りやすさと密度の折り合い）。
 * - 白背景・黒前景の固定。反転色にしない（読み取り失敗の主因）。
 * - 規格どおり 4 モジュールの余白（クワイエットゾーン）を確保する。
 * - 周囲にも白い余白を敷き、背景が暗い投影画面でも縁が潰れないようにする。
 *
 * value には参加トークンを含む URL が入る。ログや解析へ渡さないこと。
 */

/** 規格が要求するクワイエットゾーン（モジュール数）。 */
const QUIET_ZONE_MODULES = 4;

export type QrCodeProps = {
  /** 参加 URL。 */
  value: string;
  /** 描画サイズ (px)。投影では 480 以上を推奨。 */
  size?: number;
  /** 読み上げ用の説明。 */
  title?: string;
  /** コード下に表示する補足（URL は表示しない運用も可能）。 */
  caption?: string;
  className?: string;
};

export function QrCode({
  value,
  size = 256,
  title = '参加用の二次元コード',
  caption,
  className,
}: QrCodeProps) {
  return (
    <div className={cn('inline-flex flex-col items-center gap-2', className)}>
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <QRCodeSVG
          value={value}
          size={size}
          level="M"
          marginSize={QUIET_ZONE_MODULES}
          bgColor="#ffffff"
          fgColor="#000000"
          title={title}
          style={{ display: 'block', height: 'auto', maxWidth: '100%', width: size }}
        />
      </div>
      {caption !== undefined ? (
        <p className="text-center text-sm font-bold text-slate-700">{caption}</p>
      ) : null}
    </div>
  );
}
