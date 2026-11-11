import Constants from 'expo-constants';

/** The web app for this build (EAS profile env EXPO_PUBLIC_WEB_URL → app.config extra.webUrl): terms, privacy, store links. */
export const WEB_URL = ((Constants.expoConfig?.extra?.webUrl as string | undefined) ?? 'https://sell.innovative.ng').replace(/\/+$/, '');
/** "sell.innovative.ng" — for showing store links. */
export const WEB_HOST = WEB_URL.replace(/^https?:\/\//, '');
