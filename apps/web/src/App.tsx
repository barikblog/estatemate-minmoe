import { CSSProperties, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, ListResponse, User, api, money, readableDate } from './api';
import type { PassShareSource } from './pass-export';
import { exportRecordsToExcel, exportRecordsToPdf } from './records-export';

type Row = Record<string, unknown>;
type Section =
  // Overview
  | 'dashboard'
  // Access control
  | 'cards' | 'events' | 'devices' | 'remote' | 'sync' | 'isapi' | 'operations'
  // People & households
  | 'residents' | 'residency' | 'dependants' | 'staff'
  // Property & estate
  | 'properties' | 'bills' | 'maintenance' | 'bookings' | 'notices' | 'emergency'
  // Information & compliance
  | 'information' | 'legal' | 'visitors'
  // Administration
  | 'imports' | 'settings';

type NavGroup = { id: string; label: string; items: NavItem[] };
interface NavItem { id: Section; label: string; roles?: User['role'][]; badge?: string }
type PortalConfig = Record<string,string>;
const defaultPortalConfig: PortalConfig = {
  portal_name:'EstateMate',estate_name:'EstateMate Estate',portal_short_name:'EM',portal_tagline:'One estate. One secure view.',
  portal_welcome_text:'Manage residents, visitors, accounts and gate access from a single, secure workspace.',theme_mode:'light',
  theme_primary_color:'#1769e0',theme_accent_color:'#35d07f',theme_navigation_color:'#0d1b37',theme_surface_color:'#ffffff',
  theme_corner_style:'comfortable',currency:'NGN',estate_timezone:'Africa/Lagos',visitor_default_duration_hours:'8',visitor_gate_policy:'security_approval',
  portal_gate_image_key:'',portal_gate_image_caption:'',portal_gate_image_enabled:'false',
};

/**
 * URL of the administrator-published estate gate photograph, or null when none is
 * configured. The route is unauthenticated because the login screen has to show
 * it before anyone signs in.
 */
function gateImageUrl(config: PortalConfig): string | null {
  return config.portal_gate_image_enabled === 'true' && config.portal_gate_image_key ? '/api/portal-gate-image' : null;
}

/**
 * Layered backdrop for the estate gate photograph. A dark scrim sits over the
 * image so the welcome text stays legible whatever an administrator uploads.
 */
function gateImageStyle(url: string | null): CSSProperties | undefined {
  if (!url) return undefined;
  return {
    backgroundImage: `linear-gradient(158deg, rgba(6,20,44,.9), rgba(9,32,70,.66) 46%, rgba(11,45,104,.55)), url(${url})`,
    backgroundSize: 'auto, cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  };
}

function applyPortalTheme(config: PortalConfig) {
  const root=document.documentElement;
  root.style.setProperty('--blue',config.theme_primary_color || defaultPortalConfig.theme_primary_color);
  root.style.setProperty('--green',config.theme_accent_color || defaultPortalConfig.theme_accent_color);
  root.style.setProperty('--navy',config.theme_navigation_color || defaultPortalConfig.theme_navigation_color);
  root.style.setProperty('--surface',config.theme_surface_color || defaultPortalConfig.theme_surface_color);
  root.style.setProperty('--radius',config.theme_corner_style==='rounded'?'22px':config.theme_corner_style==='compact'?'8px':'15px');
  const mode=config.theme_mode==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):config.theme_mode;
  root.dataset.theme=mode || 'light';
}

const navGroups: NavGroup[] = [
  { id: 'overview', label: 'Overview', items: [
    { id: 'dashboard', label: 'Dashboard' },
  ]},
  { id: 'access', label: 'Access control', items: [
    { id: 'cards', label: 'Cards & fingerprints', roles: ['admin','manager','cashier','resident'] },
    { id: 'events', label: 'Gate activity', roles: ['admin','manager','security','resident'] },
    { id: 'devices', label: 'Terminals & devices', roles: ['admin','manager','security'] },
    { id: 'remote', label: 'Remote door control', roles: ['admin'] },
    { id: 'sync', label: 'Person sync', roles: ['admin','manager'] },
    { id: 'isapi', label: 'Device agent', roles: ['admin','manager'] },
    { id: 'operations', label: 'Hardware actions', roles: ['admin','manager'] },
  ]},
  { id: 'people', label: 'Residents & staff', items: [
    { id: 'residents', label: 'Resident manager', roles: ['admin','manager','cashier','security'] },
    { id: 'residency', label: 'Tenancy & household', roles: ['admin','manager','resident'] },
    { id: 'dependants', label: 'Dependants manager', roles: ['admin','manager','cashier','resident'] },
    { id: 'staff', label: 'Staff management', roles: ['admin','manager'] },
  ]},
  { id: 'estate', label: 'Estate management', items: [
    { id: 'properties', label: 'Property administration', roles: ['admin','manager','cashier','security','resident'] },
    { id: 'bills', label: 'Bills & payments', roles: ['admin','cashier','resident'] },
    { id: 'maintenance', label: 'Service operations', roles: ['admin','manager','resident'] },
    { id: 'bookings', label: 'Facility bookings', roles: ['admin','manager','cashier','resident'] },
    { id: 'notices', label: 'Estate notices' },
    { id: 'emergency', label: 'Emergency contacts' },
  ]},
  { id: 'visitors', label: 'Visitors', items: [
    { id: 'visitors', label: 'Visitor management' },
  ]},
  { id: 'info', label: 'Information resources', items: [
    { id: 'information', label: 'Information hub' },
    { id: 'legal', label: 'Legal & governance' },
  ]},
  { id: 'admin', label: 'Administration', items: [
    { id: 'imports', label: 'Import centre', roles: ['admin','manager'] },
    { id: 'settings', label: 'Settings', roles: ['admin'] },
  ]},
];

const allNavItems: NavItem[] = navGroups.flatMap((g) => g.items);

function useAsync<T>(loader: () => Promise<T>, dependencies: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setError('');
    loader().then(setData).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

function PasswordField({ value,onChange,name='password',label='Password',autoComplete='current-password',minLength }: { value:string;onChange:(value:string)=>void;name?:string;label?:string;autoComplete?:string;minLength?:number }) {
  const [revealed,setRevealed]=useState(false);
  return <label>{label}
    <span className="password-field">
      <input name={name} type={revealed?'text':'password'} value={value} onChange={(event)=>onChange(event.target.value)} autoComplete={autoComplete} minLength={minLength} required />
      <button type="button" className="reveal-toggle" onClick={()=>setRevealed((current)=>!current)} aria-pressed={revealed} title={revealed?'Hide password':'Show password'}>{revealed?'Hide':'Show'}</button>
    </span>
  </label>;
}

function PortalFooter({ portalName }: { portalName?:string }) {
  return <footer className="portal-footer">
    {portalName && <span className="footer-portal">{portalName}</span>}
    <span>Powered by <a href="https://wa.me/2348100065868" target="_blank" rel="noreferrer noopener">sornix.com.ng</a></span>
  </footer>;
}

/**
 * Second step of a Security sign-in: the officer picks the gate they are working
 * (only their assigned posts if an administrator set any, otherwise any active gate), and that choice scopes the whole session.
 */
function GatePicker({ config, gates, officerName, selectionToken, onSelected, onBack }: {
  config: PortalConfig;
  gates: Row[];
  officerName: string;
  selectionToken: string;
  onSelected: (user: User, gate: Row) => void;
  onBack: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const image = gateImageUrl(config);

  async function choose(deviceId: string) {
    setBusy(deviceId); setError('');
    try {
      const result = await api<{ user: User; gate: Row }>('/api/auth/select-gate', {
        method: 'POST',
        body: JSON.stringify({ selectionToken, deviceId }),
      });
      onSelected(result.user, result.gate);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start your shift');
      setBusy('');
    }
  }

  return <main className="auth-shell">
    <section className={image ? 'auth-panel brand-panel has-gate-image' : 'auth-panel brand-panel'} style={gateImageStyle(image)}>
      <div className="brand-copy">
        <div className="brand-mark">{config.portal_short_name}</div>
        <p className="eyebrow">{config.portal_tagline}</p>
        <h1>Welcome to<br />{config.portal_name}.</h1>
        <p className="auth-intro">{config.portal_welcome_text}</p>
        {image && config.portal_gate_image_caption && <p className="gate-image-caption">{config.portal_gate_image_caption}</p>}
        <div className="brand-proof"><span className="pulse-dot" /> Cloud and gate operations connected</div>
      </div>
    </section>
    <section className="auth-panel form-panel">
      {image && <div className="mobile-gate-banner" style={gateImageStyle(image)}>{config.portal_gate_image_caption || `${config.estate_name} gate`}</div>}
      <div className="login-card">
        <span className="mini-logo">{config.portal_short_name}</span>
        <h2>Select your gate</h2>
        <p>{officerName.split(' ')[0]}, which gate are you posted at for this session? Your visitor queue, gate activity and device list are limited to that post.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="gate-choice-list">
          {gates.map((gate) => {
            const id = String(gate.id);
            return <button key={id} type="button" className="gate-choice" disabled={Boolean(busy)} onClick={() => choose(id)}>
              <strong>{String(gate.gate_name || gate.name)}</strong>
              <small>{String(gate.name)} · {String(gate.direction)}{gate.model ? ` · ${String(gate.model)}` : ''}</small>
              {busy === id && <span className="gate-choice-busy">Starting shift…</span>}
            </button>;
          })}
        </div>
        <button type="button" className="text" onClick={onBack}>← Sign in as someone else</button>
      </div>
      <PortalFooter portalName={config.portal_name} />
    </section>
  </main>;
}

function Login({ onLogin, config }: { onLogin: (user: User, gate?: Row | null) => void; config:PortalConfig }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [gateStep, setGateStep] = useState<{ gates: Row[]; selectionToken: string; officerName: string } | null>(null);
  const image = gateImageUrl(config);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true); setError('');
    try {
      const result = await api<{
        user: User;
        requiresGateSelection?: boolean;
        gates?: Row[];
        selectionToken?: string;
      }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      // Every Security officer must choose a gate before a session
      // cookie is issued, so the API hands back a short-lived selection token.
      if (result.requiresGateSelection && result.gates?.length && result.selectionToken) {
        setGateStep({ gates: result.gates, selectionToken: result.selectionToken, officerName: result.user.name });
        return;
      }
      onLogin(result.user, null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login failed');
    } finally { setLoading(false); }
  }

  if (gateStep) return <GatePicker
    config={config}
    gates={gateStep.gates}
    officerName={gateStep.officerName}
    selectionToken={gateStep.selectionToken}
    onSelected={(user, gate) => onLogin(user, gate)}
    onBack={() => { setGateStep(null); setPassword(''); setError(''); }}
  />;

  return <main className="auth-shell">
    <section className={image ? 'auth-panel brand-panel has-gate-image' : 'auth-panel brand-panel'} style={gateImageStyle(image)}>
      <div className="brand-copy">
        <div className="brand-mark">{config.portal_short_name}</div>
        <p className="eyebrow">{config.portal_tagline}</p>
        <h1>Welcome to<br />{config.portal_name}.</h1>
        <p className="auth-intro">{config.portal_welcome_text}</p>
        {image && config.portal_gate_image_caption && <p className="gate-image-caption">{config.portal_gate_image_caption}</p>}
        <div className="brand-proof"><span className="pulse-dot" /> Cloud and gate operations connected</div>
      </div>
    </section>
    <section className="auth-panel form-panel">
      {image && <div className="mobile-gate-banner" style={gateImageStyle(image)}>{config.portal_gate_image_caption || `${config.estate_name} gate`}</div>}
      <form className="login-card" onSubmit={submit}>
        <span className="mini-logo">{config.portal_short_name}</span>
        <h2>Sign in</h2>
        <p>Use the account issued by your estate administrator.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <PasswordField value={password} onChange={setPassword} label="Password" />
        <button className="primary wide" disabled={loading}>{loading ? 'Signing in…' : 'Continue'}</button>
        <small>Protected by an encrypted, role-based session.</small>
      </form>
      <PortalFooter portalName={config.portal_name} />
    </section>
  </main>;
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info'|'error'|'success'|'warning' }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

function EstateNoticePopup({ notice, remaining, onAcknowledge }: { notice: Row; remaining: number; onAcknowledge: () => void }) {
  const severity = String(notice.severity ?? 'info');
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="estate-notice-title">
    <section className={`notice-modal ${severity}`}>
      <div className="notice-symbol">{severity === 'urgent' ? '!' : severity === 'important' ? '◆' : 'i'}</div>
      <p className="eyebrow">GENERAL ESTATE NOTICE</p>
      <h2 id="estate-notice-title">{String(notice.title)}</h2>
      <p className="notice-body">{String(notice.body)}</p>
      {Boolean(notice.published_until) && <small>Valid until {readableDate(notice.published_until)}</small>}
      <button className="primary wide" onClick={onAcknowledge}>{notice.requires_acknowledgement ? 'I have read this notice' : 'Close notice'}</button>
      {remaining > 0 && <small className="remaining">{remaining} more notice{remaining === 1 ? '' : 's'} waiting</small>}
    </section>
  </div>;
}

/** Lets a signed-in Security officer move to another assigned gate mid-shift. */
function SwitchGateDialog({ current, onSwitched, onClose }: { current: Row | null; onSwitched: (gate: Row) => void; onClose: () => void }) {
  const gates = useAsync<{ items: Row[]; selected: string | null }>(() => api('/api/auth/gates'), []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  async function choose(deviceId: string) {
    setBusy(deviceId); setError('');
    try {
      const result = await api<{ gate: Row }>('/api/auth/select-gate', { method: 'POST', body: JSON.stringify({ deviceId }) });
      onSwitched(result.gate);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not switch gate'); setBusy(''); }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="switch-gate-title">
    <section className="notice-modal">
      <p className="eyebrow">SHIFT POST</p>
      <h2 id="switch-gate-title">Switch gate</h2>
      <p className="notice-body">Choose the gate you are now posted at. Your visitor queue and gate activity follow this selection.</p>
      {error && <Notice tone="error">{error}</Notice>}
      {gates.error && <Notice tone="error">{gates.error}</Notice>}
      {gates.loading && <Loading />}
      <div className="gate-choice-list">
        {(gates.data?.items ?? []).map((item) => {
          const id = String(item.id);
          const active = String(current?.id ?? '') === id;
          return <button key={id} type="button" className={active ? 'gate-choice current' : 'gate-choice'} disabled={Boolean(busy)} onClick={() => choose(id)}>
            <strong>{String(item.gate_name || item.name)}</strong>
            <small>{String(item.name)} · {String(item.direction)}</small>
            {active && <span className="gate-choice-current">Current post</span>}
            {busy === id && <span className="gate-choice-busy">Switching…</span>}
          </button>;
        })}
      </div>
      <button type="button" className="secondary wide" onClick={onClose}>Close</button>
    </section>
  </div>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [gate, setGate] = useState<Row | null>(null);
  const [switchingGate, setSwitchingGate] = useState(false);
  const [section, setSection] = useState<Section>('dashboard');
  const [checking, setChecking] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popupNotices, setPopupNotices] = useState<Row[]>([]);
  const [portalConfig,setPortalConfig]=useState<PortalConfig>(defaultPortalConfig);

  useEffect(() => {
    api<PortalConfig>('/api/portal-config').then((value) => { const merged={ ...defaultPortalConfig,...value };setPortalConfig(merged);applyPortalTheme(merged); }).catch(() => applyPortalTheme(defaultPortalConfig));
    // A refreshed Security session keeps its selected gate because the gate is a
    // claim on the session token, echoed back here.
    api<{ user: User; gate?: Row | null }>('/api/auth/me').then((result) => { setUser(result.user); setGate(result.gate ?? null); }).catch(() => setUser(null)).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!user) { setPopupNotices([]); return; }
    api<{ items: Row[] }>('/api/notices/popup').then((result) => setPopupNotices(result.items)).catch(() => setPopupNotices([]));
  }, [user?.id]);

  // NOTE: every hook must run on every render, before any early return below.
  // Calling hooks after `if (checking) return` / `if (!user) return` changes the hook
  // count between the login screen and the signed-in view and crashes React
  // ("Rendered more hooks than during the previous render") -> blank page.
  const isOperator = user?.role === 'admin' || user?.role === 'manager';
  const [openMaintCount, setOpenMaintCount] = useState<number>(0);
  useEffect(() => {
    if (!user || !isOperator) { setOpenMaintCount(0); return; }
    api<{ openMaintenance?: { count: number } }>('/api/dashboard')
      .then((res) => setOpenMaintCount(Number(res.openMaintenance?.count ?? 0)))
      .catch(() => {});
  }, [user?.id, isOperator, section]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setGate(null);
    setSwitchingGate(false);
    setSection('dashboard');
    setMenuOpen(false);
  }

  async function acknowledgePopup() {
    const current = popupNotices[0];
    if (!current) return;
    try { await api(`/api/notices/${current.id}/acknowledge`, { method: 'POST' }); } finally {
      setPopupNotices((items) => items.slice(1));
    }
  }

  if (checking) return <div className="splash"><div className="brand-mark">{portalConfig.portal_short_name}</div><span>Loading {portalConfig.portal_name}…</span></div>;
  if (!user) return <Login config={portalConfig} onLogin={(nextUser, nextGate) => { setUser(nextUser); setGate(nextGate ?? null); }} />;

  const visibleGroups: NavGroup[] = navGroups
    .map((g) => ({ ...g, items: g.items.filter((item) => !item.roles || item.roles.includes(user.role)) }))
    .filter((g) => g.items.length > 0);
  const flatAvailable = visibleGroups.flatMap((g) => g.items);
  const current = flatAvailable.find((item) => item.id === section) ?? flatAvailable[0]!;

  return <div className="app-shell">
    <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
      <header className="side-brand"><span className="mini-logo">{portalConfig.portal_short_name}</span><strong>{portalConfig.portal_name}</strong><button className="icon-button close-menu" onClick={() => setMenuOpen(false)}>×</button></header>
      <nav className="nav-groups">
        {visibleGroups.map((group) => (
          <section className="nav-group" key={group.id}>
            <p className="nav-caption">{group.label}</p>
            <div className="nav-group-items">
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={current.id === item.id ? 'nav-active' : ''}
                  onClick={() => { setSection(item.id); setMenuOpen(false); }}
                  title={item.label}
                >
                  <span className="nav-icon">{navIcon(item.id)}</span>
                  <span className="nav-label">{item.label}</span>
                  {item.id === 'maintenance' && isOperator && openMaintCount > 0 && <span className="nav-badge">{openMaintCount}</span>}
                </button>
              ))}
            </div>
          </section>
        ))}
      </nav>
      <footer className="user-card"><span className="avatar">{initials(user.name)}</span><span><strong>{user.name}</strong><small>{user.role}</small></span><button className="icon-button" title="Sign out" onClick={logout}>↗</button></footer>
    </aside>
    {menuOpen && <button className="scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
    <main className="workspace">
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)}>☰</button><div><p className="eyebrow">{user.role} workspace</p><h1>{current.label}</h1></div>
        {user.role === 'security' && gate && <button type="button" className="gate-chip" title="Change the gate you are posted at" onClick={() => setSwitchingGate(true)}>🚪 {String(gate.gate_name || gate.name)}<span>switch</span></button>}
        <div className="top-status"><span className="pulse-dot" /> System online</div></header>
      <div className="content"><SectionView section={current.id} user={user} config={portalConfig} gate={gate} onNavigate={setSection} /><PortalFooter portalName={portalConfig.portal_name} /></div>
    </main>
    {popupNotices[0] && <EstateNoticePopup notice={popupNotices[0]} remaining={popupNotices.length - 1} onAcknowledge={acknowledgePopup} />}
    {switchingGate && <SwitchGateDialog current={gate} onSwitched={(next) => { setGate(next); setSwitchingGate(false); setSection('dashboard'); }} onClose={() => setSwitchingGate(false)} />}
  </div>;
}

function SectionView({ section, user, config, gate, onNavigate }: { section: Section; user: User; config: PortalConfig; gate: Row | null; onNavigate?: (s: Section) => void }) {
  switch (section) {
    case 'dashboard': return <Dashboard user={user} config={config} gate={gate} onNavigate={onNavigate} />;
    case 'residents': return <People user={user} />;
    case 'properties': return <Properties user={user} />;
    case 'residency': return <Residency user={user} />;
    case 'imports': return <ImportCentre />;
    case 'bills': return <Bills user={user} />;
    case 'visitors': return <Visitors user={user} />;
    case 'maintenance': return <Maintenance user={user} />;
    case 'notices': return <EstateNotices user={user} />;
    case 'cards': return <Cards user={user} />;
    case 'events': return <AccessEvents user={user} />;
    case 'devices': return <Devices user={user} />;
    case 'remote': return <RemoteAccess onNavigate={onNavigate} />;
    case 'sync': return <PersonSync />;
    case 'isapi': return <IsapiBridge user={user} />;
    case 'operations': return <Operations />;
    case 'settings': return <Settings />;
    // New module pages (placeholder/information surfaces; backend wiring to follow):
    case 'dependants': return <DependantsManager user={user} onNavigate={onNavigate} />;
    case 'staff': return <StaffManagement user={user} />;
    case 'bookings': return <FacilityBookings user={user} />;
    case 'emergency': return <EmergencyContacts user={user} />;
    case 'information': return <InformationHub user={user} onNavigate={onNavigate} />;
    case 'legal': return <LegalGovernance user={user} />;
  }
}

/**
 * Administrator guidance for terminating access, kept in the portal because the
 * person offboarding a resident is usually at the gate desk rather than reading
 * docs. Terminating access is a chain; skipping a step leaves a way in.
 */
const TERMINATION_STEPS: Array<{ title: string; body: string; actionLabel: string; section: Section }> = [
  { title: 'Revoke or suspend the access card and every fingerprint', body: 'Open Access cards & fingerprints, find the person, then Suspend for a temporary stop. EstateMate queues the matching disable-card action for every linked device, records the change in the status history, and queues a fingerprint removal task to confirm on the terminal.', actionLabel: 'Open Access cards & fingerprints', section: 'cards' },
  { title: 'Deactivate dependants and household members', body: 'A spouse, child, relative or domestic staff member keeps gate access through their household membership. Under Tenancy & household, deactivate the member so any card or fingerprint issued to them stops working.', actionLabel: 'Open Tenancy & household', section: 'residency' },
  { title: 'End the tenancy or the resident account', body: 'Ending a tenancy removes the right to occupy; deactivating the account under People removes the login. Do both when someone moves out. Ownership, billing, card, visitor and gate-event history is preserved either way.', actionLabel: 'Open People', section: 'residents' },
  { title: 'Cancel that household’s live visitor passes', body: 'Reject any pending or checked-in pass issued by the departing household, so a visitor cannot still use an invitation that no longer holds.', actionLabel: 'Open Visitors', section: 'visitors' },
  { title: 'Retire the gate terminal itself', body: 'Under Access-control devices, disable or delete the device. It is soft-deleted so historical gate events keep their reference, and Security officers assigned to that post must select a different gate at their next login.', actionLabel: 'Open devices', section: 'devices' },
  { title: 'Confirm the hardware action actually cleared', body: 'Terminating in EstateMate is not enough — the terminal has to agree. Open Hardware actions and mark each queued disable or revoke as applied, or fix the failures. Until then the physical card can still open the gate.', actionLabel: 'Open Hardware actions', section: 'operations' },
];

function AccessTerminationGuide({ onNavigate }: { onNavigate?: (s: Section) => void }) {
  const [open, setOpen] = useState(false);
  return <section className="panel termination-guide">
    <div className="panel-title">
      <div><p className="eyebrow">ACCESS CONTROL</p><h3>How to terminate access</h3></div>
      <button type="button" className="secondary sm" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? 'Hide steps' : 'Show steps'}</button>
    </div>
    <p>Work down the chain: the credential, the person, the pass, the terminal, and finally the hardware. Stopping at any earlier step leaves a way in.</p>
    {open && <ol className="termination-steps">
      {TERMINATION_STEPS.map((step, index) => <li key={step.title}>
        <span className="step-number">{index + 1}</span>
        <div><strong>{step.title}</strong><p>{step.body}</p>
          {onNavigate && <button type="button" className="text" onClick={() => onNavigate(step.section)}>{step.actionLabel} →</button>}
        </div>
      </li>)}
    </ol>}
  </section>;
}

function Dashboard({ user, config, gate, onNavigate }: { user: User; config: PortalConfig; gate: Row | null; onNavigate?: (s: Section) => void }) {
  const { data, error, loading } = useAsync<Row>(() => api('/api/dashboard'), [user.id]);
  if (loading) return <Loading />;
  if (error) return <Notice tone="error">{error}</Notice>;
  const isOperator = user.role === 'admin' || user.role === 'manager';
  const image = gateImageUrl(config);
  const openMaint = Number(nested(data, 'openMaintenance', 'count') ?? 0);
  const cards: Array<[string, unknown, string]> = user.role === 'resident'
    ? [
      ['Outstanding', nested(data, 'outstandingBills', 'count'), money(nested(data, 'outstandingBills', 'amount'))],
      ['Active visitors', nested(data, 'activeVisitors', 'count'), 'Current passes'],
      ['Active cards', nested(data, 'activeCards', 'count'), 'Ready at the gate'],
    ]
    : [
      ['Residents', nested(data, 'residents', 'count'), 'Active accounts'],
      ['Visitors on site', nested(data, 'visitors', 'count'), 'Active and checked in'],
      ['Open maintenance', nested(data, 'openMaintenance', 'count'), 'Needs attention'],
      ['Gate events today', nested(data, 'todayAccessEvents', 'count'), 'All terminals'],
      ['Facility-fee grace', nested(data, 'residentsInGrace', 'count'), 'Residents in window'],
    ];
  return <>
    {isOperator && openMaint > 0 && (
      <div className="notification-banner">
        <span>🔔 <strong>Maintenance Notice:</strong> You have {openMaint} maintenance request{openMaint === 1 ? '' : 's'} requiring attention or verification.</span>
        {onNavigate && <button type="button" className="secondary sm" onClick={() => onNavigate('maintenance')}>View requests →</button>}
      </div>
    )}
    {user.role === 'security' && <Notice tone={gate ? 'success' : 'warning'}>{gate
      ? <>Posted at <strong>{String(gate.gate_name || gate.name)}</strong> for this session. Your visitor queue, gate activity and device list are limited to this gate.</>
      : <>No active gate device is registered yet, so you can see every gate. Once an administrator registers a gate terminal you will choose your gate at each sign-in.</>}</Notice>}
    <section className={image ? 'hero-card has-gate-image' : 'hero-card'} style={gateImageStyle(image)}>
      <div>
        <p className="eyebrow">Estate operations</p>
        <h2>Welcome, {user.name.split(' ')[0]}.</h2>
        <p>Good day — here is the latest picture across {config.estate_name || config.portal_name}.</p>
        {image && config.portal_gate_image_caption && <p className="gate-image-caption">{config.portal_gate_image_caption}</p>}
      </div>
      <div className="hero-orb"><span>{config.portal_short_name || 'EM'}</span></div>
    </section>
    <section className="stat-grid">{cards.map(([label, value, detail]) => <article className="stat-card" key={String(label)}><p>{label}</p><strong>{String(value ?? 0)}</strong><small>{detail}</small></article>)}</section>

    {/* Quick-action shortcuts grouped by the new menu categories — helps
        mobile users reach any module in one tap from the dashboard. */}
    <section className="quick-grid">
      {buildQuickActions(user.role, isOperator).map((group) => (
        <article className="panel quick-group" key={group.title}>
          <p className="eyebrow">{group.title}</p>
          <div className="quick-tiles">
            {group.items.map((item) => (
              <button key={item.id} className="quick-tile" onClick={() => onNavigate?.(item.id)}>
                <span className="quick-tile-icon">{navIcon(item.id)}</span>
                <span className="quick-tile-label">{item.label}</span>
              </button>
            ))}
          </div>
        </article>
      ))}
    </section>

    {isOperator && <AccessTerminationGuide onNavigate={onNavigate} />}
    {user.role === 'resident' && Boolean(data?.latestNotice) && <section className="panel"><div className="panel-title"><div><p className="eyebrow">Latest estate notice</p><h3>{String((data?.latestNotice as Row).title)}</h3></div></div><p>{String((data?.latestNotice as Row).body)}</p></section>}
    {user.role !== 'resident' && <section className="split-grid"><article className="panel callout"><p className="eyebrow">HARDWARE MODE</p><h3>Direct MinMoe event upload</h3><p>Terminals post gate events straight to Cloudflare. Card changes remain in the hardware-action queue until a supported command channel is confirmed.</p></article><article className="panel"><p className="eyebrow">OPERATIONS TIP</p><h3>Check unresolved device actions</h3><p>HTTP Listening is upload-only on most firmware. Mark each manual terminal update as applied to preserve an accurate audit trail.</p></article></section>}
  </>;
}

function buildQuickActions(role: User['role'], isOperator: boolean): Array<{ title: string; items: Array<{ id: Section; label: string }> }> {
  const groups: Array<{ title: string; items: Array<{ id: Section; label: string }> }> = [
    { title: 'Access control', items: [{ id: 'cards', label: 'Cards & fingers' }, { id: 'events', label: 'Gate activity' }, { id: 'operations', label: 'Hardware' }] },
    { title: 'Residents & staff', items: [{ id: 'residents', label: 'Residents' }, { id: 'residency', label: 'Tenancy' }, { id: 'dependants', label: 'Dependants' }] },
    { title: 'Estate', items: [{ id: 'properties', label: 'Properties' }, { id: 'bills', label: 'Bills' }, { id: 'maintenance', label: 'Service' }] },
    { title: 'Resources', items: [{ id: 'visitors', label: 'Visitors' }, { id: 'notices', label: 'Notices' }, { id: 'emergency', label: 'Emergency' }, { id: 'information', label: 'Info hub' }] },
  ];
  // Filter items by role visibility (best-effort; mirroring the sidebar rules).
  const can = (id: Section) => {
    if (id === 'residents') return ['admin','manager','cashier','security'].includes(role);
    if (id === 'residency') return ['admin','manager','resident'].includes(role);
    if (id === 'dependants') return ['admin','manager','cashier','resident'].includes(role);
    if (id === 'properties') return ['admin','manager','cashier','security','resident'].includes(role);
    if (id === 'bills') return ['admin','cashier','resident'].includes(role);
    if (id === 'maintenance') return ['admin','manager','resident'].includes(role);
    if (id === 'cards') return ['admin','manager','cashier','resident'].includes(role);
    if (id === 'events') return ['admin','manager','security','resident'].includes(role);
    if (id === 'operations') return isOperator;
    return true;
  };
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => can(i.id)) }))
    .filter((g) => g.items.length > 0);
}

