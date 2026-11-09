# apps/web — LiveSell Africa frontend

Next.js 16 (App Router), React 19, TypeScript, Tailwind v4. Talks to `apps/api` directly with credentials.

```bash
cp .env.example .env.local     # NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev                    # http://localhost:3000
npm test                       # Vitest
npx tsc --noEmit && npx next build
```

- `src/app/(marketing)` landing (lazy 3D hero), pricing, terms, privacy
- `src/app/(auth)` register, login, password reset, email verification, invitation acceptance
- `src/app/(app)` onboarding, dashboard, settings (store, team, billing, verification) — behind the session gate
- `src/lib/api.ts` API client: access token in memory, single-flight refresh via the httpOnly cookie
- `src/lib/money.ts` kobo formatting with BigInt only
- `src/components/ui.tsx` design-system components; tokens in `src/app/globals.css`
