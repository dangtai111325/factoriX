import React from 'react';
import {
  Box,
  Building2,
  Cog,
  Factory,
  Gauge,
  LayoutGrid,
  LucideIcon,
  MapPin,
  Rows3,
  Square,
  Warehouse,
  Zap,
  Grid2x2,
} from 'lucide-react';

/**
 * Monochrome icon per ISA-95 resource type. Icons draw with `currentColor`, so they inherit the
 * text colour of their row (muted by default, accent when the row is selected).
 */
const ICON_BY_TYPE: Record<string, LucideIcon> = {
  enterprise: Building2,
  site: MapPin,
  plant: Factory,
  area: LayoutGrid,
  zone: Square,
  line: Rows3,
  workshop: Warehouse,
  cell: Grid2x2,
  utility_system: Zap,
  machine: Cog,
  sensor: Gauge,
  physical_asset: Box,
};

export function resourceTypeIcon(type: string | undefined): LucideIcon {
  return ICON_BY_TYPE[(type || '').toLowerCase()] || Box;
}

/** Human label for a resource type key ("utility_system" -> "Utility system"). */
export function resourceTypeLabel(type: string | undefined): string {
  const key = (type || '').replace(/_/g, ' ').trim();
  if (!key) return 'Resource';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

interface ResourceTypeIconProps {
  type: string | undefined;
  className?: string;
  /** Pixel size; defaults to 16. */
  size?: number;
}

export const ResourceTypeIcon: React.FC<ResourceTypeIconProps> = ({ type, className = '', size = 16 }) => {
  const Icon = resourceTypeIcon(type);
  return (
    <Icon
      aria-hidden="true"
      width={size}
      height={size}
      strokeWidth={1.75}
      className={`shrink-0 ${className}`}
    />
  );
};
