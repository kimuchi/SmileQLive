import { Alert } from '@/components/shared/Alert';
import type { PublishIssue } from '@/domain/quiz/publish-validation';

/**
 * 公開チェックの結果一覧。
 * 「第3問: 選択肢は2〜5個必要です」のように、どこを直せばよいかが分かる形で並べる。
 */

export type PublishIssueListProps = {
  issues: readonly PublishIssue[];
};

export function PublishIssueList({ issues }: PublishIssueListProps) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <Alert variant="error" title={`公開できません（${issues.length}件）`}>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.questionId ?? 'quiz'}-${index}`}>{issue.message}</li>
        ))}
      </ul>
    </Alert>
  );
}
