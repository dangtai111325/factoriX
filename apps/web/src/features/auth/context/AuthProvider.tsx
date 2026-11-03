import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  AuthStatus,
  AuthUser,
  bootstrap as bootstrapApi,
  currentUser,
  getAuthStatus,
  login as loginApi,
  logout as logoutApi,
  mapAuthError,
} from '../services/authClient'

type AuthState =
  | { status: 'checking'; user: null; platform: AuthStatus | null }
  | { status: 'guest'; user: null; platform: AuthStatus }
  | { status: 'authenticated'; user: AuthUser; platform: AuthStatus }

type AuthContextValue = {
  state: AuthState
  isAuthenticated: boolean
  isFirstRun: boolean
  setupCodeRequired: boolean
  refreshSession: () => Promise<void>
  signIn: (login: string, password: string) => Promise<void>
  signUp: (input: {
    fullName: string
    email: string
    username: string
    password: string
    setupCode?: string
  }) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

const EMPTY_PLATFORM: AuthStatus = {
  admin_exists: true,
  bootstrap_enabled: false,
  setup_code_required: false,
  appliance: false,
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AuthState>({ status: 'checking', user: null, platform: null })

  const refreshSession = useCallback(async () => {
    const platform = await getAuthStatus()
    try {
      const user = await currentUser()
      setState({ status: 'authenticated', user, platform })
    } catch {
      setState({ status: 'guest', user: null, platform })
    }
  }, [])

  useEffect(() => {
    void refreshSession().catch(() => {
      setState({ status: 'guest', user: null, platform: EMPTY_PLATFORM })
    })
  }, [refreshSession])

  const signIn = useCallback(async (loginName: string, password: string) => {
    await loginApi(loginName, password)
    await refreshSession()
  }, [refreshSession])

  const signUp = useCallback(async (input: {
    fullName: string
    email: string
    username: string
    password: string
    setupCode?: string
  }) => {
    await bootstrapApi({
      login: input.username,
      email: input.email,
      password: input.password,
      full_name: input.fullName,
      setupCode: input.setupCode,
    })
  }, [])

  const signOut = useCallback(async () => {
    try {
      await logoutApi()
    } catch (error) {
      // Still clear local session if the cookie is already gone.
      if ((error as { status?: number }).status !== 401) throw error
    }
    const platform = await getAuthStatus().catch(() => EMPTY_PLATFORM)
    setState({ status: 'guest', user: null, platform })
  }, [])

  const value = useMemo<AuthContextValue>(() => {
    const platform = state.platform || EMPTY_PLATFORM
    return {
      state,
      isAuthenticated: state.status === 'authenticated',
      isFirstRun: !platform.admin_exists && platform.bootstrap_enabled,
      setupCodeRequired: platform.setup_code_required,
      refreshSession,
      signIn,
      signUp,
      signOut,
    }
  }, [state, refreshSession, signIn, signUp, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}

export function useAuthErrorMessage(error: unknown, fallback: string): string {
  return mapAuthError(error, fallback)
}
