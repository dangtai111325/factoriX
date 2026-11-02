import React, { useEffect, useState } from 'react'
import { Card } from '../../components/common/Card'

export const AboutPage: React.FC = () => {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  const isHttp = typeof window !== 'undefined' && window.location.protocol === 'http:'

  useEffect(() => {
    void fetch('/api/v1/health')
      .then((r) => (r.ok ? r.json() : fetch('/health/live').then((x) => x.json())))
      .then(setHealth)
      .catch(() => setHealth({ status: 'unreachable' }))
  }, [])

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <h1 className="fx-page-title">About</h1>
        <p className="fx-page-subtitle">FactoriX appliance build information.</p>
      </div>
      <Card title="Build">
        <pre className="text-[12px] font-mono text-[#334568] whitespace-pre-wrap">
          {JSON.stringify(health || { loading: true }, null, 2)}
        </pre>
        <div className="mt-3 text-[12px] space-y-1">
          <a className="text-[#EF1B24] font-semibold block" href="/legal/terms">
            Terms of use
          </a>
          <a className="text-[#EF1B24] font-semibold block" href="/legal/privacy">
            Privacy
          </a>
        </div>
      </Card>
      <Card title="Transport">
        {isHttp ? (
          <div className="text-[12px] text-[#334568] space-y-2 leading-relaxed">
            <p>
              This browser session uses HTTP. Production appliances should terminate TLS (HTTPS) on the host reverse
              proxy, redirect port 80 → 443, and keep session cookies <span className="font-mono">Secure</span>.
            </p>
            <p>
              Lab HTTP is allowed only when <span className="font-mono">FACTORIX_ALLOW_HTTP=1</span> (or{' '}
              <span className="font-mono">FACTORIX_COOKIE_SECURE=false</span>). Replace the install self-signed
              certificate with your organization cert on the appliance proxy.
            </p>
          </div>
        ) : (
          <p className="text-[12px] text-[#334568]">
            This session uses HTTPS. Session cookies are marked Secure in production unless{' '}
            <span className="font-mono">FACTORIX_ALLOW_HTTP=1</span> is set.
          </p>
        )}
      </Card>
    </div>
  )
}
