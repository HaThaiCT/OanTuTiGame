import React from 'react';
import { login, logout, register } from '../api/client.js';
import { useSession } from '../session.js';

const controlStyle: React.CSSProperties = {background: '#0f172a', color: '#f8fafc', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px'};
export const AccountPanel: React.FC = () => {
  const {user, loading, error: sessionError, setUser} = useSession();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<'login' | 'register'>('login');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLElement>(null);
  React.useEffect(() => { if (open) panel.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [open, mode]);
  const close = () => { setOpen(false); setError(null); trigger.current?.focus(); };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    try {
      const username = String(data.get('username'));
      const password = String(data.get('password'));
      const result = mode === 'login' ? await login(username, password) : await register(username, String(data.get('email')), password);
      setUser(result.user); close();
    } catch (err) { setError(err instanceof Error ? err.message : 'Account request failed'); }
    finally { setBusy(false); }
  };
  const signOut = async () => {
    setBusy(true); setError(null);
    try { await logout(); setUser(null); close(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign out failed'); }
    finally { setBusy(false); }
  };
  return <div style={{position: 'relative', fontSize: 12}}>
    <button ref={trigger} disabled={loading || busy} aria-expanded={open} aria-controls="account-panel" onClick={() => setOpen(value => !value)} style={controlStyle}>
      {loading ? 'Loading account…' : user ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span>{user.username}</span>
          <span style={{
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 4,
            fontWeight: 700,
            background: user.role === 'ADMIN' ? 'rgba(234, 179, 8, 0.2)' : 'rgba(56, 189, 248, 0.2)',
            color: user.role === 'ADMIN' ? '#facc15' : '#38bdf8',
            border: `1px solid ${user.role === 'ADMIN' ? '#eab308' : '#0284c7'}`
          }}>
            {user.role === 'ADMIN' ? '👑 Admin' : '🎮 Player'}
          </span>
        </span>
      ) : 'Sign in / Register'}
    </button>
    {sessionError && <span role="alert" style={{color: '#fca5a5', display: 'block', maxWidth: 220}}>{sessionError}</span>}
    {open && <section ref={panel} id="account-panel" aria-label="Account" onKeyDown={event => {if (event.key === 'Escape' && !busy) close();}} style={{position: 'absolute', right: 0, top: '100%', width: 280, zIndex: 100, padding: 18, background: '#141d2d', color: '#f8fafc', border: '1px solid #334155', borderRadius: 12, boxShadow: '0 12px 30px #0008'}}>
      <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: 12}}><strong>{user ? 'Your account' : mode === 'login' ? 'Sign in' : 'Register'}</strong><button type="button" disabled={busy} onClick={close} aria-label="Close account panel" style={controlStyle}>×</button></div>
      {user ? <><p><strong>{user.username}</strong> ({user.role === 'ADMIN' ? 'Admin' : 'Player'})</p><p>{user.email}</p><button onClick={signOut} disabled={busy} style={controlStyle}>Log out</button></> : <form onSubmit={submit} style={{display: 'flex', flexDirection: 'column', gap: 12}}>
        <label>Username<input name="username" required autoComplete="username" style={{...controlStyle, width: '100%', boxSizing: 'border-box'}} /></label>
        {mode === 'register' && <label>Email<input name="email" type="email" required autoComplete="email" style={{...controlStyle, width: '100%', boxSizing: 'border-box'}} /></label>}
        <label>Password<input name="password" type="password" required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} style={{...controlStyle, width: '100%', boxSizing: 'border-box'}} /></label>
        <button disabled={busy} style={{...controlStyle, background: '#0284c7'}}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button type="button" disabled={busy} onClick={() => {setMode(mode === 'login' ? 'register' : 'login'); setError(null);}} style={controlStyle}>{mode === 'login' ? 'Register an account' : 'Already registered? Sign in'}</button>
      </form>}
      {error && <p role="alert" style={{color: '#fca5a5'}}>{error}</p>}
    </section>}
  </div>;
};
