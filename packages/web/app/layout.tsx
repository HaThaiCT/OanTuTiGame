import type { Metadata } from 'next';
import SiteHeader from './_components/SiteHeader';
import './globals.css';

export const metadata: Metadata = {
  title: 'OanTuTi Arena — Giải đấu Bot đại học',
  description: 'Cổng thi đấu thuật toán OanTuTi: giải đấu, bảng xếp hạng, bài nộp và replay.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
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
          <span>oantuti-arena</span><span>Thi đấu Bot · Búa / Kéo / Giấy · Bàn cờ chiến thuật</span>
        </footer>
      </body>
    </html>
  );
}