function People({ user }: { user: User }) {
  const canManage=user.role==='admin'||user.role==='manager';
  const [search,setSearch]=useState('');const [role,setRole]=useState('');
  const list=useList(`/api/users?limit=100&search=${encodeURIComponent(search)}${role?`&role=${role}`:''}`);
  const available=useAsync<{ items:Row[] }>(()=>canManage?api('/api/properties/available'):Promise.resolve({ items:[] }),[user.role]);
  const imports=useAsync<ListResponse<Row>>(()=>canManage?api('/api/imports?kind=users&limit=20'):Promise.resolve({ items:[],page:1,limit:20 }),[user.role]);
  const [showForm,setShowForm]=useState(false);const [showImport,setShowImport]=useState(false);const [showBulk,setShowBulk]=useState(false);const [editing,setEditing]=useState<Row|null>(null);const [message,setMessage]=useState('');const [temporaryPassword,setTemporaryPassword]=useState('');const [sampleCredentials,setSampleCredentials]=useState<Array<{ role:string;name:string;email:string;temporaryPassword:string }>>([]);
  function refresh(){list.reload();available.reload();imports.reload();}
  async function updateStatus(row:Row,status:'active'|'inactive') {
    if(status==='inactive'&&!confirm(`Deactivate ${String(row.name)}? Login will stop and active cards will be suspended. Ownership or tenancy must be resolved first.`))return;
    try { await api(`/api/users/${row.id}`,{ method:'PATCH',body:JSON.stringify({ status }) });setMessage(status==='active'?'Account reactivated. Access cards remain under administrator control.':'Account deactivated and eligible cards suspended.');refresh(); }
    catch(reason){setMessage(reason instanceof Error?reason.message:'Account status update failed');}
  }
  async function remove(row:Row) {
    if(!confirm(`Delete ${String(row.name)}? EstateMate uses a safe soft delete so billing, access and audit history remains.`))return;
    try { await api(`/api/users/${row.id}`,{ method:'DELETE' });setMessage('Account deleted safely; historical records were preserved.');refresh(); }
    catch(reason){setMessage(reason instanceof Error?reason.message:'Could not delete account');}
  }
  async function resetPassword(row:Row) {
    const entered=prompt('Enter a temporary password of at least 12 characters, or leave blank to generate a secure one.');if(entered===null)return;
    try { const result=await api<{ temporaryPassword?:string;message:string }>(`/api/users/${row.id}/reset-password`,{ method:'POST',body:JSON.stringify({ temporaryPassword:entered || undefined }) });setTemporaryPassword(result.temporaryPassword || entered);setMessage(result.message); }
    catch(reason){setMessage(reason instanceof Error?reason.message:'Password reset failed');}
  }
  async function generateSamples() {
    if(!confirm('Create one active 24-hour sample account for every user category? These are real temporary logins and must be removed after testing.'))return;
    try { const result=await api<{ expiresAt:string;credentials:Array<{ role:string;name:string;email:string;temporaryPassword:string }> }>('/api/users/sample-logins',{ method:'POST',body:JSON.stringify({ confirmation:'CREATE_24_HOUR_SAMPLE_LOGINS' }) });setSampleCredentials(result.credentials);setMessage(`Sample logins created. They expire ${readableDate(result.expiresAt)}.`);refresh(); }
    catch(reason){setMessage(reason instanceof Error?reason.message:'Could not create sample logins');}
  }
  function downloadSamples(){const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;const text=`role,name,email,temporary_password\n${sampleCredentials.map((item)=>[item.role,item.name,item.email,item.temporaryPassword].map(quote).join(',')).join('\n')}\n`;const url=URL.createObjectURL(new Blob([text],{ type:'text/csv' }));const link=document.createElement('a');link.href=url;link.download='estatemate-24-hour-sample-logins.csv';link.click();URL.revokeObjectURL(url);}
  const accessDevices=useAsync<{ items:Row[] }>(()=>canManage?api('/api/access/device-options'):Promise.resolve({ items:[] }),[user.role]);
  const [accessPerson,setAccessPerson]=useState<Row|null>(null);
  const actions=canManage?(row:Row)=>user.role==='manager'&&['admin','manager'].includes(String(row.role))?null:<div className="row-actions"><button className="text" onClick={()=>{setEditing(row);setShowForm(false);setAccessPerson(null);}}>Edit</button><button className="text" onClick={()=>{setAccessPerson(row);setEditing(null);setShowForm(false);}}>Cards &amp; fingerprints</button><button className="text" onClick={()=>resetPassword(row)}>Reset password</button>{row.status==='active'?<button className="text" onClick={()=>updateStatus(row,'inactive')}>Deactivate</button>:<button className="text" onClick={()=>updateStatus(row,'active')}>Reactivate</button>}<button className="text danger" onClick={()=>remove(row)}>Delete</button></div>:undefined;
  return <PagePanel title="People" subtitle="Register, assign, import and safely manage resident and staff accounts" action={canManage?<div className="row-actions">{user.role==='admin'&&<button className="secondary" onClick={generateSamples}>Create 24-hour sample logins</button>}<button className="secondary" onClick={()=>setShowImport(!showImport)}>Import users</button><button className="secondary" onClick={()=>setShowBulk(!showBulk)}>Bulk tools</button><button className="primary" onClick={()=>{setShowForm(!showForm);setEditing(null);}}>Add person</button></div>:null}>
    {message&&<Notice tone={/failed|Could not|before|must|cannot|already/i.test(message)?'error':'success'}>{message}</Notice>}
    {temporaryPassword&&<section className="credential-box"><p className="eyebrow">COPY NOW — SHOWN ONCE</p><h3>Temporary password</h3><code>{temporaryPassword}</code><p>Share it securely. The user should change it immediately after signing in.</p><button className="secondary" onClick={()=>navigator.clipboard.writeText(temporaryPassword)}>Copy password</button><button className="text" onClick={()=>setTemporaryPassword('')}>Hide</button></section>}
    {sampleCredentials.length>0&&<section className="credential-box"><p className="eyebrow">24-HOUR SAMPLE LOGINS — SHOWN ONCE</p><h3>All five user categories created</h3><p>Administrator, Manager, Resident, Security and Cashier sample accounts are active for 24 hours.</p><div className="row-actions"><button className="secondary" onClick={downloadSamples}>Download login details</button><button className="text" onClick={()=>setSampleCredentials([])}>Hide</button></div></section>}
    {showForm&&<UserAccountForm actorRole={user.role} properties={available.data?.items ?? []} onDone={(notice)=>{setShowForm(false);setMessage(notice);refresh();}} />}
    {editing&&<UserAccountForm actorRole={user.role} user={editing} properties={available.data?.items ?? []} onDone={(notice)=>{setEditing(null);setMessage(notice);refresh();}} onCancel={()=>setEditing(null)} />}
    {accessPerson&&<section className="person-access"><div className="row-actions"><button className="secondary sm" onClick={()=>setAccessPerson(null)}>Close access panel</button></div>
      <PersonCredentials residentId={String(accessPerson.id)} personName={String(accessPerson.name)} devices={accessDevices.data?.items ?? []} onChanged={refresh} />
    </section>}
    {showImport&&<UsersCsvImporter onDone={()=>{refresh();}} />}
    {showBulk&&<PeopleBulkTools onDone={()=>{refresh();}} />}
    <div className="people-filters"><label>Search<input value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Name, email or phone" /></label><label>Role<select value={role} onChange={(event)=>setRole(event.target.value)}><option value="">All roles</option><option value="resident">Residents</option><option value="security">Security</option><option value="cashier">Cashiers</option><option value="manager">Managers</option><option value="admin">Administrators</option></select></label></div>
    <ListState list={list}><DataTable exportTitle="Residents & Staff" rows={list.data?.items ?? []} columns={[['name','Name'],['role','Role'],['employee_id','Employee ID'],['email','Email'],['phone','Phone'],['unit_numbers','Owned'],['rented_units','Rented'],['dependant_units','Dependant at'],['property_count','Owned count'],['status','Status']]} action={actions} /></ListState>
    {canManage&&imports.data&&imports.data.items.length>0&&<section className="import-history"><h3>User import history</h3><DataTable rows={imports.data.items} columns={[['filename','File'],['status','Status'],['total_rows','Rows'],['successful_rows','Created'],['error_rows','Errors'],['created_at','Uploaded','date']]} action={(row)=>row.storage_key?<a className="text" href={`/api/files/${encodeURIComponent(String(row.storage_key))}`}>Download source</a>:null} /></section>}
  </PagePanel>;
}

function UserAccountForm({ actorRole,user,properties,onDone,onCancel }: { actorRole:User['role'];user?:Row;properties:Row[];onDone:(message:string)=>void;onCancel?:()=>void }) {
  const [message,setMessage]=useState('');const [role,setRole]=useState(String(user?.role ?? 'resident'));
  const existingEmployeeId=String(user?.employee_id ?? '');const hasLegacyEmployeeId=existingEmployeeId.length>30;
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setMessage('');const values=Object.fromEntries(new FormData(event.currentTarget));
    if(user&&values.employeeId===existingEmployeeId)delete values.employeeId;
    if(!values.propertyId)delete values.propertyId;
    try { await api(user?`/api/users/${user.id}`:'/api/users',{ method:user?'PATCH':'POST',body:JSON.stringify(values) });onDone(user?'Account details updated.':'Account created successfully.'); }
    catch(reason){setMessage(reason instanceof Error?reason.message:'Could not save account');}
  }
  return <FormCard title={user?`Edit ${String(user.name)}`:'New account'} onSubmit={submit} message={message}>
    <label>Name<input name="name" defaultValue={String(user?.name ?? '')} required /></label><label>Email<input name="email" type="email" defaultValue={String(user?.email ?? '')} required /></label><label>Phone<input name="phone" defaultValue={String(user?.phone ?? '')} /></label>
    <label>Employee ID<input name="employeeId" defaultValue={existingEmployeeId} maxLength={hasLegacyEmployeeId?existingEmployeeId.length:30} pattern={hasLegacyEmployeeId?'[A-Za-z0-9]{1,32}':'[A-Za-z0-9]{1,30}'} placeholder="Auto-generated" /><small>{hasLegacyEmployeeId?'This existing ID is over the new 30-character limit and will be kept unless replaced. New IDs must use letters and numbers only, up to 30 characters.':'Letters and numbers only, up to 30 characters. Leave blank on a new account and EstateMate generates an ID.'}</small></label>
    <label>Role<select name="role" value={role} onChange={(event)=>setRole(event.target.value)}><option value="resident">Resident</option><option value="security">Security</option><option value="cashier">Cashier</option>{actorRole==='admin'&&<><option value="manager">Manager</option><option value="admin">Administrator</option></>}</select></label>
    {user&&<label>Status<select name="status" defaultValue={String(user.status ?? 'active')}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>}
    {role==='resident'&&<label>{user?'Assign another available property (optional)':'Available property (optional)'}<select name="propertyId"><option value="">No property assignment</option>{properties.map((property)=><option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)} — {String(property.address)}</option>)}</select><small>Only properties without an approved owner are listed. Existing ownership is not replaced.</small></label>}
    {!user&&<label>Temporary password<input name="password" type="password" minLength={12} autoComplete="new-password" required /><small>At least 12 characters. The user should change it after first sign-in.</small></label>}
    <div className="row-actions"><button className="primary">{user?'Save changes':'Create account'}</button>{onCancel&&<button type="button" className="secondary" onClick={onCancel}>Cancel</button>}</div>
  </FormCard>;
}

/**
 * The four bulk verbs for the whole person register — accounts and dependants —
 * because both hold credentials on the same terminals. Upload and edit are CSV
 * files archived against an import job; delete and resynchronise act on a pasted
 * list of Employee IDs (or every person, for a full re-push).
 */
