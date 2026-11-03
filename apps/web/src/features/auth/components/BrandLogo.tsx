import React from 'react'
import { Link } from 'react-router-dom'

export const BrandLogo: React.FC<{ to?: string; compact?: boolean; className?: string }> = ({
  to = '/login',
  compact = false,
  className = '',
}) => (
  <Link to={to} className={`inline-flex items-center no-underline ${className}`} aria-label="FactoriX Home">
    <img
      src="/factorix-logo.png"
      alt="FactoriX Business Solutions"
      className={compact ? 'h-[44px] w-auto object-contain' : 'h-[50px] w-auto object-contain'}
    />
  </Link>
)
