/**
 * Package identity only.
 *
 * The application entry point is `src/main.ts` (`pnpm --filter @intelligenz/api
 * dev|start`); the testable app factory is `src/app.factory.ts`. This module is not
 * imported by either — it exists so `@intelligenz/api` can be referenced as a
 * workspace package without pulling in the Nest bootstrap, which would open a
 * database pool and bind a port as an import side effect.
 */
export const APP_NAME = '@intelligenz/api' as const;
