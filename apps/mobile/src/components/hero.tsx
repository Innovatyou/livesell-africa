import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Text, View } from 'react-native';
import { c } from '@/lib/tokens';
import { useTheme } from '@/lib/theme';

/**
 * The 3D brand mark: stacked tiles in perspective that float and tilt gently (React Native Animated, native driver).
 * Respects "reduce motion". Decorative, so hidden from screen readers.
 */
export function Hero3D({ size = 120 }: { size?: number }) {
  useTheme();
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) return;
      loop = Animated.loop(Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]));
      loop.start();
    });
    return () => loop?.stop();
  }, [t]);

  const rotY = t.interpolate({ inputRange: [0, 1], outputRange: ['-14deg', '14deg'] });
  const lift = t.interpolate({ inputRange: [0, 1], outputRange: [0, -8] });
  const tile = (scale: number, opacity: number, offset: number, color: string) => (
    <Animated.View style={{
      position: 'absolute', width: size * scale, height: size * scale, borderRadius: size * 0.28 * scale, backgroundColor: color, opacity,
      transform: [{ perspective: 600 }, { translateY: Animated.add(lift, offset) }, { rotateX: '18deg' }, { rotateY: rotY }, { rotateZ: '-8deg' }],
      shadowColor: c.shadow, shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 12 }, elevation: 8,
    }} />
  );

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size * 1.4, height: size * 1.3, alignItems: 'center', justifyContent: 'center' }}>
      {tile(1.1, 0.18, 26, c.brand)}
      {tile(1, 0.35, 13, c.brand)}
      <Animated.View style={{
        width: size, height: size, borderRadius: size * 0.28, backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center',
        transform: [{ perspective: 600 }, { translateY: lift }, { rotateX: '18deg' }, { rotateY: rotY }, { rotateZ: '-8deg' }],
        shadowColor: c.brand, shadowOpacity: 0.45, shadowRadius: 20, shadowOffset: { width: 0, height: 14 }, elevation: 12,
      }}>
        <Text style={{ fontSize: size * 0.42, color: c.onBrand, fontWeight: '900' }}>▶</Text>
        <View style={{ position: 'absolute', top: size * 0.14, right: size * 0.14, width: size * 0.13, height: size * 0.13, borderRadius: 99, backgroundColor: '#ff4d4f', borderWidth: 2, borderColor: c.onBrand }} />
      </Animated.View>
    </View>
  );
}
