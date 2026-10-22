import type { Metadata } from 'next';
import SiteHeader from './_components/SiteHeader';
import UetLogo from './_components/UetLogo';
import './globals.css';

export const metadata: Metadata = {
  title: 'OanTuTi Arena — Đấu trường thuật toán Búa Kéo Bao',
  description: 'Đấu trường thi đấu bot thuật toán OanTuTi: giải đấu, bảng xếp hạng, nộp bài và replay. Trường Đại học Công nghệ - ĐHQGHN (VNU-UET).',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Barlow:ital,wght@0,600;0,700;0,800;1,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {/* Applies the stored theme before hydration so a reload never flashes the wrong palette. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('oantuti-theme');document.documentElement.dataset.theme=t==='light'||(t==='system'&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';}catch(e){document.documentElement.dataset.theme='dark';}",
          }}
        />
        <div className="arena-bg" aria-hidden="true">
          <div className="arena-bg-glow-1" />
          <div className="arena-bg-glow-2" />
          <div className="arena-bg-glow-3" />
          <div className="arena-bg-grid" />
        </div>
        <SiteHeader />
        <main className="arena-main">{children}</main>
        <footer className="arena-footer">
          <div className="arena-footer-brand flex items-center gap-3">
            <UetLogo size={36} />
            <div>
              <p className="font-heading font-bold text-sm text-[var(--text-primary)]">OanTuTi Arena</p>
              <p className="text-xs text-[var(--text-secondary)]">Trường Đại học Công nghệ — Đại học Quốc gia Hà Nội (VNU-UET)</p>
            </div>
          </div>
          <div className="arena-footer-meta">
            <span>Chiến thuật Búa · Kéo · Bao</span>
            <span>© OanTuTi Platform</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
