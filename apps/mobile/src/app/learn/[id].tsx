import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button, Card, Empty, Icon, IconBadge, Muted, Notice, Screen, SectionTitle, c } from '@/components/ui';
import { ALL_LESSONS, lessonById, trackById } from '@/content/academy';
import { useAcademy } from '@/lib/academy-progress';
import { useTheme } from '@/lib/theme';

/** One class: what you'll learn, numbered steps, tips, mistakes to avoid, a quick check, and "do it now" buttons. */
export default function LessonScreen() {
  useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const lesson = lessonById(id);
  const a = useAcademy();
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => setPicked(null), [id]);

  if (!lesson) return <Screen><Empty title="Lesson not found" icon="school-outline" action={{ title: 'Back to the Academy', onPress: () => router.replace('/learn') }} /></Screen>;
  const track = trackById(lesson.trackId)!;
  const idx = ALL_LESSONS.findIndex((l) => l.id === lesson.id);
  const next = ALL_LESSONS[idx + 1] ?? null;
  const done = a.done.has(lesson.id);
  const passed = !lesson.check || (picked !== null && picked === lesson.check.answer);

  return (
    <Screen>
      <Stack.Screen options={{ title: track.title }} />
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <IconBadge name={track.icon} color={c.dark && track.color === '#111111' ? '#ffffff' : track.color} size={48} />
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '800', color: c.ink }}>{lesson.title}</Text>
          <Muted>{lesson.minutes} min read{done ? ' · completed' : ''}</Muted>
        </View>
      </View>
      <Card><Text style={{ color: c.ink2, fontSize: 15, lineHeight: 22 }}>{lesson.summary}</Text></Card>

      <SectionTitle>Step by step</SectionTitle>
      {lesson.steps.map((s, i) => (
        <Card key={s.title} style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: c.onBrand, fontWeight: '800' }}>{i + 1}</Text>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>{s.title}</Text>
            <Text style={{ color: c.ink2, lineHeight: 21 }}>{s.body}</Text>
          </View>
        </Card>
      ))}

      {lesson.tips?.length ? (<><SectionTitle>Pro tips</SectionTitle>{lesson.tips.map((t) => <Notice key={t} tone="good">{t}</Notice>)}</>) : null}
      {lesson.avoid?.length ? (<><SectionTitle>Avoid</SectionTitle>{lesson.avoid.map((t) => <Notice key={t} tone="warn">{t}</Notice>)}</>) : null}

      {lesson.check ? (
        <>
          <SectionTitle>Quick check</SectionTitle>
          <Card style={{ gap: 10 }}>
            <Text style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>{lesson.check.question}</Text>
            {lesson.check.options.map((o, i) => {
              const chosen = picked === i;
              const right = i === lesson.check!.answer;
              const border = chosen ? (right ? c.good : c.bad) : c.line;
              return (
                <Pressable key={o} onPress={() => setPicked(i)} accessibilityRole="radio" accessibilityState={{ selected: chosen }}
                  style={{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: 12, borderWidth: chosen ? 2 : 1, borderColor: border, backgroundColor: chosen ? (right ? c.goodBg : c.badBg) : c.surface }}>
                  <Icon name={chosen ? (right ? 'checkmark-circle' : 'close-circle') : 'radio-button-off'} color={chosen ? border : c.ink3} />
                  <Text style={{ color: c.ink, flex: 1 }}>{o}</Text>
                </Pressable>
              );
            })}
            {picked !== null ? <Notice tone={passed ? 'good' : 'warn'}>{passed ? `Correct. ${lesson.check.why}` : 'Not quite — try again.'}</Notice> : null}
          </Card>
        </>
      ) : null}

      {lesson.actions?.length ? (
        <>
          <SectionTitle>Do it now in LiveSell</SectionTitle>
          {lesson.actions.map((x) => <Button key={x.href} variant="secondary" icon="open-outline" title={x.title} onPress={() => router.push(x.href as never)} />)}
        </>
      ) : null}

      <View style={{ gap: 10, marginTop: 8 }}>
        {done ? (
          <Button variant="secondary" icon="refresh" title="Mark as not done" onPress={() => void a.toggle(lesson.id, false)} />
        ) : (
          <Button icon="checkmark-done" title={lesson.check && !passed ? 'Answer the quick check to finish' : 'Mark lesson complete'} disabled={!passed}
            onPress={() => void a.toggle(lesson.id, true).then(() => { if (next) router.replace(`/learn/${next.id}`); else router.replace('/learn'); })} />
        )}
        {next ? <Button variant="secondary" icon="arrow-forward" title={`Next: ${next.title}`} onPress={() => router.replace(`/learn/${next.id}`)} /> : null}
      </View>
    </Screen>
  );
}
