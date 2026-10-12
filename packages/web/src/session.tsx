import React from 'react';
import { fetchSession, PublicUser, SESSION_INVALIDATED } from './api/client.js';

interface SessionState {
  user: PublicUser | null;
  loading: boolean;
  error: string | null;
  setUser: (user: PublicUser | null) => void;
}
const SessionContext = React.createContext<SessionState | null>(null);
export const SessionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [user, setUser] = React.useState<PublicUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    const invalidate = () => { setUser(null); setError('Session expired. Please sign in again.'); };
    window.addEventListener(SESSION_INVALIDATED, invalidate);
    fetchSession().then(result => { if (active) setUser(result.user); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : 'Unable to load session'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; window.removeEventListener(SESSION_INVALIDATED, invalidate); };
  }, []);
  return <SessionContext.Provider value={{user, loading, error, setUser: value => {setUser(value); setError(null);}}}>{children}</SessionContext.Provider>;
};
export function useSession(): SessionState {
  const session = React.useContext(SessionContext);
  if (!session) throw new Error('SessionProvider is required');
  return session;
}
