import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

/**
 * Biometric unlock (fingerprint / face). The session itself is the rotating refresh token already in the secure store;
 * biometrics only gate opening the app with it. No password is ever stored on the phone.
 */
const ENABLED = 'ls.biometric';
const ASKED = 'ls.biometric.asked';
const REMEMBER = 'ls.login.identifier';
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export interface BiometricSupport { available: boolean; label: string }

export async function support(): Promise<BiometricSupport> {
  try {
    const [hw, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync(), LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    return { available: hw && enrolled, label: face ? 'face unlock' : 'fingerprint' };
  } catch {
    return { available: false, label: 'fingerprint' };
  }
}

export const isEnabled = async () => (await SecureStore.getItemAsync(ENABLED, OPTS)) === '1';
export const wasAsked = async () => (await SecureStore.getItemAsync(ASKED, OPTS)) === '1';
export async function setEnabled(on: boolean) {
  await SecureStore.setItemAsync(ASKED, '1', OPTS);
  if (on) await SecureStore.setItemAsync(ENABLED, '1', OPTS);
  else await SecureStore.deleteItemAsync(ENABLED, OPTS);
}

/** Shows the system prompt. The device PIN/pattern is offered as a fallback by the OS. */
export async function authenticate(reason = 'Unlock LiveSell'): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: 'Use password', disableDeviceFallback: false });
    return r.success;
  } catch {
    return false;
  }
}

/** "Remember me": the email or phone used last, to prefill sign-in. Never the password. */
export const rememberedIdentifier = () => SecureStore.getItemAsync(REMEMBER, OPTS);
export async function rememberIdentifier(value: string | null) {
  if (value) await SecureStore.setItemAsync(REMEMBER, value, OPTS);
  else await SecureStore.deleteItemAsync(REMEMBER, OPTS);
}
