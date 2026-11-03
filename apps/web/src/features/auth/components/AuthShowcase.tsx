import React from 'react'
import {
  Activity,
  ChartNoAxesColumnIncreasing,
  Database,
  Settings,
  Zap,
} from 'lucide-react'
import { BrandLogo } from './BrandLogo'

type AuthShowcaseProps = {
  variant?: 'login' | 'register'
}

const SHOWCASE_DATA = {
  login: {
    headline: 'The complete IIoT platform for smart manufacturing',
    subtitle:
      'Connect devices, collect industrial data, monitor signals, and optimize production operations from one unified platform.',
    benefits: [
      {
        icon: Database,
        title: 'Real-time data collection',
        body: 'Connect to industrial devices and multiple field protocols',
      },
      {
        icon: Activity,
        title: 'Signal monitoring & analytics',
        body: 'Track equipment health, detect issues early, and reduce downtime',
      },
      {
        icon: ChartNoAxesColumnIncreasing,
        title: 'Centralized factory operations',
        body: 'From assets to signals to runtime operations — everything in one place',
      },
    ],
  },
  register: {
    headline: 'Create your FactoriX account',
    subtitle:
      'Start your digital manufacturing journey with a unified IIoT platform for data collection, signal monitoring, and operational visibility.',
    benefits: [
      {
        icon: Zap,
        title: 'Get started quickly',
        body: 'Create your workspace in minutes and explore the IIoT platform',
      },
      {
        icon: Settings,
        title: 'Flexible configuration',
        body: 'Adapt devices, signals, and permissions to your factory needs',
      },
      {
        icon: ChartNoAxesColumnIncreasing,
        title: 'Built to scale',
        body: 'Grow from one production line to multiple plants with ease',
      },
    ],
  },
}

export const AuthShowcase: React.FC<AuthShowcaseProps> = ({ variant = 'login' }) => {
  const data = SHOWCASE_DATA[variant] || SHOWCASE_DATA.login

  return (
    <aside className="fx-auth-showcase" aria-label="FactoriX product overview">
      <div className="fx-auth-showcase-top">
        <BrandLogo />
        <div className="mt-7 lg:mt-9 max-w-[640px]">
          <h1 className="text-[34px] xl:text-[40px] 2xl:text-[44px] leading-[1.08] font-extrabold text-[#111B37] tracking-tight">
            {data.headline}
          </h1>
          <p className="mt-3.5 text-[16px] xl:text-[18px] leading-[1.45] text-[#556885] max-w-[610px]">
            {data.subtitle}
          </p>
          <div className="mt-6 lg:mt-7 space-y-3.5 max-w-[620px]">
            {data.benefits.map((item) => (
              <div key={item.title} className="fx-auth-feature-card">
                <div className="fx-auth-feature-icon">
                  <item.icon className="w-6 h-6 text-[#EF1B24]" strokeWidth={2.2} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="text-[17px] font-bold text-[#0F172A] leading-snug">{item.title}</div>
                  <p className="mt-0.5 text-[14px] leading-relaxed text-[#5C6D90]">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="sr-only" aria-hidden="true">
        Decorative factory illustration
      </div>
    </aside>
  )
}
