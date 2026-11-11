import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic config over app.json. Secrets and per-build values come from the environment (EAS build env / file vars):
 *  - GOOGLE_SERVICES_JSON: path to the Firebase Android config (EAS "file" environment variable). Local builds fall back
 *    to ./google-services.json, which is git-ignored.
 *  - EAS_PROJECT_ID: set by `eas init`; needed for Expo push tokens.
 *  - EXPO_PUBLIC_WEB_URL: the web app (terms, privacy, store links) for this build profile; EXPO_PUBLIC_API_URL: the API.
 *  - ALLOW_CLEARTEXT=1: only the `local` EAS profile (API over USB at http://localhost:4000). Store builds stay https-only.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'LiveSell',
  slug: config.slug ?? 'livesell-seller',
  android: { ...config.android, googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json' },
  plugins: [
    ...(config.plugins ?? []),
    ...(process.env.ALLOW_CLEARTEXT === '1' ? [['expo-build-properties', { android: { usesCleartextTraffic: true } }] as [string, object]] : []),
  ],
  extra: { ...config.extra, webUrl: process.env.EXPO_PUBLIC_WEB_URL || config.extra?.webUrl, eas: { ...(config.extra?.eas ?? {}), ...(process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : {}) } },
});
