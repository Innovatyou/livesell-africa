import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Tabs } from 'expo-router';
import { useEffect, useRef } from 'react';
import { type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { c } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

type Glyph = React.ComponentProps<typeof Ionicons>['name'];
const icon = (on: Glyph, off: Glyph) => ({ color, focused, size }: { color: ColorValue; focused: boolean; size: number }) => <Ionicons name={focused ? on : off} size={size} color={color as string} />;

export default function TabsLayout() {
  const { can, workspace } = useAuth();
  const { prefs } = useTheme();
  // Sit above Android's navigation buttons / gesture bar and the iPhone home indicator (edge-to-edge).
  const insets = useSafeAreaInsets();
  // Open on the seller's chosen start screen once per app start (if they can see it).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const perm = { index: null, orders: 'orders:read', live: 'live:read', products: 'products:read' }[prefs.startTab];
    if (prefs.startTab !== 'index' && (!perm || can(perm))) router.navigate(`/(tabs)/${prefs.startTab}` as never);
  }, [prefs.startTab]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Tabs screenOptions={{
      tabBarActiveTintColor: c.brand, tabBarInactiveTintColor: c.ink3, headerTitleStyle: { color: c.ink, fontWeight: '800' }, headerTitle: workspace?.businessName ?? 'LiveSell',
      headerStyle: { backgroundColor: c.canvas }, headerShadowVisible: false, sceneStyle: { backgroundColor: c.canvas },
      tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      tabBarStyle: {
        backgroundColor: c.surface, borderTopColor: c.line, height: 60 + insets.bottom, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8),
        ...(c.depth ? { elevation: 16, shadowColor: c.shadow, shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: -4 } } : {}),
      },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('home', 'home-outline') }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: icon('receipt', 'receipt-outline'), href: can('orders:read') ? undefined : null }} />
      <Tabs.Screen name="live" options={{ title: 'Live', tabBarIcon: icon('radio', 'radio-outline'), href: can('live:read') ? undefined : null }} />
      <Tabs.Screen name="products" options={{ title: 'Stock', tabBarIcon: icon('cube', 'cube-outline'), href: can('products:read') ? undefined : null }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('grid', 'grid-outline') }} />
    </Tabs>
  );
}
