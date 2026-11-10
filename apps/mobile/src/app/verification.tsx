import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Muted, Notice, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

interface Status {
  verifiedAt: string | null;
  businessType: string;
  latest: null | { status: 'PENDING' | 'APPROVED' | 'REJECTED'; registeredName: string; registrationType: string; registrationNumber: string; rejectionReason: string | null; createdAt: string };
}
const TYPES: Array<[string, string]> = [['CAC_RC', 'Limited company (RC)'], ['CAC_BN', 'Business name (BN)'], ['OTHER', 'Other']];
const IMAGE_TYPES = ['image/jpeg', 'image/png'];
const MAX = 5 * 1024 * 1024;
const date = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s));

/** CAC business verification: registered name, RC/BN number and a photo of the certificate (same API as the web). */
export default function Verification() {
  useTheme();
  const { can } = useAuth();
  const allowed = can('store:manage');
  const status = useApi<Status>(allowed ? '/business-verification' : null);
  const [name, setName] = useState('');
  const [type, setType] = useState('CAC_RC');
  const [number, setNumber] = useState('');
  const [photo, setPhoto] = useState<{ uri: string; type: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!allowed) return <Screen><Empty title="Only the owner can verify the business" /></Screen>;
  if (status.error) return <Screen><ErrorBox message={status.error} onRetry={status.reload} /></Screen>;
  if (!status.data) return <Screen><Loading /></Screen>;
  const s = status.data;
  const numberOk = /^[A-Za-z0-9-]{4,20}$/.test(number.trim());

  async function pick(camera: boolean) {
    setError(null);
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return setError(camera ? 'Allow camera access in Settings.' : 'Allow photo access in Settings.');
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8 };
    const res = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    const a = res.canceled ? null : res.assets?.[0];
    if (a) setPhoto({ uri: a.uri, type: a.mimeType ?? 'image/jpeg' });
  }

  async function submit() {
    if (!photo) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await (await fetch(photo.uri)).blob();
      const contentType = IMAGE_TYPES.includes(photo.type) ? photo.type : blob.type;
      if (!IMAGE_TYPES.includes(contentType)) throw new Error('Use a JPG or PNG photo of the certificate.');
      if (blob.size > MAX) throw new Error('The photo must be 5 MB or smaller.');
      const up = await api<{ uploadUrl: string; key: string; headers: Record<string, string> }>('/business-verification/upload-url', { method: 'POST', body: { contentType, contentLength: blob.size } });
      const put = await fetch(up.uploadUrl, { method: 'PUT', body: blob, headers: up.headers });
      if (!put.ok) throw new Error('The certificate could not be uploaded. Try again.');
      await api('/business-verification', { method: 'POST', body: { registeredName: name.trim(), registrationType: type, registrationNumber: number.trim(), documentKey: up.key } });
      setDone(true);
      status.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const showForm = !s.verifiedAt && s.latest?.status !== 'PENDING';
  return (
    <Screen refreshing={false} onRefresh={status.reload}>
      <Muted>Optional. Verified businesses get a badge on their store page.</Muted>
      {done ? <Notice tone="good">Submitted for review. This usually takes 1–2 business days.</Notice> : null}
      {s.verifiedAt ? <Notice tone="good">Your business is verified (since {date(s.verifiedAt)}).</Notice> : null}
      {!s.verifiedAt && s.latest?.status === 'PENDING' ? (
        <Card style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Text style={{ fontWeight: '600', color: c.ink }}>Under review</Text><Badge tone="info">Pending</Badge></View>
          <Muted>{s.latest.registeredName} · {s.latest.registrationNumber} · sent {date(s.latest.createdAt)}</Muted>
        </Card>
      ) : null}
      {showForm ? (
        <Card style={{ gap: 10 }}>
          {s.latest?.status === 'REJECTED' ? <Notice tone="bad">Not approved: {s.latest.rejectionReason ?? 'please check your details and try again.'}</Notice> : null}
          {s.businessType === 'INDIVIDUAL' ? <Notice tone="info">You signed up as an individual seller. Verification is for CAC-registered businesses.</Notice> : null}
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Field label="Registered business name (as on the certificate)" value={name} onChangeText={setName} />
          <Text style={{ fontWeight: '600', color: c.ink2 }}>Registration type</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {TYPES.map(([k, l]) => (
              <Pressable key={k} onPress={() => setType(k)} accessibilityRole="radio" accessibilityState={{ selected: type === k }}
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: type === k ? c.brand : c.line, backgroundColor: type === k ? c.brandSoft : c.surface }}>
                <Text style={{ color: type === k ? c.brand : c.ink2 }}>{l}</Text>
              </Pressable>
            ))}
          </View>
          <Field label={type === 'CAC_BN' ? 'BN number' : type === 'CAC_RC' ? 'RC number' : 'Registration number'} value={number} onChangeText={setNumber}
            autoCapitalize="characters" placeholder={type === 'CAC_BN' ? 'BN1234567' : 'RC1234567'} error={number && !numberOk ? '4–20 letters, numbers or hyphens' : null} />
          <Text style={{ fontWeight: '600', color: c.ink2 }}>CAC certificate</Text>
          {photo ? <Image source={{ uri: photo.uri }} style={{ width: '100%', height: 180, borderRadius: 8, backgroundColor: c.line }} resizeMode="contain" /> : <Muted>A clear photo of the whole certificate (JPG or PNG, up to 5 MB). Stored privately; only LiveSell reviewers see it. PDF? Upload it on the web.</Muted>}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Button title="Take photo" variant="secondary" onPress={() => void pick(true)} /></View>
            <View style={{ flex: 1 }}><Button title={photo ? 'Choose another' : 'Choose photo'} variant="secondary" onPress={() => void pick(false)} /></View>
          </View>
          <Button title="Submit for review" onPress={() => void submit()} loading={busy} disabled={name.trim().length < 2 || !numberOk || !photo} />
        </Card>
      ) : null}
    </Screen>
  );
}