function PeopleBulkTools({ onDone }: { onDone:()=>void }) {
  const [uploadResult,setUploadResult]=useState('');const [editResult,setEditResult]=useState('');
  const [otherResult,setOtherResult]=useState('');const [busy,setBusy]=useState(false);
  const [deleteIds,setDeleteIds]=useState('');const [resyncIds,setResyncIds]=useState('');
  const [credentials,setCredentials]=useState<Array<{ name:string;email:string;employeeId:string;temporaryPassword:string }>>([]);
  const uploadTemplate='person_type,name,email,phone,role,employee_id,unit_number,relationship,primary_resident_email\naccount,Ada Resident,ada@example.com,+2348000000000,resident,EMP0001,A-01,,\naccount,Gate Officer,security@example.com,+2348000000001,security,EMP0002,,,\ndependant,Nanny One,,+2348000000002,,EMP0003,,domestic_staff,ada@example.com\n';
  const editTemplate='employee_id,name,phone,new_employee_id,status\nEMP0001,Ada Resident,+2348000000099,,active\nEMP0003,,+2348000000100,DEP2024,,inactive\n';
  function download(name:string,text:string){const url=URL.createObjectURL(new Blob([text],{type:'text/csv'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();URL.revokeObjectURL(url);}
  function downloadCredentials(){const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;download('estatemate-bulk-people-credentials.csv',`name,email,employee_id,temporary_password\n${credentials.map((item)=>[item.name,item.email,item.employeeId,item.temporaryPassword].map(quote).join(',')).join('\n')}\n`);}
  function parseIds(raw:string):string[]{return [...new Set(raw.split(/[\s,;]+/).map((value)=>value.trim()).filter(Boolean))];}
  async function submitCsv(event:FormEvent<HTMLFormElement>,path:string,setResult:(value:string)=>void) {
    event.preventDefault();setResult('');setBusy(true);const input=event.currentTarget.elements.namedItem('file') as HTMLInputElement;const file=input.files?.[0];
    if(!file){setResult('Choose a CSV file.');setBusy(false);return;}
    try {
      const response=await api<{ totalRows:number;accountsCreated?:number;dependantsCreated?:number;successfulRows:number;errorRows:number;errors:Array<{row:number;error:string}>;credentials?:Array<{ name:string;email:string;employeeId:string;temporaryPassword:string }>;notice?:string }>(path,{method:'POST',body:await file.text(),headers:{'Content-Type':'text/csv','X-Filename':file.name}});
      if(response.credentials?.length)setCredentials(response.credentials);
      const first=response.errors[0]?` First error: row ${response.errors[0].row} — ${response.errors[0].error}`:'';
      const created=[response.accountsCreated?`${response.accountsCreated} account(s)`:null,response.dependantsCreated?`${response.dependantsCreated} dependant(s)`:null].filter(Boolean).join(', ');
      setResult(`${response.successfulRows} succeeded${created?` (${created})`:''}; ${response.errorRows} row error(s).${first}${response.notice?` ${response.notice}`:''}`);
      onDone();
    } catch(reason){setResult(reason instanceof Error?reason.message:'Bulk operation failed');}
    finally{setBusy(false);}
  }
  async function bulkDelete() {
    const ids=parseIds(deleteIds);if(!ids.length){setOtherResult('Paste at least one Employee ID to delete.');return;}
    if(!confirm(`Delete ${ids.length} person(s)? EstateMate uses a safe soft delete: access stops everywhere, history is preserved.`))return;
    setBusy(true);setOtherResult('');
    try {
      const response=await api<{ totalRows:number;successfulRows:number;errorRows:number;errors:Array<{row:number;error:string}>;notice:string }>('/api/people/bulk-delete',{method:'POST',body:JSON.stringify({confirm:'DELETE_PEOPLE',employeeIds:ids})});
      const first=response.errors[0]?` First error: ${response.errors[0].error}`:'';
      setOtherResult(`${response.successfulRows} deleted; ${response.errorRows} skipped.${first} ${response.notice}`);setDeleteIds('');onDone();
    } catch(reason){setOtherResult(reason instanceof Error?reason.message:'Bulk delete failed');}
    finally{setBusy(false);}
  }
  async function bulkResync(scope:'all'|'people') {
    const ids=parseIds(resyncIds);
    if(scope==='people'&&!ids.length){setOtherResult('Paste Employee IDs to resynchronise, or press "Resynchronise everyone".');return;}
    if(scope==='all'&&!confirm('Re-push every credential of every person to all access-control devices? Open commands are reused, not duplicated.'))return;
    setBusy(true);setOtherResult('');
    try {
      const response=await api<{ people:number;queued:number;manual:number;skipped:number;notice:string }>('/api/people/bulk-resync',{method:'POST',body:JSON.stringify(scope==='all'?{scope}:{scope:'people',employeeIds:ids})});
      setOtherResult(`${response.people} person(s): ${response.queued} command(s) queued for the agent, ${response.manual} fingerprint task(s) for an operator, ${response.skipped} already open.`);
      onDone();
    } catch(reason){setOtherResult(reason instanceof Error?reason.message:'Bulk resynchronise failed');}
    finally{setBusy(false);}
  }
  return <section className="import-grid">
    <form className="form-card import-card" onSubmit={(event)=>submitCsv(event,'/api/people/bulk-upload',setUploadResult)}><h3>Bulk upload people</h3><p>Accounts and dependants in one CSV. Accounts need email and role; dependants need a relationship and the main resident’s email or Employee ID. Employee IDs are optional but max 30 characters. Temporary passwords are returned once.</p><input name="file" type="file" accept=".csv,text/csv" required /><div className="row-actions"><button type="button" className="secondary" onClick={()=>download('people-upload-template.csv',uploadTemplate)}>Download template</button><button className="primary" disabled={busy}>{busy?'Uploading…':'Upload people'}</button>{credentials.length>0&&<button type="button" className="secondary" onClick={downloadCredentials}>Download credentials</button>}</div>{uploadResult&&<Notice tone={/error|failed|First error/i.test(uploadResult)?'warning':'success'}>{uploadResult}</Notice>}</form>
    <form className="form-card import-card" onSubmit={(event)=>submitCsv(event,'/api/people/bulk-edit',setEditResult)}><h3>Bulk edit people</h3><p>Match each row by employee_id (email is a fallback). Only the columns you fill change. new_employee_id re-points a terminal identity — resynchronise afterwards so hardware agrees.</p><input name="file" type="file" accept=".csv,text/csv" required /><div className="row-actions"><button type="button" className="secondary" onClick={()=>download('people-edit-template.csv',editTemplate)}>Download template</button><button className="primary" disabled={busy}>{busy?'Saving…':'Apply edits'}</button></div>{editResult&&<Notice tone={/error|failed|First error/i.test(editResult)?'warning':'success'}>{editResult}</Notice>}</form>
    <div className="form-card import-card"><h3>Bulk delete</h3><p>Paste Employee IDs, one per line. Safe soft delete: gate access stops on every device and billing, access-event and audit history is preserved.</p><textarea rows={4} value={deleteIds} onChange={(event)=>setDeleteIds(event.target.value)} placeholder={'EMP0001\nEMP0002'} /><div className="row-actions"><button className="primary danger" onClick={bulkDelete} disabled={busy}>{busy?'Deleting…':'Delete these people'}</button></div></div>
    <div className="form-card import-card"><h3>Resynchronise into all access controls</h3><p>Re-push every credential of the selected people — or of everyone holding a credential — to every terminal. Active cards are refreshed with the current Employee ID; inactive ones are disabled; fingerprints are queued as operator tasks.</p><textarea rows={3} value={resyncIds} onChange={(event)=>setResyncIds(event.target.value)} placeholder={'Optional: EMP0001 EMP0002'} /><div className="row-actions"><button className="primary" onClick={()=>bulkResync('people')} disabled={busy}>{busy?'Working…':'Resynchronise listed'}</button><button className="secondary" onClick={()=>bulkResync('all')} disabled={busy}>Resynchronise everyone</button></div></div>
    {otherResult&&<div className="span-2"><Notice tone={/failed|skipped|error/i.test(otherResult)?'warning':'success'}>{otherResult}</Notice></div>}
  </section>;
}

function UsersCsvImporter({ onDone }: { onDone:()=>void }) {
  const [result,setResult]=useState('');const [busy,setBusy]=useState(false);const [credentials,setCredentials]=useState<Array<{ name:string;email:string;temporaryPassword:string }>>([]);
  const template='name,email,phone,role,unit_number,status,employee_id\nAda Resident,ada@example.com,+2348000000000,resident,A-01,active,EMP0001\nGate Officer,security@example.com,+2348000000001,security,,active,\n';
  function download(name:string,text:string) { const url=URL.createObjectURL(new Blob([text],{ type:'text/csv' }));const link=document.createElement('a');link.href=url;link.download=name;link.click();URL.revokeObjectURL(url); }
  function downloadCredentials() { const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;download('estatemate-new-user-credentials.csv',`name,email,temporary_password\n${credentials.map((item)=>[item.name,item.email,item.temporaryPassword].map(quote).join(',')).join('\n')}\n`); }
  async function upload(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setResult('');setCredentials([]);setBusy(true);const input=event.currentTarget.elements.namedItem('file') as HTMLInputElement;const file=input.files?.[0];
    if(!file){setResult('Choose a CSV file.');setBusy(false);return;}
    try { const response=await api<{ successfulRows:number;errorRows:number;errors:Array<{ row:number;error:string }>;credentials:Array<{ name:string;email:string;temporaryPassword:string }>;credentialsNotice:string }>('/api/imports/users',{ method:'POST',body:await file.text(),headers:{ 'Content-Type':'text/csv','X-Filename':file.name } });setCredentials(response.credentials);const first=response.errors[0]?` First error: row ${response.errors[0].row} — ${response.errors[0].error}`:'';setResult(`${response.successfulRows} account(s) created; ${response.errorRows} row error(s).${first}`);onDone(); }
    catch(reason){setResult(reason instanceof Error?reason.message:'User import failed');}
    finally{setBusy(false);}
  }
  return <form className="form-card import-card" onSubmit={upload}><h3>Bulk user registration</h3><p>Upload up to 25 residents or staff per CSV. Use an available property unit number only for residents. Passwords are generated and returned once; they are never stored in the archived source CSV.</p><input name="file" type="file" accept=".csv,text/csv" required /><div className="row-actions"><button type="button" className="secondary" onClick={()=>download('users-import-template.csv',template)}>Download template</button><button className="primary" disabled={busy}>{busy?'Importing…':'Upload users'}</button>{credentials.length>0&&<button type="button" className="secondary" onClick={downloadCredentials}>Download temporary passwords</button>}</div>{result&&<Notice tone={result.includes('0 row error')?'success':'warning'}>{result}</Notice>}{credentials.length>0&&<Notice tone="warning">Download the temporary-password file now. EstateMate will not show these generated passwords again.</Notice>}</form>;
}

function Properties({ user }: { user: User }) {
  const operator=user.role==='admin'||user.role==='manager';
  const list = useList('/api/properties?limit=100');
  const requests = useAsync<ListResponse<Row>>(
    () => user.role === 'resident' || user.role === 'admin' || user.role === 'manager' ? api('/api/property-ownership-requests?limit=100') : Promise.resolve({ items: [], page: 1, limit: 100 }),
    [user.role],
  );
  const transfers = useAsync<ListResponse<Row>>(
    () => user.role === 'resident' || user.role === 'admin' || user.role === 'manager' ? api('/api/property-transfers?limit=100') : Promise.resolve({ items: [], page: 1, limit: 100 }),
    [user.role],
  );
  const available = useAsync<{ items: Row[] }>(
    () => user.role === 'resident' || user.role === 'admin' || user.role === 'manager' ? api('/api/properties/available') : Promise.resolve({ items: [] }),
    [user.role],
  );
  const [showAdd, setShowAdd] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [requestMode, setRequestMode] = useState<'existing'|'propose'>('existing');
  const [assignPropertyId, setAssignPropertyId] = useState('');
  const [message, setMessage] = useState('');

  function refresh() { list.reload(); requests.reload(); transfers.reload(); available.reload(); }

  async function addProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/properties', { method: 'POST', body: JSON.stringify(values) }); setShowAdd(false); setMessage('Property created.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create property'); }
  }
  async function requestProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const form = new FormData(event.currentTarget);
    try {
      const proofKeys=await uploadProofFiles(event.currentTarget,'ownership-proofs');
      const body = requestMode === 'existing'
        ? { propertyId: form.get('propertyId'), requestNote: form.get('requestNote'),proofKeys }
        : { proposedUnitNumber: form.get('proposedUnitNumber'), proposedStreet: form.get('proposedStreet'), proposedAddress: form.get('proposedAddress'), requestNote: form.get('requestNote'),proofKeys };
      await api('/api/property-ownership-requests', { method: 'POST', body: JSON.stringify(body) }); setShowRequest(false); setMessage('Ownership request submitted for administrator approval.'); refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not submit ownership request'); }
  }
  async function assignOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/property-ownerships', { method: 'POST', body: JSON.stringify(values) }); setShowAssign(false); setAssignPropertyId(''); setMessage('Property owner assigned.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not assign property owner'); }
  }
  async function requestTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { const proofKeys=await uploadProofFiles(event.currentTarget,'ownership-transfer-proofs'); await api('/api/property-transfers', { method: 'POST', body: JSON.stringify({ ...values,proofKeys }) }); setShowTransfer(false); setMessage('Ownership transfer submitted for administrator approval.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not submit ownership transfer'); }
  }
  async function reviewRequest(id: unknown, status: 'approved'|'rejected') {
    const reviewNote = prompt(status === 'approved' ? 'Optional approval note' : 'Reason for rejection') ?? '';
    try { await api(`/api/property-ownership-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status, reviewNote }) }); setMessage(`Ownership request ${status}.`); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not review ownership request'); }
  }
  async function reviewTransfer(id: unknown, action: 'approve'|'reject') {
    const reviewNote = prompt(action === 'approve' ? 'Optional approval note' : 'Reason for rejection') ?? '';
    try { await api(`/api/property-transfers/${id}`, { method: 'PATCH', body: JSON.stringify({ action, reviewNote }) }); setMessage(`Ownership transfer ${action === 'approve' ? 'approved' : 'rejected'}.`); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not review ownership transfer'); }
  }
  async function revokeOwner(row: Row) {
    if (!confirm(`Remove ${String(row.owner_name)} as owner of ${String(row.unit_number)}? Existing bills remain linked.`)) return;
    try { await api(`/api/property-ownerships/${row.ownership_id}`, { method: 'DELETE' }); setMessage('Property ownership removed.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not remove owner'); }
  }
  async function editProperty(row: Row) {
    const unitNumber = prompt('Unit number', String(row.unit_number ?? '')); if (!unitNumber) return;
    const street = prompt('Street', String(row.street ?? '')); if (!street) return;
    const block = prompt('Block (optional)', String(row.block ?? '')) ?? String(row.block ?? '');
    const zone = prompt('Zone (optional)', String(row.zone ?? '')) ?? String(row.zone ?? '');
    const address = prompt('Address', String(row.address ?? '')); if (!address) return;
    try { await api(`/api/properties/${row.id}`, { method: 'PATCH', body: JSON.stringify({ unitNumber,street,block,zone,address }) }); setMessage('Property details updated.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not update property'); }
  }

  async function exportStatement(row: Row, format: 'excel'|'pdf') {
    try {
      const res = await api<{ property: Record<string, unknown>; items: Row[]; summary: Record<string, unknown> }>(`/api/properties/${row.id}/statement`);
      const cols: Column[] = [
        ['external_reference', 'Ref'],
        ['bill_type', 'Type'],
        ['description', 'Description'],
        ['billed_to', 'Billed To'],
        ['amount_minor', 'Amount', 'money'],
        ['paid_minor', 'Paid', 'money'],
        ['due_date', 'Due Date', 'date'],
        ['status', 'Status'],
      ];
      const filename = `statement-unit-${String(row.unit_number || row.id)}`;
      const title = `Statement — Unit ${String(row.unit_number || '')} (${String(row.street || '')})`;
      if (format === 'excel') {
        exportRecordsToExcel(filename, `Unit ${String(row.unit_number || '')}`, cols, res.items);
      } else {
        await exportRecordsToPdf(filename, title, cols, res.items);
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Could not export statement');
    }
  }

  const actions = (row: Row) => <div className="row-actions">
    {(user.role==='admin' || user.role === 'cashier' || row.relationship_type === 'owner' || (row.relationship_type === 'tenant' && row.billing_responsibility === 'tenant')) && (
      <>
        <a className="text" href={`/api/properties/${row.id}/statement?format=csv`}>Statement (CSV)</a>
        <button type="button" className="text" onClick={() => exportStatement(row, 'excel')}>Excel</button>
        <button type="button" className="text" onClick={() => exportStatement(row, 'pdf')}>PDF</button>
      </>
    )}
    {operator && <><button className="text" onClick={() => editProperty(row)}>Edit</button>{row.ownership_id ? <button className="text danger" onClick={() => revokeOwner(row)}>Remove owner</button> : <button className="text" onClick={() => { setAssignPropertyId(String(row.id)); setShowAssign(true); }}>Assign owner</button>}</>}
  </div>;
  const pending = requests.data?.items.filter((request) => request.status === 'pending') ?? [];
  const pendingTransfers = transfers.data?.items.filter((transfer) => transfer.status === 'pending') ?? [];
  const transferable = list.data?.items.filter((property) => property.ownership_id && (operator || property.relationship_type === 'owner')) ?? [];

  return <PagePanel title={user.role === 'resident' ? 'My properties' : 'Properties'} subtitle="Ownership, occupancy, zones, statements and transfer history" action={<div className="row-actions">
    {(user.role === 'resident' || user.role === 'admin' || user.role === 'manager') && <button className="secondary" onClick={() => setShowTransfer(!showTransfer)}>Transfer ownership</button>}
    {user.role === 'resident' && <button className="primary" onClick={() => setShowRequest(!showRequest)}>Request another property</button>}
    {operator && <><button className="secondary" onClick={() => setShowAssign(!showAssign)}>Assign owner</button><button className="primary" onClick={() => setShowAdd(!showAdd)}>Add property</button></>}
  </div>}>
    {message && <Notice tone={message.includes('Could not') || message.includes('already') ? 'error' : 'success'}>{message}</Notice>}
    {showAdd && <FormCard title="New property" onSubmit={addProperty}><label>Unit number<input name="unitNumber" required /></label><label>Street<input name="street" required /></label><label>Block<input name="block" /></label><label>Zone<input name="zone" /></label><label>Address<input name="address" required /></label><button className="primary">Save property</button></FormCard>}
    {showAssign && <FormCard title="Assign an unowned property" onSubmit={assignOwner}><label>Property<select name="propertyId" value={assignPropertyId} onChange={(event) => setAssignPropertyId(event.target.value)} required><option value="">Select property</option>{available.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)}</option>)}</select></label><label>Resident email<input name="residentEmail" type="email" required /></label><button className="primary">Assign owner</button></FormCard>}
    {showRequest && <FormCard title="Request another property" onSubmit={requestProperty}><label>Request type<select value={requestMode} onChange={(event) => setRequestMode(event.target.value as 'existing'|'propose')}><option value="existing">Existing unowned property</option><option value="propose">Propose a new property</option></select></label>{requestMode === 'existing' ? <label>Available property<select name="propertyId" required><option value="">Select property</option>{available.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)}, {String(property.address)}</option>)}</select></label> : <><label>Unit number<input name="proposedUnitNumber" required /></label><label>Street<input name="proposedStreet" required /></label><label>Address<input name="proposedAddress" required /></label></>}<label className="span-2">Note<textarea name="requestNote" rows={3} /></label><ProofFilesField label="Ownership proof (recommended)" /><button className="primary">Submit for approval</button></FormCard>}
    {showTransfer && <FormCard title="Transfer legal ownership" onSubmit={requestTransfer}><label>Property<select name="propertyId" required><option value="">Select property</option>{transferable.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.owner_name)}</option>)}</select></label><label>New owner email<input name="newOwnerEmail" type="email" required /></label><label>Effective date<input name="effectiveDate" type="date" required /></label><label className="span-2">Transfer note<textarea name="requestNote" rows={3} /></label><ProofFilesField label="Transfer authority or sale proof (recommended)" /><button className="primary">Submit transfer</button></FormCard>}
    {operator && pending.length > 0 && <section className="approval-queue"><h3>Ownership approvals</h3><DataTable exportTitle="Ownership Approvals" rows={pending} columns={[['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['request_note','Note'],['created_at','Requested','date'],['status','Status']]} action={(row) => <div className="row-actions"><EvidenceButton entityType="property_ownership_request" entityId={row.id} count={row.proof_count} /><button className="text" onClick={() => reviewRequest(row.id,'approved')}>Approve</button><button className="text danger" onClick={() => reviewRequest(row.id,'rejected')}>Reject</button></div>} /></section>}
    {operator && pendingTransfers.length > 0 && <section className="approval-queue"><h3>Ownership transfer approvals</h3><DataTable exportTitle="Ownership Transfer Approvals" rows={pendingTransfers} columns={[['unit_number','Unit'],['from_owner_name','Current owner'],['to_owner_name','New owner'],['effective_date','Effective'],['request_note','Note'],['status','Status']]} action={(row) => <div className="row-actions"><EvidenceButton entityType="property_transfer" entityId={row.id} count={row.proof_count} /><button className="text" onClick={() => reviewTransfer(row.id,'approve')}>Approve</button><button className="text danger" onClick={() => reviewTransfer(row.id,'reject')}>Reject</button></div>} /></section>}
    <ListState list={list}><DataTable exportTitle="Properties" rows={list.data?.items ?? []} columns={user.role === 'resident' ? [['unit_number','Unit'],['zone','Zone'],['block','Block'],['street','Street'],['relationship_type','Relationship'],['main_resident_name','Main resident'],['billing_responsibility','Bill payer']] : [['unit_number','Unit'],['zone','Zone'],['block','Block'],['street','Street'],['owner_name','Owner'],['tenant_name','Tenant'],['billing_responsibility','Bill payer']]} action={actions} /></ListState>
    {requests.data && requests.data.items.length > 0 && <section className="request-history"><h3>Ownership request history</h3><DataTable exportTitle="Ownership Request History" rows={requests.data.items} columns={[['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['status','Status'],['review_note','Review note'],['created_at','Requested','date']]} action={(row)=><EvidenceButton entityType="property_ownership_request" entityId={row.id} count={row.proof_count} />} /></section>}
    {transfers.data && transfers.data.items.length > 0 && <section className="request-history"><h3>Ownership transfer history</h3><DataTable exportTitle="Ownership Transfer History" rows={transfers.data.items} columns={[['unit_number','Unit'],['from_owner_name','From'],['to_owner_name','To'],['effective_date','Effective'],['status','Status'],['review_note','Review note']]} action={(row)=><EvidenceButton entityType="property_transfer" entityId={row.id} count={row.proof_count} />} /></section>}
  </PagePanel>;
}


function Residency({ user }: { user: User }) {
  const operator=user.role==='admin'||user.role==='manager';
  const properties = useList('/api/properties?limit=100');
  const tenancies = useList('/api/property-tenancies?limit=100');
  const household = useList('/api/household-members?limit=100');
  const [showTenancy, setShowTenancy] = useState(false);
  const [showMember, setShowMember] = useState(false);
  const [accessMember,setAccessMember]=useState<Row|null>(null);
  const accessDevices=useAsync<{ items:Row[] }>(()=>operator?api('/api/access/device-options'):Promise.resolve({ items:[] }),[user.role]);
  const [message, setMessage] = useState('');
  function refresh() { properties.reload(); tenancies.reload(); household.reload(); }
  async function addTenancy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { const proofKeys=await uploadProofFiles(event.currentTarget,'tenancy-proofs'); const result = await api<{ status:string }>('/api/property-tenancies',{ method:'POST',body:JSON.stringify({ ...values,proofKeys }) }); setShowTenancy(false); setMessage(result.status === 'active' ? 'Tenant assigned.' : 'Tenant nomination submitted for administrator approval.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create tenancy'); }
  }
  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const form = new FormData(event.currentTarget);
    const body = { propertyId:form.get('propertyId'),primaryResidentId:form.get('primaryResidentId') || undefined,name:form.get('name'),relationship:form.get('relationship'),dateOfBirth:form.get('dateOfBirth') || undefined,phone:form.get('phone'),email:form.get('email'),canCreateVisitors:form.get('canCreateVisitors') === 'on',canViewBills:form.get('canViewBills') === 'on',requestNote:form.get('requestNote') };
    try { const proofKeys=await uploadProofFiles(event.currentTarget,'household-proofs'); const result = await api<{ status:string }>('/api/household-members',{ method:'POST',body:JSON.stringify({ ...body,proofKeys }) }); setShowMember(false); setMessage(result.status === 'active' ? 'Household member added.' : 'Household member submitted for administrator approval.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not add household member'); }
  }
  async function tenancyAction(row: Row, action: 'approve'|'reject'|'end'|'update') {
    const reviewNote = prompt(action === 'reject' ? 'Reason for rejection' : 'Optional note') ?? '';
    const billingResponsibility = action === 'approve' || action === 'update' ? (prompt('Who pays new property bills? Enter owner or tenant',String(row.billing_responsibility ?? 'owner')) ?? String(row.billing_responsibility ?? 'owner')) : undefined;
    try { await api(`/api/property-tenancies/${row.id}`,{ method:'PATCH',body:JSON.stringify({ action,reviewNote,billingResponsibility }) }); setMessage(`Tenancy ${action} completed.`); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Tenancy action failed'); }
  }
  async function memberAction(row: Row, action: 'approve'|'reject'|'deactivate'|'update') {
    const reviewNote = prompt(action === 'reject' ? 'Reason for rejection' : 'Optional note') ?? '';
    const canCreateVisitors = action === 'approve' || action === 'update' ? confirm('Allow this dependant to create visitor passes when they have a login?') : undefined;
    const canViewBills = action === 'approve' || action === 'update' ? confirm('Allow this dependant to view the main resident’s property bills?') : undefined;
    try { await api(`/api/household-members/${row.id}`,{ method:'PATCH',body:JSON.stringify({ action,reviewNote,canCreateVisitors,canViewBills }) }); setMessage(`Household member ${action} completed.`); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Household action failed'); }
  }
  async function createMemberLogin(row: Row) {
    const email = prompt('Login email',String(row.email ?? '')); if (!email) return;
    const temporaryPassword = prompt('Temporary password (at least 12 characters). Leave blank to link an existing resident account.','') ?? '';
    try { await api(`/api/household-members/${row.id}/login`,{ method:'POST',body:JSON.stringify({ email,temporaryPassword:temporaryPassword || undefined }) }); setMessage('Dependant login linked.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create dependant login'); }
  }
  const pendingTenancies = tenancies.data?.items.filter((row) => row.status === 'pending') ?? [];
  const pendingMembers = household.data?.items.filter((row) => row.status === 'pending') ?? [];
  const tenancyActions = (row:Row) => <div className="row-actions"><EvidenceButton entityType="property_tenancy" entityId={row.id} count={row.proof_count} />{operator&&<>{row.status === 'pending' && <><button className="text" onClick={() => tenancyAction(row,'approve')}>Approve</button><button className="text danger" onClick={() => tenancyAction(row,'reject')}>Reject</button></>}{row.status === 'active' && <><button className="text" onClick={() => tenancyAction(row,'update')}>Billing</button><button className="text danger" onClick={() => tenancyAction(row,'end')}>End</button></>}</>}</div>;
  const accessMemberRow = accessMember ? household.data?.items.find((row) => String(row.id) === String(accessMember.id)) : undefined;
  const memberActions = (row:Row) => <div className="row-actions"><EvidenceButton entityType="household_member" entityId={row.id} count={row.proof_count} />{operator&&<>{row.status === 'pending' && <><button className="text" onClick={() => memberAction(row,'approve')}>Approve</button><button className="text danger" onClick={() => memberAction(row,'reject')}>Reject</button></>}{row.status === 'active' && <><button className="text" onClick={() => memberAction(row,'update')}>Permissions</button><button className="text" onClick={() => setAccessMember(row)}>Cards &amp; fingerprints</button>{!row.linked_user_id && <button className="text" onClick={() => createMemberLogin(row)}>Add login</button>}<button className="text danger" onClick={() => memberAction(row,'deactivate')}>Deactivate</button></>}</>}</div>;
  return <PagePanel title="Tenancy & household" subtitle="Main tenants, rented apartments, dependants, domestic staff and delegated permissions" action={<div className="row-actions"><button className="secondary" onClick={() => setShowMember(!showMember)}>Add dependant</button><button className="primary" onClick={() => setShowTenancy(!showTenancy)}>{operator ? 'Assign tenant' : 'Nominate tenant'}</button></div>}>
    <Notice tone="info"><strong>Rented apartment:</strong> legal ownership remains with the owner. The approved tenant becomes the main resident for the tenancy dates. The administrator chooses whether future property bills go to the owner or tenant.</Notice>
    {message && <Notice tone={message.includes('Could not') || message.includes('failed') ? 'error' : 'success'}>{message}</Notice>}
    {showTenancy && <FormCard title={operator ? 'Assign a tenant' : 'Nominate a tenant for approval'} onSubmit={addTenancy}><label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.owner_name ?? property.relationship_type)}</option>)}</select></label><label>Tenant email<input name="tenantEmail" type="email" required /></label><label>Start date<input name="startDate" type="date" required /></label><label>End date<input name="endDate" type="date" /></label><label>Bill responsibility<select name="billingResponsibility"><option value="owner">Legal owner</option><option value="tenant">Main tenant</option></select></label><label className="span-2">Note<textarea name="requestNote" rows={3} /></label><ProofFilesField label="Tenancy agreement or authority proof (recommended)" /><button className="primary">{operator ? 'Assign tenant' : 'Submit nomination'}</button></FormCard>}
    {showMember && <FormCard title="Add a dependant or household member" onSubmit={addMember}><label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.main_resident_name ?? property.owner_name)}</option>)}</select></label>{operator && <label>Main resident ID<input name="primaryResidentId" placeholder="Optional; resolved automatically" /></label>}<label>Full name<input name="name" required /></label><label>Relationship<select name="relationship"><option value="spouse">Spouse</option><option value="child">Child</option><option value="parent">Parent</option><option value="relative">Relative</option><option value="domestic_staff">Domestic staff</option><option value="caregiver">Caregiver</option><option value="other">Other</option></select></label><label>Date of birth<input name="dateOfBirth" type="date" /></label><label>Phone<input name="phone" /></label><label>Email<input name="email" type="email" /></label><label className="check"><input name="canCreateVisitors" type="checkbox" /> May create visitors after login</label><label className="check"><input name="canViewBills" type="checkbox" /> May view bills after login</label><label className="span-2">Note<textarea name="requestNote" rows={3} /></label><ProofFilesField label="Identity, relationship or consent proof (recommended)" /><button className="primary">{operator ? 'Add member' : 'Submit for approval'}</button></FormCard>}
    {operator && (pendingTenancies.length > 0 || pendingMembers.length > 0) && <section className="approval-queue"><h3>Pending residency approvals</h3><p>{pendingTenancies.length} tenancy nomination(s) and {pendingMembers.length} household member(s) are waiting.</p></section>}
    <section className="residency-section"><h3>Tenancies</h3><ListState list={tenancies}><DataTable exportTitle="Tenancies" rows={tenancies.data?.items ?? []} columns={[['unit_number','Unit'],['owner_name','Legal owner'],['tenant_name','Main tenant'],['start_date','Starts'],['end_date','Ends'],['billing_responsibility','Bill payer'],['status','Status']]} action={tenancyActions} /></ListState></section>
    <section className="residency-section"><h3>Dependants and household members</h3><ListState list={household}><DataTable exportTitle="Household Members" rows={household.data?.items ?? []} columns={[['name','Name'],['relationship','Relationship'],['unit_number','Unit'],['primary_resident_name','Main resident'],['login_email','Login'],['can_create_visitors','Visitors'],['can_view_bills','Bills'],['status','Status']]} action={memberActions} /></ListState></section>
    {operator && accessMemberRow && <section className="person-access"><div className="row-actions"><button className="secondary sm" onClick={() => setAccessMember(null)}>Close access panel</button></div>
      <PersonCredentials householdMemberId={String(accessMemberRow.id)} personName={String(accessMemberRow.name)} devices={accessDevices.data?.items ?? []} onChanged={refresh} />
    </section>}
  </PagePanel>;
}


const operationImportDefinitions={
  properties:{ label:'Properties',description:'Create streets, units, blocks and zones before assigning residents.',template:'unit_number,address,street,block,zone\nA-01,1 Palm Avenue,Palm Avenue,Block A,North\n' },
  ownerships:{ label:'Property ownerships',description:'Assign existing available properties to existing active resident accounts.',template:'resident_email,unit_number\nresident@example.com,A-01\n' },
  tenancies:{ label:'Tenancies',description:'Import current or historical main tenancies and bill responsibility.',template:'tenant_email,unit_number,start_date,end_date,billing_responsibility,status,can_manage_visitors,can_manage_maintenance,note\ntenant@example.com,A-01,2026-01-01,2026-12-31,tenant,active,true,true,Opening balance migration\n' },
  cards:{ label:'Access cards',description:'Register digits-only card numbers (keep leading zeroes) for active residents and queue hardware synchronization.',template:'resident_email,card_uid,card_label,status,expires_at\nresident@example.com,10000001,Main card,active,2027-12-31\n' },
} as const;

function ImportCentre() {
  type ImportKind=keyof typeof operationImportDefinitions;
  const [kind,setKind]=useState<ImportKind>('properties');const [result,setResult]=useState('');const [busy,setBusy]=useState(false);
  const history=useAsync<ListResponse<Row>>(()=>api('/api/imports?scope=operations&limit=50'),[]);const definition=operationImportDefinitions[kind];
  function downloadTemplate(){const url=URL.createObjectURL(new Blob([definition.template],{ type:'text/csv' }));const link=document.createElement('a');link.href=url;link.download=`${kind}-import-template.csv`;link.click();URL.revokeObjectURL(url);}
  async function upload(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setResult('');const input=event.currentTarget.elements.namedItem('file') as HTMLInputElement;const file=input.files?.[0];if(!file){setResult('Choose a CSV file.');setBusy(false);return;}try{const response=await api<{ successfulRows:number;errorRows:number;errors:Array<{ row:number;error:string }> }>(`/api/imports/${kind}`,{ method:'POST',body:await file.text(),headers:{ 'Content-Type':'text/csv','X-Filename':file.name } });const first=response.errors[0]?` First error: row ${response.errors[0].row} — ${response.errors[0].error}`:'';setResult(`${response.successfulRows} row(s) imported; ${response.errorRows} error(s).${first}`);history.reload();}catch(reason){setResult(reason instanceof Error?reason.message:'Import failed');}finally{setBusy(false);}}
  return <PagePanel title="Import centre" subtitle="Bulk-load the most common estate setup and access-control records">
    <Notice tone="info">Recommended order: Properties → People → Ownerships → Tenancies → Access cards. Billing and payment imports remain under Bills & payments. Every source CSV is archived in the configured private GitHub repository.</Notice>
    <form className="form-card import-card" onSubmit={upload}><h3>{definition.label}</h3><label>Import type<select value={kind} onChange={(event)=>{setKind(event.target.value as ImportKind);setResult('');}}>{Object.entries(operationImportDefinitions).map(([key,value])=><option key={key} value={key}>{value.label}</option>)}</select></label><p className="span-2">{definition.description}</p><label className="span-2">CSV file<input name="file" type="file" accept=".csv,text/csv" required /></label><div className="row-actions span-2"><button type="button" className="secondary" onClick={downloadTemplate}>Download {definition.label.toLowerCase()} template</button><button className="primary" disabled={busy}>{busy?'Importing…':'Upload and validate'}</button></div>{result&&<div className="span-2"><Notice tone={result.includes('0 error')?'success':'warning'}>{result}</Notice></div>}</form>
    {history.data&&<section className="import-history"><h3>Operational import history</h3><DataTable exportTitle="Operational Import History" rows={history.data.items} columns={[['kind','Type'],['filename','File'],['status','Status'],['total_rows','Rows'],['successful_rows','Imported'],['error_rows','Errors'],['uploaded_by_name','Uploaded by'],['created_at','Uploaded','date']]} action={(row)=>row.storage_key?<a className="text" href={`/api/files/${encodeURIComponent(String(row.storage_key))}`}>Download source</a>:null} /></section>}
  </PagePanel>;
}

interface PaymentMethodOption { id: string; label: string; detail: string; proofLabel: string }
interface PaymentChannels { methods: PaymentMethodOption[]; bankAccount: Record<string, string>; bankAccountConfigured: boolean; editable: boolean }

function BankAccountCard({ channels }: { channels: PaymentChannels }) {
  const [copied, setCopied] = useState('');
  const account = channels.bankAccount;
  if (!channels.bankAccountConfigured) {
    return <Notice tone="warning"><strong>No bank account published yet.</strong> The Administrator has not added the estate account. Pay at the office, or ask them to publish it under Settings.</Notice>;
  }
  async function copyDetails() {
    const lines = [account.bankName, account.accountName, account.accountNumber, account.sortCode && `Sort code: ${account.sortCode}`].filter(Boolean).join('\n');
    try { await navigator.clipboard.writeText(lines); setCopied('Account details copied.'); }
    catch { setCopied('Copy is blocked by this browser — write the details down instead.'); }
  }
  return <div className="bank-card span-2">
    <p className="eyebrow">TRANSFER TO THIS ESTATE ACCOUNT</p>
    <dl>
      <div><dt>Bank</dt><dd>{account.bankName}</dd></div>
      <div><dt>Account name</dt><dd>{account.accountName || '—'}</dd></div>
      <div><dt>Account number</dt><dd className="account-number">{account.accountNumber}</dd></div>
      {Boolean(account.sortCode) && <div><dt>Sort code</dt><dd>{account.sortCode}</dd></div>}
    </dl>
    {Boolean(account.referenceNote) && <small>{account.referenceNote}</small>}
    <div className="row-actions"><button type="button" className="secondary" onClick={copyDetails}>Copy account details</button>{copied && <small>{copied}</small>}</div>
  </div>;
}

function Bills({ user }: { user: User }) {
  const list = useList('/api/bills?limit=50');
  const payments = useList('/api/payments?limit=50');
  const groups = useAsync<{ streets:Row[];blocks:Row[];zones:Row[] }>(() => user.role === 'resident' ? Promise.resolve({ streets:[],blocks:[],zones:[] }) : api('/api/property-groups'), [user.role]);
  const imports = useAsync<ListResponse<Row>>(() => user.role === 'resident' ? Promise.resolve({ items: [], page: 1, limit: 20 }) : api('/api/imports?scope=billing&limit=20'), [user.role]);
  const channels = useAsync<PaymentChannels>(() => api('/api/payment-channels'), []);
  const [showBatch, setShowBatch] = useState(false);
  const [targetType, setTargetType] = useState<'all'|'street'|'block'|'zone'>('all');
  const [audience, setAudience] = useState<'all_owners_and_tenants'|'only_owners'|'only_tenants'|'standard'>('all_owners_and_tenants');
  const [showImport, setShowImport] = useState(false);
  const [showPayment,setShowPayment]=useState(false);
  const [paymentMethod,setPaymentMethod]=useState('');
  const [message, setMessage] = useState('');

  async function submitPayment(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setMessage('');const form=new FormData(event.currentTarget);
    try {
      const proofKeys=await uploadProofFiles(event.currentTarget,'payment-proofs');
      const result=await api<{ receiptNumber:string;status:string }>('/api/payments',{ method:'POST',body:JSON.stringify({ billId:form.get('billId'),amountMinor:Math.round(Number(form.get('amount'))*100),paymentMethod:form.get('paymentMethod'),proofKeys }) });
      setMessage(`Payment ${result.receiptNumber} submitted with status ${result.status}.`);setShowPayment(false);setPaymentMethod('');list.reload();payments.reload();
    } catch(reason) { setMessage(reason instanceof Error?reason.message:'Payment submission failed'); }
  }

  async function reviewPayment(id:unknown,status:'approved'|'rejected') {
    const note=prompt(status==='rejected'?'Reason for rejection':'Optional review note') ?? '';
    await api(`/api/payments/${id}/review`,{ method:'PATCH',body:JSON.stringify({ status,note }) });payments.reload();list.reload();
  }

  async function createStreetBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get('amount'));
    const body = {
      name: form.get('name'),
      targetType,
      targets: targetType === 'all' ? [] : form.getAll('targets'),
      audience,
      amountMinor: Math.round(amount * 100),
      dueDate: form.get('dueDate'),
      billType: form.get('billType'),
      description: form.get('description'),
    };
    try {
      const result = await api<{ billCount:number;targetType:string;targets:string[] }>('/api/bills/batch', { method: 'POST', body: JSON.stringify(body) });
      const audienceLabel = audience === 'only_owners' ? 'owners only' : audience === 'only_tenants' ? 'tenants only' : 'owners & tenants';
      setMessage(`${result.billCount} bill${result.billCount === 1 ? '' : 's'} created for ${audienceLabel} (${result.targetType === 'all' ? 'all properties' : `${result.targetType}: ${result.targets.join(', ')}`}).`);
      setShowBatch(false); list.reload();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Batch billing failed'); }
  }

  const staff = user.role === 'admin' || user.role === 'cashier';
  const targetRows = targetType === 'block' ? groups.data?.blocks : targetType === 'zone' ? groups.data?.zones : groups.data?.streets;
  const selectedMethod = channels.data?.methods.find((method) => method.id === paymentMethod);
  const methodLabels: Record<string,string> = { pos: 'POS at office', cash: 'Cash at office', bank_transfer: 'Bank transfer' };
  return <PagePanel title="Bills & payments" subtitle={user.role === 'resident' ? 'Your charges and payment status' : 'Estate receivables, grouped billing and historical imports'} action={<div className="row-actions"><button className="secondary" onClick={() => { setShowPayment(!showPayment); setPaymentMethod(''); }}>Initiate payment</button>{staff&&<><button className="secondary" onClick={() => setShowImport(!showImport)}>Import CSV</button><button className="primary" onClick={() => setShowBatch(!showBatch)}>Create grouped bills</button></>}</div>}>
    {message && <Notice tone={message.includes('created') || message.includes('submitted') ? 'success' : 'error'}>{message}</Notice>}
    {showPayment&&<FormCard title={user.role==='resident'?'Initiate a payment':'Record a payment received'} onSubmit={submitPayment}>
      <label>Bill<select name="billId" required><option value="">Select bill</option>{list.data?.items.filter((bill)=>!['paid','void'].includes(String(bill.status))).map((bill)=><option key={String(bill.id)} value={String(bill.id)}>{String(bill.unit_number)} — {String(bill.bill_type)} — {money(bill.amount_minor)}</option>)}</select></label>
      <label>Amount (NGN)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
      <fieldset className="method-picker span-2"><legend>Payment option</legend>
        {channels.loading && <small>Loading payment options…</small>}
        {channels.error && <Notice tone="error">{channels.error}</Notice>}
        {(channels.data?.methods ?? []).map((method)=>(
          <label className="check" key={method.id}>
            <input type="radio" name="paymentMethod" value={method.id} checked={paymentMethod===method.id} onChange={()=>setPaymentMethod(method.id)} required />
            <span>{method.label}<small>{method.detail}</small></span>
          </label>
        ))}
      </fieldset>
      {paymentMethod==='bank_transfer'&&channels.data&&<BankAccountCard channels={channels.data} />}
      <ProofFilesField label={selectedMethod?`${selectedMethod.proofLabel} (recommended; required by estate policy where applicable)`:'Receipt or payment proof (recommended; required by estate policy where applicable)'} />
      <button className="primary">Submit payment</button>
    </FormCard>}
    {showBatch && <FormCard title="Create bills for property owners / tenants" onSubmit={createStreetBatch}>
      <label>Batch name<input name="name" placeholder="2026 facility fee" required /></label>
      <label>Amount (NGN)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
      <label>Due date<input name="dueDate" type="date" required /></label>
      <label>Bill type<input name="billType" defaultValue="facility_fee" required /></label>
      <label>Billing recipient / audience
        <select value={audience} onChange={(e) => setAudience(e.target.value as any)}>
          <option value="all_owners_and_tenants">All property owners (per property owned) &amp; tenants</option>
          <option value="only_owners">Only property owners (per property owned)</option>
          <option value="only_tenants">Only tenants</option>
          <option value="standard">Standard (tenants if responsible, otherwise owners)</option>
        </select>
      </label>
      <label>Group by<select value={targetType} onChange={(event) => setTargetType(event.target.value as 'all'|'street'|'block'|'zone')}><option value="all">All estate properties</option><option value="street">Street</option><option value="block">Block</option><option value="zone">Zone</option></select></label>
      <label className="span-2">Description<input name="description" /></label>
      {targetType !== 'all' ? (
        <fieldset className="street-picker span-2"><legend>{targetType[0].toUpperCase()+targetType.slice(1)}s to bill</legend>{groups.loading && <small>Loading property groups…</small>}{targetRows?.map((group) => <label className="check" key={String(group.value)}><input type="checkbox" name="targets" value={String(group.value)} /> <span>{String(group.value)} <small>({String(group.property_count)} properties)</small></span></label>)}{!groups.loading && !targetRows?.length && <Notice tone="warning">Add {targetType} details to properties before using this billing group.</Notice>}</fieldset>
      ) : (
        <div className="span-2"><Notice tone="info">Bills will be generated across all active properties in the estate for the selected audience.</Notice></div>
      )}
      <button className="primary">Create grouped bills</button>
    </FormCard>}
    {showImport && <section className="import-grid">
      <CsvImporter kind="bills" title="Import existing bills" onDone={() => { list.reload(); imports.reload(); }} />
      <CsvImporter kind="payments" title="Import resident payments" onDone={() => { list.reload(); imports.reload(); }} />
    </section>}
    <ListState list={list}><DataTable exportTitle="Bills & Payments" rows={list.data?.items ?? []} columns={[['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['bill_type','Type'],['batch_name','Batch'],['external_reference','External ref.'],['amount_minor','Amount','money'],['paid_minor','Paid','money'],['due_date','Due'],['status','Status']]} /></ListState>
    <section className="request-history"><h3>Payment submissions</h3><ListState list={payments}><DataTable exportTitle="Payment Submissions" rows={(payments.data?.items ?? []).map((row)=>({ ...row,payment_method:methodLabels[String(row.payment_method)] ?? String(row.payment_method ?? '—') }))} columns={[['receipt_number','Receipt'],['resident_name','Resident'],['unit_number','Unit'],['amount_minor','Amount','money'],['payment_method','Method'],['status','Status'],['submitted_at','Submitted','date']]} action={(row)=><div className="row-actions"><EvidenceButton entityType="payment" entityId={row.id} count={row.proof_count} />{staff&&row.status==='pending'&&<><button className="text" onClick={()=>reviewPayment(row.id,'approved')}>Approve</button><button className="text danger" onClick={()=>reviewPayment(row.id,'rejected')}>Reject</button></>}</div>} /></ListState></section>
    {staff && imports.data && imports.data.items.length > 0 && <section className="import-history"><h3>Recent imports</h3><DataTable rows={imports.data.items} columns={[['kind','Type'],['filename','File'],['status','Status'],['total_rows','Rows'],['successful_rows','Imported'],['error_rows','Errors'],['created_at','Uploaded','date']]} action={(row) => row.storage_key ? <a className="text" href={`/api/files/${encodeURIComponent(String(row.storage_key))}`}>Download source</a> : null} /></section>}
  </PagePanel>;
}

function CsvImporter({ kind, title, onDone }: { kind: 'bills'|'payments'; title: string; onDone: () => void }) {
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const template = kind === 'bills'
    ? 'external_reference,unit_number,resident_email,amount,currency,due_date,bill_type,description,status,created_at\nBILL-001,A-01,resident@example.com,25000,NGN,2026-12-31,facility_fee,Imported facility fee,unpaid,2026-01-01\n'
    : 'external_reference,bill_reference,amount,payment_method,receipt_number,status,type,submitted_at\nPAY-001,BILL-001,25000,bank_transfer,OLD-RECEIPT-001,approved,payment,2026-02-01\n';
  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([template], { type: 'text/csv' }));
    const link = document.createElement('a'); link.href = url; link.download = `${kind}-import-template.csv`; link.click(); URL.revokeObjectURL(url);
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setResult(''); setBusy(true);
    const input = event.currentTarget.elements.namedItem('file') as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) { setResult('Choose a CSV file.'); setBusy(false); return; }
    try {
      const response = await api<{ successfulRows: number; errorRows: number; errors: Array<{ row: number; error: string }> }>(`/api/imports/${kind}`, { method: 'POST', body: await file.text(), headers: { 'Content-Type': 'text/csv', 'X-Filename': file.name } });
      const firstError = response.errors[0] ? ` First error: row ${response.errors[0].row} — ${response.errors[0].error}` : '';
      setResult(`${response.successfulRows} imported; ${response.errorRows} failed.${firstError}`); onDone();
    } catch (reason) { setResult(reason instanceof Error ? reason.message : 'Import failed'); }
    finally { setBusy(false); }
  }
  return <form className="form-card import-card" onSubmit={upload}><h3>{title}</h3><p>Maximum 500 rows and 2 MB per upload. Duplicate references are rejected safely.</p><input name="file" type="file" accept=".csv,text/csv" required /><div className="row-actions"><button type="button" className="secondary" onClick={downloadTemplate}>Download template</button><button className="primary" disabled={busy}>{busy ? 'Importing…' : 'Upload CSV'}</button></div>{result && <Notice tone={result.includes('failed. First') || result.includes('Import failed') ? 'error' : 'success'}>{result}</Notice>}</form>;
}

function CameraCodeScanner({ onCode,onClose }: { onCode:(code:string)=>void;onClose:()=>void }) {
  const video=useRef<HTMLVideoElement>(null);const [error,setError]=useState('');
  useEffect(()=>{
    let controls:{ stop:()=>void }|undefined;let finished=false;let cancelled=false;
    import('@zxing/browser').then(({ BrowserMultiFormatReader })=>{
      if(cancelled)return;const reader=new BrowserMultiFormatReader();
      return reader.decodeFromVideoDevice(undefined,video.current!, (result,_failure,scanControls)=>{
        if (result&&!finished) { finished=true;scanControls.stop();onCode(result.getText()); }
      });
    }).then((value)=>{if(value)controls=value;}).catch((reason:unknown)=>setError(reason instanceof Error?reason.message:'Camera could not start'));
    return ()=>{cancelled=true;controls?.stop();};
  },[onCode]);
  return <div className="scanner-box"><video ref={video} muted playsInline /><p>Point the camera at the visitor QR code or Code 128 barcode.</p>{error&&<Notice tone="error">{error}</Notice>}<button type="button" className="secondary" onClick={onClose}>Close camera</button></div>;
}

function VisitorPass({ pass,onClose,branding }: { pass:Row;onClose:()=>void;branding:{ portalName:string;shortName:string } }) {
  const [qr,setQr]=useState('');const barcode=useRef<SVGSVGElement>(null);
  const [shareState,setShareState]=useState('');
  const credential=String(pass.credential_number ?? pass.credentialNumber ?? pass.pin ?? '');
  useEffect(()=>{ if (!credential) return;let cancelled=false;Promise.all([import('qrcode'),import('jsbarcode')]).then(([qrModule,barcodeModule])=>{if(cancelled)return;qrModule.default.toDataURL(credential,{ width:280,margin:2,errorCorrectionLevel:'M' }).then((value)=>!cancelled&&setQr(value));if(barcode.current)barcodeModule.default(barcode.current,credential,{ format:'CODE128',displayValue:true,fontSize:16,height:64,margin:8 });});return()=>{cancelled=true;}; },[credential]);
  const host=String(pass.resident_name ?? pass.residentName ?? 'Estate resident');
  const propertyText=`${String(pass.unit_number ?? pass.propertyId ?? 'Selected property')}${pass.street?` — ${String(pass.street)}`:''}`;
  const gateText=String(pass.gate_scope ?? pass.gateScope ?? 'both')==='gate'
    ? `Gate device: ${String(pass.device_name ?? 'Selected device')}`
    : 'Valid at every gate — entry and exit';

  async function share(format:'image'|'pdf') {
    if (!credential) { setShareState('This pass has no credential to share.'); return; }
    setShareState('Preparing the pass file…');
    try {
      const exporter=await import('./pass-export');
      const source: PassShareSource={
        credential,
        visitorName:String(pass.visitor_name ?? pass.visitorName ?? 'Visitor'),
        host, property:propertyText,
        pin:String(pass.pin ?? ''),
        fromText:readableDate(pass.valid_from ?? pass.validFrom),
        untilText:readableDate(pass.valid_until ?? pass.validUntil),
        gateText, portalName:branding.portalName, shortName:branding.shortName,
      };
      const blob=format==='image'?await exporter.visitorPassImageBlob(source):await exporter.visitorPassPdfBlob(source);
      const filename=`visitor-pass-${credential}.${format==='image'?'png':'pdf'}`;
      const outcome=await exporter.sharePassFile(blob,filename,`Visitor pass ${credential}`);
      setShareState(outcome==='shared'?'Pass shared.':outcome==='cancelled'?'Share cancelled.':`${format==='image'?'Image':'PDF'} saved to your downloads.`);
    } catch(reason) { setShareState(reason instanceof Error?reason.message:'Could not prepare the pass file'); }
  }

  return <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="notice-modal visitor-pass-modal"><div className="visitor-pass printable-pass"><p className="eyebrow">ESTATE VISITOR PASS</p><h2>{String(pass.visitor_name ?? pass.visitorName ?? 'Visitor')}</h2><p>Host: <strong>{host}</strong></p><p>Property: <strong>{propertyText}</strong></p>{qr&&<img className="pass-qr" src={qr} alt={`Visitor QR ${credential}`} />}<svg className="pass-barcode" ref={barcode} /><strong className="credential-number">{credential}</strong><small>Unique visitor number</small>{Boolean(pass.pin)&&<p className="pass-pin">Keypad PIN: <strong>{String(pass.pin)}</strong></p>}<div className="pass-dates"><span>From {readableDate(pass.valid_from ?? pass.validFrom)}</span><span>Until {readableDate(pass.valid_until ?? pass.validUntil)}</span></div><p className="pass-gates">{gateText}</p><p className="pass-policy">Security must scan and review this pass before accepting entry. Device recognition requires a compatible, configured reader.</p></div>{shareState&&<p className="share-status no-print">{shareState}</p>}<div className="row-actions no-print"><button className="primary" onClick={()=>window.print()}>Print pass</button><button className="secondary" onClick={()=>share('image')}>Share as image</button><button className="secondary" onClick={()=>share('pdf')}>Share as PDF</button><button className="secondary" onClick={onClose}>Close</button></div></section></div>;
}

function Visitors({ user }: { user: User }) {
  const list = useList('/api/visitors?limit=50');
  const properties = useList('/api/properties?limit=100');
  const devices=useAsync<{ items:Row[] }>(()=>api('/api/access/device-options'),[]);
  const portal=useAsync<PortalConfig>(()=>api('/api/portal-config'),[]);
  const defaultStart=useMemo(()=>new Date(),[]);const defaultEnd=new Date(defaultStart.valueOf()+Number(portal.data?.visitor_default_duration_hours||8)*3600000);
  const [show, setShow] = useState(false);
  const [result, setResult] = useState('');
  const [selectedPass,setSelectedPass]=useState<Row|null>(null);
  const [preview,setPreview]=useState<Row|null>(null);
  const [scanId,setScanId]=useState('');
  const [camera,setCamera]=useState(false);
  const [deviceSession,setDeviceSession]=useState<Row|null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setResult(''); const form=event.currentTarget;const raw=Object.fromEntries(new FormData(form));delete raw.proofFiles;
    try {
      const proofKeys=await uploadProofFiles(form,'visitor-proofs');
      const created = await api<Row>('/api/visitors', { method: 'POST', body: JSON.stringify({ ...raw,proofKeys }) });
      const property=properties.data?.items.find((item)=>item.id===raw.propertyId);
      setSelectedPass({ ...raw,...created,visitor_name:raw.visitorName,valid_from:created.validFrom ?? raw.validFrom,valid_until:created.validUntil ?? raw.validUntil,resident_name:user.role==='resident'?user.name:raw.residentId,unit_number:property?.unit_number,street:property?.street });
      setResult('Pass created and the visitor account is live on the estate terminals. It is deleted from all of them automatically when validity ends; the pass record stays. Share the QR/barcode and unique number with the visitor.');setShow(false);list.reload();
    } catch (reason) { setResult(reason instanceof Error ? reason.message : 'Failed'); }
  }
  const previewCode=useCallback(async(code:string,source:'phone_camera'|'device'|'manual')=>{
    setResult('');setCamera(false);
    try {
      const checked=await api<{ scanId:string;valid:boolean;reason?:string;visitor:Row;proofs?:Row[] }>('/api/visitors/scan',{ method:'POST',body:JSON.stringify({ code,source }) });
      setPreview({ ...checked.visitor,valid:checked.valid,invalid_reason:checked.reason,proofs:checked.proofs ?? [] });
      setScanId(checked.scanId);
    }
    catch(reason) { setPreview(null);setResult(reason instanceof Error?reason.message:'Pass lookup failed'); }
  },[]);
  async function manualPreview(event:FormEvent<HTMLFormElement>) { event.preventDefault();const form=new FormData(event.currentTarget);await previewCode(String(form.get('code')??''),'manual'); }
  async function decide(decision:'accepted'|'rejected',action:'in'|'out'='in') {
    if (!preview) return;
    const note=decision==='rejected'?(prompt('Reason for rejection','')??''):'';
    try {
      let gateProofKeys: string[] = [];
      if (decision === 'accepted' && action === 'in') {
        const fileInput = document.getElementById('gateVerificationFile') as HTMLInputElement | null;
        if (fileInput?.files?.[0]) {
          const file = fileInput.files[0];
          const uploaded = await api<{ key: string }>('/api/files', {
            method: 'POST',
            body: file,
            headers: { 'Content-Type': file.type || 'image/jpeg', 'X-Filename': file.name, 'X-File-Category': 'gate-verification' }
          });
          gateProofKeys = [uploaded.key];
        } else if (Number(preview.require_gate_id_verification ?? 0) === 1) {
          setResult('Gate verification photo is required before granting entry.');
          return;
        }
      }
      await api(`/api/visitors/${preview.id}/decision`,{ method:'POST',body:JSON.stringify({ decision,action,scanId,note,gateProofKeys }) });
      setResult(decision==='accepted'?`Accepted ${String(preview.visitor_name)} for check ${action}.`:`Rejected ${String(preview.visitor_name)}.`);
      setPreview(null);setScanId('');list.reload();
    }
    catch(reason) { setResult(reason instanceof Error?reason.message:'Decision failed'); }
  }
  async function startDeviceScan(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=new FormData(event.currentTarget);
    try { const session=await api<Row>('/api/visitors/device-scan-sessions',{ method:'POST',body:JSON.stringify({ deviceId:form.get('deviceId') }) });setDeviceSession(session);setResult('Waiting for the visitor credential to be presented at the selected device…'); }
    catch(reason) { setResult(reason instanceof Error?reason.message:'Could not start device scan'); }
  }
  async function syncActivePasses() {
    try {
      const synced=await api<{ passes:number;queued:number }>('/api/visitors/sync-active',{ method:'POST' });
      setResult(`Synced ${synced.passes} active visitor pass${synced.passes===1?'':'es'}; queued ${synced.queued} hardware update${synced.queued===1?'':'s'}.`);
      list.reload();
    } catch(reason) { setResult(reason instanceof Error?reason.message:'Could not sync active visitor passes'); }
  }
  const deviceAccounts=useAsync<{ summary:Row;items:Row[];retention:string }>(()=>['admin','manager'].includes(user.role)?api('/api/visitors/device-accounts'):Promise.resolve({ summary:{},items:[],retention:'' }),[user.role]);
  async function releaseDeviceAccounts() {
    try {
      const released=await api<{ passes:number;queued:number;notice:string }>('/api/visitors/release-device-accounts',{ method:'POST' });
      setResult(released.notice);
      list.reload();deviceAccounts.reload();
    } catch(reason) { setResult(reason instanceof Error?reason.message:'Could not release visitor device accounts'); }
  }
  useEffect(()=>{
    if (!deviceSession?.id || deviceSession.status==='captured') return;
    const timer=setInterval(()=>api<Row>(`/api/visitors/device-scan-sessions/${deviceSession.id}`).then((session)=>{
      setDeviceSession(session);if(session.status==='captured'&&session.captured_credential)previewCode(String(session.captured_credential),'device');
    }).catch(()=>undefined),2000);
    return ()=>clearInterval(timer);
  },[deviceSession?.id,deviceSession?.status,previewCode]);

  const staff=user.role==='security'||user.role==='admin'||user.role==='manager';
  const canIssue=user.role === 'resident' || user.role === 'admin' || user.role === 'manager';
  const canSync=user.role === 'admin' || user.role === 'manager';
  return <PagePanel title="Visitors" subtitle="QR/barcode passes, preview-before-entry decisions and auditable arrivals" action={(canSync||canIssue)?<div className="row-actions">{canSync&&<button className="secondary" onClick={syncActivePasses}>Sync active passes</button>}{canSync&&<button className="secondary" onClick={releaseDeviceAccounts}>Release expired accounts</button>}{canIssue&&<button className="primary" onClick={() => setShow(!show)}>New pass</button>}</div>:null}>
    {result && <Notice tone={result.includes('created')||result.includes('Accepted')||result.includes('Synced')?'success':result.includes('Waiting')?'info':'error'}>{result}</Notice>}
    <Notice tone="info"><strong>Recommended:</strong> use the QR code for phones and QR-capable readers, Code 128 as a second scanner format, and the written unique number or six-digit PIN on terminals such as DS-K1T808MFWX-B. DS-K2802 needs a compatible Wiegand reader.</Notice>
    {show && <FormCard title="Create visitor pass" onSubmit={create}>
      <label>Visitor name<input name="visitorName" required /></label>
      <label>Phone<input name="visitorPhone" /></label>
      {(user.role==='admin'||user.role==='manager')&&<label>Resident ID<input name="residentId" required /></label>}
      {user.role === 'resident' ? <label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)}</option>)}</select></label> : <label>Property ID<input name="propertyId" required /></label>}
      {(user.role==='admin'||user.role==='manager')&&<label>Preferred gate device<select name="deviceId"><option value="">Every gate, entry and exit</option>{devices.data?.items.map((device)=><option key={String(device.id)} value={String(device.id)}>{String(device.name)} — {String(device.model||device.vendor)} {device.supportsQr?'(QR)':'(PIN/card)'}</option>)}</select></label>}
      <label>Valid from<input name="validFrom" type="datetime-local" defaultValue={localDateTime(defaultStart)} required /></label>
      <label>Valid until<input name="validUntil" type="datetime-local" defaultValue={localDateTime(defaultEnd)} required /></label>
      <label className="span-2">Gate ID / Invitation verification
        <select name="requireGateIdVerification" defaultValue="0">
          <option value="0">Optional — security can verify credentials without mandatory gate upload</option>
          <option value="1">Mandatory — visitor physical ID or invitation must be verified and gate photo uploaded before granting access</option>
        </select>
      </label>
      <ProofFilesField label="Visitor identity or invitation proof (uploaded by resident)" />
      <button className="primary">Issue secure pass</button>
    </FormCard>}
    {staff&&<section className="scan-grid"><form className="form-card" onSubmit={manualPreview}><h3>Phone or manual scan</h3><label>QR, barcode, unique number or PIN<input name="code" required /></label><div className="row-actions"><button className="primary">Preview details</button><button type="button" className="secondary" onClick={()=>setCamera(!camera)}>Use phone camera</button></div>{camera&&<CameraCodeScanner onCode={(code)=>previewCode(code,'phone_camera')} onClose={()=>setCamera(false)} />}</form><form className="form-card" onSubmit={startDeviceScan}><h3>Scan at an access-control device</h3><label>Device<select name="deviceId" required><option value="">Select device</option>{devices.data?.items.map((device)=><option key={String(device.id)} value={String(device.id)}>{String(device.name)} — {String(device.gate_name)}</option>)}</select></label><button className="primary">Start device scan</button><small>The next credential event from this device is captured for review. No entry is accepted automatically.</small></form></section>}
    {preview&&<section className={`visitor-preview ${preview.valid?'valid':'invalid'}`}><p className="eyebrow">VISITOR PASS PREVIEW — NO ENTRY ACCEPTED YET</p><h3>{String(preview.visitor_name)}</h3><dl><div><dt>Host</dt><dd>{String(preview.resident_name)}</dd></div><div><dt>Property</dt><dd>{String(preview.unit_number)} — {String(preview.street)}</dd></div><div><dt>Phone</dt><dd>{String(preview.visitor_phone??'—')}</dd></div><div><dt>Valid</dt><dd>{readableDate(preview.valid_from)} to {readableDate(preview.valid_until)}</dd></div><div><dt>Gates</dt><dd>{String(preview.gate_scope ?? 'both')==='gate'?String(preview.device_name ?? 'Selected device'):'Every gate, entry and exit'}</dd></div><div><dt>Gate verification</dt><dd>{Number(preview.require_gate_id_verification) === 1 ? '⚠️ Mandatory ID/invitation verification required' : 'Optional'}</dd></div><div><dt>Status</dt><dd>{String(preview.status)}</dd></div></dl>{Boolean((preview.proofs as Row[])?.length)&&<div className="span-2"><p className="eyebrow">RESIDENT UPLOADED VISITOR ID / INVITATION PROOF</p>{(preview.proofs as Row[]).map((p)=><a key={String(p.storage_key)} className="evidence-link" href={`/api/files/${encodeURIComponent(String(p.storage_key))}`} target="_blank" rel="noreferrer">🖼️ Host-uploaded {String(p.original_name)} ({Math.ceil(Number(p.size_bytes)/1024)} KB)</a>)}</div>}{!preview.valid&&<Notice tone="error">{String(preview.invalid_reason||'This pass is not valid.')}</Notice>}{Boolean(preview.valid)&&<label className="span-2"><span>Upload gate verification photo {Number(preview.require_gate_id_verification) === 1 ? '(REQUIRED before entry)' : '(optional)'}</span><input id="gateVerificationFile" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" /><small>Capture the visitor physical ID card, driver license, or physical invitation presented at the gate.</small></label>}<div className="row-actions">{Boolean(preview.valid)&&<><button className="primary" onClick={()=>decide('accepted','in')}>Accept check-in</button>{preview.status==='checked_in'&&<button className="secondary" onClick={()=>decide('accepted','out')}>Accept check-out</button>}</>}<button className="secondary" onClick={()=>decide('rejected')}>Reject</button></div></section>}
    {canSync&&deviceAccounts.data&&(
      <div className="stat-grid">
        <article className="stat-card"><p>Slots held on terminals</p><strong>{Number(deviceAccounts.data.summary.active_slots ?? 0)}</strong></article>
        <article className="stat-card"><p>Awaiting release</p><strong>{Number(deviceAccounts.data.summary.awaiting_release ?? 0)}</strong></article>
        <article className="stat-card"><p>Removal in flight</p><strong>{Number(deviceAccounts.data.summary.removal_queued ?? 0)}</strong></article>
        <article className="stat-card"><p>Operator removals left</p><strong>{Number(deviceAccounts.data.summary.manual_removals ?? 0)}</strong></article>
        <article className="stat-card"><p>Fully released</p><strong>{Number(deviceAccounts.data.summary.released ?? 0)}</strong></article>
      </div>
    )}
    <ListState list={list}><DataTable exportTitle="Visitor Passes" rows={(list.data?.items ?? []).map((row)=>({ ...row,gates:String(row.gate_scope ?? 'both')==='gate'?'Selected gate only':'Every gate, entry and exit' }))} columns={[['visitor_name','Visitor'],['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['credential_number','Unique number'],...(staff?[['gates','Gates'],['device_name','Preferred device'],['device_account_state','Device account']] as Column[]:[]),['status','Status'],['valid_until','Valid until','date']]} action={(row)=><div className="row-actions"><button className="text" onClick={()=>setSelectedPass(row)}>View pass</button><EvidenceButton entityType="visitor_request" entityId={row.id} count={row.proof_count} /></div>} /></ListState>
    {selectedPass&&<VisitorPass pass={selectedPass} onClose={()=>setSelectedPass(null)} branding={{ portalName:portal.data?.portal_name||'EstateMate',shortName:portal.data?.portal_short_name||'EM' }} />}
  </PagePanel>;
}

function Maintenance({ user }: { user: User }) {
  const list = useList('/api/maintenance?limit=50');
  const properties = useList('/api/properties?limit=100');
  const [show, setShow] = useState(false);
  const [scopeType, setScopeType] = useState<'personal'|'street'|'block'|'zone'|'estate'>('personal');
  const [statusModalRow, setStatusModalRow] = useState<Row|null>(null);
  const [chargeModalRow, setChargeModalRow] = useState<Row|null>(null);
  const [message, setMessage] = useState('');

  const operator = user.role === 'admin' || user.role === 'manager';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const form = new FormData(event.currentTarget);
    const description = String(form.get('description'));
    const residentId = form.get('residentId') ? String(form.get('residentId')) : undefined;
    const propertyId = form.get('propertyId') ? String(form.get('propertyId')) : undefined;
    const scopeTarget = form.get('scopeTarget') ? String(form.get('scopeTarget')) : undefined;
    try {
      const proofKeys = await uploadProofFiles(event.currentTarget, 'maintenance-proofs');
      await api('/api/maintenance', {
        method: 'POST',
        body: JSON.stringify({ description, residentId, propertyId, scopeType, scopeTarget, proofKeys })
      });
      setShow(false);
      setMessage('Maintenance request submitted successfully.');
      list.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Submission failed');
    }
  }

  async function submitStatusUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!statusModalRow) return;
    const form = new FormData(event.currentTarget);
    const status = String(form.get('status'));
    const statusNote = form.get('statusNote') ? String(form.get('statusNote')) : undefined;
    try {
      const proofKeys = await uploadProofFiles(event.currentTarget, 'maintenance-status-proofs');
      await api(`/api/maintenance/${statusModalRow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, statusNote, proofKeys })
      });
      setStatusModalRow(null);
      setMessage(`Maintenance status updated to ${status}.`);
      list.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Status update failed');
    }
  }

  async function submitCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!chargeModalRow) return;
    const form = new FormData(event.currentTarget);
    const target = String(form.get('target'));
    const amount = Number(form.get('amount'));
    const dueDate = String(form.get('dueDate'));
    const description = form.get('description') ? String(form.get('description')) : undefined;
    try {
      const res = await api<{ billsCreated: number; amountMinor: number }>(`/api/maintenance/${chargeModalRow.id}/charge`, {
        method: 'POST',
        body: JSON.stringify({ target, amountMinor: Math.round(amount * 100), dueDate, description })
      });
      setChargeModalRow(null);
      setMessage(`${res.billsCreated} bill(s) created for this maintenance charge.`);
      list.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Charge failed');
    }
  }

  return <PagePanel title="Maintenance" subtitle="Requests, scope, proof verification and work status" action={<button className="primary" onClick={() => setShow(!show)}>New request</button>}>
    {message && <Notice tone={message.includes('failed') || message.includes('Could not') ? 'error' : 'success'}>{message}</Notice>}
    {show && <FormCard title="Report a maintenance issue" onSubmit={submit}>
      <label>Maintenance scope
        <select value={scopeType} onChange={(e) => setScopeType(e.target.value as any)}>
          <option value="personal">Personal / Residence</option>
          <option value="street">Street</option>
          <option value="block">Block</option>
          <option value="zone">Zone</option>
          <option value="estate">Entire Estate</option>
        </select>
      </label>
      {scopeType !== 'personal' && scopeType !== 'estate' && (
        <label>{scopeType[0].toUpperCase() + scopeType.slice(1)} name / label
          <input name="scopeTarget" placeholder={`e.g. ${scopeType === 'street' ? 'Palm Avenue' : scopeType === 'block' ? 'Block C' : 'Zone 2'}`} required />
        </label>
      )}
      {(user.role === 'admin' || user.role === 'manager') && <label>Resident ID<input name="residentId" required /></label>}
      {user.role === 'resident' ? (
        scopeType === 'personal' && (
          <label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)}</option>)}</select></label>
        )
      ) : (
        <label>Property ID (optional)<input name="propertyId" /></label>
      )}
      <label className="span-2">Description<textarea name="description" rows={4} required placeholder="Describe the maintenance required (e.g. plumbing leak, faulty streetlight, generator repair)..." /></label>
      <ProofFilesField label="Photos, quotation or issue proof (recommended)" />
      <button className="primary">Submit request</button>
    </FormCard>}

    {statusModalRow && (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <section className="notice-modal">
          <p className="eyebrow">UPDATE STATUS</p>
          <h2>Maintenance #{String(statusModalRow.id).slice(0, 8)}</h2>
          <p>Current: <strong>{String(statusModalRow.status)}</strong></p>
          <form className="form-card" onSubmit={submitStatusUpdate}>
            <label>New status
              <select name="status" defaultValue={String(statusModalRow.status)}>
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="needs_verification">Need to verify</option>
                <option value="completed">Completed</option>
                <option value="rejected">Reject</option>
              </select>
            </label>
            <label className="span-2">Status notes / reason
              <textarea name="statusNote" rows={2} placeholder="Add notes for resident and inspection team..." defaultValue={String(statusModalRow.status_note ?? '')} />
            </label>
            <ProofFilesField label="Inspection or completion photos (uploaded as proof)" />
            <div className="row-actions span-2">
              <button className="primary">Update status</button>
              <button type="button" className="secondary" onClick={() => setStatusModalRow(null)}>Cancel</button>
            </div>
          </form>
        </section>
      </div>
    )}

    {chargeModalRow && (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <section className="notice-modal">
          <p className="eyebrow">CHARGE FOR MAINTENANCE / FACILITY DUTY</p>
          <h2>Apply charge #{String(chargeModalRow.id).slice(0, 8)}</h2>
          <p>Issue: {String(chargeModalRow.description)}</p>
          <form className="form-card" onSubmit={submitCharge}>
            <label>Charge target / audience
              <select name="target" defaultValue={chargeModalRow.scope_type === 'street' ? 'street' : chargeModalRow.scope_type === 'block' ? 'block' : chargeModalRow.scope_type === 'zone' ? 'zone' : chargeModalRow.scope_type === 'estate' ? 'all' : 'residence'}>
                <option value="residence">Residence / Property of request</option>
                <option value="tenant">Active tenant</option>
                <option value="owner">Property owner</option>
                <option value="street">All properties on this street</option>
                <option value="block">All properties in this block</option>
                <option value="zone">All properties in this zone</option>
                <option value="all">All estate properties</option>
              </select>
            </label>
            <label>Amount (NGN)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Due date<input name="dueDate" type="date" required /></label>
            <label>Bill description<input name="description" defaultValue={`Maintenance fee: ${String(chargeModalRow.description).slice(0, 50)}`} /></label>
            <div className="row-actions span-2">
              <button className="primary">Generate bill(s)</button>
              <button type="button" className="secondary" onClick={() => setChargeModalRow(null)}>Cancel</button>
            </div>
          </form>
        </section>
      </div>
    )}

    <ListState list={list}>
      <DataTable
        exportTitle="Maintenance Requests"
        rows={(list.data?.items ?? []).map((row) => ({
          ...row,
          scope_label: `${String(row.scope_type || 'personal')}${row.scope_target ? `: ${row.scope_target}` : ''}`
        }))}
        columns={[
          ['resident_name', 'Resident'],
          ['unit_number', 'Unit'],
          ['scope_label', 'Scope'],
          ['description', 'Description'],
          ['status', 'Status'],
          ['charge_amount_minor', 'Charged', 'money'],
          ['created_at', 'Reported', 'date']
        ]}
        action={(row) => (
          <div className="row-actions">
            <EvidenceButton entityType="maintenance_request" entityId={row.id} count={row.proof_count} />
            {operator && (
              <>
                <button type="button" className="text" onClick={() => setStatusModalRow(row)}>Update</button>
                <button type="button" className="text" onClick={() => setChargeModalRow(row)}>Charge</button>
              </>
            )}
          </div>
        )}
      />
    </ListState>
  </PagePanel>;
}

