import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router'
import { AuthProvider, FullPageSpinner, RequireCreator } from './lib/auth'
import { I18nProvider } from './lib/i18n'
import { ThemeProvider } from './lib/theme'
import DashboardPage, { DashboardIndex } from './pages/Dashboard'
import DiscoverPage from './pages/Discover'
import LoginPage from './pages/Login'
import WelcomePage from './pages/Welcome'

const EditorPage = lazy(() => import('./pages/editor/Editor'))
const ProjectPage = lazy(() => import('./pages/Project'))
const MonthlyPage = lazy(() => import('./pages/Monthly'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 2 && !(e as { status?: number }).status, refetchOnWindowFocus: false } },
})

const guard = (el: React.ReactNode, allowIncomplete = false) => <RequireCreator allowIncomplete={allowIncomplete}>{el}</RequireCreator>

const router = createBrowserRouter([
  { path: '/', element: <DiscoverPage /> },
  { path: '/p/:slug', element: <Suspense fallback={<FullPageSpinner />}><ProjectPage /></Suspense> },
  { path: '/login', element: <LoginPage /> },
  { path: '/welcome', element: guard(<WelcomePage />, true) },
  // Supporters don't need a creator profile.
  { path: '/monthly', element: guard(<Suspense fallback={<FullPageSpinner />}><MonthlyPage /></Suspense>, true) },
  { path: '/dashboard', element: guard(<DashboardIndex />) },
  { path: '/dashboard/:id', element: guard(<DashboardPage />) },
  { path: '/projects/new', element: guard(<Suspense fallback={<FullPageSpinner />}><EditorPage /></Suspense>) },
  { path: '/projects/:id/edit', element: guard(<Suspense fallback={<FullPageSpinner />}><EditorPage /></Suspense>) },
  { path: '*', element: <Navigate to="/" replace /> },
])

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
