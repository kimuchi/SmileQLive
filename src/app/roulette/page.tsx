import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import { StandaloneRoulette } from '@/components/presentation/StandaloneRoulette';
import { parseRouletteJson, ROULETTE_QUERY_KEY } from '@/domain/roulette/roulette-url';
import { blankRouletteConfig, ROULETTE_ITEM_MAX_COUNT } from '@/domain/roulette/wheel';

/**
 * URL だけで回すルーレット。
 *
 * **ログインもルームも要りません。** 盤面は URL に載っていて、
 * サーバーへは何も送らないし記録も残りません。
 *
 *   /roulette?json={"name":["山田","田中"],"ratio":[1,2],...}
 *
 * 形は配布されているルーレット（exe.tanidaiz.com/roulette.php）と同じにしてあり、
 * 向こうの URL をそのまま開けます。何も付けずに開けば 1 から作れます。
 *
 * ルームを作って進める抽選会のルーレット（`/present/{roomId}`）とは別物です。
 * あちらはサーバーが引いて記録し、司会と投影で画面が分かれます。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ルーレット | SmileQ Live',
  robots: { index: false, follow: false },
};

export default async function RoulettePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params[ROULETTE_QUERY_KEY];
  // 同じ名前で 2 つ付いていることがある（貼り間違い）。最初の 1 つを読む。
  const json = Array.isArray(raw) ? raw[0] : raw;

  const parsed = parseRouletteJson(json ?? null, randomUUID);

  if (!parsed.ok) {
    return (
      <StandaloneRoulette
        initialConfig={blankRouletteConfig(randomUUID)}
        initialNotice={
          parsed.reason === 'invalid'
            ? 'URL の中身を読み取れませんでした。ここから作り直せます。'
            : null
        }
        /*
          URL に何も付いていなかったときだけ、その端末に控えてある
          前回の内容へ戻す（画面側でやる。控えはブラウザの中にしか無い）。
          壊れた URL を開いたときは戻さない。直したい人の邪魔になる。
        */
        restoreSaved={parsed.reason === 'empty'}
      />
    );
  }

  return (
    <StandaloneRoulette
      restoreSaved={false}
      initialConfig={parsed.config}
      initialNotice={
        parsed.truncated > 0
          ? `項目が多すぎたため、${String(ROULETTE_ITEM_MAX_COUNT)}件までを読み込みました（${String(parsed.truncated)}件は入っていません）。`
          : null
      }
    />
  );
}