function EstateNotices({ user }: { user: User }) {
  const operator=user.role==='admin'||user.role==='manager';
  const list = useList(`/api/notices?limit=50${operator?'&scope=all':''}`);
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const form = new FormData(event.currentTarget);
    const from = String(form.get('publishedFrom') ?? ''); const until = String(form.get('publishedUntil') ?? '');
    const body = {
      title: form.get('title'), body: form.get('body'), severity: form.get('severity'),
      requiresAcknowledgement: form.get('requiresAcknowledgement') === 'on',
      publishedFrom: from ? new Date(from).toISOString() : undefined,
      publishedUntil: until ? new Date(until).toISOString() : undefined,
    };
    try { await api('/api/notices', { method: 'POST', body: JSON.stringify(body) }); setShow(false); setMessage('Estate notice published. It will appear as a popup for every user.'); list.reload(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not publish notice'); }
  }
  async function acknowledge(id: unknown) { await api(`/api/notices/${id}/acknowledge`, { method: 'POST' }); list.reload(); }
  async function deactivate(id: unknown) { await api(`/api/notices/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'inactive' }) }); list.reload(); }
  return <PagePanel title="General estate notices" subtitle="Official notices shown to every user as an in-app popup" action={operator ? <button className="primary" onClick={() => setShow(!show)}>Publish notice</button> : null}>
    {message && <Notice tone={message.includes('published') ? 'success' : 'error'}>{message}</Notice>}
    {show && <FormCard title="New general estate notice" onSubmit={submit}>
      <label>Title<input name="title" required /></label>
      <label>Priority<select name="severity"><option value="info">Information</option><option value="important">Important</option><option value="urgent">Urgent</option></select></label>
      <label className="check"><input name="requiresAcknowledgement" type="checkbox" defaultChecked /> Require users to confirm reading</label>
      <label className="span-2">Notice<textarea name="body" rows={5} required /></label>
      <label>Show from<input name="publishedFrom" type="datetime-local" /></label>
      <label>Stop showing<input name="publishedUntil" type="datetime-local" /></label>
      <button className="primary">Publish estate notice</button>
    </FormCard>}
    <div className="post-grid">{list.data?.items.map((notice) => <article className={`post estate-notice ${String(notice.severity)}`} key={String(notice.id)}><span className={`pill ${String(notice.severity)}`}>{String(notice.severity)}</span><h3>{String(notice.title)}</h3><p>{String(notice.body)}</p><small>{String(notice.author_name)} · {readableDate(notice.created_at)} · {String(notice.status)}</small><div className="row-actions">{!notice.acknowledged && <button className="text" onClick={() => acknowledge(notice.id)}>Mark as read</button>}{operator && notice.status === 'active' && <button className="text danger" onClick={() => deactivate(notice.id)}>Deactivate</button>}</div></article>)}</div>
  </PagePanel>;
}

interface CardRecipient { kind: 'resident' | 'household_member'; id: string; name: string; detail: string; meta: string | null }
interface PickedPerson { kind: CardRecipient['kind']; id: string; name: string; detail: string }

/**
 * Searchable picker for the person a card is issued to.
 *
 * Replaces the old pair of raw "Main resident ID" / "Household member ID" text
 * boxes: pasting an id was error-prone at the gate desk and failed silently when
 * the id belonged to an inactive account. Search matches name, unit, email and
 * phone across active residents and active household members at once.
 */
function PersonPicker({ picked, onPick }: { picked: PickedPerson | null; onPick: (next: PickedPerson | null) => void }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const results = useAsync<{ items: CardRecipient[] }>(
    () => api(`/api/access/card-recipients?limit=25&search=${encodeURIComponent(debounced)}`),
    [debounced],
  );

  if (picked) return <div className="person-picked">
    <span className="avatar">{initials(picked.name)}</span>
    <div><strong>{picked.name}</strong><small>{picked.kind === 'resident' ? 'Main resident' : 'Household member (dependant)'} · {picked.detail}</small></div>
    <button type="button" className="icon-button" title="Choose someone else" onClick={() => { onPick(null); setSearch(''); setOpen(true); }}>×</button>
  </div>;

  return <div className="person-picker">
    <label>Card holder
      <input
        type="search"
        value={search}
        placeholder="Search existing residents and household members by name, unit, email or phone"
        onChange={(event) => { setSearch(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        autoComplete="off"
      />
      <small>Only active main residents and active household members can hold a card.</small>
    </label>
    {open && <div className="person-results">
      {results.loading && <Loading />}
      {results.error && <Notice tone="error">{results.error}</Notice>}
      {!results.loading && !results.error && !(results.data?.items ?? []).length && (
        <p className="person-empty">No active resident or household member matches{debounced ? ` “${debounced}”` : ' yet'}. Register them under People or Tenancy &amp; household first.</p>
      )}
      {(results.data?.items ?? []).map((item) => <button type="button" key={`${item.kind}:${item.id}`} className="person-result" onClick={() => { onPick({ kind: item.kind, id: item.id, name: item.name, detail: item.detail }); setOpen(false); }}>
        <span className="avatar">{initials(item.name)}</span>
        <span className="person-identity"><strong>{item.name}</strong><small>{item.detail}{item.meta ? ` · ${item.meta}` : ''}</small></span>
        <em>{item.kind === 'resident' ? 'Resident' : 'Dependant'}</em>
      </button>)}
    </div>}
  </div>;
}

/**
 * One person's access credentials: cards and fingerprints, in one place.
 *
 * Admin/Manager only — a credential is access, not profile data. Used from the
 * People table (main residents) and from Tenancy & household (dependants), so a
 * person's profile gives the same controls as the Access cards & fingerprints page
 * without hunting for them in a separate screen.
 */
function PersonCredentials({ residentId, householdMemberId, personName, devices, onChanged }: {
  residentId?: string;
  householdMemberId?: string;
  personName: string;
  devices: Row[];
  onChanged?: () => void;
}) {
  const query = residentId ? `residentId=${encodeURIComponent(residentId)}` : `householdMemberId=${encodeURIComponent(String(householdMemberId))}`;
  const list = useList(`/api/access/credentials?limit=50&${query}`);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [captureId, setCaptureId] = useState('');

  async function addCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/access/cards', { method: 'POST', body: JSON.stringify({
        ...(residentId ? { residentId } : { householdMemberId }),
        cardUid: String(form.get('cardUid') ?? ''),
        cardLabel: String(form.get('cardLabel') ?? '').trim() || undefined,
      }) });
      setMessage(`Card added to ${personName}. Hardware synchronization is queued for every linked terminal.`);
      event.currentTarget.reset(); list.reload(); onChanged?.();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not add the card'); }
    finally { setBusy(false); }
  }

  async function addFingerprint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    const form = new FormData(event.currentTarget);
    const deviceId = String(form.get('deviceId') ?? '').trim();
    const shared = {
      fingerNo: Number(form.get('fingerNo')),
      fingerLabel: String(form.get('fingerLabel') ?? '').trim() || undefined,
      employeeNo: String(form.get('employeeNo') ?? '').trim() || undefined,
      deviceId: deviceId || undefined,
    };
    try {
      if (deviceId) {
        // A terminal is chosen: arm its reader and read the finger for real.
        const started = await api<{ captureId:string; instruction:string }>('/api/access/fingerprints/capture', { method: 'POST', body: JSON.stringify({
          ...(residentId ? { residentId, personId: residentId, personKind: 'account' } : { householdMemberId, personId: householdMemberId, personKind: 'dependant' }),
          ...shared,
        }) });
        setCaptureId(String(started.captureId));
        setMessage(started.instruction);
        event.currentTarget.reset();
        return;
      }
      const result = await api<{ queuedActions:number }>('/api/access/fingerprints', { method: 'POST', body: JSON.stringify({
        ...(residentId ? { residentId } : { householdMemberId }),
        ...shared,
      }) });
      setMessage(`Fingerprint recorded for ${personName}. ${result.queuedActions} terminal task(s) queued — enroll the finger on the terminal, then mark each action applied under Hardware actions.`);
      event.currentTarget.reset(); list.reload(); onChanged?.();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not add the fingerprint'); }
    finally { setBusy(false); }
  }

  async function change(type: unknown, id: unknown, status: string) {
    const label = String(type) === 'fingerprint' ? 'fingerprint' : 'card';
    if (!confirm(`Set this ${label} to ${status}?`)) return;
    const path = String(type) === 'fingerprint' ? `/api/access/fingerprints/${id}` : `/api/access/cards/${id}`;
    try {
      await api(path, { method: 'PATCH', body: JSON.stringify({ status, reason: 'Portal administrator action' }) });
      setMessage(`${label[0]!.toUpperCase()}${label.slice(1)} set to ${status}. A terminal task is queued where one is needed.`);
      list.reload(); onChanged?.();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Status change failed'); }
  }

  const rows = list.data?.items ?? [];
  return <section className="panel person-credentials">
    <div className="panel-title"><div><p className="eyebrow">ACCESS</p><h3>{personName} — cards &amp; fingerprints</h3></div><button className="secondary sm" onClick={() => list.reload()}>Refresh</button></div>
    {message && <Notice tone={/Could not|failed/i.test(message) ? 'error' : 'success'}>{message}</Notice>}
    <p className="presence-hint">A card is written to a terminal by a linked agent. For a fingerprint, EstateMate arms the reader on the terminal you choose: the person presses a finger, and the template is written to every other terminal automatically. Choose <em>Not recorded yet</em> to record the slot only and enrol it on the terminal by hand.</p>
    {captureId && <FingerprintCapture captureId={captureId} onFinished={(status, value) => {
      setMessage(status === 'captured'
        ? `Fingerprint read from ${personName} and sent to the other terminals.`
        : String(value.error ?? 'The fingerprint could not be read — the manual enrolment task is in Hardware actions.'));
      if (status === 'captured') { list.reload(); onChanged?.(); }
    }} onCancel={() => setCaptureId('')} />}
    <ListState list={list}><DataTable rows={rows} columns={[['credential_type','Type'],['credential_reference','Card / finger'],['credential_label','Label'],['finger_no','Slot'],['employee_no','Employee no'],['enrolled_device_name','Enrolled at'],['status','Status'],['pending_operations','Open tasks'],['updated_at','Updated','date']]} action={(row) => <div className="row-actions">{String(row.status) === 'active'
      ? <button className="text danger" onClick={() => change(row.credential_type, row.id, 'suspended')}>Suspend</button>
      : <button className="text" onClick={() => change(row.credential_type, row.id, 'active')}>Activate</button>}</div>} /></ListState>
    <div className="credential-forms">
      <FormCard title={`Add an access card for ${personName}`} onSubmit={addCard}>
        <label>Card UID / number<input name="cardUid" required inputMode="numeric" pattern="[0-9]+" title="Enter digits only; leading zeroes are preserved." placeholder="Printed card number" /><small>Digits only. Leading zeroes are preserved.</small></label>
        <label>Label<input name="cardLabel" placeholder="Main card" /></label>
        <button className="primary" disabled={busy}>Add card</button>
      </FormCard>
      <FormCard title={`Add a fingerprint for ${personName}`} onSubmit={addFingerprint}>
        <label>Finger slot<select name="fingerNo" defaultValue="1">{[1,2,3,4,5,6,7,8,9,10].map((value) => <option key={value} value={value}>Finger {value}</option>)}</select><small>The slot the terminal stores this finger under (1–10).</small></label>
        <label>Which finger<input name="fingerLabel" placeholder="Right index" /></label>
        <label>Employee number<input name="employeeNo" maxLength={30} pattern="[A-Za-z0-9]{1,30}" title="Letters and numbers only; maximum 30 characters." placeholder={residentId ? 'Defaults to the EstateMate person ID' : 'Required for this dependant'} /><small>Letters and numbers only, up to 30 characters. The terminal uses this to attribute fingerprint events.</small></label>
        <label>Capture at<select name="deviceId"><option value="">Not recorded yet — enrol on the terminal myself</option>{devices.map((device) => <option key={String(device.id)} value={String(device.id)}>{String(device.name)} — {String(device.gate_name)}</option>)}</select><small>Choose a terminal to arm its reader now and read the finger; the template then goes to the other terminals.</small></label>
        <button className="primary" disabled={busy}>{busy ? 'Working…' : 'Read the fingerprint'}</button>
      </FormCard>
    </div>
  </section>;
}

function Cards({ user }: { user: User }) {
  const operator=user.role==='admin'||user.role==='manager';
  const list = useList('/api/access/credentials?limit=50');
  const devices=useAsync<{ items:Row[] }>(()=>operator?api('/api/access/device-options'):Promise.resolve({ items:[] }),[user.role]);
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState('');
  const [credentialKind,setCredentialKind]=useState<'card'|'fingerprint'>('card');
  const [mode,setMode]=useState<'device'|'manual'>('device');
  const [scanSession,setScanSession]=useState<Row|null>(null);
  const [captureId,setCaptureId]=useState('');
  const [fingerMode,setFingerMode]=useState<'capture'|'manual'>('capture');
  const [picked,setPicked]=useState<PickedPerson|null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!picked) { setMessage('Choose the resident or household member this card belongs to.'); return; }
    const form=new FormData(event.currentTarget);
    // One person per card: the picker decides which id the API receives.
    const person = picked.kind === 'resident' ? { residentId: picked.id } : { householdMemberId: picked.id };
    try {
      if(mode==='device') {
        const session=await api<Row>('/api/access/card-scan-sessions',{ method:'POST',body:JSON.stringify({ deviceId:form.get('deviceId'),...person,cardLabel:String(form.get('cardLabel') ?? '').trim() || undefined }) });
        setScanSession(session);setMessage(`Waiting for ${picked.name} to tap or scan a card at the selected access-control device.`);
      } else {
        await api('/api/access/cards', { method: 'POST', body: JSON.stringify({ ...person, cardUid:String(form.get('cardUid') ?? ''), cardLabel:String(form.get('cardLabel') ?? '').trim() || undefined }) });
        setShow(false);setPicked(null);setMessage(`Card issued to ${picked.name} and hardware actions queued.`);list.reload();
      }
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Failed'); }
  }
  useEffect(()=>{
    if(!scanSession?.id||scanSession.status==='captured') return;
    const timer=setInterval(()=>api<Row>(`/api/access/card-scan-sessions/${scanSession.id}`).then(setScanSession).catch(()=>undefined),2000);
    return()=>clearInterval(timer);
  },[scanSession?.id,scanSession?.status]);
  async function completeScan() {
    if(!scanSession?.id)return;
    try { const card=await api<Row>(`/api/access/card-scan-sessions/${scanSession.id}/complete`,{ method:'POST' });setMessage(`Card ${String(card.cardUid)} issued and synchronized to the hardware-action queue.`);setScanSession(null);setShow(false);setPicked(null);list.reload(); }
    catch(reason){setMessage(reason instanceof Error?reason.message:'Could not issue scanned card');}
  }
  async function cancelScan(){if(scanSession?.id)await api(`/api/access/card-scan-sessions/${scanSession.id}`,{ method:'DELETE' });setScanSession(null);setMessage('Card scan cancelled.');}
  async function removeFingerprint(row: Row) {
    if (!confirm('Delete this fingerprint credential? The status history is preserved and a removal task is queued for the terminal.')) return;
    try { await api(`/api/access/fingerprints/${row.id}`, { method: 'DELETE' }); setMessage('Fingerprint revoked and a terminal removal task queued.'); list.reload(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not delete the fingerprint'); }
  }
  async function submitFingerprint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!picked) { setMessage('Choose the person this fingerprint belongs to.'); return; }
    const form = new FormData(event.currentTarget);
    const person = picked.kind === 'resident' ? { residentId: picked.id } : { householdMemberId: picked.id };
    const deviceId = String(form.get('deviceId') ?? '').trim();
    try {
      if (fingerMode === 'capture') {
        if (!deviceId) { setMessage('Choose the terminal whose reader will take the fingerprint.'); return; }
        const started = await api<Row>('/api/access/fingerprints/capture', { method: 'POST', body: JSON.stringify({
          ...person,
          personKind: picked.kind === 'resident' ? 'account' : 'dependant',
          personId: picked.id,
          fingerNo: Number(form.get('fingerNo')),
          fingerLabel: String(form.get('fingerLabel') ?? '').trim() || undefined,
          deviceId,
        }) });
        setShow(false); setPicked(null);
        setCaptureId(String(started.captureId));
        setMessage(String(started.instruction ?? 'The terminal reader is armed.'));
        return;
      }
      const result = await api<Row>('/api/access/fingerprints', { method: 'POST', body: JSON.stringify({
        ...person,
        fingerNo: Number(form.get('fingerNo')),
        fingerLabel: String(form.get('fingerLabel') ?? '').trim() || undefined,
        employeeNo: String(form.get('employeeNo') ?? '').trim() || undefined,
        deviceId: deviceId || undefined,
      }) });
      setShow(false); setPicked(null);
      setMessage(String(result.instruction ?? `Fingerprint recorded for ${picked.name}.`) + ' Mark it applied under Hardware actions once the finger is enrolled.');
      list.reload();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not record the fingerprint'); }
  }
  async function change(row: Row, status: string) {
    const fingerprint = String(row.credential_type) === 'fingerprint';
    if (!confirm(`Set this ${fingerprint ? 'fingerprint' : 'card'} to ${status}?`)) return;
    const path = fingerprint ? `/api/access/fingerprints/${row.id}` : `/api/access/cards/${row.id}`;
    await api(path, { method: 'PATCH', body: JSON.stringify({ status, reason: 'Portal administrator action' }) }); list.reload();
  }
  const actions = operator ? (row: Row) => <div className="row-actions">{row.status === 'active' ? <button className="text danger" onClick={() => change(row, 'suspended')}>Suspend</button> : <button className="text" onClick={() => change(row, 'active')}>Activate</button>}{String(row.credential_type) === 'fingerprint' && <button className="text danger" onClick={() => removeFingerprint(row)}>Delete</button>}</div> : undefined;
  return <PagePanel title="Access cards & fingerprints" subtitle="Cards are written to a terminal by an agent; fingerprints are captured on the terminal and confirmed here" action={operator ? <button className="primary" onClick={() => { setShow(!show); setPicked(null); setMessage(''); }}>Issue card or fingerprint</button> : null}>
    {message && <Notice tone={message.includes('issued')?'success':message.includes('Waiting')?'info':'error'}>{message}</Notice>}
    {show && <FormCard title="Issue a card or record a fingerprint" onSubmit={credentialKind==='card'?submit:submitFingerprint}><label>Credential type<select value={credentialKind} onChange={(event)=>setCredentialKind(event.target.value as 'card'|'fingerprint')}><option value="card">Access card</option><option value="fingerprint">Fingerprint</option></select></label>{credentialKind==='card'?<><label>Enrollment method<select value={mode} onChange={(event)=>setMode(event.target.value as 'device'|'manual')}><option value="device">Tap/scan at selected device (recommended)</option><option value="manual">Enter card UID manually</option></select></label>{mode==='device'&&<label>Access-control device<select name="deviceId" required><option value="">Select device</option>{devices.data?.items.map((device)=><option key={String(device.id)} value={String(device.id)}>{String(device.name)} — {String(device.model||device.vendor)} — {String(device.gate_name)}</option>)}</select></label>}<PersonPicker picked={picked} onPick={setPicked} />{mode==='manual'&&<label>Card UID / number<input name="cardUid" required inputMode="numeric" pattern="[0-9]+" title="Enter digits only; leading zeroes are preserved." /><small>Digits only. Leading zeroes are preserved.</small></label>}<label>Label<input name="cardLabel" placeholder="Optional card label" /></label><button className="primary">{mode==='device'?'Start scan':'Issue card'}</button></>:<><p className="form-note">EstateMate arms the reader on the terminal you choose: the person presses a finger on the glass, the terminal hands back the template, and it is written to every other terminal automatically. Nothing is typed on the terminal, and the template is kept only until every gate has it. If the terminal’s firmware cannot do it, EstateMate says so and queues the manual enrolment instead.</p><PersonPicker picked={picked} onPick={setPicked} /><label>Enrollment<select value={fingerMode} onChange={(event)=>setFingerMode(event.target.value as 'capture'|'manual')}><option value="capture">Scan the finger at a selected terminal (recommended)</option><option value="manual">Record the slot only — enrol on the terminal myself</option></select></label><label>Finger slot<select name="fingerNo" defaultValue="1">{[1,2,3,4,5,6,7,8,9,10].map((value)=><option key={value} value={value}>Finger {value}</option>)}</select></label><label>Which finger<input name="fingerLabel" placeholder="Right index" /></label>{fingerMode==='manual'&&<label>Employee number<input name="employeeNo" placeholder="Defaults to the EstateMate person ID" /><small>Required when the person chosen is a dependant.</small></label>}<label>Capture at<select name="deviceId" required={fingerMode==='capture'}><option value="">{fingerMode==='capture'?'Select the terminal the person is standing at':'Not recorded yet'}</option>{devices.data?.items.map((device)=><option key={String(device.id)} value={String(device.id)}>{String(device.name)} — {String(device.gate_name)}</option>)}</select><small>{fingerMode==='capture'?'The reader of this terminal is armed for the next three minutes.':''}</small></label><button className="primary">{fingerMode==='capture'?'Scan fingerprint':'Record fingerprint'}</button></>}</FormCard>}
    {scanSession&&<section className={`enrollment-session ${String(scanSession.status)}`}><p className="eyebrow">DEVICE CARD ENROLLMENT</p><h3>{scanSession.status==='captured'?'Card detected':'Waiting for a card…'}</h3>{Boolean(scanSession.captured_credential)&&<strong className="credential-number">{String(scanSession.captured_credential)}</strong>}<p>Present the card at the selected device. EstateMate captures the next card credential event, including a denied unknown-card event.</p><div className="row-actions">{scanSession.status==='captured'&&<button className="primary" onClick={completeScan}>Confirm and issue card</button>}<button className="secondary" onClick={cancelScan}>Cancel</button></div></section>}
    {captureId && <FingerprintCapture captureId={captureId} onFinished={(status, value) => {
      setMessage(status === 'captured'
        ? `Fingerprint read from ${String(value.personName ?? 'the person')} and sent to the other terminals.`
        : String(value.error ?? 'The fingerprint could not be read — record the slot and enrol it on the terminal instead.'));
      if (status === 'captured') list.reload();
    }} onCancel={() => setCaptureId('')} />}
    <ListState list={list}><DataTable exportTitle="Access Credentials" rows={list.data?.items ?? []} columns={[['credential_type','Type'],['resident_name','Main resident'],['household_member_name','Holder'],['unit_number','Unit'],['credential_reference','Card / finger'],['finger_no','Slot'],['credential_label','Label'],['enrolled_device_name','Enrolled at'],['employee_no','Employee no'],['status','Status'],['deactivated_reason','Reason'],['pending_operations','Open tasks'],['updated_at','Updated','date']]} action={actions} /></ListState>
  </PagePanel>;
}

function AccessEvents({ user }: { user: User }) {
  const list = useList('/api/access/events?limit=50');
  const [live, setLive] = useState<Row[]>([]);
  const [connection, setConnection] = useState<'connecting'|'live'|'offline'>('connecting');
  useEffect(() => {
    if (user.role === 'resident') return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/access/events/stream`);
    socket.onopen = () => setConnection('live');
    socket.onclose = () => setConnection('offline');
    socket.onerror = () => setConnection('offline');
    socket.onmessage = (event) => {
      try { const message = JSON.parse(event.data) as { type: string; events?: Row[] }; if (message.type === 'access_events') setLive((current) => [...(message.events ?? []), ...current].slice(0, 20)); } catch { /* ignore heartbeat */ }
    };
    return () => socket.close();
  }, [user.role]);
  return <PagePanel title="Gate activity" subtitle="Granted and denied access across every configured point" action={user.role !== 'resident' ? <span className={`connection ${connection}`}><span className="pulse-dot" /> {connection}</span> : null}>
    {live.length > 0 && <section className="live-strip"><p className="eyebrow">JUST RECEIVED</p>{live.map((event, index) => <div className="live-event" key={`${String(event.vendorEventId)}-${index}`}><span className={`result-dot ${event.result}`} /><strong>{String(event.personName ?? event.cardUid ?? 'Unknown credential')}</strong><span>{String(event.result)}</span><small>{readableDate(event.deviceTimestamp)}</small></div>)}</section>}
    <ListState list={list}><DataTable exportTitle="Gate Events" rows={list.data?.items ?? []} columns={[['result','Result'],['visitor_name','Visitor'],['household_member_name','Household member'],['person_name','Device person'],['resident_name','Main resident'],['employee_no','Employee no.'],['credential_type','Method'],['card_uid','Card'],['device_name','Device'],['access_point_name','Access point'],['door_no','Door'],['direction','Direction'],['device_timestamp','Time','date']]} /></ListState>
  </PagePanel>;
}

