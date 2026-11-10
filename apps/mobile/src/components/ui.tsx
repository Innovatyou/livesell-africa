import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, Text, TextInput, View, useWindowDimensions,
  type TextInputProps, type ViewStyle,
} from 'react-native';
import type { Tone } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { c } from '@/lib/tokens';

export { c };

export type IconName = React.ComponentProps<typeof Ionicons>['name'];
/** Ionicons (bundled with Expo). Decorative unless a label is given. */
export function Icon({ name, size = 20, color, label }: { name: IconName; size?: number; color?: string; label?: string }) {
  return <Ionicons name={name} size={size} color={color ?? c.ink2} accessibilityLabel={label} accessibilityElementsHidden={!label} importantForAccessibility={label ? 'yes' : 'no-hide-descendants'} />;
}
const tap = () => { void Haptics.selectionAsync().catch(() => undefined); };

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

export function Button({ title, onPress, loading, disabled, variant = 'primary', icon }: { title: string; onPress: () => void; loading?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger'; icon?: IconName }) {
  useTheme();
  const p = usePress();
  const bg = variant === 'primary' ? c.brand : variant === 'danger' ? c.bad : c.surface;
  const fg = variant === 'secondary' ? c.ink : variant === 'primary' ? c.onBrand : '#fff';
  const lift: ViewStyle = c.depth && variant !== 'secondary' && !disabled ? { shadowColor: bg, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 5 } : {};
  return (
    <Animated.View style={{ transform: [{ scale: p.scale }], opacity: disabled ? 0.5 : 1 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }} onPress={() => { tap(); onPress(); }} disabled={disabled || loading}
        onPressIn={p.onPressIn} onPressOut={p.onPressOut}
        style={[{ minHeight: 48, borderRadius: 14, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, backgroundColor: bg, borderWidth: variant === 'secondary' ? 1 : 0, borderColor: c.line }, lift]}>
        {loading ? <ActivityIndicator color={fg} /> : <>{icon ? <Ionicons name={icon} size={18} color={fg} /> : null}<Text style={{ fontSize: 15, fontWeight: '700', color: fg }}>{title}</Text></>}
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

const NOTICE_ICON: Record<Tone, IconName> = { neutral: 'information-circle', info: 'information-circle', good: 'checkmark-circle', warn: 'alert-circle', bad: 'close-circle' };
export function Notice({ tone: t = 'info', children }: { tone?: Tone; children: React.ReactNode }) {
  const [fg, bg] = tone(t);
  return (
    <View accessibilityRole={t === 'bad' ? 'alert' : undefined} style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14, backgroundColor: bg, alignItems: 'flex-start' }}>
      <Ionicons name={NOTICE_ICON[t]} size={20} color={fg} style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: fg }}>{children}</Text>
    </View>
  );
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

export function Empty({ title, hint, icon = 'sparkles-outline', action }: { title: string; hint?: string; icon?: IconName; action?: { title: string; onPress: () => void } }) {
  return (
    <Card style={{ alignItems: 'center', gap: 8, paddingVertical: 24 }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.brandSoft, alignItems: 'center', justifyContent: 'center' }}><Ionicons name={icon} size={26} color={c.brand} /></View>
      <Text style={{ fontWeight: '700', color: c.ink, fontSize: 16, textAlign: 'center' }}>{title}</Text>
      {hint ? <Text style={{ color: c.ink3, textAlign: 'center', lineHeight: 20 }}>{hint}</Text> : null}
      {action ? <View style={{ alignSelf: 'stretch', marginTop: 4 }}><Button title={action.title} onPress={action.onPress} /></View> : null}
    </Card>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, style]}>{children}</View>;
}

/** Small heading above a group of cards. */
export function SectionTitle({ children, action }: { children: React.ReactNode; action?: { title: string; onPress: () => void } }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
      <Text accessibilityRole="header" style={{ fontSize: 13, fontWeight: '800', color: c.ink3, letterSpacing: 0.6, textTransform: 'uppercase' }}>{children}</Text>
      {action ? <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button"><Text style={{ color: c.brand, fontWeight: '700' }}>{action.title}</Text></Pressable> : null}
    </View>
  );
}

/** Initials in a coloured circle (customers, staff). */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: c.brand, fontWeight: '800', fontSize: size * 0.38 }}>{initials}</Text>
    </View>
  );
}

