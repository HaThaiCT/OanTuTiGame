'use client';

interface UetLogoProps {
  readonly size?: number;
  readonly className?: string;
  readonly priority?: boolean;
}

/**
 * Official emblem of Trường Đại học Công nghệ – Đại học Quốc gia Hà Nội (VNU-UET).
 * Renders the circular emblem with the dynamic 'C', 5-line 'T' pedestal, and 'ĐẠI HỌC CÔNG NGHỆ'.
 */
export default function UetLogo({
  size = 32,
  className = '',
  priority = false,
}: UetLogoProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full overflow-hidden shadow-xs transition-transform duration-200 hover:scale-105 ${className}`}
      style={{ width: size, height: size }}
      title="Trường Đại học Công nghệ — Đại học Quốc gia Hà Nội (VNU-UET)"
    >
      <img
        src="/logo-uet.svg"
        alt="Logo Trường Đại học Công nghệ - ĐHQGHN"
        width={size}
        height={size}
        className="h-full w-full object-contain select-none"
        loading={priority ? 'eager' : 'lazy'}
      />
    </span>
  );
}
