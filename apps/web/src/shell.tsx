import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, type Me } from "./api";
import { plainLabel } from "./format";
import { applyTheme, currentTheme, type ThemeName } from "./theme";

const GROUPS: { label: string; items: { to: string; label: string; planned?: boolean }[] }[] = [
  { label: "Workspace", items: [{ to: "/", label: "Overview" }] },
  {
    label: "Factory",
    items: [
      { to: "/factory", label: "Factory" },
      { to: "/layouts", label: "Layout" },
      { to: "/graph", label: "Relationships" },
      { to: "/hierarchy", label: "Hierarchy" },
    ],
  },
  {
    label: "Collection",
    items: [
      { to: "/connections", label: "Connections" },
      { to: "/signals", label: "Signals" },
      { to: "/formulas", label: "Calculations" },
      { to: "/output-groups", label: "Output groups" },
      { to: "/commissioning", label: "Tests" },
      { to: "/collect", label: "Add data" },
    ],
  },
  { label: "Operations", items: [{ to: "/edges", label: "Edge nodes" }, { to: "/deployments", label: "Releases" }] },
  { label: "Storage", items: [{ to: "/storage", label: "Storage" }, { to: "/history", label: "History" }] },
  {
    label: "Later",
    items: [
      { to: "/dashboards", label: "Dashboards", planned: true },
      { to: "/planned/rules", label: "Rules & Alarms", planned: true },
      { to: "/planned/analytics", label: "Analytics", planned: true },
      { to: "/planned/reports", label: "Reports", planned: true },
    ],
  },
  { label: "System", items: [{ to: "/audit", label: "Activity" }, { to: "/settings", label: "Settings" }] },
];

type SearchHit = { id: string; name?: string; code?: string; key?: string; display_name?: string; protocol?: string };

export function Shell() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ resources: SearchHit[]; connections: SearchHit[]; signals: SearchHit[] } | null>(null);
  const [menu, setMenu] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(currentTheme);
  const [nav, setNav] = useState(false);

  useEffect(() => {
    api<Me>("/api/v1/auth/me").then(setMe).catch(() => navigate("/login"));
  }, [navigate]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !typing) {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") {
        setOpen(false);
        setMenu(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open || query.trim().length < 1) return;
    const handle = window.setTimeout(() => {
      api<{ resources: SearchHit[]; connections: SearchHit[]; signals: SearchHit[] }>(`/api/v1/search?q=${encodeURIComponent(query)}`)
        .then(setHits)
        .catch(() => setHits(null));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [open, query]);

  async function logout() {
    await api("/api/v1/auth/logout", { method: "POST" });
    navigate("/login");
  }

  function chooseTheme(next: ThemeName) {
    applyTheme(next);
    setTheme(next);
  }

  if (!me) return <p className="page">Checking session…</p>;

  return (
    <div className="shell">
      <header className="header">
        <button className="btn ghost menu-btn" type="button" aria-expanded={nav} onClick={() => setNav((value) => !value)}>Menu</button>
        <img src="/brand/avenue-logo.png" alt="Avenue" />
        <div className="brand-name">FactoriX Industrial IoT</div>
        <button className="search-trigger" type="button" onClick={() => setOpen(true)}>
          <span>Search</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="btn ghost" type="button" onClick={() => { setMenu((value) => !value); setAppearance(false); }} aria-expanded={menu}>
          {me.login}
        </button>
        {menu ? (
          <div className="panel account-menu">
            <p className="muted">{me.email || me.login}</p>
            <button className="menu-choice" type="button" onClick={() => { setMenu(false); navigate("/settings"); }}>Account</button>
            <button className="menu-choice" type="button" aria-expanded={appearance} onClick={() => setAppearance((value) => !value)}>Appearance</button>
            {appearance ? (
              <div>
                <button className="menu-choice" type="button" role="radio" aria-checked={theme === "light"} onClick={() => chooseTheme("light")}>Light</button>
                <button className="menu-choice" type="button" role="radio" aria-checked={theme === "dark"} onClick={() => chooseTheme("dark")}>Dark</button>
              </div>
            ) : null}
            <button className="menu-choice" type="button" onClick={logout}>Sign out</button>
          </div>
        ) : null}
      </header>
      <div className={nav ? "body nav-open" : "body"}>
        <nav className="sidebar" aria-label="Main" onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setNav(false); }}>
          {GROUPS.map((group) => group.label === "Later" ? (
            <details key={group.label} className="nav-future">
              <summary className="nav-group">Later</summary>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link planned${isActive ? " active" : ""}`}>
                  {item.label}
                  <span className="badge">Planned</span>
                </NavLink>
              ))}
            </details>
          ) : (
            <div key={group.label}>
              <div className="nav-group">{group.label}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <main className="page">
          <Outlet />
        </main>
      </div>
      {open ? (
        <div className="dialog-back" onMouseDown={() => setOpen(false)}>
          <form
            className="dialog stack"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (hits?.resources[0]) navigate(`/factory?resource=${hits.resources[0].id}`);
              else if (hits?.signals[0]) navigate(`/history?signal=${hits.signals[0].id}`);
              else if (hits?.connections[0]) navigate("/connections");
              setOpen(false);
            }}
          >
            <input autoFocus aria-label="Search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search resources, connections, signals" />
            {hits ? (
              <div>
                <SearchGroup title="Resources" empty="No resources">
                  {hits.resources.map((item) => (
                    <button className="list-btn" type="button" key={item.id} onClick={() => { navigate(`/factory?resource=${item.id}`); setOpen(false); }}>{item.code} · {item.name}</button>
                  ))}
                </SearchGroup>
                <SearchGroup title="Connections" empty="No connections">
                  {hits.connections.map((item) => (
                    <button className="list-btn" type="button" key={item.id} onClick={() => { navigate("/connections"); setOpen(false); }}>{item.name} · {plainLabel(item.protocol)}</button>
                  ))}
                </SearchGroup>
                <SearchGroup title="Signals" empty="No signals">
                  {hits.signals.map((item) => (
                    <button className="list-btn" type="button" key={item.id} onClick={() => { navigate(`/history?signal=${item.id}`); setOpen(false); }}>{item.key} · {item.display_name}</button>
                  ))}
                </SearchGroup>
              </div>
            ) : <p className="muted">Type to search this site.</p>}
          </form>
        </div>
      ) : null}
    </div>
  );
}

function SearchGroup(props: { title: string; empty: string; children: ReactNode }) {
  const count = Array.isArray(props.children) ? props.children.length : props.children ? 1 : 0;
  return (
    <section className="command-group">
      <h3>{props.title}</h3>
      {count === 0 ? <p className="muted">{props.empty}</p> : props.children}
    </section>
  );
}
