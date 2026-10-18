import React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  readonly variant?: 'live' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'neutral',
  children,
  style,
  ...props
}) => {
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.02em',
    lineHeight: '16px',
    width: 'fit-content',
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    live: {
      backgroundColor: 'rgba(253, 186, 116, 0.15)',
      color: 'var(--live-accent)',
      border: '1px solid var(--live-accent)',
    },
    success: {
      backgroundColor: 'var(--success-tint)',
      color: 'var(--success-text)',
      border: '1px solid rgba(187, 247, 208, 0.3)',
    },
    warning: {
      backgroundColor: 'var(--warning-tint)',
      color: 'var(--warning-text)',
      border: '1px solid rgba(253, 230, 138, 0.3)',
    },
    danger: {
      backgroundColor: 'var(--danger-tint)',
      color: 'var(--danger-text)',
      border: '1px solid rgba(254, 202, 202, 0.3)',
    },
    info: {
      backgroundColor: 'var(--info-tint)',
      color: 'var(--info-text)',
      border: '1px solid rgba(191, 219, 254, 0.3)',
    },
    neutral: {
      backgroundColor: 'var(--surface-subtle)',
      color: 'var(--text-secondary)',
      border: '1px solid var(--border-subtle)',
    },
  };

  return (
    <span
      style={{
        ...baseStyle,
        ...variantStyles[variant],
        ...style,
      }}
      {...props}
    >
      {variant === 'live' && (
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: 'var(--live-accent)',
            display: 'inline-block',
          }}
        />
      )}
      {children}
    </span>
  );
};
