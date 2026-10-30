import React from 'react';

interface CardProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
}

export const Card: React.FC<CardProps> = ({
  title,
  subtitle,
  action,
  children,
  className = '',
  headerClassName = '',
}) => {
  return (
    <div className={`fx-card overflow-hidden ${className}`}>
      {(title || action) && (
        <div
          className={`px-5 py-3.5 border-b border-[#E3EAF3] flex items-center justify-between ${headerClassName}`}
        >
          <div>
            {typeof title === 'string' ? (
              <h3 className="text-[14px] font-bold text-[#111B37] tracking-tight">{title}</h3>
            ) : (
              title
            )}
            {subtitle && <p className="text-[12px] text-[#657794] mt-0.5">{subtitle}</p>}
          </div>
          {action && <div className="flex items-center gap-2">{action}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
};
