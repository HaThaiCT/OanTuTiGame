import React from 'react';

export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ children, style, ...props }) => (
  <div
    style={{
      backgroundColor: 'var(--surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: '8px',
      overflow: 'hidden',
      ...style,
    }}
    {...props}
  >
    {children}
  </div>
);

export const CardHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ children, style, ...props }) => (
  <div
    style={{
      padding: '16px 20px',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      ...style,
    }}
    {...props}
  >
    {children}
  </div>
);

export const CardTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({ children, style, ...props }) => (
  <h3
    style={{
      margin: 0,
      fontSize: '18px',
      fontWeight: 600,
      color: 'var(--text-primary)',
      ...style,
    }}
    {...props}
  >
    {children}
  </h3>
);

export const CardContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ children, style, ...props }) => (
  <div
    style={{
      padding: '20px',
      ...style,
    }}
    {...props}
  >
    {children}
  </div>
);
