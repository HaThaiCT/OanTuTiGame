import type { Metadata } from 'next';
import SiteHeader from './_components/SiteHeader';
import './globals.css';

export const metadata: Metadata = {
  title: 'OanTuTi Arena — Đấu trường thuật toán Búa Kéo Bao',
  description: 'Đấu trường thi đấu bot thuật toán OanTuTi: giải đấu, bảng xếp hạng, nộp bài và replay.',
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
        <SiteHeader />
        <main className="arena-main">{children}</main>
        <footer className="arena-footer">
          <div className="arena-footer-brand">
            OanTuTi Arena
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
