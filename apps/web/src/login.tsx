import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api, type AuthStatus } from "./api";

type Mode = "register" | "signin" | "forgot";

export function LoginPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AuthStatus>("/api/v1/auth/status")
      .then((next) => {
        setStatus(next);
        setMode(next.admin_exists ? "signin" : "register");
      })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") {
        if (!status?.bootstrap_enabled) return;
        if (password !== repeat) {
          setError("The passwords do not match.");
          return;
        }
        const headers = new Headers();
        if (status.setup_code_required) headers.set("X-Bootstrap-Token", token);
        await api("/api/v1/auth/bootstrap", {
          method: "POST",
          headers,
          body: JSON.stringify({ login, email, password, display_name: login, tenant_code: "primary" }),
        });
        await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ login, password }) });
        navigate("/");
        return;
      }
      if (mode === "forgot" && !codeSent) {
        await api("/api/v1/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
        setCodeSent(true);
        return;
      }
      if (mode === "forgot" && codeSent) {
        if (password !== repeat) {
          setError("The passwords do not match.");
          return;
        }
        await api("/api/v1/auth/reset", { method: "POST", body: JSON.stringify({ email, code, new_password: password }) });
        await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ login: email, password }) });
        navigate("/");
        return;
      }
      await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ login, password }) });
      navigate("/");
    } catch (reason) {
      const apiError = reason as ApiError;
      const wait = apiError.body?.retry_after_seconds;
      setError(wait ? `${apiError.message} Try again in ${wait} seconds.` : apiError.message);
    } finally {
      setBusy(false);
    }
  }

  const ready = status !== null;
  const needsCode = Boolean(status?.setup_code_required);
  const heading = !ready ? "Checking setup" : mode === "register" ? "Create an account" : mode === "forgot" ? "Reset password" : "Sign in";
  const showPassword = mode === "register" || mode === "signin" || codeSent;

  return (
    <main className="login">
      <section className="login-brand">
        <div>
          <img src="/brand/avenue-logo.png" alt="Avenue" />
          <h1>FactoriX Industrial IoT</h1>
          <p>See machines, connections, and live measurements in one place.</p>
        </div>
        <p className="muted">One administrator</p>
      </section>
      <section className="login-panel">
        <form className="login-card stack" onSubmit={onSubmit}>
          <h2>{heading}</h2>
          <p className="muted">
            {!ready
              ? "Checking whether an administrator exists."
              : mode === "register"
              ? status?.bootstrap_enabled
                ? needsCode
                  ? "Enter the one-time setup code, then your email, sign-in name, and password."
                  : "Enter an email, a sign-in name, and a password for this site."
                : "Administrator setup is not enabled."
              : mode === "forgot"
                ? codeSent
                  ? "If that email is registered, a code is on its way. Enter it with a new password."
                  : "Enter the email used to create the account."
                : "Use your email or sign-in name."}
          </p>
          {ready && mode === "register" && needsCode ? (
            <label className="field">
              <span>Setup code</span>
              <input value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required />
            </label>
          ) : null}
          {ready && (mode === "register" || mode === "forgot") ? (
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
            </label>
          ) : null}
          {ready && mode === "register" ? (
            <label className="field">
              <span>Sign-in name</span>
              <input value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" required />
            </label>
          ) : null}
          {ready && mode === "signin" ? (
            <label className="field">
              <span>Email or sign-in name</span>
              <input value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" required />
            </label>
          ) : null}
          {ready && mode === "forgot" && codeSent ? (
            <label className="field">
              <span>Reset code</span>
              <input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
            </label>
          ) : null}
          {ready && showPassword ? (
            <label className="field">
              <span>{mode === "forgot" ? "New password" : "Password"}</span>
              <input
                type={reveal ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyUp={(event) => setCaps(event.getModifierState("CapsLock"))}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                required
              />
            </label>
          ) : null}
          {ready && (mode === "register" || (mode === "forgot" && codeSent)) ? (
            <p className="muted">At least 12 characters, using three of lowercase, uppercase, digits, and symbols.</p>
          ) : null}
          {ready && (mode === "register" || (mode === "forgot" && codeSent)) ? (
            <label className="field">
              <span>Repeat password</span>
              <input type={reveal ? "text" : "password"} value={repeat} onChange={(event) => setRepeat(event.target.value)} autoComplete="new-password" required />
            </label>
          ) : null}
          {ready && showPassword ? (
            <div className="row">
              <button className="btn ghost" type="button" onClick={() => setReveal((value) => !value)} aria-pressed={reveal}>
                {reveal ? "Hide password" : "Show password"}
              </button>
              {caps ? <span>Caps Lock is on</span> : null}
            </div>
          ) : null}
          {error ? <div className="error" role="alert">{error}</div> : null}
          <button className="btn primary" disabled={busy || status === null || (mode === "register" && !status.bootstrap_enabled)} type="submit">
            {!ready ? "Checking setup" : busy ? "Working" : mode === "register" ? "Create and sign in" : mode === "forgot" ? (codeSent ? "Update password" : "Send code") : "Sign in"}
          </button>
          {ready && mode === "signin" ? (
            <button className="btn ghost" type="button" onClick={() => { setMode("forgot"); setError(""); setCodeSent(false); }}>
              Forgot password
            </button>
          ) : null}
          {ready && mode === "forgot" ? (
            <button className="btn ghost" type="button" onClick={() => { setMode("signin"); setError(""); setCodeSent(false); }}>
              Back to sign in
            </button>
          ) : null}
        </form>
      </section>
    </main>
  );
}