/**
 * Remote Network Verification, per terminal.
 *
 * The toggle is Administrator-only because it changes what happens when a person
 * stands at the gate; everyone else sees the status only. The status is whatever
 * the bridge itself reported on its last heartbeat - how many credentials it is
 * holding, how stale they are, and whether the door answered the last command -
 * because none of that is knowable from the database.
 */
function RemoteVerification({ rows, canEdit, reload }: { rows: Row[]; canEdit: boolean; reload: () => void }) {
  const [notice, setNotice] = useState('');
  const [tone, setTone] = useState<'info' | 'error'>('info');
  const [saving, setSaving] = useState('');
  async function save(id: string, body: { enabled?: boolean; doorNo?: number; cooldownMs?: number }) {
    setNotice(''); setSaving(String(id));
    try {
      const result = await api<{ warnings?: string[] }>(`/api/access/devices/${id}/remote-verify`, { method: 'PATCH', body: JSON.stringify(body) });
      // The API answers with what enabling this actually commits an estate to.
      // Showing it here is the difference between an informed switch-on and a
      // support call next week about a door that did not open.
      setTone('info');
      setNotice((result.warnings ?? []).join(' '));
      reload();
    } catch (reason) {
      setTone('error');
      setNotice(reason instanceof Error ? reason.message : 'Could not save the remote verification setting');
    } finally { setSaving(''); }
  }
  return <section className="form-card">
    <h3>Remote Network Verification</h3>
    <p className="presence-hint">Turn a terminal into a reader: it reports the credential it saw and <strong>EstateMate Bridge</strong> decides against its local copy of the estate, then answers with the door command. For estates with more people than the terminal can store.</p>
    {notice && <Notice tone={tone}>{notice}</Notice>}
    <table className="data-table compact">
      <thead><tr><th>Terminal</th><th>Mode</th><th>Door</th><th>Cooldown (ms)</th><th>Bridge status</th></tr></thead>
      <tbody>
        {rows.map((row) => {
          const id = String(row.id ?? '');
          const enabled = Number(row.remote_verify_enabled ?? 0) === 1;
          const state = (() => { try { return JSON.parse(String(row.remote_verify_state ?? '')) as Row; } catch { return null; } })();
          const cache = (state?.cache ?? {}) as Row;
          const age = typeof cache.cacheAgeSeconds === 'number' ? Number(cache.cacheAgeSeconds) : null;
          let status = 'No bridge has reported yet';
          let statusTone = 'muted';
          if (enabled && state) {
            if (state.lastResult === 'refused') { status = 'Door refused the last command — check Gate activity'; statusTone = 'error'; }
            else if (cache.lastSyncError) { status = `Snapshot not refreshing: ${String(cache.lastSyncError)}`; statusTone = 'error'; }
            else if (age !== null && age > 900) { status = `Snapshot ${Math.round(age / 60)} min old`; statusTone = 'warn'; }
            else {
              const count = typeof cache.credentialCount === 'number' ? Number(cache.credentialCount) : null;
              status = `${count ?? 'no'} credential(s), synced ${age === null ? 'recently' : `${age}s ago`}`;
              statusTone = 'ok';
            }
          } else if (enabled) {
            status = 'On, waiting for the bridge to report';
          }
          return <tr key={id}>
            <td>{String(row.name ?? '')}<br /><small>{String(row.gate_name ?? '')}</small></td>
            <td>
              <label className="switch">
                <input type="checkbox" checked={enabled} disabled={!canEdit || saving === id}
                  onChange={(event) => { void save(id, { enabled: event.currentTarget.checked }); }} />
                <span>{enabled ? 'Reader — bridge decides' : 'Terminal decides'}</span>
              </label>
            </td>
            <td><input className="narrow" type="number" min={1} max={8} defaultValue={Number(row.remote_verify_door_no ?? 1)} disabled={!canEdit || !enabled || saving === id}
              onBlur={(event) => { const value = Number(event.currentTarget.value); if (value !== Number(row.remote_verify_door_no ?? 1)) void save(id, { doorNo: value }); }} /></td>
            <td><input className="narrow" type="number" min={0} max={60000} step={100} defaultValue={Number(row.remote_verify_cooldown_ms ?? 1500)} disabled={!canEdit || !enabled || saving === id}
              onBlur={(event) => { const value = Number(event.currentTarget.value); if (value !== Number(row.remote_verify_cooldown_ms ?? 1500)) void save(id, { cooldownMs: value }); }} /></td>
            <td><span className={`chip ${statusTone}`}>{status}</span>{state?.lastDecision ? <small><br />Last: {String(state.lastDecision)}{state.lastReason ? ` (${String(state.lastReason)})` : ''}</small> : null}</td>
          </tr>;
        })}
      </tbody>
    </table>
    {!canEdit && <p className="presence-hint">Only an Administrator can switch a terminal into reader mode.</p>}
  </section>;
}

/**
 * Terminal clocks, per terminal.
 *
 * A terminal enforces everything time-sensitive with its own clock — a
 * visitor's finite pass window is checked against the terminal's hardware,
 * and gate events carry its timestamp. The bridge's time-sync check reports
 * what each terminal thinks the time is and how far it is from the bridge
 * host; when the offset passes the threshold the bridge sets the clock back.
 * Display-only here: the switch lives in the bridge host's agent-config.json
 * (`timeSync`), because the reference clock is the machine the bridge runs
 * on, not anything the portal can set.
 */
function TerminalClock({ rows }: { rows: Row[] }) {
  const parseClock = (row: Row): Row | null => {
    try { const value = JSON.parse(String(row.device_clock ?? '')) as Row; return value && value.terminalTime ? value : null; } catch { return null; }
  };
  const formatDrift = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };
  const withClock = rows.flatMap((row) => { const clock = parseClock(row); return clock ? [{ row, clock }] : []; });
  if (!withClock.length) return null;
  return <section className="form-card">
    <h3>Terminal clocks</h3>
    <p className="presence-hint">Each terminal enforces visitor pass windows and timestamps gate events with its <strong>own clock</strong>. The bridge reports what each terminal thinks the time is and how far it is from the bridge host; when the offset passes the threshold it sets the clock back. The switch is in the bridge host's <code>agent-config.json</code> (<code>timeSync</code>).</p>
    <table className="data-table compact">
      <thead><tr><th>Terminal</th><th>Terminal time</th><th>Drift</th><th>Last check</th><th>Last sync</th></tr></thead>
      <tbody>
        {withClock.map(({ row, clock }) => {
          const id = String(row.id ?? '');
          const drift = typeof clock.driftMs === 'number' ? Number(clock.driftMs) : 0;
          const absDriftSeconds = Math.round(Math.abs(drift) / 1000);
          let tone = 'ok';
          if (clock.lastError) tone = 'error';
          else if (absDriftSeconds > 300) tone = 'error';
          else if (absDriftSeconds > 30) tone = 'warn';
          const driftLabel = clock.lastError ? 'Unreachable'
            : absDriftSeconds < 2 ? 'In sync'
            : `${drift > 0 ? 'Ahead by' : 'Behind by'} ${formatDrift(absDriftSeconds)}`;
          return <tr key={id}>
            <td>{String(row.name ?? '')}<br /><small>{String(row.gate_name ?? '')}</small></td>
            <td>{clock.terminalTime ? readableDate(clock.terminalTime) : '—'}</td>
            <td><span className={`chip ${tone}`}>{driftLabel}</span>{clock.lastError ? <small><br />{String(clock.lastError)}</small> : null}</td>
            <td>{clock.lastCheckedAt ? readableDate(clock.lastCheckedAt) : '—'}</td>
            <td>{clock.lastSyncAt ? `${readableDate(clock.lastSyncAt)} (${Number(clock.syncs ?? 0)}×)` : 'Never'}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </section>;
}

function Devices({ user }: { user: User }) {
  const operator=user.role==='admin'||user.role==='manager';
  const list = useList('/api/access/devices');
  const profiles = useAsync<{ items: Row[] }>(() => api('/api/access/profiles'), []);
  const [show, setShow] = useState(false);
  const [credentials, setCredentials] = useState<Row | null>(null);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { const result = await api<Row>('/api/access/devices', { method: 'POST', body: JSON.stringify(values) }); setCredentials(result); setShow(false); list.reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Failed'); }
  }
  async function edit(row:Row) {
    const name=prompt('Display name',String(row.name??''));if(!name)return;
    const vendor=prompt('Vendor',String(row.vendor??'Hikvision'))??String(row.vendor??'Hikvision');
    const gateName=prompt('Gate name',String(row.gate_name??''));if(!gateName)return;
    const model=prompt('Model',String(row.model??''))??String(row.model??'');
    const firmware=prompt('Firmware',String(row.firmware??''))??String(row.firmware??'');
    const serialNumber=prompt('Serial number',String(row.serial_number??''))??String(row.serial_number??'');
    try { await api(`/api/access/devices/${row.id}`,{ method:'PATCH',body:JSON.stringify({ name,vendor,gateName,model,firmware,serialNumber,direction:row.direction,profileKey:row.profile_key,connectionPattern:row.connection_pattern,status:row.status }) });list.reload(); }
    catch(reason){setError(reason instanceof Error?reason.message:'Device update failed');}
  }
  async function remove(row:Row) { if(!confirm(`Delete ${String(row.name)}? Credentials will be revoked while historical gate events remain.`))return;try{await api(`/api/access/devices/${row.id}`,{ method:'DELETE' });list.reload();setError('');}catch(reason){setError(reason instanceof Error?reason.message:'Delete failed');} }
  return <PagePanel title="Access-control devices" subtitle="Hikvision MinMoe, card/fingerprint terminals, DS-K2800 controllers and validated third-party devices" action={operator?<button className="primary" onClick={() => setShow(!show)}>Register device</button>:null}>
    <Notice tone="info"><strong>How devices connect:</strong> the EstateMate device agent runs on the gate network, sends live events to the portal and applies access updates. Register the terminal here, then connect it under <strong>Device agent</strong>. Keep terminal ports private to the estate network.</Notice>
    {error && <Notice tone="error">{error}</Notice>}
    {credentials && <section className="credential-box"><h3>Device registered</h3><p>Profile: <code>{String((credentials.profile as Row | undefined)?.label ?? '')}</code></p><p>Connection: <code>{String(credentials.connectionPattern??'')}</code></p><p>{String(credentials.warning??'')}</p></section>}
    {show && <FormCard title="Register an access-control terminal" onSubmit={submit}>
      <label>Display name<input name="name" placeholder="Gate 1 terminal" required /></label><label>Vendor<input name="vendor" defaultValue="Hikvision" /></label>
      <label>Gate name<input name="gateName" placeholder="Main gate" required /></label>
      <label>Direction<select name="direction"><option value="entry">Entry</option><option value="exit">Exit</option><option value="both">Both</option></select></label>
      <label>Model<input name="model" list="access-models" placeholder="DS-K1T808MFWX-B or DS-K2802" /><datalist id="access-models"><option value="DS-K1T808MFWX-B" /><option value="DS-K2802" /><option value="DS-K2602T" /><option value="DS-K1T807EBWX-QRE1" /><option value="DS-K1T502DBWX-QRE1" /><option value="DS-K1T341CMFW" /><option value="DS-K1T671M" /><option value="DS-K1T680DFG" /></datalist></label>
      <label>Firmware<input name="firmware" placeholder="Full version and build" /></label><label>Serial number<input name="serialNumber" /></label>
      <label>Series profile<select name="profileKey"><option value="auto">Auto-detect from model (recommended)</option>{profiles.data?.items.map((profile) => <option key={String(profile.key)} value={String(profile.key)}>{String(profile.label)}</option>)}</select></label>
      <label>Connection pattern<select name="connectionPattern"><option value="">Use profile recommendation (recommended)</option><option value="isapi_bridge">ISAPI bridge agent (cross-platform)</option><option value="windows_agent">Windows agent (ISAPI)</option><option value="isapi_windows_agent">ISAPI Windows agent (combined)</option><option value="manual_sync">Manual synchronization (no agent)</option></select></label>
      <button className="primary">Register</button>
    </FormCard>}
    {Boolean(list.data?.items?.length) && <RemoteVerification rows={list.data?.items ?? []} canEdit={user.role === 'admin'} reload={list.reload} />}
    {Boolean(list.data?.items?.length) && <TerminalClock rows={list.data?.items ?? []} />}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['name','Device'],['id','EstateMate device ID','id'],['vendor','Vendor'],['model','Model'],['profile_key','Series profile'],['connection_pattern','Connection'],['isapi_agent_name','ISAPI agent'],['isapi_host','ISAPI host'],['last_isapi_sync_status','ISAPI sync'],['gate_name','Gate'],['direction','Direction'],['status','Status'],['last_seen_at','Last seen','date'],['pending_operations','Manual pending'],['queued_operations','Queued ops']]} action={operator?(row)=><div className="row-actions"><button className="text" onClick={()=>edit(row)}>Edit</button><button className="text danger" onClick={()=>remove(row)}>Delete</button></div>:undefined} /></ListState>
  </PagePanel>;
}

