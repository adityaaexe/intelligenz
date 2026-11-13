'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { Banner, Button, Field, Input } from '@intelligenz/design-system';

import { ApiClient, ApiError } from '../lib/api';
import { defaultScopeHref, readSession, saveFromLogin, sessionExpired } from '../lib/session';

/**
 * Sign-in against `POST /v1/auth/login`.
 *
 * The API returns one identical 401 for an unknown email and a wrong password
 * (`api-contract.md` §4), so this form must not try to be more specific than the
 * server: it says the pair did not match, which is exactly what the server is
 * willing to disclose.
 */
export function LoginForm({ nextPath }: { readonly nextPath: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Already signed in: skip the form.
  useEffect(() => {
    const session = readSession();
    if (session !== null && !sessionExpired(session)) {
      router.replace(nextPath ?? defaultScopeHref(session));
    }
  }, [nextPath, router]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const client = new ApiClient();
      const response = await client.login(email.trim(), password);
      const session = saveFromLogin(response);
      router.replace(nextPath ?? defaultScopeHref(session));
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError('UNKNOWN', 0, 'Sign-in failed for an unexpected reason.'),
      );
      setPending(false);
    }
  };

  return (
    <form className="login-form" onSubmit={submit} noValidate>
      {error !== null ? (
        <Banner
          variant="error"
          title={
            error.isNetwork
              ? 'The API could not be reached.'
              : error.code === 'UNAUTHORIZED'
                ? 'That email and password did not match an account.'
                : error.message
          }
          announce
        >
          {error.correlationId !== null ? (
            <span className="iz-mono">Correlation {error.correlationId}</span>
          ) : null}
        </Banner>
      ) : null}

      <Field id="email" label="Email" required hint="Lower-case; stored normalised by the API.">
        {(args) => (
          <Input
            {...args}
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        )}
      </Field>

      <Field id="password" label="Password" required>
        {(args) => (
          <Input
            {...args}
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>

      <Button type="submit" variant="primary" size="lg" loading={pending}>
        Sign in
      </Button>

      <p className="iz-field__hint">
        The access token is valid for 15 minutes. There is no refresh endpoint in this phase, so
        the session ends and you sign in again.
      </p>
    </form>
  );
}
