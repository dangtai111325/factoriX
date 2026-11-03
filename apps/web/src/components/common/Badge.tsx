import React from 'react';

export type BadgeVariant =
  | 'good'
  | 'warning'
  | 'error'
  | 'info'
  | 'neutral'
  | 'modbus'
  | 'opcua'
  | 'mqtt'
  | 'http';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'neutral',
  dot = true,
  className = '',
}) => {
  const variantStyles: Record<BadgeVariant, { bg: string; text: string; dotColor: string }> = {
    good: { bg: 'bg-[#E8FBF0]', text: 'text-[#0A9855]', dotColor: 'bg-[#0A9855]' },
    warning: { bg: 'bg-[#FFF3DA]', text: 'text-[#B96B00]', dotColor: 'bg-[#B96B00]' },
    error: { bg: 'bg-[#FFE5E7]', text: 'text-[#DB2028]', dotColor: 'bg-[#DB2028]' },
    info: { bg: 'bg-[#EEF5FF]', text: 'text-[#2A82E7]', dotColor: 'bg-[#2A82E7]' },
    neutral: { bg: 'bg-[#F1F5FA]', text: 'text-[#657794]', dotColor: 'bg-[#94A3B8]' },
    modbus: { bg: 'bg-[#EEF5FF]', text: 'text-[#1D63BD]', dotColor: 'bg-[#1D63BD]' },
    opcua: { bg: 'bg-[#F5F0FF]', text: 'text-[#7B3AE0]', dotColor: 'bg-[#7B3AE0]' },
    mqtt: { bg: 'bg-[#EBFBF7]', text: 'text-[#149580]', dotColor: 'bg-[#149580]' },
    http: { bg: 'bg-[#FFF5EC]', text: 'text-[#C76114]', dotColor: 'bg-[#C76114]' },
  };

  const style = variantStyles[variant] || variantStyles.neutral;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide ${style.bg} ${style.text} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${style.dotColor}`} />}
      <span>{children}</span>
    </span>
  );
};
