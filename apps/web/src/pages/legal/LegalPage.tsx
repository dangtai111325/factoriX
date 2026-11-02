import React from 'react'
import { Link, useParams } from 'react-router-dom'

const TERMS = `
FactoriX End User License Agreement (EULA)

This appliance software is licensed, not sold. You may use FactoriX solely for industrial data collection
within your organization. You must not reverse engineer, redistribute, or use the software to process
data you are not authorized to collect. The software is provided as-is for on-premises appliance use.
Contact Avenue Net support for commercial terms that apply to your deployment.
`.trim()

const PRIVACY = `
FactoriX Privacy Notice

FactoriX runs on your appliance. Operator accounts, factory models, and telemetry stay on the appliance
unless you configure outbound integrations. Password-reset email is sent only when SMTP is configured
by your administrator. For product privacy questions, contact your appliance administrator.
`.trim()

export const LegalPage: React.FC = () => {
  const { doc } = useParams()
  const isPrivacy = doc === 'privacy'
  const title = isPrivacy ? 'Privacy' : 'Terms of use'
  const body = isPrivacy ? PRIVACY : TERMS

  return (
    <div className="min-h-screen bg-[#F6F8FC] px-4 py-10">
      <div className="max-w-2xl mx-auto bg-white border border-[#E3EAF3] rounded-xl p-6 shadow-sm space-y-4">
        <h1 className="text-[28px] font-extrabold text-[#111B37]">{title}</h1>
        <pre className="whitespace-pre-wrap text-[14px] text-[#334568] font-sans leading-relaxed">{body}</pre>
        <div className="flex gap-4 text-[13px] font-semibold">
          <Link to="/legal/terms" className="text-[#EF1B24]">
            Terms
          </Link>
          <Link to="/legal/privacy" className="text-[#EF1B24]">
            Privacy
          </Link>
          <Link to="/login" className="text-[#657794]">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  )
}