function IsapiBridge({ user }: { user: User }) {
  const operator = user.role === 'admin' || user.role === 'manager';
  const administrator = user.role === 'admin';
  const agents = useList('/api/isapi/agents');
  const deviceConfigs = useList('/api/isapi/device-configs');
  const devices = useAsync<{ items: Row[] }>(() => api('/api/access/device-options'), []);
  const logs = useList('/api/isapi/sync-logs?limit=50');
  const [showAgent, setShowAgent] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [credentials, setCredentials] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [copyNotice, copy] = useCopy();

  async function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string,string>;
    try {
      const result = await api<Row>('/api/isapi/agents', { method: 'POST', body: JSON.stringify(values) });
      setCredentials(result); setShowAgent(false); agents.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Failed to create agent'); }
  }

  async function rotateAgent(row: Row) {
    if (!confirm(`Rotate the secret for ${String(row.name)}? Its current bridge will disconnect until it is set up again.`)) return;
    // The rotate response carries only the new secret; keep the row's name and
    // ID so the panel that follows can still show which agent was rotated.
    try { setCredentials({ ...row, ...(await api<Row>(`/api/isapi/agents/${row.id}/rotate-secret`, { method: 'POST' })) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Rotate failed'); }
  }

  async function downloadInstaller(row: Row) {
    if (!confirm(`Create a new setup file for ${String(row.name)}? Its current secret will stop working, so use the new file on the bridge.`)) return;
    setError('');
    try {
      const response = await fetch(`/api/isapi/agents/${row.id}/installer`, { method: 'POST', credentials: 'include' });
      if (!response.ok) { const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` })) as { error?: string }; throw new Error(data.error || `Request failed (${response.status})`); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const ext = String(row.platform) === 'windows' ? 'ps1' : 'sh';
      link.download = `estatemate-isapi-agent-${String(row.id).slice(0,8)}.${ext}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not generate installer'); }
  }

  async function removeAgent(row: Row) {
    if (!confirm(`Delete agent ${String(row.name)}? Linked devices will be unlinked.`)) return;
    try { await api(`/api/isapi/agents/${row.id}`, { method: 'DELETE' }); agents.reload(); deviceConfigs.reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Delete failed'); }
  }

  async function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string,string>;
    const body = {
      deviceId: values.deviceId,
      agentId: values.agentId || null,
      isapiHost: values.isapiHost,
      isapiPort: values.isapiPort ? Number(values.isapiPort) : 80,
      isapiUsername: values.isapiUsername || 'admin',
      isapiPassword: values.isapiPassword || undefined,
      protocol: values.protocol || 'http',
      syncEnabled: values.syncEnabled === 'on',
    };
    try {
      await api('/api/isapi/device-configs', { method: 'POST', body: JSON.stringify(body) });
      setShowLink(false); deviceConfigs.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Link failed'); }
  }

  async function removeLink(row: Row) {
    if (!confirm(`Remove ISAPI config for ${String(row.device_name)}?`)) return;
    try { await api(`/api/isapi/device-configs/${row.id}`, { method: 'DELETE' }); deviceConfigs.reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Delete failed'); }
  }

  return <PagePanel
    title="Device agent"
    subtitle="Connect local gate terminals for live events and automatic access updates"
    action={operator ? <div className="row-actions page-actions">
      {administrator && <button className="primary" onClick={() => setShowAgent(!showAgent)} aria-expanded={showAgent}>{showAgent ? 'Close form' : 'Add agent'}</button>}
      <button className="secondary" onClick={() => setShowLink(!showLink)} aria-expanded={showLink}>{showLink ? 'Close form' : 'Connect terminal'}</button>
    </div> : null}
  >
    <div className="agent-summary">
      <p><strong>Local connection only.</strong> Run one bridge on a Windows or Linux computer, or an Android device, that stays on the same network as the gate terminals. No inbound Internet access or port forwarding is required.</p>
      <p className="presence-hint"><strong>How status is decided:</strong> an agent is online while it heartbeats (offline after 3 minutes of silence). A terminal goes <strong>online</strong> as soon as its bridge holds the terminal's event stream open, or forwards an event — whichever happens first — and reads offline after 10 minutes without either, or immediately when the bridge reports the stream as down. A newly registered terminal shows <strong>pending</strong> until its bridge proves it is reachable. Stopping or deleting a bridge retires its terminals at once.</p>
      <details className="agent-setup">
        <summary>Setup instructions</summary>
        <ol>
          <li>Add an agent and connect each terminal to it here using the terminal's LAN address and login.</li>
          <li><a href="https://github.com/barikblog/estatemate-minmoe/releases/latest" target="_blank" rel="noreferrer">Get the latest bridge</a>: use the single-file Windows app, or the Android bridge APK for a dedicated phone or tablet.</li>
          <li>Choose <strong>Download setup</strong> on the agent row. Import that file during Windows setup (<code>setup --from-installer</code>), or paste it into the Android bridge. Add each terminal's LAN login when prompted; its EstateMate ID is resolved automatically.</li>
          <li>Run <strong>Check</strong> or <strong>Test connection</strong>, start the bridge and confirm the agent status below changes to <strong>online</strong>.</li>
          <li>Configuring a bridge by hand instead? <em>Copy ID</em> on the agent and terminal rows supplies the two IDs a bridge config needs — the agent ID and each terminal's EstateMate device ID.</li>
        </ol>
      </details>
    </div>

    {error && <Notice tone="error">{error}</Notice>}
    {copyNotice && <Notice tone="success">{copyNotice}</Notice>}
    {credentials && <section className="credential-box">
      <p className="eyebrow">COPY NOW — SHOWN ONCE</p>
      <h3>Agent credentials</h3>
      <p>Agent: <code>{String(credentials.name ?? '—')}</code></p>
      {Boolean(credentials.id) && <p>Agent ID: <code>{String(credentials.id)}</code> <button className="secondary sm" onClick={() => copy(credentials.id, 'Agent ID')}>Copy ID</button></p>}
      {Boolean(credentials.secret) && <p>Secret: <code>{String(credentials.secret)}</code> <button className="secondary sm" onClick={() => copy(credentials.secret, 'Agent secret')}>Copy secret</button></p>}
      {Boolean(credentials.id) && Boolean(credentials.secret) && <p><button className="secondary sm" onClick={() => copy(`agentId=${String(credentials.id)}\nagentSecret=${String(credentials.secret)}`, 'Agent ID and secret')}>Copy both</button></p>}
      <p>{String(credentials.warning ?? '')}</p>
      <p>Use these only for manual configuration. For Windows or Android, <strong>Download setup</strong> from the agent row instead — that file already carries the agent ID, the secret and the Worker URL.</p>
    </section>}

    {showAgent && administrator && <FormCard title="Add device agent" onSubmit={submitAgent}>
      <label>Agent name<input name="name" placeholder="Estate office PC" required /></label>
      <label>Computer name (optional)<input name="hostname" placeholder="OFFICE-PC" /></label>
      <label>Runs on<select name="platform"><option value="windows">Windows</option><option value="linux">Linux</option><option value="darwin">macOS</option><option value="other">Android or other</option></select></label>
      <button className="primary">Add agent</button>
    </FormCard>}

    {showLink && <FormCard title="Connect a gate terminal" onSubmit={submitLink}>
      <label>Terminal<select name="deviceId" required><option value="">Select terminal</option>{devices.data?.items.map((device) => <option key={String(device.id)} value={String(device.id)}>{String(device.gate_name)} — {String(device.name)} ({String(device.model)})</option>)}</select></label>
      <label>Agent<select name="agentId" required><option value="">Select agent</option>{agents.data?.items.map((agent) => <option key={String(agent.id)} value={String(agent.id)}>{String(agent.name)} — {String(agent.platform)} ({String(agent.status)})</option>)}</select></label>
      <label>Terminal LAN address<input name="isapiHost" placeholder="192.168.1.100" required /></label>
      <label>Port<input name="isapiPort" type="number" min={1} max={65535} defaultValue={80} /></label>
      <label>Terminal username<input name="isapiUsername" defaultValue="admin" /></label>
      <label>Terminal password<input name="isapiPassword" type="password" placeholder="Device administrator password" required /><small>Encrypted at rest and never displayed again.</small></label>
      <label>Connection<select name="protocol"><option value="http">HTTP on the private LAN</option><option value="https">HTTPS</option></select></label>
      <label className="check"><input name="syncEnabled" type="checkbox" defaultChecked /> Enable automatic updates</label>
      <button className="primary">Connect terminal</button>
    </FormCard>}

    <section className="panel agent-section">
      <div className="panel-title"><div><p className="eyebrow">Bridge hosts</p><h3>Agents</h3></div><button className="secondary sm" onClick={() => agents.reload()}>Refresh</button></div>
      <ListState list={agents}><DataTable rows={agents.data?.items ?? []} columns={[['name','Agent'],['id','Agent ID','id'],['hostname','Computer'],['platform','Runs on'],['status','Status'],['last_seen_at','Last heartbeat','date'],['linked_devices','Terminals'],['pending_operations','Pending actions']]} action={administrator ? (row) => <div className="row-actions"><button className="text" onClick={() => copy(row.id, 'Agent ID')}>Copy ID</button><button className="text" onClick={() => downloadInstaller(row)}>Download setup</button><button className="text" onClick={() => rotateAgent(row)}>Rotate secret</button><button className="text danger" onClick={() => removeAgent(row)}>Delete</button></div> : undefined} /></ListState>
    </section>

    <section className="panel agent-section">
      <div className="panel-title"><div><p className="eyebrow">Gate network</p><h3>Connected terminals</h3></div><button className="secondary sm" onClick={() => deviceConfigs.reload()}>Refresh</button></div>
      <ListState list={deviceConfigs}><DataTable rows={deviceConfigs.data?.items ?? []} columns={[['device_name','Terminal'],['device_id','EstateMate device ID','id'],['gate_name','Gate'],['device_status','Terminal status'],['isapi_host','LAN address'],['isapi_port','Port'],['agent_name','Agent'],['agent_status','Agent status'],['last_sync_at','Last update','date'],['last_sync_status','Update status'],['last_error','Last error']]} action={operator ? (row) => <div className="row-actions"><button className="text" onClick={() => copy(row.device_id, 'EstateMate device ID')}>Copy ID</button><button className="text danger" onClick={() => removeLink(row)}>Disconnect</button></div> : undefined} /></ListState>
    </section>

    <section className="panel agent-section">
      <div className="panel-title"><div><p className="eyebrow">Recent activity</p><h3>Agent updates</h3></div><button className="secondary sm" onClick={() => logs.reload()}>Refresh</button></div>
      <ListState list={logs}><DataTable rows={logs.data?.items ?? []} columns={[['created_at','Time','date'],['device_name','Terminal'],['agent_name','Agent'],['operation_type','Action'],['status','Status'],['message','Message']]} /></ListState>
    </section>
  </PagePanel>;
}

type RemoteTab = 'terminals' | 'doors' | 'access' | 'visitors' | 'commands' | 'posts';
type RemoteSnapshot = {
  note?: string;
  isupSupported?: boolean;
  commandsUseTunnel?: boolean;
  summary?: Record<string, number>;
  terminals?: Row[];
  agents?: Row[];
  doorCommands?: Array<{ operation: string; label: string }>;
  recentDoorCommands?: Row[];
};

function RemoteAccess({ onNavigate }: { onNavigate?: (section: Section) => void }) {
  const remote = useAsync(() => api<RemoteSnapshot>('/api/access/remote'), []);
  const operations = useList('/api/access/operations?limit=100');
  const visitors = useList('/api/visitors?limit=30');
  const events = useList('/api/access/events?limit=8');
  const [tab, setTab] = useState<RemoteTab>('terminals');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [person, setPerson] = useState<PickedPerson | null>(null);
  const snapshot = remote.data;
  const summary = snapshot?.summary ?? {};
  const terminals = snapshot?.terminals ?? [];
  const doorCommands = snapshot?.doorCommands ?? [];

  function refresh() {
    remote.reload();
    operations.reload();
    visitors.reload();
    events.reload();
  }

  async function run(action: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); setMessage(ok); refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Command failed'); }
    finally { setBusy(false); }
  }

  async function sendDoor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const command = (event.nativeEvent as Event & { submitter?: HTMLButtonElement }).submitter?.value || values.command;
    const label = doorCommands.find((item) => item.operation === command)?.label ?? command;
    const terminal = terminals.find((item) => item.id === values.deviceId);
    if (command === 'remote_always_open' || command === 'remote_always_close') {
      if (!confirm(`${label} on ${String(terminal?.name ?? 'this terminal')} until someone resumes the schedule?`)) return;
    }
    await run(() => api('/api/access/remote/door', { method: 'POST', body: JSON.stringify({ deviceId: values.deviceId, doorNo: Number(values.doorNo || 1), command, reason: values.reason }) }), `${label} queued for the estate agent.`);
  }

  async function changeAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const action = (event.nativeEvent as Event & { submitter?: HTMLButtonElement }).submitter?.value || 'suspend';
    if (!person) { setError('Choose the person whose access should change'); return; }
    if (action === 'suspend' && !confirm('Suspend this person\'s cards and fingerprints on every linked terminal?')) return;
    await run(() => api('/api/access/remote/access', {
      method: 'POST',
      body: JSON.stringify({
        residentId: person.kind === 'resident' ? person.id : undefined,
        householdMemberId: person.kind === 'household_member' ? person.id : undefined,
        action,
        reason: values.reason,
        includeHousehold: form.querySelector<HTMLInputElement>('[name=includeHousehold]')?.checked ?? false,
      }),
    }), action === 'suspend' ? 'Access suspended and queued for the terminals.' : 'Suspended access restored and queued for the terminals.');
  }

  async function revokeVisitor(row: Row) {
    const reason = prompt(`Revoke the pass for ${String(row.visitor_name)}? This stops the pass in the portal and asks the agent to remove it from the terminals.`, 'Revoked by administrator');
    if (!reason || reason.trim().length < 3) return;
    await run(() => api(`/api/access/remote/visitors/${row.id}/revoke`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }), `Pass for ${String(row.visitor_name)} revoked.`);
  }

  async function retry(id: unknown) {
    await run(() => api(`/api/access/remote/operations/${id}/retry`, { method: 'POST' }), 'Command queued again.');
  }

  async function mark(id: unknown, status: 'applied' | 'failed') {
    await run(() => api(`/api/access/operations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), status === 'applied' ? 'Marked applied.' : 'Marked failed.');
  }

  const tabs: Array<[RemoteTab, string]> = [['terminals', 'Terminals'], ['doors', 'Doors'], ['access', 'Cards & fingerprints'], ['visitors', 'Visitor passes'], ['commands', 'Command queue'], ['posts', 'Gate posts']];
  return <PagePanel title="Access control remote" subtitle="Control gates, cards, fingerprints and visitor passes from anywhere the agent can reach the terminals" action={<button className="secondary" onClick={refresh}>Refresh</button>}>
    <Notice tone="info">{snapshot?.note ?? 'Commands travel through the estate agent on the LAN. A free Cloudflare Tunnel cannot carry ISUP, and this page never publishes a terminal or sends a command through a tunnel.'}</Notice>
    {error && <Notice tone="warning">{error}</Notice>}
    {message && <Notice tone="success">{message}</Notice>}
    {remote.error && <Notice tone="warning">{remote.error}</Notice>}
    <div className="stat-grid">
      <article className="stat-card"><p>Terminals online</p><strong>{summary.online ?? 0}/{summary.terminals ?? 0}</strong><small>Agent delivery only</small></article>
      <article className="stat-card"><p>Agents online</p><strong>{summary.agentsOnline ?? 0}</strong><small>LAN bridge hosts</small></article>
      <article className="stat-card"><p>Waiting commands</p><strong>{summary.pendingCommands ?? 0}</strong><small>Pending or in flight</small></article>
      <article className="stat-card"><p>Failed commands</p><strong>{summary.failedCommands ?? 0}</strong><small>Retry from the queue</small></article>
      <article className="stat-card"><p>ISUP / tunnel</p><strong>{snapshot?.isupSupported || snapshot?.commandsUseTunnel ? 'On' : 'Off'}</strong><small>Not used for commands</small></article>
    </div>
    <div className="remote-tabs" role="tablist">
      {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {tab === 'terminals' && <>
      {remote.loading ? <Loading /> : <DataTable rows={terminals} columns={[['name','Terminal'],['gate_name','Gate'],['direction','Direction'],['status','Status'],['connection_pattern','Connection'],['agent_name','Agent'],['last_seen_at','Last seen','date'],['open_commands','Open']]} />}
      <div className="split-grid" style={{ marginTop: 16 }}>
        <section className="panel">
          <h3>Recent gate activity</h3>
          <ListState list={events}><DataTable rows={events.data?.items ?? []} columns={[['resident_name','Resident'],['visitor_name','Visitor'],['device_name','Terminal'],['event_type','Event'],['direction','Direction'],['result','Result'],['device_timestamp','Time','date']]} /></ListState>
        </section>
        <section className="panel">
          <h3>What this page can and cannot do</h3>
          <p>Momentary open, close, remain open, remain closed and resume schedule are queued for the estate agent. Card enable, disable and revoke, visitor sync and visitor revoke follow the same path. Fingerprints can be suspended here, but a new fingerprint still has to be captured on the terminal.</p>
          <p>Automatic door control is best-effort until that terminal's firmware is recorded in device profiles. A rejection stays in the command queue for someone on site. ISUP over a free tunnel is not available, and these commands are not sent through the Cloudflare Tunnel.</p>
          <div className="row-actions">
            <button className="text" type="button" onClick={() => onNavigate?.('isapi')}>Device agent</button>
            <button className="text" type="button" onClick={() => onNavigate?.('devices')}>Terminals</button>
            <button className="text" type="button" onClick={() => onNavigate?.('events')}>Gate activity</button>
          </div>
        </section>
      </div>
    </>}
    {tab === 'doors' && <form className="form-card" onSubmit={sendDoor}>
      <h3>Send a door command</h3>
      <p>The agent applies this over ISAPI on the estate LAN. It is not a public remote and not ISUP. Automatic door control is best-effort until the terminal firmware is recorded in device profiles.</p>
      <div className="form-grid">
        <label>Terminal
          <select name="deviceId" required defaultValue="">
            <option value="" disabled>Choose a terminal</option>
            {terminals.map((device) => <option key={String(device.id)} value={String(device.id)}>{String(device.gate_name)} — {String(device.name)} ({String(device.status)})</option>)}
          </select>
        </label>
        <label>Door number<input name="doorNo" type="number" min={1} max={8} defaultValue={1} required /></label>
        <label className="span-2">Reason<input name="reason" required minLength={3} maxLength={200} placeholder="Why this door is being controlled" /></label>
        <div className="row-actions span-2">
          {doorCommands.map((command) => <button key={command.operation} className={command.operation === 'remote_always_close' ? 'secondary' : 'primary'} name="command" value={command.operation} disabled={busy}>{command.label}</button>)}
        </div>
      </div>
      <DataTable rows={snapshot?.recentDoorCommands ?? []} columns={[['created_at','When','date'],['device_name','Terminal'],['gate_name','Gate'],['operation','Command'],['doorNo','Door'],['reason','Reason'],['status','Status'],['error_message','Error']]} />
    </form>}
    {tab === 'access' && <>
      <form className="form-card" onSubmit={changeAccess}>
        <h3>Suspend or restore a person</h3>
        <p>Every matching card is enabled or disabled on linked terminals. Fingerprints are queued as a terminal task because the agent cannot write a finger template.</p>
        <div className="form-grid">
          <div className="span-2"><PersonPicker picked={person} onPick={setPerson} /></div>
          <label className="span-2">Reason<input name="reason" required minLength={3} maxLength={200} placeholder="Why access is changing" /></label>
          <label className="check"><input name="includeHousehold" type="checkbox" defaultChecked /> Include dependants when a resident is selected</label>
          <div className="row-actions span-2">
            <button className="secondary" name="action" value="suspend" disabled={busy}>Suspend all access</button>
            <button className="primary" name="action" value="restore" disabled={busy}>Restore suspended access</button>
          </div>
        </div>
      </form>
      <p>To issue a new card or capture a fingerprint, use <button className="text" type="button" onClick={() => onNavigate?.('cards')}>Access cards & fingerprints</button>. A new finger still has to be captured on the terminal.</p>
    </>}
    {tab === 'visitors' && <>
      <div className="row-actions" style={{ marginBottom: 12 }}>
        <button className="primary" disabled={busy} onClick={() => run(() => api('/api/visitors/sync-active', { method: 'POST' }), 'Active passes queued for every linked terminal.')}>Sync active passes</button>
        <button className="text" type="button" onClick={() => onNavigate?.('visitors')}>Open Visitors</button>
      </div>
      <ListState list={visitors}><DataTable rows={(visitors.data?.items ?? []).filter((row) => ['active','checked_in','pending'].includes(String(row.status)))} columns={[['visitor_name','Visitor'],['resident_name','Host'],['unit_number','Unit'],['status','Status'],['valid_until','Until','date'],['device_name','Terminal']]} action={(row) => <button className="text danger" onClick={() => revokeVisitor(row)}>Revoke</button>} /></ListState>
    </>}
    {tab === 'commands' && <ListState list={operations}><DataTable rows={operations.data?.items ?? []} columns={[['device_name','Terminal'],['credential_kind','Kind'],['operation','Action'],['credential_reference','Reference'],['holder_name','Who / why'],['status','Status'],['error_message','Error'],['created_at','Created','date']]} action={(row) => <div className="row-actions">{row.status === 'failed' && <button className="text" onClick={() => retry(row.id)}>Retry</button>}<button className="text" onClick={() => mark(row.id, 'applied')}>Mark applied</button><button className="text danger" onClick={() => mark(row.id, 'failed')}>Failed</button></div>} /></ListState>}
    {tab === 'posts' && <SecurityGateAssignments />}
  </PagePanel>;
}

/**
 * The person × terminal grid, and the two actions an estate actually needs.
 *
 * A terminal only lets somebody through when the *person* exists on it with door
 * rights — a card recorded for an employee number no terminal has seen as a
 * person is stored and does not open anything. That is why "synchronise" writes
 * the person first and the credentials after, why it is automatic whenever a
 * credential is issued or a name changes, and why this page exists at all: it is
 * the only place that can honestly say which terminal is still missing whom.
 */
function PersonSync() {
  const [copyNotice, copy] = useCopy();
  const overview = useAsync<{
    devices: Array<Row>; people: Array<Row>; totals: { people:number; terminals:number; synced:number; pending:number; manual:number; missing:number };
  }>(() => api('/api/device-sync'), []);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');

  async function syncAll() {
    if (!confirm('Push every person holding a credential (and their cards and fingerprints) to every terminal now? Repeated presses reuse work that is already queued.')) return;
    setBusy('all'); setMessage('');
    try {
      const result = await api<{ people:number;devices:number;queued:number;manual:number;skipped:number;notice:string }>('/api/device-sync/people', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
      setMessage(result.notice ?? `${result.people} person(s) synchronised.`);
      overview.reload();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Synchronisation failed'); }
    finally { setBusy(''); }
  }

  async function syncPerson(person: Row) {
    setBusy(String(person.id)); setMessage('');
    try {
      const result = await api<{ notice:string }>('/api/device-sync/people', { method: 'POST', body: JSON.stringify({ scope: 'people', people: [{ personKind: person.kind, id: person.id }] }) });
      setMessage(result.notice ?? 'Synchronised.'); overview.reload();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Synchronisation failed'); }
    finally { setBusy(''); }
  }

  async function removeFromDevices(person: Row) {
    if (!confirm(`Remove ${String(person.name)} from every terminal, with their cards, fingerprints and door permissions? The portal history stays.`)) return;
    setBusy(String(person.id)); setMessage('');
    try {
      const result = await api<{ notice:string }>('/api/device-sync/remove', { method: 'POST', body: JSON.stringify({ personKind: person.kind, id: person.id }) });
      setMessage(result.notice ?? 'Removal queued.'); overview.reload();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Removal failed'); }
    finally { setBusy(''); }
  }

  const totals = overview.data?.totals;
  const devices = overview.data?.devices ?? [];
  return <PagePanel title="Person sync" subtitle="Keep every person, card and fingerprint in step with every access-control terminal" action={<div className="row-actions"><button className="secondary" onClick={overview.reload}>Refresh</button><button className="primary" onClick={syncAll} disabled={busy === 'all'}>{busy === 'all' ? 'Synchronising…' : 'Synchronise everyone'}</button></div>}>
    {copyNotice && <Notice tone="info">{copyNotice}</Notice>}
    {message && <Notice tone={/failed|error|without an employee/i.test(message) ? 'warning' : 'success'}>{message}</Notice>}
    <Notice tone="info">EstateMate writes the <strong>person record</strong> to a terminal before the card, because a card filed against a person the terminal has never seen is stored but cannot open the door. Edits to a name or Employee ID, and every new card or fingerprint, are pushed automatically. A terminal with no bridge is listed here as a task for an operator instead of a silent failure.</Notice>
    {totals && <div className="stat-row"><div className="stat-card"><span className="eyebrow">PEOPLE</span><strong>{totals.people}</strong></div><div className="stat-card"><span className="eyebrow">TERMINALS</span><strong>{totals.terminals}</strong></div><div className="stat-card"><span className="eyebrow">IN STEP</span><strong>{totals.synced}</strong></div><div className="stat-card"><span className="eyebrow">PENDING</span><strong>{totals.pending}</strong></div><div className="stat-card"><span className="eyebrow">NEEDS AN OPERATOR</span><strong>{totals.manual}</strong></div><div className="stat-card"><span className="eyebrow">NOT YET SENT</span><strong>{totals.missing}</strong></div></div>}
    <h3>Terminals</h3>
    {devices.length === 0 ? <p className="presence-hint">No access-control device is configured yet. Add one under <strong>Terminals &amp; devices</strong> and connect it to a bridge.</p> : <div className="device-sync-grid">{devices.map((device) => <article key={String(device.id)} className="form-card sync-card">
      <strong>{String(device.name)}</strong>
      <small>{String(device.gate_name || '')} · doors {Array.isArray(device.doorNumbers) ? (device.doorNumbers as number[]).join(', ') : '1'}</small>
      {device.hasAgent
        ? <small className="capabilities">Bridge can write: {(Array.isArray(device.agentCapabilities) && (device.agentCapabilities as string[]).length ? (device.agentCapabilities as string[]) : ['card','door']).join(', ')}</small>
        : <small className="capabilities warning">No bridge linked — every change here is a task for an operator.</small>}
      <span className="sync-counts">{String(device.synced)} in step · {String(device.pending)} pending · {String(device.manual)} manual · {String(device.missing)} not sent</span>
    </article>)}</div>}
    <h3>People</h3>
    <ListState list={overview as unknown as ReturnType<typeof useList>}><DataTable rows={overview.data?.people ?? []} columns={[['name','Person'],['employeeNo','Employee no'],['status','Status'],['cards','Cards'],['fingerprints','Fingers']]} action={(row) => <div className="row-actions">
      <button className="text" onClick={() => syncPerson(row)} disabled={busy === String(row.id)}>{busy === String(row.id) ? 'Working…' : 'Sync now'}</button>
      <button className="text danger" onClick={() => removeFromDevices(row)} disabled={busy === String(row.id)}>Remove from devices</button>
    </div>} /></ListState>
    {overview.data?.people?.length === 0 && <p className="presence-hint">Nobody holds a card or fingerprint yet. Issue one under <strong>Cards &amp; fingerprints</strong> and it will be written to every terminal automatically.</p>}
  </PagePanel>;
}

function Operations() {
  const [copyNotice, copy] = useCopy();
  const list = useList('/api/access/operations?limit=100');
  async function mark(id: unknown, status: 'applied'|'failed') { await api(`/api/access/operations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); list.reload(); }
  return <PagePanel title="Hardware actions" subtitle="Changes that must reach each physical terminal">
    <Notice tone="warning">Cards, visitor passes and door commands with a linked agent are written automatically. Fingerprints — and everything with only HTTP Listening — must be applied in the terminal UI or iVMS-4200. Door commands are queued from Access control remote and are never sent through a public tunnel. Then mark them applied here.</Notice>
    {copyNotice && <Notice tone="info">{copyNotice}</Notice>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['device_name','Device'],['credential_kind','Credential'],['operation','Action'],['credential_reference','Card / finger'],['holder_name','Holder'],['manual_instruction','What to do'],['status','Status'],['created_at','Created','date'],['error_message','Error']]} action={(row) => <div className="row-actions">{Boolean(row.manual_instruction) && <button className="text" onClick={() => copy(String(row.manual_instruction), 'Instructions')}>Copy steps</button>}<button className="text" onClick={() => mark(row.id, 'applied')}>Mark applied</button><button className="text danger" onClick={() => mark(row.id, 'failed')}>Failed</button></div>} /></ListState>
  </PagePanel>;
}

/**
 * Administrator control for the estate gate welcome photograph.
 *
 * The image itself is uploaded to the administrator-configured private GitHub
 * repository (D1 stores metadata only); this card saves the resulting storage key
 * plus the caption and on/off flag read by the login screen and dashboard hero.
 */
function GateImageCard({ config, onSaved }: { config: PortalConfig; onSaved: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = config.portal_gate_image_enabled === 'true' && Boolean(config.portal_gate_image_key);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    const form = event.currentTarget;
    const input = form.elements.namedItem('gateImage') as HTMLInputElement | null;
    const file = input?.files?.[0];
    try {
      const body: Record<string, string> = {
        portal_gate_image_caption: String((form.elements.namedItem('portal_gate_image_caption') as HTMLInputElement | null)?.value ?? '').trim(),
        portal_gate_image_enabled: (form.elements.namedItem('portal_gate_image_enabled') as HTMLInputElement | null)?.checked ? 'true' : 'false',
      };
      if (file) {
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Only JPEG, PNG or WebP photographs are accepted');
        const uploaded = await api<{ key: string }>('/api/files', {
          method: 'POST', body: file,
          headers: { 'Content-Type': file.type, 'X-Filename': file.name, 'X-File-Category': 'portal-branding' },
        });
        body.portal_gate_image_key = uploaded.key;
        body.portal_gate_image_enabled = 'true';
      } else if (!config.portal_gate_image_key && body.portal_gate_image_enabled === 'true') {
        throw new Error('Upload a photograph of the estate gate before turning the welcome image on');
      }
      await api('/api/portal-config', { method: 'PUT', body: JSON.stringify(body) });
      setMessage('Estate gate welcome image saved. It shows behind the login welcome text and on the dashboard.');
      form.reset();
      onSaved();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not save the gate image'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm('Remove the estate gate welcome image? The uploaded photograph stays in your private repository.')) return;
    setMessage('');
    try {
      await api('/api/portal-config', { method: 'PUT', body: JSON.stringify({ portal_gate_image_key: '', portal_gate_image_enabled: 'false' }) });
      setMessage('Estate gate welcome image removed.');
      onSaved();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not remove the gate image'); }
  }

  return <>
    {message && <Notice tone={message.includes('saved') || message.includes('removed') ? 'success' : 'error'}>{message}</Notice>}
    <FormCard title="Estate gate welcome image" onSubmit={save}>
    <label className="span-2">Photograph of the estate gate
      <input name="gateImage" type="file" accept="image/jpeg,image/png,image/webp" />
      <small>JPEG, PNG or WebP, maximum 4 MB. Stored in your configured private GitHub repository. Shown behind the welcome text on the login screen and on every dashboard.</small>
    </label>
    <label className="span-2">Caption shown over the image
      <input name="portal_gate_image_caption" defaultValue={config.portal_gate_image_caption ?? ''} placeholder="Welcome to the main gate of the estate" maxLength={200} />
    </label>
    <label className="check span-2"><input name="portal_gate_image_enabled" type="checkbox" defaultChecked={enabled} /> Show the gate image on the login page and dashboards</label>
    {enabled && <div className="gate-image-preview span-2">
      <p className="eyebrow">CURRENT IMAGE</p>
      <img src="/api/portal-gate-image" alt="The configured estate gate welcome photograph" />
    </div>}
    <div className="row-actions span-2">
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save gate image'}</button>
      {Boolean(config.portal_gate_image_key) && <button type="button" className="secondary danger" onClick={remove}>Remove image</button>}
    </div>
    </FormCard>
  </>;
}

/**
 * Posts Security officers at specific gates. Once an officer has at least one
 * assignment, signing in requires them to choose which gate they are working, and
 * that choice scopes their visitor queue, gate activity and device list.
 */
function SecurityGateAssignments() {
  const officers = useAsync<ListResponse<Row>>(() => api('/api/users?role=security&limit=100'), []);
  const devices = useAsync<{ items: Row[] }>(() => api('/api/access/device-options'), []);
  const assignments = useList('/api/security/gate-assignments');
  const [message, setMessage] = useState('');

  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/security/gate-assignments', {
        method: 'POST',
        body: JSON.stringify({ securityUserId: form.get('securityUserId'), deviceId: form.get('deviceId'), note: form.get('note') || undefined }),
      });
      setMessage('Gate assigned. The officer must select this gate when they next sign in.');
      assignments.reload(); officers.reload();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not assign the gate'); }
  }

  async function unassign(id: unknown, label: string) {
    if (!confirm(`Remove ${label}? An officer already signed in at that gate is asked to select again.`)) return;
    try { await api(`/api/security/gate-assignments/${id}`, { method: 'DELETE' }); setMessage('Gate assignment removed.'); assignments.reload(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not remove the assignment'); }
  }

  return <>
    {message && <Notice tone={message.includes('assigned') || message.includes('removed') ? 'success' : 'error'}>{message}</Notice>}
    {officers.error && <Notice tone="error">{officers.error}</Notice>}
    {devices.error && <Notice tone="error">{devices.error}</Notice>}
    <FormCard title="Security gate assignments" onSubmit={assign}>
      <label>Security officer<select name="securityUserId" required><option value="">Select officer</option>{(officers.data?.items ?? []).map((officer)=><option key={String(officer.id)} value={String(officer.id)}>{String(officer.name)} — {String(officer.email)}</option>)}</select></label>
      <label>Gate (access-control device)<select name="deviceId" required><option value="">Select gate</option>{(devices.data?.items ?? []).map((device)=><option key={String(device.id)} value={String(device.id)}>{String(device.gate_name)} — {String(device.name)} ({String(device.direction)})</option>)}</select></label>
      <label className="span-2">Note (shift or post detail)<input name="note" placeholder="Morning shift, Gate A pedestrian lane" maxLength={200} /></label>
      <small className="span-2">Every officer chooses a gate when they sign in. Officers with no assignment may pick any active gate; assigning an officer here restricts the choice to their assigned gates and moves anyone already signed in at another gate. The choice scopes their visitor queue, gate activity and device list to that post for the whole session, and is re-checked on every request — removing an assignment ends a live session at that gate.</small>
      <button className="primary">Assign gate</button>
    </FormCard>
    <section className="panel">
      <div className="panel-title"><div><p className="eyebrow">SHIFT POSTS</p><h3>Assigned gates</h3></div></div>
      <ListState list={assignments}><DataTable exportTitle="Security Gate Assignments" rows={assignments.data?.items ?? []} columns={[['security_name','Officer'],['security_email','Email'],['gate_name','Gate'],['device_name','Device'],['direction','Direction'],['note','Note'],['active','Active'],['assigned_by_name','Assigned by'],['created_at','Assigned','date']]} action={(row)=><div className="row-actions">{Number(row.active)===1 && <button className="text danger" onClick={()=>unassign(row.id,`${String(row.security_name)} at ${String(row.gate_name)}`)}>Remove</button>}</div>} /></ListState>
    </section>
  </>;
}

function Settings() {
  const list = useList('/api/settings');
  const storage = useAsync<Row>(() => api('/api/storage-settings'), []);
  const portal=useAsync<PortalConfig>(()=>api('/api/portal-config'),[]);
  const channels=useAsync<PaymentChannels>(()=>api('/api/payment-channels'),[]);
  const [message, setMessage] = useState('');
  const [portalMessage,setPortalMessage]=useState('');
  const [bankMessage,setBankMessage]=useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [storageMessage, setStorageMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const value = String(form.get('value') ?? '');
    try { await api('/api/settings/facility_fee_grace_period_days', { method: 'PUT', body: JSON.stringify({ value }) }); setMessage('Grace period updated.'); list.reload(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Failed'); }
  }
  async function saveBankAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBankMessage('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api('/api/payment-channels', { method: 'PUT', body: JSON.stringify(values) });
      setBankMessage('Bank account details saved. Residents can now initiate a bank transfer.'); channels.reload();
    } catch (reason) { setBankMessage(reason instanceof Error ? reason.message : 'Could not save the bank account'); }
  }
  async function saveStorage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setStorageMessage(''); const storageForm = event.currentTarget; const form = new FormData(storageForm);
    const body = {
      enabled: form.get('enabled') === 'on', owner: form.get('owner'), repository: form.get('repository'),
      branch: form.get('branch'), basePath: form.get('basePath'), accessToken: form.get('accessToken') || undefined,
    };
    try { await api('/api/storage-settings', { method: 'PUT', body: JSON.stringify(body) }); setStorageMessage('Private GitHub storage verified and updated.'); storage.reload(); (storageForm.elements.namedItem('accessToken') as HTMLInputElement).value = ''; }
    catch (reason) { setStorageMessage(reason instanceof Error ? reason.message : 'Storage update failed'); }
  }
  async function savePortal(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setPortalMessage('');const values=Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/portal-config',{ method:'PUT',body:JSON.stringify(values) });setPortalMessage('Portal customisation saved. Reloading the theme…');portal.reload();setTimeout(()=>location.reload(),700); }
    catch(reason){setPortalMessage(reason instanceof Error?reason.message:'Portal customisation failed');}
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage('');
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (values.newPassword !== values.confirmPassword) { setPasswordMessage('New passwords do not match.'); return; }
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) });
      form.reset();
      setPasswordMessage('Password changed successfully.');
    } catch (reason) { setPasswordMessage(reason instanceof Error ? reason.message : 'Password change failed'); }
  }
  return <PagePanel title="Settings" subtitle="Estate-wide operational rules and private storage">
    {message && <Notice tone={message.includes('updated') ? 'success' : 'error'}>{message}</Notice>}
    <FormCard title="Facility-fee enforcement" onSubmit={submit}><label>Grace period (days)<input name="value" type="number" min="0" max="365" defaultValue={String(list.data?.items.find((item) => item.key === 'facility_fee_grace_period_days')?.value ?? '7')} required /></label><button className="primary">Save rule</button></FormCard>
    {bankMessage&&<Notice tone={bankMessage.includes('saved')?'success':'error'}>{bankMessage}</Notice>}
    {channels.error&&<Notice tone="error">{channels.error}</Notice>}
    {channels.data&&<FormCard title="Estate bank account for transfers" onSubmit={saveBankAccount}>
      <label>Bank name<input name="bankName" defaultValue={channels.data.bankAccount.bankName} required /></label>
      <label>Account name<input name="accountName" defaultValue={channels.data.bankAccount.accountName} required /></label>
      <label>Account number<input name="accountNumber" defaultValue={channels.data.bankAccount.accountNumber} inputMode="numeric" required /></label>
      <label>Sort code (optional)<input name="sortCode" defaultValue={channels.data.bankAccount.sortCode} /></label>
      <label className="span-2">Reference note shown to residents<input name="referenceNote" defaultValue={channels.data.bankAccount.referenceNote} placeholder="Use your unit number as the transfer reference" /></label>
      <small className="span-2">Residents and Cashiers see these details when they choose Bank transfer. Only an Administrator can change them.</small>
      <button className="primary">Save bank account</button>
    </FormCard>}
    {portalMessage&&<Notice tone={portalMessage.includes('saved')?'success':'error'}>{portalMessage}</Notice>}
    {portal.data&&<FormCard title="Portal identity, theme and recommended defaults" onSubmit={savePortal}><label>Portal name<input name="portal_name" defaultValue={portal.data.portal_name||'EstateMate'} required /></label><label>Estate name<input name="estate_name" defaultValue={portal.data.estate_name||'EstateMate Estate'} required /></label><label>Short mark<input name="portal_short_name" maxLength={4} defaultValue={portal.data.portal_short_name||'EM'} required /></label><label>Tagline<input name="portal_tagline" defaultValue={portal.data.portal_tagline} /></label><label className="span-2">Welcome text<textarea name="portal_welcome_text" rows={3} defaultValue={portal.data.portal_welcome_text} /></label><label>Theme mode<select name="theme_mode" defaultValue={portal.data.theme_mode||'light'}><option value="light">Light (recommended)</option><option value="dark">Dark</option><option value="system">Follow device</option></select></label><label>Corner style<select name="theme_corner_style" defaultValue={portal.data.theme_corner_style||'comfortable'}><option value="comfortable">Comfortable (recommended)</option><option value="compact">Compact</option><option value="rounded">Rounded</option></select></label><label>Primary colour<input name="theme_primary_color" type="color" defaultValue={portal.data.theme_primary_color||'#1769e0'} /></label><label>Accent colour<input name="theme_accent_color" type="color" defaultValue={portal.data.theme_accent_color||'#35d07f'} /></label><label>Navigation colour<input name="theme_navigation_color" type="color" defaultValue={portal.data.theme_navigation_color||'#0d1b37'} /></label><label>Surface colour<input name="theme_surface_color" type="color" defaultValue={portal.data.theme_surface_color||'#ffffff'} /></label><label>Support email<input name="support_email" type="email" defaultValue={portal.data.support_email} /></label><label>Support phone<input name="support_phone" defaultValue={portal.data.support_phone} /></label><label>Timezone<input name="estate_timezone" defaultValue={portal.data.estate_timezone||'Africa/Lagos'} /></label><label>Currency<input name="currency" defaultValue={portal.data.currency||'NGN'} maxLength={3} /></label><label>Default visitor hours<input name="visitor_default_duration_hours" type="number" min="1" max="168" defaultValue={portal.data.visitor_default_duration_hours||'8'} /></label><label>Gate decision policy<select name="visitor_gate_policy" defaultValue="security_approval"><option value="security_approval">Show details, then Security approves (recommended)</option></select></label><label>Visitor credential format<select name="visitor_credential_format" defaultValue="qr_code128_pin"><option value="qr_code128_pin">QR + Code 128 + PIN (recommended)</option></select></label><label>Card scan timeout (minutes)<input name="card_scan_timeout_minutes" type="number" min="1" max="30" defaultValue={portal.data.card_scan_timeout_minutes||'5'} /></label><button className="primary">Save portal customisation</button></FormCard>}
    {portal.data&&<GateImageCard config={portal.data} onSaved={portal.reload} />}
    <SecurityGateAssignments />
    {storageMessage && <Notice tone={storageMessage.includes('updated') ? 'success' : 'error'}>{storageMessage}</Notice>}
    <Notice tone="warning"><strong>Private repository required.</strong> EstateMate encrypts the GitHub token before saving it and never displays it again. Use a fine-grained token limited to this repository’s Contents permission.</Notice>
    {storage.data && <FormCard title="Private GitHub upload storage" onSubmit={saveStorage}>
      <label className="check"><input name="enabled" type="checkbox" defaultChecked={Boolean(storage.data.enabled)} /> Enable uploads</label>
      <label>GitHub owner<input name="owner" defaultValue={String(storage.data.owner || 'Barikblog')} required /></label>
      <label>Private repository<input name="repository" defaultValue={String(storage.data.repository || 'estatemate-private-storage')} required /></label>
      <label>Branch<input name="branch" defaultValue={String(storage.data.branch || 'main')} required /></label>
      <label>Base folder<input name="basePath" defaultValue={String(storage.data.basePath || 'uploads')} required /></label>
      <label>Fine-grained access token<input name="accessToken" type="password" autoComplete="new-password" placeholder={storage.data.tokenConfigured ? 'Configured — leave blank to keep it' : 'Required to enable storage'} /></label>
      <button className="primary">Verify and save storage</button>
    </FormCard>}
    {passwordMessage && <Notice tone={passwordMessage.includes('successfully') ? 'success' : 'error'}>{passwordMessage}</Notice>}
    <FormCard title="Change my password" onSubmit={changePassword}><label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required /></label><label>New password<input name="newPassword" type="password" minLength={12} autoComplete="new-password" required /></label><label>Confirm new password<input name="confirmPassword" type="password" minLength={12} autoComplete="new-password" required /></label><button className="primary">Change password</button></FormCard>
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['key','Setting'],['value','Value'],['updated_at','Updated','date']]} /></ListState>
  </PagePanel>;
}

