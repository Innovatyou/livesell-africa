import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { c } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  const { can, workspace } = useAuth();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: c.brand, headerTitleStyle: { color: c.ink }, headerTitle: workspace?.businessName ?? 'LiveSell' }}>
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('◎') }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: icon('☰'), href: can('orders:read') ? undefined : null }} />
      <Tabs.Screen name="live" options={{ title: 'Live', tabBarIcon: icon('●'), href: can('live:read') ? undefined : null }} />
      <Tabs.Screen name="products" options={{ title: 'Stock', tabBarIcon: icon('▦'), href: can('products:read') ? undefined : null }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('⋯') }} />
    </Tabs>
  );
}
