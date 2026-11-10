import { Pressable, Text, View } from 'react-native';
import { Hero3D } from '@/components/hero';
import { Badge, Card, Choice, Muted, Row, Screen, c, depth } from '@/components/ui';
import { ACCENTS, type Prefs, useTheme } from '@/lib/theme';

/** Make the app yours: light/dark, accent colour, raised (3D) or flat cards, and the screen it opens on. Saved on this phone. */
export default function Appearance() {
  const { prefs, set, dark } = useTheme();
  return (
    <Screen>
      <Card style={{ alignItems: 'center', gap: 8, paddingVertical: 20 }}>
        <Hero3D size={72} />
        <Text style={{ color: c.ink, fontWeight: '700' }}>Preview</Text>
        <Row style={{ gap: 8, justifyContent: 'center' }}><Badge tone="good">Paid</Badge><Badge tone="warn">Awaiting payment</Badge><Badge tone="info">New</Badge></Row>
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={{ color: c.ink, fontWeight: '700' }}>Theme</Text>
        <Choice<Prefs['mode']> label="Theme" value={prefs.mode} onChange={(mode) => set({ mode })} options={[['system', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']]} />
        <Muted>{prefs.mode === 'system' ? `Following your phone (now ${dark ? 'dark' : 'light'}).` : 'Dark mode is easier on the eyes at night and saves battery on many phones.'}</Muted>
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={{ color: c.ink, fontWeight: '700' }}>Accent colour</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Accent colour" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          {(Object.keys(ACCENTS) as Array<Prefs['accent']>).map((k) => {
            const on = prefs.accent === k;
            const col = dark ? ACCENTS[k].dark[0] : ACCENTS[k].light[0];
            return (
              <Pressable key={k} onPress={() => set({ accent: k })} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={ACCENTS[k].label}
                style={{ alignItems: 'center', gap: 4, width: 64 }}>
                <View style={[{ width: 44, height: 44, borderRadius: 22, backgroundColor: col, borderWidth: on ? 3 : 0, borderColor: c.ink }, depth(on ? 2 : 1)]} />
                <Text style={{ fontSize: 11, color: on ? c.ink : c.ink3, textAlign: 'center' }} numberOfLines={2}>{ACCENTS[k].label}</Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={{ color: c.ink, fontWeight: '700' }}>Card style</Text>
        <Choice<Prefs['depth']> label="Card style" value={prefs.depth} onChange={(d) => set({ depth: d })} options={[['3d', '3D (raised)'], ['flat', 'Flat']]} />
        <Muted>3D adds soft shadows and depth to cards and buttons. Flat is simpler and lighter on older phones.</Muted>
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={{ color: c.ink, fontWeight: '700' }}>Open the app on</Text>
        <Choice<Prefs['startTab']> label="Start screen" value={prefs.startTab} onChange={(startTab) => set({ startTab })}
          options={[['index', 'Today'], ['orders', 'Orders'], ['live', 'Live'], ['products', 'Stock']]} />
        <Muted>Takes effect the next time you open LiveSell.</Muted>
      </Card>
    </Screen>
  );
}
