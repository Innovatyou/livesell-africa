import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic config over app.json. Secrets and per-build values come from the environment (EAS build env / file vars):
 *  - GOOGLE_SERVICES_JSON: path to the Firebase Android config (EAS "file" environment variable). Local builds fall back
 *    to ./google-services.json, which is git-ignored.
 *  - EAS_PROJECT_ID: set by `eas init`; needed for Expo push tokens.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'LiveSell',
  slug: config.slug ?? 'livesell-seller',
  android: { ...config.android, googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json' },
  extra: { ...config.extra, eas: { ...(config.extra?.eas ?? {}), ...(process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : {}) } },
});