/** Icon in a soft rounded square. */
export function IconBadge({ name, color, size = 40 }: { name: IconName; color?: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: color ? `${color}22` : c.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={size * 0.5} color={color ?? c.brand} />
    </View>
  );
}

/** Tappable row: icon, title, subtitle, optional right side and chevron. */
export function ListRow({ icon, iconColor, title, subtitle, right, onPress, left }: {
  icon?: IconName; iconColor?: string; title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; left?: React.ReactNode;
}) {
  useTheme();
  return (
    <Pressable onPress={onPress ? () => { tap(); onPress(); } : undefined} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, opacity: pressed ? 0.7 : 1 })}>
      {left ?? (icon ? <IconBadge name={icon} color={iconColor} size={38} /> : null)}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={{ color: c.ink3, fontSize: 13 }} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right}
      {onPress ? <Ionicons name="chevron-forward" size={18} color={c.ink3} /> : null}
    </Pressable>
  );
}

/** Figure tile for dashboards. */
export function StatTile({ label, value, icon, tint, onPress, hint }: { label: string; value: string; icon: IconName; tint?: string; onPress?: () => void; hint?: string }) {
  useTheme();
  return (
    <Pressable onPress={onPress ? () => { tap(); onPress(); } : undefined} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={`${label}: ${value}`} style={{ flexBasis: '47%', flexGrow: 1 }}>
      <Card style={{ gap: 10 }}>
        <Row><IconBadge name={icon} color={tint} size={34} />{onPress ? <Ionicons name="arrow-forward" size={16} color={c.ink3} /> : null}</Row>
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: c.ink, letterSpacing: -0.3 }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
          <Text style={{ color: c.ink3, fontSize: 13 }}>{label}</Text>
          {hint ? <Text style={{ color: c.ink3, fontSize: 12 }}>{hint}</Text> : null}
        </View>
      </Card>
    </Pressable>
  );
}

/** Brand gradient header card (greeting, hero figures). Stays readable in light and dark mode (white on deep brand). */
export function Hero({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  useTheme();
  const from = c.dark ? '#0b3d27' : c.brand;
  const to = c.dark ? '#06261a' : '#0a5a39';
  return (
    <LinearGradient colors={[from, to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ borderRadius: 22, padding: 18, gap: 8, overflow: 'hidden' }, depth(2), style]}>
      <View pointerEvents="none" style={{ position: 'absolute', right: -40, top: -40, width: 160, height: 160, borderRadius: 80, backgroundColor: 'rgba(255,255,255,0.08)' }} />
      <View pointerEvents="none" style={{ position: 'absolute', right: 30, bottom: -60, width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(255,255,255,0.06)' }} />
      {children}
    </LinearGradient>
  );
}

/** Search box with icon and clear button. Searches on submit (or as you type when `live`). */
export function SearchBar({ value, onChangeText, onSubmit, placeholder }: { value: string; onChangeText: (v: string) => void; onSubmit?: () => void; placeholder: string }) {
  useTheme();
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, borderRadius: 14, paddingHorizontal: 12, backgroundColor: c.surface }, depth(0)]}>
      <Ionicons name="search" size={18} color={c.ink3} />
      <TextInput value={value} onChangeText={onChangeText} onSubmitEditing={onSubmit} placeholder={placeholder} placeholderTextColor={c.ink3} returnKeyType="search" accessibilityLabel={placeholder}
        style={{ flex: 1, color: c.ink, fontSize: 15, paddingVertical: 10 }} autoCapitalize="none" autoCorrect={false} />
      {value ? <Pressable onPress={() => { onChangeText(''); setTimeout(() => onSubmit?.(), 0); }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search"><Ionicons name="close-circle" size={18} color={c.ink3} /></Pressable> : null}
    </View>
  );
}

/** Horizontal filter chips. */
export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map(([k, l]) => {
        const on = k === value;
        return (
          <Pressable key={k} onPress={() => { tap(); onChange(k); }} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: on ? c.brand : c.surface, borderWidth: on ? 0 : 1, borderColor: c.line }}>
            <Text style={{ color: on ? c.onBrand : c.ink2, fontWeight: on ? '700' : '500' }}>{l}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Progress bar (Academy, onboarding). */
export function Progress({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }} style={{ height: 8, borderRadius: 4, backgroundColor: c.sunken, overflow: 'hidden' }}>
      <View style={{ width: `${pct * 100}%`, height: '100%', borderRadius: 4, backgroundColor: c.brand }} />
    </View>
  );
}

