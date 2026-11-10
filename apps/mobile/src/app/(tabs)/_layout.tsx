import { router, Tabs } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Text, type ColorValue } from 'react-native';
import { c } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  const { can, workspace } = useAuth();
  const { prefs } = useTheme();
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
      tabBarActiveTintColor: c.brand, tabBarInactiveTintColor: c.ink3, headerTitleStyle: { color: c.ink }, headerTitle: workspace?.businessName ?? 'LiveSell',
      headerStyle: { backgroundColor: c.surface }, sceneStyle: { backgroundColor: c.canvas },
      tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.line, ...(c.depth ? { elevation: 12, shadowColor: c.shadow, shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: -3 } } : {}) },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('◎') }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: icon('☰'), href: can('orders:read') ? undefined : null }} />
      <Tabs.Screen name="live" options={{ title: 'Live', tabBarIcon: icon('●'), href: can('live:read') ? undefined : null }} />
      <Tabs.Screen name="products" options={{ title: 'Stock', tabBarIcon: icon('▦'), href: can('products:read') ? undefined : null }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('⋯') }} />
    </Tabs>
  );
}
