'use client';

import { useEffect, useRef, useState } from 'react';

export type BgMode = 'solid' | 'animation';

const STORAGE_KEY = 'oantuti-bg-mode';

export function getStoredBgMode(): BgMode {
  if (typeof window === 'undefined') return 'solid';
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (val === 'animation') return 'animation';
  } catch {
    // fallback
  }
  return 'solid';
}

export function setStoredBgMode(mode: BgMode): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
    window.dispatchEvent(new Event('oantuti:bg-changed'));
  } catch {
    // fallback
  }
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
}

export default function BackgroundSystem() {
  const [mode, setMode] = useState<BgMode>('solid');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const sync = () => setMode(getStoredBgMode());
    sync();
    window.addEventListener('oantuti:bg-changed', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('oantuti:bg-changed', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // Canvas animation logic when mode === 'animation'
  useEffect(() => {
    if (mode !== 'animation') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const isLight = document.documentElement.dataset.theme === 'light';
    const primaryColor = isLight ? 'rgba(29, 82, 148, 0.6)' : 'rgba(0, 245, 212, 0.6)';
    const secondaryColor = isLight ? 'rgba(185, 28, 44, 0.4)' : 'rgba(56, 189, 248, 0.5)';
    const lineColor = isLight ? 'rgba(29, 82, 148,' : 'rgba(0, 245, 212,';

    const count = Math.min(50, Math.floor((width * height) / 25000));
    const particles: Particle[] = [];

    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.45,
        vy: (Math.random() - 0.5) * 0.45,
        radius: Math.random() * 1.5 + 1,
        color: Math.random() > 0.4 ? primaryColor : secondaryColor,
      });
    }

    let mouseX = -1000;
    let mouseY = -1000;

    const onMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    };

    const onResize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });

    const maxDist = 120;

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Draw connecting lines
      for (let i = 0; i < particles.length; i++) {
        const p1 = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p1.x - p2.x;
          const dy = p1.y - p2.y;
          const dist = Math.hypot(dx, dy);

          if (dist < maxDist) {
            const alpha = (1 - dist / maxDist) * 0.16;
            ctx.strokeStyle = `${lineColor}${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }

        // Mouse interactive line
        const mdx = p1.x - mouseX;
        const mdy = p1.y - mouseY;
        const mdist = Math.hypot(mdx, mdy);
        if (mdist < 140) {
          const mAlpha = (1 - mdist / 140) * 0.25;
          ctx.strokeStyle = `${lineColor}${mAlpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(mouseX, mouseY);
          ctx.stroke();
        }

        // Update position
        p1.x += p1.vx;
        p1.y += p1.vy;

        if (p1.x < 0 || p1.x > width) p1.vx *= -1;
        if (p1.y < 0 || p1.y > height) p1.vy *= -1;

        // Draw particle
        ctx.fillStyle = p1.color;
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, p1.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('resize', onResize);
    };
  }, [mode]);

  return (
    <div className="arena-bg" aria-hidden="true">
      {/* Subtle top ambient glow for depth */}
      <div className="arena-bg-ambient" />

      {/* 60fps algorithmic constellation canvas (only active in animation mode) */}
      {mode === 'animation' ? (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 pointer-events-none opacity-80 transition-opacity duration-500"
        />
      ) : null}
    </div>
  );
}
