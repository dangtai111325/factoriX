import React, { useEffect, useState } from 'react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { api } from '../../api/client';

type EmailSettings = {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  from_address: string;
  password_set: boolean;
  configured: boolean;
};

type LockRow = {
  key: string;
  login: string;
  ip: string;
  failed_count: number;
  locked_until: string;
};

export const AdministrationPage: React.FC = () => {
  const [email, setEmail] = useState<EmailSettings>({
    host: '',
    port: 587,
    tls: true,
    user: '',
    from_address: '',
    password_set: false,
    configured: false,
  });
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const reload = async () => {
    const [mail, lockList] = await Promise.all([
      api<EmailSettings>('/api/v1/admin/email'),
      api<{ items?: LockRow[] }>('/api/v1/admin/locks').catch(() => ({ items: [] })),
    ]);
    setEmail(mail);
    setLocks(lockList.items || []);
  };

  useEffect(() => {
    void reload().catch((err) => {
      setError(err instanceof Error ? err.message : 'Could not load administration');
    });
  }, []);

  const saveEmail = async () => {
    setPending(true);
    setError('');
    setMessage('');
    try {
      const saved = await api<EmailSettings & { status: string }>('/api/v1/admin/email', {
        method: 'PUT',
        body: JSON.stringify({
          host: email.host,
          port: email.port,
          tls: email.tls,
          user: email.user,
          password,
          from_address: email.from_address,
        }),
      });
      setEmail({
        host: saved.host,
        port: saved.port,
        tls: saved.tls,
        user: saved.user,
        from_address: saved.from_address,
        password_set: saved.password_set,
        configured: saved.configured,
      });
      setPassword('');
      setMessage(saved.configured ? 'Email settings saved.' : 'Saved. Fill host, user, from, and password to enable recovery.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save email settings');
    } finally {
      setPending(false);
    }
  };

  const sendTest = async () => {
    setPending(true);
    setError('');
    setMessage('');
    try {
      await api('/api/v1/admin/email/test', {
        method: 'POST',
        body: JSON.stringify({ to: testTo.trim().toLowerCase() }),
      });
      setMessage('Test message accepted by the mail server.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send test failed');
    } finally {
      setPending(false);
    }
  };

  const unlock = async (login: string) => {
    setPending(true);
    setError('');
    setMessage('');
    try {
      await api('/api/v1/admin/unlock', {
        method: 'POST',
        body: JSON.stringify({ login }),
      });
      setMessage(`Unlocked ${login}.`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200 max-w-3xl">
      <div>
        <h1 className="fx-page-title">Administration</h1>
        <p className="fx-page-subtitle">Email delivery and account lockouts for this appliance.</p>
      </div>

      {error && <p className="text-[12px] text-[#F2343B]">{error}</p>}
      {message && <p className="text-[12px] text-[#0DBA67]">{message}</p>}

      <Card title="Email">
        <p className="text-[12px] text-[#657794] mb-3">
          {email.configured
            ? 'SMTP is configured. Password recovery and verification codes can be sent.'
            : 'Password recovery is disabled until email is set up.'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-[12px] font-semibold text-[#334568]">
            Host
            <input
              className="mt-1 w-full fx-input"
              value={email.host}
              onChange={(e) => setEmail((prev) => ({ ...prev, host: e.target.value }))}
              placeholder="smtp.example.local"
            />
          </label>
          <label className="block text-[12px] font-semibold text-[#334568]">
            Port
            <input
              type="number"
              className="mt-1 w-full fx-input"
              value={email.port}
              onChange={(e) => setEmail((prev) => ({ ...prev, port: Number(e.target.value) || 587 }))}
            />
          </label>
          <label className="block text-[12px] font-semibold text-[#334568]">
            Username
            <input
              className="mt-1 w-full fx-input"
              value={email.user}
              onChange={(e) => setEmail((prev) => ({ ...prev, user: e.target.value }))}
            />
          </label>
          <label className="block text-[12px] font-semibold text-[#334568]">
            Password
            <input
              type="password"
              className="mt-1 w-full fx-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={email.password_set ? 'Leave blank to keep current' : 'SMTP password'}
              autoComplete="new-password"
            />
          </label>
          <label className="block text-[12px] font-semibold text-[#334568] sm:col-span-2">
            From address
            <input
              className="mt-1 w-full fx-input"
              value={email.from_address}
              onChange={(e) => setEmail((prev) => ({ ...prev, from_address: e.target.value }))}
              placeholder="noreply@example.local"
            />
          </label>
          <label className="inline-flex items-center gap-2 text-[13px] text-[#334568] sm:col-span-2">
            <input
              type="checkbox"
              checked={email.tls}
              onChange={(e) => setEmail((prev) => ({ ...prev, tls: e.target.checked }))}
            />
            Use STARTTLS
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" loading={pending} onClick={() => void saveEmail()}>
            Save email settings
          </Button>
        </div>
        <div className="mt-4 pt-3 border-t border-[#E3EAF3] flex flex-col sm:flex-row gap-2 sm:items-end">
          <label className="block text-[12px] font-semibold text-[#334568] flex-1">
            Send test to
            <input
              className="mt-1 w-full fx-input"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="admin@example.local"
            />
          </label>
          <Button
            variant="secondary"
            loading={pending}
            disabled={!testTo.trim() || !email.configured}
            onClick={() => void sendTest()}
          >
            Send test
          </Button>
        </div>
      </Card>

      <Card title="Locked sign-ins">
        <p className="text-[12px] text-[#657794] mb-3">
          After 5 failed attempts, a login is locked for 15 minutes for that username and IP. Unlock clears the lock
          immediately.
        </p>
        {!locks.length ? (
          <p className="text-[12px] text-[#94A3B8]">No active locks.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="fx-table">
              <thead>
                <tr>
                  <th>Login</th>
                  <th>IP</th>
                  <th>Failures</th>
                  <th>Locked until</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {locks.map((row) => (
                  <tr key={row.key}>
                    <td className="font-mono text-[12px]">{row.login}</td>
                    <td className="font-mono text-[12px] text-[#657794]">{row.ip}</td>
                    <td>{row.failed_count}</td>
                    <td className="font-mono text-[11px] text-[#657794]">{String(row.locked_until)}</td>
                    <td className="text-right">
                      <Button size="sm" variant="secondary" loading={pending} onClick={() => void unlock(row.login)}>
                        Unlock
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};
