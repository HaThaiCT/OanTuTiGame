import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  readonly size?: 'sm' | 'md' | 'lg';
  readonly isLoading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  disabled,
  children,
  style,
  ...props
}) => {
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    borderRadius: '6px',
    fontWeight: 500,
    cursor: disabled || isLoading ? 'not-allowed' : 'pointer',
    opacity: disabled || isLoading ? 0.6 : 1,
    transition: 'background-color 120ms ease-out, border-color 120ms ease-out',
    border: '1px solid transparent',
    outline: 'none',
    fontFamily: 'inherit',
  };

  const sizeStyles: Record<string, React.CSSProperties> = {
    sm: { padding: '6px 12px', fontSize: '13px', height: '32px' },
    md: { padding: '8px 16px', fontSize: '14px', height: '40px' },
    lg: { padding: '12px 24px', fontSize: '16px', height: '48px' },
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      backgroundColor: 'var(--action)',
      color: '#0B0D17',
      borderColor: 'transparent',
    },
    secondary: {
      backgroundColor: 'var(--surface-subtle)',
      color: 'var(--text-primary)',
      borderColor: 'var(--border-subtle)',
    },
    outline: {
      backgroundColor: 'transparent',
      color: 'var(--text-primary)',
      borderColor: 'var(--border-control)',
    },
    ghost: {
      backgroundColor: 'transparent',
      color: 'var(--text-secondary)',
      borderColor: 'transparent',
    },
    danger: {
      backgroundColor: 'var(--danger-tint)',
      color: 'var(--danger-text)',
      borderColor: 'var(--danger-text)',
    },
  };

  return (
    <button
      disabled={disabled || isLoading}
      style={{
        ...baseStyle,
        ...sizeStyles[size],
        ...variantStyles[variant],
        ...style,
      }}
      {...props}
    >
      {isLoading ? <span>Loading...</span> : children}
    </button>
  );
};
