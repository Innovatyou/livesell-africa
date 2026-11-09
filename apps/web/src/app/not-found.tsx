import { ButtonLink, Logo } from '@/components/ui';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-4">
      <Logo />
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-ink-2">The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
      <ButtonLink href="/">Back to home</ButtonLink>
    </div>
  );
}
