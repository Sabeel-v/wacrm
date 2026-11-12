import { toNextJsHandler } from 'better-auth/next-js'
import { getAuth } from '@/lib/auth/better-auth'

// Better Auth endpoints: /api/auth/sign-in/email, /sign-up/email, /sign-out,
// /get-session, /request-password-reset, /reset-password, /change-password, …
const handler = async (request: Request) => {
  const auth = await getAuth()
  return toNextJsHandler(auth).POST(request)
}
const getHandler = async (request: Request) => {
  const auth = await getAuth()
  return toNextJsHandler(auth).GET(request)
}

export { getHandler as GET, handler as POST }
