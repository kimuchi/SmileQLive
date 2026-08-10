import { commandExists, run, runCapture } from './proc.mjs';
import { fatal, info, warn } from './log.mjs';

/** Google Cloud CLI に関する共通処理。 */

export function ensureGcloud() {
  if (!commandExists('gcloud')) {
    fatal(
      'Google Cloud CLI (gcloud) が見つかりません。',
      [
        'インストール手順: https://cloud.google.com/sdk/docs/install',
        'インストール後、新しいターミナルで `gcloud version` が動くことを確認してください。',
      ].join('\n'),
    );
  }
}

export function activeAccount() {
  const account = runCapture(
    'gcloud',
    ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
    { quiet: true, allowFailure: true },
  );
  return account ? account.split(/\r?\n/)[0].trim() : '';
}

export function ensureLoggedIn() {
  const account = activeAccount();
  if (!account) {
    fatal(
      'gcloud にログインしていません。',
      ['次のコマンドでログインしてください:', '  gcloud auth login'].join('\n'),
    );
  }
  return account;
}

export function ensureProjectAccessible(projectId) {
  const result = run('gcloud', ['projects', 'describe', projectId, '--format=value(projectId)'], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });
  if (!result.ok) {
    fatal(
      `Google Cloud プロジェクトへアクセスできません: ${projectId}`,
      [
        '次を確認してください:',
        '  * プロジェクト ID が正しいか',
        '  * gcloud auth login したアカウントに権限があるか',
        '  * 課金が有効か',
      ].join('\n'),
    );
  }
}

export function projectNumber(projectId) {
  return runCapture(
    'gcloud',
    ['projects', 'describe', projectId, '--format=value(projectNumber)'],
    { quiet: true },
  );
}

export function secretExists(projectId, secretName) {
  const result = run('gcloud', ['secrets', 'describe', secretName, '--project', projectId], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });
  return result.ok;
}

export function secretHasVersion(projectId, secretName) {
  const result = run(
    'gcloud',
    [
      'secrets',
      'versions',
      'list',
      secretName,
      '--project',
      projectId,
      '--filter=state:ENABLED',
      '--limit=1',
      '--format=value(name)',
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  return result.ok && result.stdout.trim().length > 0;
}

export function serviceExists(projectId, region, serviceName) {
  const result = run(
    'gcloud',
    [
      'run',
      'services',
      'describe',
      serviceName,
      '--project',
      projectId,
      '--region',
      region,
      '--format=value(status.url)',
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  return result.ok ? result.stdout.trim() : '';
}

export function serviceUrl(projectId, region, serviceName) {
  return runCapture(
    'gcloud',
    [
      'run',
      'services',
      'describe',
      serviceName,
      '--project',
      projectId,
      '--region',
      region,
      '--format=value(status.url)',
    ],
    { quiet: true },
  );
}

/**
 * gcloud のバージョン差でフラグが存在しない場合に備え、
 * 「未知のフラグ」で失敗したら任意フラグを外して 1 度だけ再試行する。
 */
export function runWithOptionalFlags(args, optionalArgs, options = {}) {
  const first = run('gcloud', [...args, ...optionalArgs], { ...options, allowFailure: true });
  if (first.ok) {
    return first;
  }

  const message = `${first.stderr ?? ''}`;
  const unknownFlag = /unrecognized arguments|Unknown flag|unrecognized flag|invalid choice/i.test(
    message,
  );

  if (unknownFlag && optionalArgs.length > 0) {
    warn(
      'お使いの gcloud では一部の任意フラグが未対応でした。' +
        ' 任意フラグを外して再実行します（起動プローブ等は Cloud Run コンソールで確認してください）。',
    );
    info(`外したフラグ: ${optionalArgs.join(' ')}`);
    const retry = run('gcloud', args, { ...options, allowFailure: true });
    if (retry.ok) {
      return retry;
    }
    if (retry.stderr) {
      console.error(retry.stderr);
    }
    fatal('gcloud run deploy に失敗しました。上のエラーを確認してください。');
  }

  if (first.stderr) {
    console.error(first.stderr);
  }
  fatal('gcloud コマンドに失敗しました。上のエラーを確認してください。');
  return first;
}

export function enableServices(projectId, services) {
  run('gcloud', ['services', 'enable', ...services, '--project', projectId]);
}
