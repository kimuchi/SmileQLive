'use client';

import { useCallback, useRef, useState } from 'react';
import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import type { StageDraw } from '@/domain/draw/draw-stage';
import { formatCount } from '@/lib/format';

/**
 * 抽選会・ビンゴの待機画面。
 *
 * 司会が「はじめる」を押すまでここを出す。
 *
 * オープニング動画は**任意**。抽選リストの設定に URL が入っていれば流せる。
 * 動画そのものはこのアプリでは受け取らない（画像しかアップロードを許していない）ので、
 * すでにどこかに置いてあるファイルの URL を指してもらう作りにしている。
 * 自動では流さない。会場の準備が整う前に音が出ると事故になるため、
 * 操作者が押したときだけ流す（GAS 版の CLICK TO START と同じ考え方）。
 */
export function DrawWaitingStage({ draw }: { draw: StageDraw }) {
  const videoUrl = draw.settings.openingVideoUrl;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  const handlePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    setFailed(false);
    setPlaying(true);
    void video.play().catch(() => {
      // 読み込めない・再生できない URL でも進行は止めない。
      setPlaying(false);
      setFailed(true);
    });
  }, []);

  const handleStop = useCallback(() => {
    videoRef.current?.pause();
    setPlaying(false);
  }, []);

  if (videoUrl && playing) {
    return (
      <div className="relative flex h-full w-full items-center justify-center">
        <video
          ref={videoRef}
          src={videoUrl}
          playsInline
          onEnded={handleStop}
          className="h-full w-full object-contain"
        />
        <button
          type="button"
          onClick={handleStop}
          className="absolute rounded-lg border border-white/40 bg-black/50 font-bold text-white/80"
          style={{
            right: stageSize(24),
            bottom: stageSize(24),
            paddingInline: stageSize(24),
            paddingBlock: stageSize(10),
            fontSize: stageSize(STAGE_FONT.caption),
          }}
        >
          スキップ
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center text-center"
      style={{ gap: stageSize(28) }}
    >
      <h1
        className="font-bold break-words text-white"
        style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.15 }}
      >
        {draw.title}
      </h1>

      <p
        className="stage-urgent font-bold text-cyan-300"
        style={{
          fontSize: stageSize(STAGE_FONT.heading),
          textShadow: '0 0 0.4cqw rgba(103,232,249,0.8)',
        }}
      >
        まもなくはじまります
      </p>

      <p className="font-bold text-white/50" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
        全 {formatCount(draw.entries.length)}
      </p>

      {videoUrl ? (
        <>
            <video ref={videoRef} src={videoUrl} playsInline preload="metadata" className="hidden" />
          <button
            type="button"
            onClick={handlePlay}
            className="text-stage-950 rounded-full bg-white font-bold"
            style={{
              paddingInline: stageSize(48),
              paddingBlock: stageSize(16),
              fontSize: stageSize(STAGE_FONT.body),
            }}
          >
            オープニングを流す
          </button>
          {failed ? (
            <p className="text-red-300" style={{ fontSize: stageSize(STAGE_FONT.caption) }}>
              動画を再生できませんでした。URL を確認してください。
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
