import { useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, Text, TextInput, View, useWindowDimensions,
  type TextInputProps, type ViewStyle,
} from 'react-native';
import type { Tone } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { c } from '@/lib/tokens';

export { c };

const tone = (t: Tone): [string, string] =>
  ({ neutral: [c.ink2, c.sunken], good: [c.good, c.goodBg], warn: [c.warn, c.warnBg], bad: [c.bad, c.badBg], info: [c.info, c.infoBg] })[t] as [string, string];

/** Raised "3D" surface (soft shadow + elevation) or a flat bordered one, per the seller's preference. */
export const depth = (level = 1): ViewStyle =>
  c.depth
    ? { shadowColor: c.shadow, shadowOpacity: c.dark ? 0.5 : 0.1 + level * 0.03, shadowRadius: 6 + level * 6, shadowOffset: { width: 0, height: 2 + level * 3 }, elevation: 2 + level * 3, borderWidth: c.dark ? 1 : 0, borderColor: c.line }
    : { borderWidth: 1, borderColor: c.line };

/** Screen scroll container. On tablets and wide phones the content is centred at a readable width. */
export function Screen({ children, refreshing, onRefresh }: { children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  useTheme();
  const { width } = useWindowDimensions();
  const pad = width > 720 ? (width - 680) / 2 : 16;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.canvas }} contentContainerStyle={{ paddingHorizontal: pad, paddingVertical: 16, gap: 12 }} keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.brand} colors={[c.brand]} progressBackgroundColor={c.surface} /> : undefined}>
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  useTheme();
  return <View style={[{ backgroundColor: c.surface, borderRadius: c.depth ? 16 : 12, padding: 14 }, depth(1), style]}>{children}</View>;
}

export const H1 = ({ children }: { children: React.ReactNode }) => <Text style={{ fontSize: 24, fontWeight: '800', color: c.ink, letterSpacing: -0.3 }}>{children}</Text>;
export const Muted = ({ children }: { children: React.ReactNode }) => <Text style={{ fontSize: 13, color: c.ink3 }}>{children}</Text>;
export const Label = ({ children }: { children: React.ReactNode }) => <Text style={{ fontSize: 13, fontWeight: '600', color: c.ink2 }}>{children}</Text>;

export function Badge({ tone: t = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  const [fg, bg] = tone(t);
  return <Text style={{ fontSize: 12, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden', alignSelf: 'flex-start', color: fg, backgroundColor: bg }}>{children}</Text>;
}

/** Press feedback: a quick spring "push in" that reads as a physical button. */
function usePress() {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  return { scale, onPressIn: () => to(0.96), onPressOut: () => to(1) };
}

export function Button({ title, onPress, loading, disabled, variant = 'primary' }: { title: string; onPress: () => void; loading?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger' }) {
  useTheme();
  const p = usePress();
  const bg = variant === 'primary' ? c.brand : variant === 'danger' ? c.bad : c.surface;
  const fg = variant === 'secondary' ? c.ink : variant === 'primary' ? c.onBrand : '#fff';
  const lift: ViewStyle = c.depth && variant !== 'secondary' && !disabled ? { shadowColor: bg, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 5 } : {};
  return (
    <Animated.View style={{ transform: [{ scale: p.scale }], opacity: disabled ? 0.5 : 1 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }} onPress={onPress} disabled={disabled || loading}
        onPressIn={p.onPressIn} onPressOut={p.onPressOut}
        style={[{ minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, backgroundColor: bg, borderWidth: variant === 'secondary' ? 1 : 0, borderColor: c.line }, lift]}>
        {loading ? <ActivityIndicator color={fg} /> : <Text style={{ fontSize: 15, fontWeight: '700', color: fg }}>{title}</Text>}
      </Pressable>
    </Animated.View>
  );
}

/** Text field. `password` adds a Show / Hide toggle so the seller can check what they typed. */
export function Field({ label, error, password, ...props }: TextInputProps & { label: string; error?: string | null; password?: boolean }) {
  useTheme();
  const [visible, setVisible] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Label>{label}</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, borderWidth: focus ? 2 : 1, borderColor: error ? c.bad : focus ? c.brand : c.line, borderRadius: 12, backgroundColor: c.surface, paddingLeft: focus ? 11 : 12 }}>
        <TextInput placeholderTextColor={c.ink3} {...props} secureTextEntry={password ? !visible : props.secureTextEntry} accessibilityLabel={label}
          onFocus={(e) => { setFocus(true); props.onFocus?.(e); }} onBlur={(e) => { setFocus(false); props.onBlur?.(e); }}
          style={[{ flex: 1, fontSize: 15, color: c.ink, paddingVertical: 10 }, props.style]} />
        {password ? (
          <Pressable onPress={() => setVisible((v) => !v)} accessibilityRole="button" accessibilityLabel={visible ? 'Hide password' : 'Show password'} hitSlop={8} style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
            <Text style={{ color: c.brand, fontWeight: '700', fontSize: 13 }}>{visible ? 'Hide' : 'Show'}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={{ color: c.bad, fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

export function Notice({ tone: t = 'info', children }: { tone?: Tone; children: React.ReactNode }) {
  const [fg, bg] = tone(t);
  return <Text style={{ padding: 12, borderRadius: 12, fontSize: 14, overflow: 'hidden', color: fg, backgroundColor: bg }}>{children}</Text>;
}

/** Segmented choice (radio group) for settings. */
export function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map(([k, l]) => {
        const on = k === value;
        return (
          <Pressable key={k} onPress={() => onChange(k)} accessibilityRole="radio" accessibilityState={{ selected: on }}
            style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: on ? c.brand : c.line, backgroundColor: on ? c.brandSoft : c.surface }}>
            <Text style={{ color: on ? c.brand : c.ink2, fontWeight: on ? '700' : '500' }}>{l}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export const Loading = () => <View style={{ padding: 32, flex: 1, backgroundColor: c.canvas }}><ActivityIndicator color={c.brand} /></View>;

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Card style={{ gap: 10 }}><Text style={{ color: c.bad }}>{message}</Text>{onRetry ? <Button variant="secondary" title="Try again" onPress={onRetry} /> : null}</Card>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return <Card style={{ alignItems: 'center', gap: 4 }}><Text style={{ fontWeight: '600', color: c.ink }}>{title}</Text>{hint ? <Muted>{hint}</Muted> : null}</Card>;
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, style]}>{children}</View>;
}
