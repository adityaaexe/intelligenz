import type { Metadata } from 'next';

import { LoginForm } from '../../components/login-form';

export const metadata: Metadata = {
  title: 'Sign in',
};

/**
 * A server page that only reads the `next` search parameter and hands it to the
 * client form. Reading search params on the server avoids the `useSearchParams`
 * suspense requirement entirely, and keeps the redirect target a plain string.
 */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly next?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = params.next;
  const nextPath = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : null;

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-card__head">
          <h1 className="login-card__title">
            <span className="app-brand__mark" aria-hidden="true" />
            INTELLIGENZ
          </h1>
          <p className="login-card__subtitle">
            Control centre — sign in with the credentials issued to your account.
          </p>
        </div>
        <LoginForm nextPath={nextPath} />
      </div>
    </main>
  );
}
