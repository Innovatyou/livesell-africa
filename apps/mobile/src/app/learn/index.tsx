import { router, useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';
import { Hero3D } from '@/components/hero';
import { Badge, Button, Card, Hero, Icon, IconBadge, ListRow, Progress, Screen, SectionTitle, c } from '@/components/ui';
import { TRACKS } from '@/content/academy';
import { useAcademy } from '@/lib/academy-progress';
import { useTheme } from '@/lib/theme';

/** LiveSell Academy: classes that take a new seller from "I've never gone live" to their first paid orders. */
export default function Academy() {
  useTheme();
  const a = useAcademy();
  useFocusEffect(a.reload);
  const pct = a.total ? a.completed / a.total : 0;

  return (
    <Screen>
      <Hero>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontWeight: '700', letterSpacing: 0.6, fontSize: 12 }}>LIVESELL ACADEMY</Text>
            <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>Learn to sell live</Text>
            <Text style={{ color: 'rgba(255,255,255,0.85)', lineHeight: 20 }}>Short classes, real steps. From your first product to your first paid order on TikTok, Instagram, Facebook and WhatsApp.</Text>
          </View>
          <Hero3D size={56} />
        </View>
        <View style={{ gap: 6, marginTop: 6 }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>{a.completed} of {a.total} lessons done</Text>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}>
            <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: '#fff', borderRadius: 4 }} />
          </View>
        </View>
        {a.next ? (
          <View style={{ marginTop: 6 }}>
            <Button title={a.completed ? `Continue: ${a.next.title}` : 'Start the first lesson'} icon="play" variant="secondary" onPress={() => router.push(`/learn/${a.next!.id}`)} />
          </View>
        ) : <Text style={{ color: '#fff', fontWeight: '700' }}>🎉 You finished every class. Time to go live!</Text>}
      </Hero>

      {TRACKS.map((t) => {
        const done = t.lessons.filter((l) => a.done.has(l.id)).length;
        return (
          <View key={t.id} style={{ gap: 8 }}>
            <SectionTitle>{t.level}</SectionTitle>
            <Card style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <IconBadge name={t.icon} color={c.dark && t.color === '#111111' ? '#ffffff' : t.color} size={46} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>{t.title}</Text>
                  <Text style={{ color: c.ink3 }}>{t.subtitle}</Text>
                </View>
                {done === t.lessons.length ? <Badge tone="good">Done</Badge> : <Text style={{ color: c.ink3, fontWeight: '700' }}>{done}/{t.lessons.length}</Text>}
              </View>
              <Progress value={done / t.lessons.length} label={`${t.title}: ${done} of ${t.lessons.length} lessons`} />
              {t.lessons.map((l) => (
                <ListRow key={l.id} onPress={() => router.push(`/learn/${l.id}`)} title={l.title} subtitle={`${l.minutes} min · ${l.summary}`}
                  left={<View style={{ width: 28, alignItems: 'center' }}><Icon name={a.done.has(l.id) ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={a.done.has(l.id) ? c.good : c.ink3} /></View>} />
              ))}
            </Card>
          </View>
        );
      })}
      <Text style={{ color: c.ink3, fontSize: 12, lineHeight: 18 }}>TikTok, Instagram, Facebook and WhatsApp set their own rules (who can go live, what you may sell). They change often — check each app’s rules. LiveSell isn’t affiliated with them.</Text>
    </Screen>
  );
}
