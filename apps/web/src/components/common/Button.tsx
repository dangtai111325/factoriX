import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'icon';
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  className = '',
  disabled,
  ...props
}) => {
  const baseClasses =
    'inline-flex items-center justify-center font-semibold rounded-lg transition-all duration-150 select-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

  const sizeClasses = {
    sm: 'h-8 px-2.5 text-[12px] gap-1.5',
    md: 'h-9 px-4 text-[13px] gap-2',
    lg: 'h-10 px-5 text-[14px] gap-2.5',
  };

  const variantClasses = {
    primary:
      'bg-[#EF1B24] text-white hover:bg-[#D9141D] active:bg-[#C7111A] border border-[#EF1B24] shadow-sm',
    secondary:
      'bg-white text-[#334568] hover:bg-[#F9FAFD] hover:text-[#111B37] border border-[#D4DFEC]',
    danger:
      'bg-white text-[#F2343B] hover:bg-[#FFF0F1] border border-[#FAC6C9]',
    ghost:
      'bg-transparent text-[#657794] hover:bg-[#F1F5FA] hover:text-[#111B37]',
    icon:
      'h-9 w-9 p-0 bg-white text-[#334568] hover:bg-[#F9FAFD] hover:text-[#111B37] border border-[#D4DFEC]',
  };

  return (
    <button
      className={`${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        icon && <span className="flex-shrink-0">{icon}</span>
      )}
      {children && <span>{children}</span>}
    </button>
  );
};
