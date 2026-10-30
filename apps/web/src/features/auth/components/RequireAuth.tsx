import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthProvider'

export const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { state, isFirstRun } = useAuth()
  const location = useLocation()

  if (state.status === 'checking') {
    return (
      <div className="min-h-screen bg-[#F6F8FC] flex items-center justify-center text-[#657794]">
        Opening FactoriX…
      </div>
    )
  }

  if (state.status !== 'authenticated') {
    const target = isFirstRun ? '/register' : '/login'
    return <Navigate to={target} replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />
  }

  return <>{children}</>
}

export const GuestOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { state } = useAuth()
  if (state.status === 'checking') {
    return (
      <div className="min-h-screen bg-[#F6F8FC] flex items-center justify-center text-[#657794]">
        Opening FactoriX…
      </div>
    )
  }
  if (state.status === 'authenticated') return <Navigate to="/overview" replace />
  return <>{children}</>
}
