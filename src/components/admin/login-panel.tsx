/**
 * 管理・司会のログイン画面の実体は `login-form.tsx`（Google ログイン）へ移した。
 *
 * `/admin/login` ページが参照している名前を変えないための再エクスポート。
 * 新しいコードは `@/components/admin/login-form` を直接 import すること。
 */
export { LoginPanel, type LoginPanelProps } from '@/components/admin/login-form';