async function uploadProofFiles(form: HTMLFormElement, category:string): Promise<string[]> {
  const input=form.elements.namedItem('proofFiles') as HTMLInputElement|null;
  const files=[...(input?.files ?? [])].slice(0,5);
  const keys:string[]=[];
  for (const file of files) {
    const uploaded=await api<{ key:string }>('/api/files',{ method:'POST',body:file,headers:{ 'Content-Type':file.type || 'application/pdf','X-Filename':file.name,'X-File-Category':category } });
    keys.push(uploaded.key);
  }
  return keys;
}

function ProofFilesField({ label='Supporting proof (optional)' }: { label?:string }) {
  return <label className="span-2">{label}<input name="proofFiles" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" /><small>Up to five JPEG, PNG, WebP or PDF files, maximum 4 MB each. Stored in the configured private GitHub repository.</small></label>;
}

function EvidenceButton({ entityType,entityId,count }: { entityType:string;entityId:unknown;count:unknown }) {
  const [files,setFiles]=useState<Row[]|null>(null); const [error,setError]=useState('');
  const total=Number(count ?? 0);
  async function open() { setError('');try { const value=await api<{ items:Row[] }>(`/api/evidence/${entityType}/${entityId}`);setFiles(value.items); } catch(reason) { setError(reason instanceof Error?reason.message:'Could not load proof'); } }
  if (!total) return null;
  return <><button className="text" onClick={open}>Proof ({total})</button>{(files||error)&&<div className="modal-backdrop" role="dialog" aria-modal="true"><section className="notice-modal evidence-modal"><p className="eyebrow">SUPPORTING EVIDENCE</p><h2>Uploaded proof</h2>{error&&<Notice tone="error">{error}</Notice>}{files?.map((file)=><a className="evidence-link" key={String(file.storage_key)} href={`/api/files/${encodeURIComponent(String(file.storage_key))}`}>{String(file.original_name)} <small>{Math.ceil(Number(file.size_bytes)/1024)} KB</small></a>)}{files?.length===0&&<p>No accessible files were found.</p>}<button className="secondary wide" onClick={()=>{setFiles(null);setError('');}}>Close</button></section></div>}</>;
}

/**
 * Watches one fingerprint capture until the reader answers.
 *
 * The operator is standing at a terminal with a person in front of them, so the
 * page has to say what is happening second by second: the reader is armed, the
 * finger has been read, the template is on its way to the other terminals. When
 * the firmware cannot do it, the same panel says so and names the fallback
 * instead of showing an unexplained failure.
 */
function FingerprintCapture({ captureId, onFinished, onCancel }: {
  captureId: string;
  onFinished: (status: 'captured'|'failed'|'cancelled'|'expired', capture: Row) => void;
  onCancel: () => void;
}) {
  const [capture, setCapture] = useState<Row | null>(null);
  const [stopped, setStopped] = useState(false);
  // A read finger is finished, but the template is still travelling to the other
  // terminals; keep watching for a short while so the operator sees where it
  // landed instead of a last frame that says "sending".
  const settlePolls = useRef(0);
  useEffect(() => {
    if (stopped) return;
    let active = true;
    const tick = () => {
      api<Row>(`/api/access/fingerprints/captures/${captureId}`).then((value) => {
        if (!active) return;
        setCapture(value);
        const status = String(value.status);
        if (status === 'captured') {
          const uploads = (value.uploads as Array<Row> | undefined) ?? [];
          const settling = uploads.some((row) => row.status === 'pending' || row.status === 'sent');
          if (settling && settlePolls.current < 15) { settlePolls.current += 1; return; }
        }
        if (status !== 'pending') {
          setStopped(true);
          onFinished(status as 'captured'|'failed'|'cancelled'|'expired', value);
        }
      }).catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => { active = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureId, stopped]);
  async function cancel() {
    setStopped(true);
    try { await api(`/api/access/fingerprints/captures/${captureId}/cancel`, { method: 'POST' }); } catch { /* the capture may already be finished */ }
    onCancel();
  }
  const status = String(capture?.status ?? 'pending');
  const uploads = (capture?.uploads as Array<Row> | undefined) ?? [];
  return <section className={`enrollment-session ${status === 'captured' ? 'captured' : status === 'pending' ? '' : 'failed'}`}>
    <p className="eyebrow">FINGERPRINT CAPTURE</p>
    <h3>{status === 'pending' ? `Waiting for ${String(capture?.personName ?? 'the person')} to touch the reader…` : status === 'captured' ? 'Fingerprint read' : status === 'failed' ? 'Capture failed' : 'Capture stopped'}</h3>
    <p>{status === 'pending'
      ? <>The terminal’s own reader is armed. Ask <strong>{String(capture?.personName ?? 'the person')}</strong> to place finger <strong>{String(capture?.fingerNo ?? '')}</strong> on the glass. Nothing is typed on the terminal.</>
      : status === 'captured'
        ? <>{String(capture?.personName ?? 'The person')}’s template was read and is being written to the other terminals: {uploads.length ? uploads.map((row) => String(row.device_name)).join(', ') : 'no other terminal needs it'}.</>
        : String(capture?.error ?? 'The terminal did not return a fingerprint.')}</p>
    {uploads.length > 0 && <ul className="capture-uploads">{uploads.map((row, index) => <li key={index}>{String(row.device_name)} — {row.status === 'applied' ? 'written' : row.status === 'pending' || row.status === 'sent' ? 'sending' : row.status === 'manual_action_required' ? 'needs an operator on the terminal' : `failed: ${String(row.error_message ?? 'unknown reason')}`}</li>)}</ul>}
    <div className="row-actions">{status === 'pending' && <button className="secondary" onClick={cancel}>Stop waiting</button>}{status !== 'pending' && <button className="secondary" onClick={onCancel}>Close</button>}</div>
  </section>;
}

function useList(url: string) {
  return useAsync<ListResponse<Row>>(() => api(url), [url]);
}

/**
 * Clipboard writes that say what they did. Several pages here hand out
 * identifiers someone has to type into another program - the bridge's
 * agent-config.json takes the agent ID and isapi-devices.json takes one
 * EstateMate device ID per terminal - and a 36-character UUID is not something
 * to transcribe from a screenshot.
 */
function useCopy() {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const copy = useCallback((value: unknown, label = 'Value') => {
    const text = String(value ?? '').trim();
    if (!text) { setNotice(`Nothing to copy — ${label.toLowerCase()} is empty.`); return; }
    if (!navigator.clipboard?.writeText) { setNotice(`Clipboard unavailable here — select the ${label.toLowerCase()} and copy it manually.`); return; }
    navigator.clipboard.writeText(text).then(
      () => setNotice(`${label} copied to the clipboard.`),
      () => setNotice(`Could not copy automatically — select the ${label.toLowerCase()} and copy it manually.`),
    );
  }, []);
  return [notice, copy] as const;
}

function ListState({ list, children }: { list: ReturnType<typeof useList>; children: ReactNode }) {
  if (list.loading) return <Loading />;
  if (list.error) return <Notice tone="error">{list.error} <button className="text" onClick={list.reload}>Retry</button></Notice>;
  return <>{children}</>;
}

function Loading() { return <div className="loading"><span /><span /><span /></div>; }

function PagePanel({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel page-panel"><header className="panel-title"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</header>{children}</section>;
}

function FormCard({ title, onSubmit, message, children }: { title: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>; message?: string; children: ReactNode }) {
  return <form className="form-card" onSubmit={onSubmit}><h3>{title}</h3>{message && <Notice tone="error">{message}</Notice>}<div className="form-grid">{children}</div></form>;
}

type Column = [string, string, ('date'|'money'|'id')?];
function DataTable({ rows, columns, action, exportTitle }: { rows: Row[]; columns: Column[]; action?: (row: Row) => ReactNode; exportTitle?: string }) {
  if (!rows.length) return <div className="empty"><div>◇</div><h3>Nothing here yet</h3><p>New records will appear in this view.</p></div>;
  return (
    <div>
      {exportTitle && (
        <div className="table-toolbar">
          <span className="record-count">{rows.length} record{rows.length === 1 ? '' : 's'}</span>
          <div className="export-actions">
            <button type="button" className="secondary sm" onClick={() => exportRecordsToExcel(`${exportTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-records`, exportTitle, columns, rows)}>📊 Export Excel</button>
            <button type="button" className="secondary sm" onClick={() => exportRecordsToPdf(`${exportTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-records`, exportTitle, columns, rows)}>📄 Export PDF</button>
          </div>
        </div>
      )}
      <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column[0]}>{column[1]}</th>)}{action && <th />}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{columns.map(([key,, format]) => <td key={key}>{cell(row[key], key, format)}</td>)}{action && <td>{action(row)}</td>}</tr>)}</tbody></table></div>
    </div>
  );
}

function cell(value: unknown, key: string, format?: 'date'|'money'|'id'): ReactNode {
  if (format === 'date') return readableDate(value);
  if (format === 'money') return money(value);
  if (format === 'id') return <code className="id-value" title={String(value ?? '')}>{String(value ?? '—')}</code>;
  if (key === 'status' || key === 'result' || key === 'role' || key === 'direction') return <span className={`pill ${String(value ?? '').toLowerCase()}`}>{String(value ?? '—').replaceAll('_',' ')}</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '—');
}

function nested(source: Row | null, objectKey: string, key: string): unknown {
  const object = source?.[objectKey];
  return object && typeof object === 'object' ? (object as Row)[key] : null;
}

function localDateTime(date:Date):string { const offset=date.getTimezoneOffset()*60000;return new Date(date.valueOf()-offset).toISOString().slice(0,16); }
function initials(name: string): string { return name.split(/\s+/).slice(0,2).map((part) => part[0]).join('').toUpperCase(); }
function navIcon(section: Section): string {
  return ({
    dashboard: '◫',
    cards: '▤', events: '⌁', devices: '▣', remote: '◎', isapi: '⧉', operations: '↻', sync: '⇄',
    residents: '●', residency: '♙', dependants: '♟', staff: '✦',
    properties: '⌂', bills: '₦', maintenance: '◇', bookings: '▦', notices: '!', emergency: '✚',
    visitors: '↔',
    information: 'ⓘ', legal: '§',
    imports: '⇩', settings: '⚙',
  })[section] ?? '•';
}

