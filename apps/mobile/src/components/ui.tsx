import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import type { Tone } from '@/lib/format';

/** Design tokens shared with the web app (apps/web/src/app/globals.css). */
export const c = {
  brand: '#0e7a4d', brandSoft: '#e7f4ee', ink: '#17201b', ink2: '#3d4842', ink3: '#6b7570', line: '#e3e6e4', canvas: '#f6f7f6', surface: '#ffffff',
  good: '#0e7a4d', goodBg: '#e7f4ee', warn: '#8a5a00', warnBg: '#fdf5e3', bad: '#b42318', badBg: '#fdf0ee', info: '#1d5fa8', infoBg: '#eaf2fb',
};
const toneColors: Record<Tone, [string, string]> = { neutral: [c.ink2, '#eef0ef'], good: [c.good, c.goodBg], warn: [c.warn, c.warnBg], bad: [c.bad, c.badBg], info: [c.info, c.infoBg] };

export function Screen({ children, refreshing, onRefresh }: { children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.canvas }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.brand} /> : undefined}>
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export const H1 = ({ children }: { children: React.ReactNode }) => <Text style={s.h1}>{children}</Text>;
export const Muted = ({ children }: { children: React.ReactNode }) => <Text style={s.muted}>{children}</Text>;
export const Label = ({ children }: { children: React.ReactNode }) => <Text style={s.label}>{children}</Text>;

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  const [fg, bg] = toneColors[tone];
  return <Text style={[s.badge, { color: fg, backgroundColor: bg }]}>{children}</Text>;
}

export function Button({ title, onPress, loading, disabled, variant = 'primary' }: { title: string; onPress: () => void; loading?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger' }) {
  const bg = variant === 'primary' ? c.brand : variant === 'danger' ? c.bad : c.surface;
  const fg = variant === 'secondary' ? c.ink : '#fff';
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }} onPress={onPress} disabled={disabled || loading}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1, borderWidth: variant === 'secondary' ? 1 : 0 }]}>
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string | null }) {
  return (
    <View style={{ gap: 4 }}>
      <Label>{label}</Label>
      <TextInput placeholderTextColor={c.ink3} {...props} style={[s.input, error ? { borderColor: c.bad } : null, props.style]} accessibilityLabel={label} />
      {error ? <Text style={{ color: c.bad, fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

export function Notice({ tone = 'info', children }: { tone?: Tone; children: React.ReactNode }) {
  const [fg, bg] = toneColors[tone];
  return <Text style={[s.notice, { color: fg, backgroundColor: bg }]}>{children}</Text>;
}

export const Loading = () => <View style={{ padding: 32 }}><ActivityIndicator color={c.brand} /></View>;

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Card style={{ gap: 10 }}><Text style={{ color: c.bad }}>{message}</Text>{onRetry ? <Button variant="secondary" title="Try again" onPress={onRetry} /> : null}</Card>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return <Card style={{ alignItems: 'center', gap: 4 }}><Text style={{ fontWeight: '600', color: c.ink }}>{title}</Text>{hint ? <Muted>{hint}</Muted> : null}</Card>;
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, style]}>{children}</View>;
}

const s = StyleSheet.create({
  card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 14 },
  h1: { fontSize: 22, fontWeight: '700', color: c.ink },
  muted: { fontSize: 13, color: c.ink3 },
  label: { fontSize: 13, fontWeight: '600', color: c.ink2 },
  badge: { fontSize: 12, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden', alignSelf: 'flex-start' },
  btn: { minHeight: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderColor: c.line },
  btnText: { fontSize: 15, fontWeight: '600' },
  input: { minHeight: 46, borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, color: c.ink, backgroundColor: c.surface },
  notice: { padding: 10, borderRadius: 10, fontSize: 14, overflow: 'hidden' },
});
