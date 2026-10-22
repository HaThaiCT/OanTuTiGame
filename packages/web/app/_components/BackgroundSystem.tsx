'use client';

import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
}

/**
 * Default ambient background system for OanTuTi Arena:
 * Clean, high-performance HTML5 Canvas algorithmic constellation network.
 * Lightweight, 60fps, subtle and non-distracting; automatically pauses when tab is hidden.
 */
export default function BackgroundSystem() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    // Check prefers-reduced-motion
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const getColors = () => {
      const isLight = document.documentElement.dataset.theme === 'light';
      return {
        primaryColor: isLight ? 'rgba(29, 82, 148, 0.55)' : 'rgba(0, 245, 212, 0.55)',
        secondaryColor: isLight ? 'rgba(185, 28, 44, 0.4)' : 'rgba(56, 189, 248, 0.5)',
        lineColor: isLight ? 'rgba(29, 82, 148,' : 'rgba(0, 245, 212,',
      };
    };

    let colors = getColors();

    const onThemeChange = () => {
      colors = getColors();
      for (const p of particles) {
        p.color = Math.random() > 0.4 ? colors.primaryColor : colors.secondaryColor;
      }
    };
    window.addEventListener('oantuti:theme-changed', onThemeChange);

    const count = Math.min(55, Math.max(25, Math.floor((width * height) / 24000)));
    const particles: Particle[] = [];

    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: prefersReducedMotion ? 0 : (Math.random() - 0.5) * 0.45,
        vy: prefersReducedMotion ? 0 : (Math.random() - 0.5) * 0.45,
        radius: Math.random() * 1.5 + 1.2,
        color: Math.random() > 0.4 ? colors.primaryColor : colors.secondaryColor,
      });
    }

    let mouseX = -1000;
    let mouseY = -1000;

    const onMouseMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    };

    const onMouseLeave = () => {
      mouseX = -1000;
      mouseY = -1000;
    };

    const onResize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseleave', onMouseLeave, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });

    const maxDist = 125;

    const render = () => {
      if (document.hidden) {
        animId = requestAnimationFrame(render);
        return;
      }

      ctx.clearRect(0, 0, width, height);

      // Draw connecting lines between nearby particles
      for (let i = 0; i < particles.length; i++) {
        const p1 = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p1.x - p2.x;
          const dy = p1.y - p2.y;
          const dist = Math.hypot(dx, dy);

          if (dist < maxDist) {
            const alpha = (1 - dist / maxDist) * 0.16;
            ctx.strokeStyle = `${colors.lineColor}${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }

        // Interactive mouse connection line
        const mdx = p1.x - mouseX;
        const mdy = p1.y - mouseY;
        const mdist = Math.hypot(mdx, mdy);
        if (mdist < 140) {
          const mAlpha = (1 - mdist / 140) * 0.25;
          ctx.strokeStyle = `${colors.lineColor}${mAlpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(mouseX, mouseY);
          ctx.stroke();
        }

        // Move particles
        if (!prefersReducedMotion) {
          p1.x += p1.vx;
          p1.y += p1.vy;

          if (p1.x < 0 || p1.x > width) p1.vx *= -1;
          if (p1.y < 0 || p1.y > height) p1.vy *= -1;
        }

        // Draw particle dot
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
      window.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('oantuti:theme-changed', onThemeChange);
    };
  }, []);

  return (
    <div className="arena-bg" aria-hidden="true">
      {/* Subtle top ambient glow for depth */}
      <div className="arena-bg-ambient" />

      {/* Default 60fps algorithmic constellation canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none opacity-80"
      />
    </div>
  );
}
