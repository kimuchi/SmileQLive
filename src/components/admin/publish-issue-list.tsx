import { Alert } from '@/components/shared/Alert';
import type { PublishIssue } from '@/domain/quiz/publish-validation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 422 応答の details から公開チェック結果を取り出す。形が違えば空配列。
 *
 * details に入るのは「第3問: 選択肢Aには文章または画像が必要です」のような
 * **利用者が直せる指摘**であり、技術情報ではない。必ず画面へ出すこと。
 */
export function parsePublishIssues(details: unknown): PublishIssue[] {
  if (!Array.isArray(details)) {
    return [];
  }
  const issues: PublishIssue[] = [];
  for (const entry of details) {
    if (!isRecord(entry) || typeof entry.message !== 'string' || typeof entry.code !== 'string') {
      continue;
    }
    issues.push({
      questionPosition: typeof entry.questionPosition === 'number' ? entry.questionPosition : null,
      questionId: typeof entry.questionId === 'string' ? entry.questionId : null,
      code: entry.code,
      message: entry.message,
    });
  }
  return issues;
}

/**
 * 公開チェックの結果一覧。
 * 「第3問: 選択肢は2〜5個必要です」のように、どこを直せばよいかが分かる形で並べる。
 */

export type PublishIssueListProps = {
  issues: readonly PublishIssue[];
  /** 見出し。ルーム作成時など、文脈に合わせて変えられるようにする。 */
  title?: string;
};

export function PublishIssueList({ issues, title }: PublishIssueListProps) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <Alert variant="error" title={title ?? `公開できません（${issues.length}件）`}>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.questionId ?? 'quiz'}-${index}`}>{issue.message}</li>
        ))}
      </ul>
    </Alert>
  );
}
