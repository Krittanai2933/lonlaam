import type { Creator, LoginResponse } from '@nampu/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { api, tokenStore, UNAUTHORIZED_EVENT } from './api'

interface Auth {
  token: string | null
  creator: Creator | undefined
  loading: boolean
  /** Stores the session and primes the `me` cache. */
  signIn: (res: LoginResponse) => void
  signOut: () => Promise<void>
}

const Ctx = createContext<Auth | null>(null)
export const meKey = ['me'] as const

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [token, setToken] = useState(tokenStore.get)
  const me = useQuery({ queryKey: meKey, queryFn: api.me, enabled: !!token, staleTime: 60_000 })

  const clear = useCallback(() => {
    tokenStore.set(null)
    setToken(null)
    qc.clear()
  }, [qc])

  useEffect(() => {
    window.addEventListener(UNAUTHORIZED_EVENT, clear)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, clear)
  }, [clear])

  const value = useMemo<Auth>(
    () => ({
      token,
      creator: token ? me.data : undefined,
      loading: !!token && me.isPending,
      signIn: (res) => {
        tokenStore.set(res.token)
        qc.setQueryData(meKey, res.creator)
        setToken(res.token)
      },
      signOut: async () => {
        await api.logout().catch(() => undefined)
        clear()
      },
    }),
    [token, me.data, me.isPending, qc, clear],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): Auth {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}

export const isOnboarded = (c: Creator | undefined) => !!c?.handle && !!c.displayName

/** Route guard: login → onboarding → page. */
export function RequireCreator({ children, allowIncomplete }: { children: ReactNode; allowIncomplete?: boolean }) {
  const { token, creator, loading } = useAuth()
  const loc = useLocation()
  if (!token) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  if (loading || !creator) return <FullPageSpinner />
  if (!allowIncomplete && !isOnboarded(creator)) return <Navigate to="/welcome" replace state={{ from: loc.pathname + loc.search }} />
  return <>{children}</>
}

export function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center text-accent" aria-busy="true">
      <span className="inline-block size-5 animate-np-spin rounded-full border-[1.5px] border-current border-r-transparent" />
    </div>
  )
}