function DependantsManager({ user, onNavigate: _onNavigate }: { user: User; onNavigate?: (s: Section) => void }) {
  const canManage = user.role === 'admin' || user.role === 'manager';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [relationship, setRelationship] = useState('');
  const roster = useList(`/api/dependants?limit=100&search=${encodeURIComponent(search)}${status ? `&status=${status}` : ''}${relationship ? `&relationship=${relationship}` : ''}`);
  const [message, setMessage] = useState('');
  function refresh() { roster.reload(); }
  async function decide(row: Row, action: string, promptText?: string) {
    const note = promptText ? prompt(promptText) : null;
    if (promptText && note === null) return;
    if (action === 'deactivate' && !confirm(`Deactivate ${String(row.name)}? Their cards and fingerprints are suspended on every terminal; the record stays.`)) return;
    try {
      await api(`/api/household-members/${row.id}`, { method: 'PATCH', body: JSON.stringify({ action, reviewNote: note || undefined }) });
      setMessage(action === 'approve' ? 'Dependant approved.' : action === 'deactivate' ? 'Dependant deactivated; all their credentials were suspended.' : 'Dependant updated.');
      refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Dependant update failed'); }
  }
  const summary = roster.data?.summary as Record<string, unknown> | undefined;
  const actions = (row: Row) => (
    <div className="row-actions">
      {canManage && String(row.status) === 'pending' && <button className="text" onClick={() => decide(row, 'approve')}>Approve</button>}
      {canManage && String(row.status) === 'pending' && <button className="text" onClick={() => decide(row, 'reject', 'Reason for rejecting this dependant')}>Reject</button>}
      {canManage && String(row.status) !== 'inactive'
        ? <button className="text" onClick={() => decide(row, 'deactivate')}>Deactivate</button>
        : canManage && <button className="text" onClick={() => decide(row, 'update')}>Reactivate</button>}
    </div>
  );
  return <PagePanel title="Dependants manager" subtitle="Every spouse, child, relative and domestic worker across every household — with their live access picture" action={canManage ? <span className="eyebrow">Bulk uploads: Residents & staff → People → Bulk tools</span> : undefined}>
    {message && <Notice tone={/failed|Could not/i.test(message) ? 'error' : 'success'}>{message}</Notice>}
    {summary && <div className="stat-grid">
      <article className="stat-card"><p>All dependants</p><strong>{Number(summary.total ?? 0)}</strong></article>
      <article className="stat-card"><p>Active</p><strong>{Number(summary.active ?? 0)}</strong></article>
      <article className="stat-card"><p>Pending approval</p><strong>{Number(summary.pending ?? 0)}</strong></article>
      <article className="stat-card"><p>Domestic staff &amp; caregivers</p><strong>{Number(summary.domestic_staff ?? 0)}</strong></article>
      <article className="stat-card"><p>With their own login</p><strong>{Number(summary.with_logins ?? 0)}</strong></article>
    </div>}
    <div className="people-filters">
      <label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, phone, Employee ID or main resident" /></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="active">Active</option><option value="pending">Pending</option><option value="inactive">Inactive</option><option value="rejected">Rejected</option></select></label>
      <label>Relationship<select value={relationship} onChange={(event) => setRelationship(event.target.value)}><option value="">All relationships</option><option value="spouse">Spouse</option><option value="child">Child</option><option value="parent">Parent</option><option value="relative">Relative</option><option value="domestic_staff">Domestic staff</option><option value="caregiver">Caregiver</option><option value="other">Other</option></select></label>
    </div>
    <ListState list={roster}>
      <DataTable exportTitle="Dependants" rows={roster.data?.items ?? []} columns={[
        ['name', 'Name'], ['relationship', 'Relationship'], ['employee_id', 'Employee ID'],
        ['primary_resident_name', 'Main resident'], ['unit_number', 'Unit'],
        ['active_cards', 'Cards live'], ['active_fingerprints', 'Fingers live'],
        ['gate_events', 'Gate events'], ['last_gate_event_at', 'Last gate use', 'date'],
        ['status', 'Status'],
      ]} action={actions} />
    </ListState>
    <Notice tone="info">A deactivated dependant keeps their record, bills and gate history; only their credentials stop working. Register new dependants from Tenancy &amp; household, or in bulk from People → Bulk tools.</Notice>
  </PagePanel>;
}

function StaffManagement({ user }: { user: User }) {
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const staff = useList(`/api/staff?limit=100&search=${encodeURIComponent(search)}${role ? `&role=${role}` : ''}`);
  const shifts = useList('/api/staff/shifts?limit=100');
  const people = useAsync<{ items: Row[] }>(() => api('/api/users?limit=100'), []);
  const devices = useAsync<{ items: Row[] }>(() => api('/api/access/device-options'), []);
  const [showShiftForm, setShowShiftForm] = useState(false);
  const [message, setMessage] = useState('');
  function refresh() { staff.reload(); shifts.reload(); }
  async function submitShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!values.deviceId) delete values.deviceId;
    try {
      await api('/api/staff/shifts', { method: 'POST', body: JSON.stringify(values) });
      setShowShiftForm(false); setMessage('Shift scheduled.'); refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not schedule shift'); }
  }
  async function shiftStatus(row: Row, status: string) {
    try {
      await api(`/api/staff/shifts/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setMessage(`Shift marked ${status}.`); refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Shift update failed'); }
  }
  async function removeShift(row: Row) {
    if (!confirm('Delete this scheduled shift? Only future scheduled shifts can be removed.')) return;
    try { await api(`/api/staff/shifts/${row.id}`, { method: 'DELETE' }); setMessage('Shift removed.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not delete shift'); }
  }
  const summary = staff.data?.summary as Record<string, unknown> | undefined;
  const staffOnly = (people.data?.items ?? []).filter((row) => String(row.role) !== 'resident');
  return <PagePanel title="Staff management" subtitle="Administrators, managers, cashiers and security officers — postings, shifts and accountability" action={<button className="primary" onClick={() => setShowShiftForm(!showShiftForm)}>Schedule shift</button>}>
    {message && <Notice tone={/failed|Could not/i.test(message) ? 'error' : 'success'}>{message}</Notice>}
    {summary && <div className="stat-grid">
      <article className="stat-card"><p>Staff accounts</p><strong>{Number(summary.total ?? 0)}</strong></article>
      <article className="stat-card"><p>Active</p><strong>{Number(summary.active ?? 0)}</strong></article>
      <article className="stat-card"><p>Security officers</p><strong>{Number(summary.security_officers ?? 0)}</strong></article>
      <article className="stat-card"><p>Cashiers</p><strong>{Number(summary.cashiers ?? 0)}</strong></article>
      <article className="stat-card"><p>Managers &amp; admins</p><strong>{Number(summary.managers ?? 0) + Number(summary.administrators ?? 0)}</strong></article>
    </div>}
    {showShiftForm && <FormCard title="Schedule a shift" onSubmit={submitShift} message="">
      <label>Staff member<select name="staffUserId" required><option value="">Select staff…</option>{staffOnly.map((row) => <option key={String(row.id)} value={String(row.id)}>{String(row.name)} — {String(row.role)}</option>)}</select></label>
      <label>Date<input name="shiftDate" type="date" required /></label>
      <label>Starts<input name="startsAt" type="time" required /></label>
      <label>Ends<input name="endsAt" type="time" required /></label>
      <label>Duty<select name="duty"><option value="gate">Gate</option><option value="patrol">Patrol</option><option value="office">Office</option><option value="cashier">Cashier</option><option value="supervisor">Supervisor</option><option value="standby">Standby</option></select></label>
      <label>Gate / post (optional)<select name="deviceId"><option value="">No specific gate</option>{(devices.data?.items ?? []).map((row) => <option key={String(row.id)} value={String(row.id)}>{String(row.name)}{row.gate_name ? ` (${String(row.gate_name)})` : ''}</option>)}</select></label>
      <label className="span-2">Note<input name="note" placeholder="Optional instruction" /></label>
      <div className="row-actions"><button className="primary">Schedule</button><button type="button" className="secondary" onClick={() => setShowShiftForm(false)}>Cancel</button></div>
    </FormCard>}
    <div className="people-filters">
      <label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, phone or Employee ID" /></label>
      <label>Role<select value={role} onChange={(event) => setRole(event.target.value)}><option value="">All staff roles</option><option value="admin">Administrators</option><option value="manager">Managers</option><option value="cashier">Cashiers</option><option value="security">Security</option></select></label>
    </div>
    <ListState list={staff}>
      <DataTable exportTitle="Staff" rows={staff.data?.items ?? []} columns={[
        ['name', 'Name'], ['role', 'Role'], ['employee_id', 'Employee ID'], ['phone', 'Phone'],
        ['gates', 'Gate postings'], ['upcoming_shifts', 'Upcoming shifts'], ['next_shift', 'Next shift'],
        ['audit_entries', 'Actions on record'], ['last_action_at', 'Last action', 'date'], ['status', 'Status'],
      ]} />
    </ListState>
    <h3>Shift roster</h3>
    <ListState list={shifts}>
      <DataTable exportTitle="Shift roster" rows={shifts.data?.items ?? []} columns={[
        ['shift_date', 'Date'], ['starts_at', 'From'], ['ends_at', 'To'], ['staff_name', 'Staff'], ['staff_role', 'Role'],
        ['duty', 'Duty'], ['gate_name', 'Gate'], ['status', 'Status'],
      ]} action={(row) => (
        <div className="row-actions">
          {String(row.status) === 'scheduled' && <button className="text" onClick={() => shiftStatus(row, 'worked')}>Worked</button>}
          {String(row.status) === 'scheduled' && <button className="text" onClick={() => shiftStatus(row, 'cancelled')}>Cancel</button>}
          {String(row.status) === 'scheduled' && <button className="text danger" onClick={() => removeShift(row)}>Delete</button>}
        </div>
      )} />
    </ListState>
    <Notice tone="info">Gate postings (which terminal an officer may operate) are managed under Access control → Remote door control. Roles and passwords are edited from the People page. Every staff action remains in the audit log.</Notice>
  </PagePanel>;
}

function FacilityBookings({ user }: { user: User }) {
  const canOperate = user.role === 'admin' || user.role === 'manager';
  const canBook = ['admin', 'manager', 'resident'].includes(user.role);
  const facilities = useList('/api/facilities');
  const [statusFilter, setStatusFilter] = useState('');
  const bookings = useList(`/api/facility-bookings?limit=100${statusFilter ? `&status=${statusFilter}` : ''}${!canOperate ? '&mine=1' : ''}`);
  const [message, setMessage] = useState('');
  const [showFacilityForm, setShowFacilityForm] = useState(false);
  const [editingFacility, setEditingFacility] = useState<Row | null>(null);
  const [showBookForm, setShowBookForm] = useState(false);
  const [rateValue, setRateValue] = useState('');
  function refresh() { facilities.reload(); bookings.reload(); }
  async function submitFacility(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const body = {
      name: values.name, description: values.description, location: values.location,
      capacity: values.capacity === '' ? undefined : Number(values.capacity),
      hourlyRateMinor: Math.round(Number(values.hourlyRate || 0) * 100),
      depositMinor: Math.round(Number(values.deposit || 0) * 100),
      requiresApproval: values.requiresApproval === '1', requiresPayment: values.requiresPayment === '1',
      minNoticeHours: Number(values.minNoticeHours || 0), maxHoursPerBooking: Number(values.maxHoursPerBooking || 8),
      rules: values.rules,
    };
    try {
      await api(editingFacility ? `/api/facilities/${editingFacility.id}` : '/api/facilities', { method: editingFacility ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setShowFacilityForm(false); setEditingFacility(null); setMessage(editingFacility ? 'Facility updated.' : 'Facility added.'); refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not save facility'); }
  }
  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api<{ status: string }>('/api/facility-bookings', { method: 'POST', body: JSON.stringify({ ...values, attendees: values.attendees === '' ? undefined : Number(values.attendees) }) });
      setShowBookForm(false);
      setMessage(result.status === 'approved' ? 'Booking confirmed.' : 'Booking requested — an administrator or manager will confirm it.');
      refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Booking request failed'); }
  }
  async function decide(row: Row, action: string) {
    const note = action === 'decline' ? prompt('Reason to share with the resident:') : null;
    if (action === 'decline' && note === null) return;
    try {
      const result = await api<{ billId?: string }>(`/api/facility-bookings/${row.id}`, { method: 'PATCH', body: JSON.stringify({ action, note: note ?? undefined }) });
      setMessage(action === 'approve' ? `Booking approved${result.billId ? ' and the fee billed' : ''}.` : `Booking ${action === 'decline' ? 'declined' : 'cancelled'}.`);
      refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Booking decision failed'); }
  }
  const facilityItems = (facilities.data?.items ?? []) as Row[];
  const pendingCount = facilityItems.reduce((sum, row) => sum + Number(row.pending_bookings ?? 0), 0);
  return <PagePanel title="Facility bookings" subtitle="Reserve shared amenities — request, approval, billing and one calendar" action={<div className="row-actions">{canOperate && <button className="secondary" onClick={() => { setShowFacilityForm(!showFacilityForm); setEditingFacility(null); setRateValue(''); }}>Add facility</button>}{canBook && <button className="primary" onClick={() => setShowBookForm(!showBookForm)}>Request booking</button>}</div>}>
    {message && <Notice tone={/failed|refused|Could not/i.test(message) ? 'error' : 'success'}>{message}</Notice>}
    {pendingCount > 0 && canOperate && <Notice tone="warning">{pendingCount} booking request(s) are waiting for a decision below.</Notice>}
    {showFacilityForm && <FormCard title={editingFacility ? `Edit ${String(editingFacility.name)}` : 'Add a facility'} onSubmit={submitFacility} message="">
      <label>Name<input name="name" defaultValue={String(editingFacility?.name ?? '')} required /></label>
      <label>Location<input name="location" defaultValue={String(editingFacility?.location ?? '')} /></label>
      <label>Capacity<input name="capacity" type="number" min="1" defaultValue={String(editingFacility?.capacity ?? '')} /></label>
      <label>Hourly rate (₦)<input name="hourlyRate" type="number" min="0" step="0.01" value={rateValue} onChange={(event) => setRateValue(event.target.value)} placeholder="0.00" /></label>
      <label>Refundable deposit (₦)<input name="deposit" type="number" min="0" step="0.01" defaultValue={editingFacility ? String(Number(editingFacility.deposit_minor ?? 0) / 100) : '0'} /></label>
      <label>Approval<select name="requiresApproval" defaultValue={String(editingFacility?.requires_approval ?? 1) === String(1) || Number(editingFacility?.requires_approval ?? 1) ? '1' : '0'}><option value="1">Approval required</option><option value="0">Auto-approve</option></select></label>
      <label>Payment<select name="requiresPayment" defaultValue={Number(editingFacility?.requires_payment ?? 0) ? '1' : '0'}><option value="0">Free to book</option><option value="1">Bill the requester</option></select></label>
      <label>Minimum notice (hours)<input name="minNoticeHours" type="number" min="0" defaultValue={Number(editingFacility?.min_notice_hours ?? 0)} /></label>
      <label>Max hours per booking<input name="maxHoursPerBooking" type="number" min="1" defaultValue={Number(editingFacility?.max_hours_per_booking ?? 8)} /></label>
      <label className="span-2">Rules<input name="rules" defaultValue={String(editingFacility?.rules ?? '')} placeholder="Noise curfew, guest count, cleanup…" /></label>
      <label className="span-2">Description<input name="description" defaultValue={String(editingFacility?.description ?? '')} /></label>
      <div className="row-actions"><button className="primary">{editingFacility ? 'Save facility' : 'Add facility'}</button><button type="button" className="secondary" onClick={() => { setShowFacilityForm(false); setEditingFacility(null); }}>Cancel</button></div>
    </FormCard>}
    {showBookForm && <FormCard title="Request a booking" onSubmit={submitBooking} message="">
      <label>Facility<select name="facilityId" required><option value="">Choose…</option>{facilityItems.map((row) => <option key={String(row.id)} value={String(row.id)}>{String(row.name)}{row.location ? ` — ${String(row.location)}` : ''}{Number(row.hourly_rate_minor) ? ` (₦${(Number(row.hourly_rate_minor) / 100).toLocaleString()}/hr)` : ''}</option>)}</select></label>
      <label>Starts<input name="startsAt" type="datetime-local" required /></label>
      <label>Ends<input name="endsAt" type="datetime-local" required /></label>
      <label>Purpose<input name="purpose" placeholder="Birthday, meeting…" /></label>
      <label>Attendees<input name="attendees" type="number" min="1" /></label>
      <label>Contact phone<input name="contactPhone" /></label>
      <div className="row-actions"><button className="primary">Send request</button><button type="button" className="secondary" onClick={() => setShowBookForm(false)}>Cancel</button></div>
    </FormCard>}
    <h3>Facilities</h3>
    <ListState list={facilities}>
      <DataTable rows={facilityItems} columns={[
        ['name', 'Name'], ['location', 'Location'], ['capacity', 'Capacity'],
        ['hourly_rate_minor', 'Hourly rate', 'money'], ['deposit_minor', 'Deposit', 'money'],
        ['upcoming_bookings', 'Upcoming'], ['pending_bookings', 'Waiting decision'], ['status', 'Status'],
      ]} action={canOperate ? (row) => <div className="row-actions"><button className="text" onClick={() => { setEditingFacility(row); setShowFacilityForm(true); setRateValue(String(Number(row.hourly_rate_minor ?? 0) / 100)); }}>Edit</button>
        {String(row.status) === 'active'
          ? <button className="text" onClick={async () => { await api(`/api/facilities/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'inactive' }) }); refresh(); }}>Retire</button>
          : <button className="text" onClick={async () => { await api(`/api/facilities/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) }); refresh(); }}>Restore</button>}</div> : undefined} />
    </ListState>
    <div className="people-filters">
      <label>Booking status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All bookings</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="declined">Declined</option><option value="cancelled">Cancelled</option><option value="completed">Completed</option></select></label>
    </div>
    <h3>Bookings</h3>
    <ListState list={bookings}>
      <DataTable exportTitle="Facility bookings" rows={bookings.data?.items ?? []} columns={[
        ['facility_name', 'Facility'], ['requester_name', 'Requested by'], ['unit_number', 'Unit'],
        ['starts_at', 'Starts', 'date'], ['ends_at', 'Ends', 'date'], ['purpose', 'Purpose'],
        ['estimated_cost_minor', 'Est. cost', 'money'], ['payment_status', 'Payment'], ['status', 'Status'],
      ]} action={(row) => (
        <div className="row-actions">
          {canOperate && String(row.status) === 'pending' && <button className="text" onClick={() => decide(row, 'approve')}>Approve</button>}
          {canOperate && String(row.status) === 'pending' && <button className="text" onClick={() => decide(row, 'decline')}>Decline</button>}
          {(canOperate || String(row.requester_id) === user.id) && ['pending', 'approved'].includes(String(row.status)) && <button className="text danger" onClick={() => decide(row, 'cancel')}>Cancel</button>}
        </div>
      )} />
    </ListState>
    <Notice tone="info">Approving a paid booking raises an ordinary bill — cashiers clear it in Bills &amp; payments like any other. Cancelling before payment voids the bill. Deposits are included in the billed total and refunded manually.</Notice>
  </PagePanel>;
}

function EmergencyContacts({ user }: { user: User }) {
  const canManage = user.role === 'admin' || user.role === 'manager';
  const [category, setCategory] = useState('');
  const contacts = useList(`/api/emergency-contacts${category ? `?category=${category}` : ''}`);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [message, setMessage] = useState('');
  const categories = ['security', 'medical', 'fire', 'police', 'utility', 'management', 'neighbour', 'other'];
  function refresh() { contacts.reload(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(editing ? `/api/emergency-contacts/${editing.id}` : '/api/emergency-contacts', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({ ...values, priority: values.priority === '' ? undefined : Number(values.priority) }),
      });
      setShowForm(false); setEditing(null);
      setMessage(editing ? 'Contact updated.' : 'Contact added.');
      refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not save contact'); }
  }
  async function setStatus(row: Row, status: string) {
    try { await api(`/api/emergency-contacts/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Update failed'); }
  }
  async function remove(row: Row) {
    if (!confirm(`Remove ${String(row.name)} from the emergency directory?`)) return;
    try { await api(`/api/emergency-contacts/${row.id}`, { method: 'DELETE' }); setMessage('Contact removed.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not remove contact'); }
  }
  return <PagePanel title="Emergency contacts" subtitle="One-tap directory for estate security, medical, fire, utility and management response lines" action={canManage ? <button className="primary" onClick={() => { setShowForm(!showForm); setEditing(null); }}>Add contact</button> : undefined}>
    {message && <Notice tone={/failed|Could not/i.test(message) ? 'error' : 'success'}>{message}</Notice>}
    <div className="people-filters">
      <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map((item) => <option key={item} value={item}>{item[0]!.toUpperCase() + item.slice(1)}</option>)}</select></label>
    </div>
    {showForm && <FormCard title={editing ? `Edit ${String(editing.name)}` : 'Add an emergency contact'} onSubmit={submit} message="">
      <label>Name<input name="name" defaultValue={String(editing?.name ?? '')} required /></label>
      <label>Category<select name="category" defaultValue={String(editing?.category ?? 'security')}>{categories.map((item) => <option key={item} value={item}>{item[0]!.toUpperCase() + item.slice(1)}</option>)}</select></label>
      <label>Role / label<input name="roleTitle" defaultValue={String(editing?.role_title ?? '')} placeholder="24/7 response desk" /></label>
      <label>Phone<input name="phone" type="tel" defaultValue={String(editing?.phone ?? '')} /></label>
      <label>Alternate phone<input name="alternatePhone" type="tel" defaultValue={String(editing?.alternate_phone ?? '')} /></label>
      <label>Email<input name="email" type="email" defaultValue={String(editing?.email ?? '')} /></label>
      <label>Available hours<input name="availableHours" defaultValue={String(editing?.available_hours ?? '')} placeholder="24 hours" /></label>
      <label>Priority (lower shows first)<input name="priority" type="number" min="1" max="999" defaultValue={Number(editing?.priority ?? 100)} /></label>
      <label>Visible to<select name="visibleTo" defaultValue={String(editing?.visible_to ?? 'everyone')}><option value="everyone">Everyone</option><option value="staff">Staff only</option><option value="residents">Residents only</option></select></label>
      <label className="span-2">Address / location<input name="address" defaultValue={String(editing?.address ?? '')} /></label>
      <div className="row-actions"><button className="primary">{editing ? 'Save contact' : 'Add contact'}</button><button type="button" className="secondary" onClick={() => { setShowForm(false); setEditing(null); }}>Cancel</button></div>
    </FormCard>}
    <ListState list={contacts}>
      <section className="contact-grid">
        {(contacts.data?.items ?? []).map((row) => (
          <article className="panel contact-card" key={String(row.id)}>
            <p className="eyebrow">{String(row.category)} · {String(row.role_title || row.available_hours || '')}</p>
            <h3>{row.phone ? <a className="contact-tel" href={`tel:${String(row.phone)}`}>{String(row.name)}</a> : String(row.name)}</h3>
            {Boolean(row.phone) && <p><a className="contact-tel" href={`tel:${String(row.phone)}`}>{String(row.phone)}</a>{row.alternate_phone ? <span> · alt <a className="contact-tel" href={`tel:${String(row.alternate_phone)}`}>{String(row.alternate_phone)}</a></span> : null}</p>}
            {Boolean(row.available_hours) && <p>{String(row.available_hours)}</p>}
            {Boolean(row.address) && <p>{String(row.address)}</p>}
            {String(row.visible_to) !== 'everyone' && <p className="eyebrow">Visible to {String(row.visible_to)}</p>}
            {String(row.status) !== 'active' && <p className="eyebrow">Inactive</p>}
            {canManage && <div className="row-actions">
              <button className="text" onClick={() => { setEditing(row); setShowForm(true); }}>Edit</button>
              {String(row.status) === 'active'
                ? <button className="text" onClick={() => setStatus(row, 'inactive')}>Hide</button>
                : <button className="text" onClick={() => setStatus(row, 'active')}>Show</button>}
              <button className="text danger" onClick={() => remove(row)}>Delete</button>
            </div>}
          </article>
        ))}
        {contacts.data && contacts.data.items.length === 0 && <div className="empty"><div>◇</div><h3>No contacts here</h3><p>Add the first emergency contact for this category.</p></div>}
      </section>
    </ListState>
    <Notice tone="info">Bookmark this page on every guard post. Numbers marked “staff only” are hidden from residents; guard posts sign in as Security, which counts as staff. Tap a number on a mobile device to call it.</Notice>
  </PagePanel>;
}

/** One library renders both menu surfaces; `set` keeps the collections apart. */
function DocumentLibrary({ user, set, title, subtitle, categories }: { user: User; set: 'info' | 'legal'; title: string; subtitle: string; categories: Array<[string, string]> }) {
  const canManage = user.role === 'admin' || user.role === 'manager';
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const docs = useList(`/api/documents?set=${set}&search=${encodeURIComponent(search)}${category ? `&category=${category}` : ''}`);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [message, setMessage] = useState('');
  const [acks, setAcks] = useState<{ id: string; items: Row[] } | null>(null);
  function refresh() { docs.reload(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const fileInput = form.elements.namedItem('file') as HTMLInputElement;
    let fileKey: string | undefined;
    if (fileInput?.files?.[0]) {
      const file = fileInput.files[0];
      try {
        const stored = await api<{ key: string }>('/api/files', { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/pdf', 'X-Filename': file.name, 'X-File-Category': 'documents' } });
        fileKey = stored.key;
      } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'File upload failed'); return; }
    }
    try {
      await api(editing ? `/api/documents/${editing.id}` : '/api/documents', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          category: values.category, title: values.title, summary: values.summary, body: values.body,
          externalUrl: values.externalUrl || undefined, version: values.version || undefined,
          effectiveDate: values.effectiveDate || undefined, audience: values.audience,
          requiresAcknowledgement: values.requiresAcknowledgement === '1',
          status: values.status, proofKeys: fileKey ? [fileKey] : undefined,
        }),
      });
      setShowForm(false); setEditing(null);
      setMessage(editing ? 'Document updated.' : 'Document published.');
      refresh();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not save document'); }
  }
  async function acknowledge(row: Row) {
    try { await api(`/api/documents/${row.id}/acknowledge`, { method: 'POST' }); setMessage(`You have acknowledged ${String(row.title)}.`); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not acknowledge'); }
  }
  async function setStatus(row: Row, status: string) {
    try { await api(`/api/documents/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Update failed'); }
  }
  async function remove(row: Row) {
    if (!confirm(`Remove ${String(row.title)}? Documents with acknowledgements are archived instead.`)) return;
    try { const result = await api<{ notice?: string }>(`/api/documents/${row.id}`, { method: 'DELETE' }); setMessage(result.notice ?? 'Document removed.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not remove document'); }
  }
  async function showAcks(row: Row) {
    try { const result = await api<{ items: Row[] }>(`/api/documents/${row.id}/acknowledgements`); setAcks({ id: String(row.id), items: result.items }); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not load acknowledgements'); }
  }
  return <PagePanel title={title} subtitle={subtitle} action={canManage ? <button className="primary" onClick={() => { setShowForm(!showForm); setEditing(null); }}>Publish document</button> : undefined}>
    {message && <Notice tone={/failed|Could not/i.test(message) ? 'error' : 'success'}>{message}</Notice>}
    {showForm && <FormCard title={editing ? `Edit ${String(editing.title)}` : 'Publish a document'} onSubmit={submit} message="">
      <label>Category<select name="category" defaultValue={String(editing?.category ?? categories[0]![0])}>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Title<input name="title" defaultValue={String(editing?.title ?? '')} required /></label>
      <label>Version<input name="version" defaultValue={String(editing?.version ?? '1.0')} /></label>
      <label>Effective date<input name="effectiveDate" type="date" defaultValue={String(editing?.effective_date ?? '')} /></label>
      <label>Audience<select name="audience" defaultValue={String(editing?.audience ?? 'everyone')}><option value="everyone">Everyone</option><option value="residents">Residents</option><option value="staff">Staff</option><option value="managers">Managers</option></select></label>
      <label>Status<select name="status" defaultValue={String(editing?.status ?? 'published')}><option value="published">Published</option><option value="draft">Draft</option><option value="archived">Archived</option></select></label>
      <label>Acknowledgement<select name="requiresAcknowledgement" defaultValue={Number(editing?.requires_acknowledgement ?? 0) ? '1' : '0'}><option value="0">No read receipt</option><option value="1">Require acknowledgement</option></select></label>
      <label>External link<input name="externalUrl" type="url" defaultValue={String(editing?.external_url ?? '')} placeholder="https://…" /></label>
      <label className="span-2">Summary<input name="summary" defaultValue={String(editing?.summary ?? '')} /></label>
      <label className="span-2">Document text<textarea name="body" rows={5} defaultValue={String(editing?.body ?? '')} placeholder="Paste the document text here — or upload a file or link instead" /></label>
      <label className="span-2">Or upload a file<input name="file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
      <div className="row-actions"><button className="primary">{editing ? 'Save document' : 'Publish document'}</button><button type="button" className="secondary" onClick={() => { setShowForm(false); setEditing(null); }}>Cancel</button></div>
    </FormCard>}
    <div className="people-filters">
      <label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title or summary" /></label>
      <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <ListState list={docs}>
      <DataTable exportTitle={title} rows={docs.data?.items ?? []} columns={[
        ['title', 'Title'], ['category', 'Category'], ['version', 'Version'], ['effective_date', 'Effective', 'date'],
        ['audience', 'Audience'], ['acknowledgements', 'Acknowledged'], ['acknowledged_by_me', 'You read'], ['status', 'Status'],
      ]} action={(row) => (
        <div className="row-actions">
          {Boolean(row.file_key) && <a className="text" href={`/api/files/${encodeURIComponent(String(row.file_key))}`}>Open file</a>}
          {Boolean(row.external_url) && <a className="text" href={String(row.external_url)} target="_blank" rel="noreferrer noopener">Open link</a>}
          {Number(row.requires_acknowledgement) === 1 && Number(row.acknowledged_by_me) === 0 && <button className="text" onClick={() => acknowledge(row)}>Acknowledge</button>}
          {canManage && <button className="text" onClick={() => { setEditing(row); setShowForm(true); }}>Edit</button>}
          {canManage && Number(row.acknowledgements) > 0 && <button className="text" onClick={() => showAcks(row)}>Readers ({String(row.acknowledgements)})</button>}
          {canManage && String(row.status) === 'draft' && <button className="text" onClick={() => setStatus(row, 'published')}>Publish</button>}
          {canManage && String(row.status) === 'published' && <button className="text" onClick={() => setStatus(row, 'archived')}>Archive</button>}
          {canManage && <button className="text danger" onClick={() => remove(row)}>Delete</button>}
        </div>
      )} />
    </ListState>
    {(docs.data?.items ?? []).some((row) => row.body) && <section className="panel">
      <h3>Document texts</h3>
      {(docs.data?.items ?? []).filter((row) => row.body).map((row) => (
        <details key={String(row.id)} className="document-body"><summary>{String(row.title)} <small>({String(row.version)})</small></summary><p>{String(row.body)}</p></details>
      ))}
    </section>}
    {acks && <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="notice-modal">
      <p className="eyebrow">READ ACKNOWLEDGEMENTS</p><h2>Who has read it</h2>
      <ul className="document-acks">{acks.items.map((row) => <li key={String(row.user_id)}>{String(row.name)} <small>· {String(row.role)} · {readableDate(row.acknowledged_at)}</small></li>)}</ul>
      <button className="secondary wide" onClick={() => setAcks(null)}>Close</button>
    </section></div>}
  </PagePanel>;
}

function InformationHub({ user, onNavigate }: { user: User; onNavigate?: (s: Section) => void }) {
  return <>
    <DocumentLibrary user={user} set="info" title="Information hub" subtitle="Resident guides, forms, service documents and estate communications" categories={[
      ['guide', 'Resident guide'], ['form', 'Form'], ['other', 'Other'],
    ]} />
    <InformationShortcuts onNavigate={onNavigate} />
  </>;
}

/** The hub's quick-route cards remain alongside the real library. */
function InformationShortcuts({ onNavigate }: { onNavigate?: (s: Section) => void }) {
  const cards: Array<[Section, string, string]> = [
    ['notices', 'Estate notices', 'Announcements, policy updates and urgent broadcasts pushed to every resident.'],
    ['maintenance', 'Service operations', 'Open maintenance requests, fault reports and resolution status.'],
    ['bookings', 'Facility bookings', 'Reserve estate amenities and view the upcoming events calendar.'],
    ['emergency', 'Emergency contacts', 'Quick access to security, medical, fire and utility response lines.'],
    ['visitors', 'Visitor management', 'Invite guests, issue passes and review arrival history.'],
    ['legal', 'Legal & governance', 'Estate by-laws, house rules, data handling and governance documents.'],
  ];
  return <section className="feature-grid">
    {cards.map(([id, title, body]) => (
      <button key={id} className="panel hub-card" onClick={() => onNavigate?.(id)}>
        <span className="hub-icon">{navIcon(id)}</span>
        <p className="eyebrow">Go to</p>
        <h3>{title}</h3>
        <p>{body}</p>
        <span className="hub-arrow">→</span>
      </button>
    ))}
  </section>;
}

function LegalGovernance({ user }: { user: User }) {
  return <DocumentLibrary user={user} set="legal" title="Legal & governance" subtitle="By-laws, house rules, residents’ agreement, privacy and data-handling notices, AGM minutes and Exco resolutions" categories={[
    ['bylaw', 'By-law'], ['house_rule', 'House rule'], ['privacy', 'Privacy & data'], ['agreement', 'Residents’ agreement'], ['minutes', 'Meeting minutes'], ['policy', 'Policy'],
  ]} />;
}

export default App;
