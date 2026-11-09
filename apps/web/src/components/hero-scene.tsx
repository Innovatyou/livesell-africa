'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import type { Group, Mesh } from 'three';

/**
 * Lightweight 3D hero: a "phone" slab with floating product tiles orbiting it. Plain three.js primitives
 * (no drei, no textures, no models) keep the chunk small; DPR is capped and rendering pauses off-screen.
 */
const BRAND = '#0e7a4d';
const BRAND_LIGHT = '#7ce0ae';
const PAPER = '#ffffff';

function Tile({ position, color, speed, phase }: { position: [number, number, number]; color: string; speed: number; phase: number }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime() * speed + phase;
    if (!ref.current) return;
    ref.current.position.y = position[1] + Math.sin(t) * 0.12;
    ref.current.rotation.y = Math.sin(t * 0.6) * 0.35;
    ref.current.rotation.x = Math.cos(t * 0.5) * 0.12;
  });
  return (
    <mesh ref={ref} position={position} castShadow>
      <boxGeometry args={[0.9, 0.9, 0.12]} />
      <meshStandardMaterial color={color} roughness={0.35} metalness={0.05} />
    </mesh>
  );
}

function Scene() {
  const group = useRef<Group>(null);
  useFrame(({ clock, pointer }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime();
    group.current.rotation.y = Math.sin(t * 0.15) * 0.25 + pointer.x * 0.15;
    group.current.rotation.x = -pointer.y * 0.08;
  });
  return (
    <group ref={group}>
      {/* Phone */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[1.9, 3.6, 0.18]} />
        <meshStandardMaterial color="#121815" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0, 0.095]}>
        <planeGeometry args={[1.7, 3.35]} />
        <meshStandardMaterial color={BRAND} roughness={0.6} />
      </mesh>
      {/* Live ring */}
      <mesh position={[0, 1.15, 0.12]}>
        <torusGeometry args={[0.32, 0.05, 16, 64]} />
        <meshStandardMaterial color={BRAND_LIGHT} emissive={BRAND_LIGHT} emissiveIntensity={0.35} />
      </mesh>
      <Tile position={[-1.85, 1.1, 0.4]} color={PAPER} speed={0.9} phase={0} />
      <Tile position={[1.9, 0.5, 0.2]} color={BRAND_LIGHT} speed={0.8} phase={1.4} />
      <Tile position={[-1.6, -1.2, 0.3]} color={BRAND_LIGHT} speed={1.0} phase={2.6} />
      <Tile position={[1.7, -1.5, 0.5]} color={PAPER} speed={0.7} phase={3.7} />
    </group>
  );
}

export default function HeroScene({ onReady }: { onReady: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);

  // Stop rendering entirely while the hero is scrolled out of view (saves battery).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={wrap} className="h-full w-full" aria-hidden>
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 0, 7], fov: 40 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        frameloop={inView ? 'always' : 'never'}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
          onReady();
        }}
      >
        <ambientLight intensity={0.75} />
        <directionalLight position={[3, 4, 5]} intensity={1.4} />
        <directionalLight position={[-4, -2, 2]} intensity={0.35} color={BRAND_LIGHT} />
        <Scene />
      </Canvas>
    </div>
  );
}
