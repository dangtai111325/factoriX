import React from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ title, description, action }) => (
  <div className="p-10 text-center">
    <p className="text-[14px] font-semibold text-[#111B37]">{title}</p>
    {description && <p className="text-[12px] text-[#657794] mt-1">{description}</p>}
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>
);
