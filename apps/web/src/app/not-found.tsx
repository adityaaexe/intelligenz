import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Not found',
};

export default function NotFound() {
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-card__head">
          <h1 className="login-card__title">That route does not exist</h1>
          <p className="login-card__subtitle">
            Every screen lives under <span className="iz-mono">/&#123;workspace&#125;/&#123;module&#125;</span>.
            If you followed a link to a module this build does not know, the module register in
            <span className="iz-mono"> lib/nav.ts</span> is the list of what does.
          </p>
        </div>
        <Link className="iz-btn" href="/" data-variant="primary" data-size="lg">
          <span className="iz-btn__label">Go to the control centre</span>
        </Link>
      </div>
    </main>
  );
}
