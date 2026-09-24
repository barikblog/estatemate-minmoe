import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, ListResponse, User, api, money, readableDate } from './api';
import type { PassShareSource } from './pass-export';
import { exportRecordsToExcel, exportRecordsToPdf } from './records-export';

type Row = Record<string, unknown>;
type Section = 'dashboard' | 'residents' | 'properties' | 'residency' | 'imports' | 'bills' | 'visitors' | 'maintenance' | 'notices' | 'cards' | 'events' | 'devices' | 'isapi' | 'operations' | 'settings';

interface NavItem { id: Section; label: string; roles?: User['role'][] }
type PortalConfig = Record<string,string>;
const defaultPortalConfig: PortalConfig = {
  portal_name:'EstateMate',estate_name:'EstateMate Estate',portal_short_name:'EM',portal_tagline:'One estate. One secure view.',
  portal_welcome_text:'Manage residents, visitors, accounts and gate access from a single, secure workspace.',theme_mode:'light',
  theme_primary_color:'#1769e0',theme_accent_color:'#35d07f',theme_navigation_color:'#0d1b37',theme_surface_color:'#ffffff',
  theme_corner_style:'comfortable',currency:'NGN',estate_timezone:'Africa/Lagos',visitor_default_duration_hours:'8',visitor_gate_policy:'security_approval',
};

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

const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'residents', label: 'People', roles: ['admin','manager','cashier','security'] },
  { id: 'properties', label: 'Properties', roles: ['admin','manager','cashier','security','resident'] },
  { id: 'residency', label: 'Tenancy & household', roles: ['admin','manager','resident'] },
  { id: 'imports', label: 'Import centre', roles: ['admin','manager'] },
  { id: 'bills', label: 'Bills & payments', roles: ['admin','cashier','resident'] },
  { id: 'visitors', label: 'Visitors' },
  { id: 'maintenance', label: 'Maintenance', roles: ['admin','manager','resident'] },
  { id: 'notices', label: 'Estate notices' },
  { id: 'cards', label: 'Access cards', roles: ['admin','manager','cashier','resident'] },
  { id: 'events', label: 'Gate activity', roles: ['admin','manager','security','resident'] },
  { id: 'devices', label: 'Access-control devices', roles: ['admin','manager','security'] },
  { id: 'isapi', label: 'ISAPI Bridge & Windows Agent', roles: ['admin','manager'] },
  { id: 'operations', label: 'Hardware actions', roles: ['admin','manager'] },
  { id: 'settings', label: 'Settings', roles: ['admin'] },
];

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

function Login({ onLogin, config }: { onLogin: (user: User) => void; config:PortalConfig }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true); setError('');
    try {
      const result = await api<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      onLogin(result.user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login failed');
    } finally { setLoading(false); }
  }

  return <main className="auth-shell">
    <section className="auth-panel brand-panel">
      <div className="brand-mark">{config.portal_short_name}</div>
      <p className="eyebrow">{config.portal_tagline}</p>
      <h1>Welcome to<br />{config.portal_name}.</h1>
      <p className="auth-intro">{config.portal_welcome_text}</p>
      <div className="brand-proof"><span className="pulse-dot" /> Cloud and gate operations connected</div>
    </section>
    <section className="auth-panel form-panel">
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

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [section, setSection] = useState<Section>('dashboard');
  const [checking, setChecking] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popupNotices, setPopupNotices] = useState<Row[]>([]);
  const [portalConfig,setPortalConfig]=useState<PortalConfig>(defaultPortalConfig);

  useEffect(() => {
    api<PortalConfig>('/api/portal-config').then((value) => { const merged={ ...defaultPortalConfig,...value };setPortalConfig(merged);applyPortalTheme(merged); }).catch(() => applyPortalTheme(defaultPortalConfig));
    api<{ user: User }>('/api/auth/me').then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!user) { setPopupNotices([]); return; }
    api<{ items: Row[] }>('/api/notices/popup').then((result) => setPopupNotices(result.items)).catch(() => setPopupNotices([]));
  }, [user?.id]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }

  async function acknowledgePopup() {
    const current = popupNotices[0];
    if (!current) return;
    try { await api(`/api/notices/${current.id}/acknowledge`, { method: 'POST' }); } finally {
      setPopupNotices((items) => items.slice(1));
    }
  }

  if (checking) return <div className="splash"><div className="brand-mark">{portalConfig.portal_short_name}</div><span>Loading {portalConfig.portal_name}…</span></div>;
  if (!user) return <Login onLogin={setUser} config={portalConfig} />;

  const isOperator = user?.role === 'admin' || user?.role === 'manager';
  const [openMaintCount, setOpenMaintCount] = useState<number>(0);
  useEffect(() => {
    if (!user || !isOperator) { setOpenMaintCount(0); return; }
    api<{ openMaintenance?: { count: number } }>('/api/dashboard')
      .then((res) => setOpenMaintCount(Number(res.openMaintenance?.count ?? 0)))
      .catch(() => {});
  }, [user?.id, isOperator, section]);

  const availableNav = navItems.filter((item) => !item.roles || item.roles.includes(user.role));
  const current = availableNav.find((item) => item.id === section) ?? availableNav[0]!;
  if (current.id !== section) setSection(current.id);

  return <div className="app-shell">
    <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
      <header className="side-brand"><span className="mini-logo">{portalConfig.portal_short_name}</span><strong>{portalConfig.portal_name}</strong><button className="icon-button close-menu" onClick={() => setMenuOpen(false)}>×</button></header>
      <p className="nav-caption">WORKSPACE</p>
      <nav>{availableNav.map((item) => <button key={item.id} className={section === item.id ? 'nav-active' : ''} onClick={() => { setSection(item.id); setMenuOpen(false); }}><span className="nav-icon">{navIcon(item.id)}</span>{item.label}{item.id === 'maintenance' && isOperator && openMaintCount > 0 && <span className="nav-badge">{openMaintCount}</span>}</button>)}</nav>
      <footer className="user-card"><span className="avatar">{initials(user.name)}</span><span><strong>{user.name}</strong><small>{user.role}</small></span><button className="icon-button" title="Sign out" onClick={logout}>↗</button></footer>
    </aside>
    {menuOpen && <button className="scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
    <main className="workspace">
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)}>☰</button><div><p className="eyebrow">{user.role} workspace</p><h1>{current.label}</h1></div><div className="top-status"><span className="pulse-dot" /> System online</div></header>
      <div className="content"><SectionView section={section} user={user} onNavigate={setSection} /><PortalFooter portalName={portalConfig.portal_name} /></div>
    </main>
    {popupNotices[0] && <EstateNoticePopup notice={popupNotices[0]} remaining={popupNotices.length - 1} onAcknowledge={acknowledgePopup} />}
  </div>;
}

function SectionView({ section, user, onNavigate }: { section: Section; user: User; onNavigate?: (s: Section) => void }) {
  switch (section) {
    case 'dashboard': return <Dashboard user={user} onNavigate={onNavigate} />;
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
    case 'isapi': return <IsapiBridge user={user} />;
    case 'operations': return <Operations />;
    case 'settings': return <Settings />;
  }
}

function Dashboard({ user, onNavigate }: { user: User; onNavigate?: (s: Section) => void }) {
  const { data, error, loading } = useAsync<Row>(() => api('/api/dashboard'), [user.id]);
  if (loading) return <Loading />;
  if (error) return <Notice tone="error">{error}</Notice>;
  const isOperator = user.role === 'admin' || user.role === 'manager';
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
    <section className="hero-card"><div><p className="eyebrow">Estate operations</p><h2>Good day, {user.name.split(' ')[0]}.</h2><p>Here is the latest picture across your estate.</p></div><div className="hero-orb"><span>EM</span></div></section>
    <section className="stat-grid">{cards.map(([label, value, detail]) => <article className="stat-card" key={String(label)}><p>{label}</p><strong>{String(value ?? 0)}</strong><small>{detail}</small></article>)}</section>
    {user.role === 'resident' && Boolean(data?.latestNotice) && <section className="panel"><div className="panel-title"><div><p className="eyebrow">Latest estate notice</p><h3>{String((data?.latestNotice as Row).title)}</h3></div></div><p>{String((data?.latestNotice as Row).body)}</p></section>}
    {user.role !== 'resident' && <section className="split-grid"><article className="panel callout"><p className="eyebrow">HARDWARE MODE</p><h3>Direct MinMoe event upload</h3><p>Terminals post gate events straight to Cloudflare. Card changes remain in the hardware-action queue until a supported command channel is confirmed.</p></article><article className="panel"><p className="eyebrow">OPERATIONS TIP</p><h3>Check unresolved device actions</h3><p>HTTP Listening is upload-only on most firmware. Mark each manual terminal update as applied to preserve an accurate audit trail.</p></article></section>}
  </>;
}

function People({ user }: { user: User }) {
  const canManage=user.role==='admin'||user.role==='manager';
  const [search,setSearch]=useState('');const [role,setRole]=useState('');
  const list=useList(`/api/users?limit=100&search=${encodeURIComponent(search)}${role?`&role=${role}`:''}`);
  const available=useAsync<{ items:Row[] }>(()=>canManage?api('/api/properties/available'):Promise.resolve({ items:[] }),[user.role]);
  const imports=useAsync<ListResponse<Row>>(()=>canManage?api('/api/imports?kind=users&limit=20'):Promise.resolve({ items:[],page:1,limit:20 }),[user.role]);
  const [showForm,setShowForm]=useState(false);const [showImport,setShowImport]=useState(false);const [editing,setEditing]=useState<Row|null>(null);const [message,setMessage]=useState('');const [temporaryPassword,setTemporaryPassword]=useState('');const [sampleCredentials,setSampleCredentials]=useState<Array<{ role:string;name:string;email:string;temporaryPassword:string }>>([]);
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
  const actions=canManage?(row:Row)=>user.role==='manager'&&['admin','manager'].includes(String(row.role))?null:<div className="row-actions"><button className="text" onClick={()=>{setEditing(row);setShowForm(false);}}>Edit</button><button className="text" onClick={()=>resetPassword(row)}>Reset password</button>{row.status==='active'?<button className="text" onClick={()=>updateStatus(row,'inactive')}>Deactivate</button>:<button className="text" onClick={()=>updateStatus(row,'active')}>Reactivate</button>}<button className="text danger" onClick={()=>remove(row)}>Delete</button></div>:undefined;
  return <PagePanel title="People" subtitle="Register, assign, import and safely manage resident and staff accounts" action={canManage?<div className="row-actions">{user.role==='admin'&&<button className="secondary" onClick={generateSamples}>Create 24-hour sample logins</button>}<button className="secondary" onClick={()=>setShowImport(!showImport)}>Import users</button><button className="primary" onClick={()=>{setShowForm(!showForm);setEditing(null);}}>Add person</button></div>:null}>
    {message&&<Notice tone={/failed|Could not|before|must|cannot|already/i.test(message)?'error':'success'}>{message}</Notice>}
    {temporaryPassword&&<section className="credential-box"><p className="eyebrow">COPY NOW — SHOWN ONCE</p><h3>Temporary password</h3><code>{temporaryPassword}</code><p>Share it securely. The user should change it immediately after signing in.</p><button className="secondary" onClick={()=>navigator.clipboard.writeText(temporaryPassword)}>Copy password</button><button className="text" onClick={()=>setTemporaryPassword('')}>Hide</button></section>}
    {sampleCredentials.length>0&&<section className="credential-box"><p className="eyebrow">24-HOUR SAMPLE LOGINS — SHOWN ONCE</p><h3>All five user categories created</h3><p>Administrator, Manager, Resident, Security and Cashier sample accounts are active for 24 hours.</p><div className="row-actions"><button className="secondary" onClick={downloadSamples}>Download login details</button><button className="text" onClick={()=>setSampleCredentials([])}>Hide</button></div></section>}
    {showForm&&<UserAccountForm actorRole={user.role} properties={available.data?.items ?? []} onDone={(notice)=>{setShowForm(false);setMessage(notice);refresh();}} />}
    {editing&&<UserAccountForm actorRole={user.role} user={editing} properties={available.data?.items ?? []} onDone={(notice)=>{setEditing(null);setMessage(notice);refresh();}} onCancel={()=>setEditing(null)} />}
    {showImport&&<UsersCsvImporter onDone={()=>{refresh();}} />}
    <div className="people-filters"><label>Search<input value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Name, email or phone" /></label><label>Role<select value={role} onChange={(event)=>setRole(event.target.value)}><option value="">All roles</option><option value="resident">Residents</option><option value="security">Security</option><option value="cashier">Cashiers</option><option value="manager">Managers</option><option value="admin">Administrators</option></select></label></div>
    <ListState list={list}><DataTable exportTitle="Residents & Staff" rows={list.data?.items ?? []} columns={[['name','Name'],['role','Role'],['email','Email'],['phone','Phone'],['unit_numbers','Owned'],['rented_units','Rented'],['dependant_units','Dependant at'],['property_count','Owned count'],['status','Status']]} action={actions} /></ListState>
    {canManage&&imports.data&&imports.data.items.length>0&&<section className="import-history"><h3>User import history</h3><DataTable rows={imports.data.items} columns={[['filename','File'],['status','Status'],['total_rows','Rows'],['successful_rows','Created'],['error_rows','Errors'],['created_at','Uploaded','date']]} action={(row)=>row.storage_key?<a className="text" href={`/api/files/${encodeURIComponent(String(row.storage_key))}`}>Download source</a>:null} /></section>}
  </PagePanel>;
}

function UserAccountForm({ actorRole,user,properties,onDone,onCancel }: { actorRole:User['role'];user?:Row;properties:Row[];onDone:(message:string)=>void;onCancel?:()=>void }) {
  const [message,setMessage]=useState('');const [role,setRole]=useState(String(user?.role ?? 'resident'));
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setMessage('');const values=Object.fromEntries(new FormData(event.currentTarget));
    if(!values.propertyId)delete values.propertyId;
    try { await api(user?`/api/users/${user.id}`:'/api/users',{ method:user?'PATCH':'POST',body:JSON.stringify(values) });onDone(user?'Account details updated.':'Account created successfully.'); }
    catch(reason){setMessage(reason instanceof Error?reason.message:'Could not save account');}
  }
  return <FormCard title={user?`Edit ${String(user.name)}`:'New account'} onSubmit={submit} message={message}>
    <label>Name<input name="name" defaultValue={String(user?.name ?? '')} required /></label><label>Email<input name="email" type="email" defaultValue={String(user?.email ?? '')} required /></label><label>Phone<input name="phone" defaultValue={String(user?.phone ?? '')} /></label>
    <label>Role<select name="role" value={role} onChange={(event)=>setRole(event.target.value)}><option value="resident">Resident</option><option value="security">Security</option><option value="cashier">Cashier</option>{actorRole==='admin'&&<><option value="manager">Manager</option><option value="admin">Administrator</option></>}</select></label>
    {user&&<label>Status<select name="status" defaultValue={String(user.status ?? 'active')}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>}
    {role==='resident'&&<label>{user?'Assign another available property (optional)':'Available property (optional)'}<select name="propertyId"><option value="">No property assignment</option>{properties.map((property)=><option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)} — {String(property.address)}</option>)}</select><small>Only properties without an approved owner are listed. Existing ownership is not replaced.</small></label>}
    {!user&&<label>Temporary password<input name="password" type="password" minLength={12} autoComplete="new-password" required /><small>At least 12 characters. The user should change it after first sign-in.</small></label>}
    <div className="row-actions"><button className="primary">{user?'Save changes':'Create account'}</button>{onCancel&&<button type="button" className="secondary" onClick={onCancel}>Cancel</button>}</div>
  </FormCard>;
}

function UsersCsvImporter({ onDone }: { onDone:()=>void }) {
  const [result,setResult]=useState('');const [busy,setBusy]=useState(false);const [credentials,setCredentials]=useState<Array<{ name:string;email:string;temporaryPassword:string }>>([]);
  const template='name,email,phone,role,unit_number,status\nAda Resident,ada@example.com,+2348000000000,resident,A-01,active\nGate Officer,security@example.com,+2348000000001,security,,active\n';
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
  const memberActions = (row:Row) => <div className="row-actions"><EvidenceButton entityType="household_member" entityId={row.id} count={row.proof_count} />{operator&&<>{row.status === 'pending' && <><button className="text" onClick={() => memberAction(row,'approve')}>Approve</button><button className="text danger" onClick={() => memberAction(row,'reject')}>Reject</button></>}{row.status === 'active' && <><button className="text" onClick={() => memberAction(row,'update')}>Permissions</button>{!row.linked_user_id && <button className="text" onClick={() => createMemberLogin(row)}>Add login</button>}<button className="text danger" onClick={() => memberAction(row,'deactivate')}>Deactivate</button></>}</>}</div>;
  return <PagePanel title="Tenancy & household" subtitle="Main tenants, rented apartments, dependants, domestic staff and delegated permissions" action={<div className="row-actions"><button className="secondary" onClick={() => setShowMember(!showMember)}>Add dependant</button><button className="primary" onClick={() => setShowTenancy(!showTenancy)}>{operator ? 'Assign tenant' : 'Nominate tenant'}</button></div>}>
    <Notice tone="info"><strong>Rented apartment:</strong> legal ownership remains with the owner. The approved tenant becomes the main resident for the tenancy dates. The administrator chooses whether future property bills go to the owner or tenant.</Notice>
    {message && <Notice tone={message.includes('Could not') || message.includes('failed') ? 'error' : 'success'}>{message}</Notice>}
    {showTenancy && <FormCard title={operator ? 'Assign a tenant' : 'Nominate a tenant for approval'} onSubmit={addTenancy}><label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.owner_name ?? property.relationship_type)}</option>)}</select></label><label>Tenant email<input name="tenantEmail" type="email" required /></label><label>Start date<input name="startDate" type="date" required /></label><label>End date<input name="endDate" type="date" /></label><label>Bill responsibility<select name="billingResponsibility"><option value="owner">Legal owner</option><option value="tenant">Main tenant</option></select></label><label className="span-2">Note<textarea name="requestNote" rows={3} /></label><ProofFilesField label="Tenancy agreement or authority proof (recommended)" /><button className="primary">{operator ? 'Assign tenant' : 'Submit nomination'}</button></FormCard>}
    {showMember && <FormCard title="Add a dependant or household member" onSubmit={addMember}><label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.main_resident_name ?? property.owner_name)}</option>)}</select></label>{operator && <label>Main resident ID<input name="primaryResidentId" placeholder="Optional; resolved automatically" /></label>}<label>Full name<input name="name" required /></label><label>Relationship<select name="relationship"><option value="spouse">Spouse</option><option value="child">Child</option><option value="parent">Parent</option><option value="relative">Relative</option><option value="domestic_staff">Domestic staff</option><option value="caregiver">Caregiver</option><option value="other">Other</option></select></label><label>Date of birth<input name="dateOfBirth" type="date" /></label><label>Phone<input name="phone" /></label><label>Email<input name="email" type="email" /></label><label className="check"><input name="canCreateVisitors" type="checkbox" /> May create visitors after login</label><label className="check"><input name="canViewBills" type="checkbox" /> May view bills after login</label><label className="span-2">Note<textarea name="requestNote" rows={3} /></label><ProofFilesField label="Identity, relationship or consent proof (recommended)" /><button className="primary">{operator ? 'Add member' : 'Submit for approval'}</button></FormCard>}
    {operator && (pendingTenancies.length > 0 || pendingMembers.length > 0) && <section className="approval-queue"><h3>Pending residency approvals</h3><p>{pendingTenancies.length} tenancy nomination(s) and {pendingMembers.length} household member(s) are waiting.</p></section>}
    <section className="residency-section"><h3>Tenancies</h3><ListState list={tenancies}><DataTable exportTitle="Tenancies" rows={tenancies.data?.items ?? []} columns={[['unit_number','Unit'],['owner_name','Legal owner'],['tenant_name','Main tenant'],['start_date','Starts'],['end_date','Ends'],['billing_responsibility','Bill payer'],['status','Status']]} action={tenancyActions} /></ListState></section>
    <section className="residency-section"><h3>Dependants and household members</h3><ListState list={household}><DataTable exportTitle="Household Members" rows={household.data?.items ?? []} columns={[['name','Name'],['relationship','Relationship'],['unit_number','Unit'],['primary_resident_name','Main resident'],['login_email','Login'],['can_create_visitors','Visitors'],['can_view_bills','Bills'],['status','Status']]} action={memberActions} /></ListState></section>
  </PagePanel>;
}


const operationImportDefinitions={
  properties:{ label:'Properties',description:'Create streets, units, blocks and zones before assigning residents.',template:'unit_number,address,street,block,zone\nA-01,1 Palm Avenue,Palm Avenue,Block A,North\n' },
  ownerships:{ label:'Property ownerships',description:'Assign existing available properties to existing active resident accounts.',template:'resident_email,unit_number\nresident@example.com,A-01\n' },
  tenancies:{ label:'Tenancies',description:'Import current or historical main tenancies and bill responsibility.',template:'tenant_email,unit_number,start_date,end_date,billing_responsibility,status,can_manage_visitors,can_manage_maintenance,note\ntenant@example.com,A-01,2026-01-01,2026-12-31,tenant,active,true,true,Opening balance migration\n' },
  cards:{ label:'Access cards',description:'Register known card numbers for active residents and queue hardware synchronization.',template:'resident_email,card_uid,card_label,status,expires_at\nresident@example.com,10000001,Main card,active,2027-12-31\n' },
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
      setResult('Pass created. Share the QR/barcode and unique number with the visitor.');setShow(false);list.reload();
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
  useEffect(()=>{
    if (!deviceSession?.id || deviceSession.status==='captured') return;
    const timer=setInterval(()=>api<Row>(`/api/visitors/device-scan-sessions/${deviceSession.id}`).then((session)=>{
      setDeviceSession(session);if(session.status==='captured'&&session.captured_credential)previewCode(String(session.captured_credential),'device');
    }).catch(()=>undefined),2000);
    return ()=>clearInterval(timer);
  },[deviceSession?.id,deviceSession?.status,previewCode]);

  const staff=user.role==='security'||user.role==='admin'||user.role==='manager';
  return <PagePanel title="Visitors" subtitle="QR/barcode passes, preview-before-entry decisions and auditable arrivals" action={(user.role === 'resident' || user.role === 'admin' || user.role === 'manager') ? <button className="primary" onClick={() => setShow(!show)}>New pass</button> : null}>
    {result && <Notice tone={result.includes('created')||result.includes('Accepted')?'success':result.includes('Waiting')?'info':'error'}>{result}</Notice>}
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
    <ListState list={list}><DataTable exportTitle="Visitor Passes" rows={(list.data?.items ?? []).map((row)=>({ ...row,gates:String(row.gate_scope ?? 'both')==='gate'?'Selected gate only':'Every gate, entry and exit' }))} columns={[['visitor_name','Visitor'],['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['credential_number','Unique number'],...(staff?[['gates','Gates'],['device_name','Preferred device']] as Column[]:[]),['status','Status'],['valid_until','Valid until','date']]} action={(row)=><div className="row-actions"><button className="text" onClick={()=>setSelectedPass(row)}>View pass</button><EvidenceButton entityType="visitor_request" entityId={row.id} count={row.proof_count} /></div>} /></ListState>
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

function Cards({ user }: { user: User }) {
  const operator=user.role==='admin'||user.role==='manager';
  const list = useList('/api/access/cards?limit=50');
  const devices=useAsync<{ items:Row[] }>(()=>operator?api('/api/access/device-options'):Promise.resolve({ items:[] }),[user.role]);
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState('');
  const [mode,setMode]=useState<'device'|'manual'>('device');
  const [scanSession,setScanSession]=useState<Row|null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const form=new FormData(event.currentTarget);const values=Object.fromEntries(form);
    try {
      if(mode==='device') {
        const session=await api<Row>('/api/access/card-scan-sessions',{ method:'POST',body:JSON.stringify({ deviceId:form.get('deviceId'),residentId:form.get('residentId')||undefined,householdMemberId:form.get('householdMemberId')||undefined,cardLabel:form.get('cardLabel') }) });
        setScanSession(session);setMessage('Waiting for the card to be tapped or scanned at the selected access-control device.');
      } else {
        await api('/api/access/cards', { method: 'POST', body: JSON.stringify(values) }); setShow(false);setMessage('Card issued and hardware actions queued.');list.reload();
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
    try { const card=await api<Row>(`/api/access/card-scan-sessions/${scanSession.id}/complete`,{ method:'POST' });setMessage(`Card ${String(card.cardUid)} issued and synchronized to the hardware-action queue.`);setScanSession(null);setShow(false);list.reload(); }
    catch(reason){setMessage(reason instanceof Error?reason.message:'Could not issue scanned card');}
  }
  async function cancelScan(){if(scanSession?.id)await api(`/api/access/card-scan-sessions/${scanSession.id}`,{ method:'DELETE' });setScanSession(null);setMessage('Card scan cancelled.');}
  async function change(id: unknown, status: string) {
    if (!confirm(`Set this card to ${status}?`)) return;
    await api(`/api/access/cards/${id}`, { method: 'PATCH', body: JSON.stringify({ status, reason: 'Portal administrator action' }) }); list.reload();
  }
  const actions = operator ? (row: Row) => <div className="row-actions">{row.status === 'active' ? <button className="text danger" onClick={() => change(row.id, 'suspended')}>Suspend</button> : <button className="text" onClick={() => change(row.id, 'active')}>Activate</button>}</div> : undefined;
  return <PagePanel title="Access cards" subtitle="Enroll by tapping a selected device, or enter a known card number manually" action={operator ? <button className="primary" onClick={() => setShow(!show)}>Issue card</button> : null}>
    {message && <Notice tone={message.includes('issued')?'success':message.includes('Waiting')?'info':'error'}>{message}</Notice>}
    {show && <FormCard title="Issue a physical card" onSubmit={submit}><label>Enrollment method<select value={mode} onChange={(event)=>setMode(event.target.value as 'device'|'manual')}><option value="device">Tap/scan at selected device (recommended)</option><option value="manual">Enter card UID manually</option></select></label>{mode==='device'&&<label>Access-control device<select name="deviceId" required><option value="">Select device</option>{devices.data?.items.map((device)=><option key={String(device.id)} value={String(device.id)}>{String(device.name)} — {String(device.model||device.vendor)} — {String(device.gate_name)}</option>)}</select></label>}<label>Main resident ID<input name="residentId" placeholder="Use this for a main resident" /></label><label>Household member ID<input name="householdMemberId" placeholder="Or use this for a dependant" /></label>{mode==='manual'&&<label>Card UID / number<input name="cardUid" required /></label>}<label>Label<input name="cardLabel" placeholder="Optional card label" /></label><button className="primary">{mode==='device'?'Start scan':'Issue card'}</button></FormCard>}
    {scanSession&&<section className={`enrollment-session ${String(scanSession.status)}`}><p className="eyebrow">DEVICE CARD ENROLLMENT</p><h3>{scanSession.status==='captured'?'Card detected':'Waiting for a card…'}</h3>{Boolean(scanSession.captured_credential)&&<strong className="credential-number">{String(scanSession.captured_credential)}</strong>}<p>Present the card at the selected device. EstateMate captures the next card credential event, including a denied unknown-card event.</p><div className="row-actions">{scanSession.status==='captured'&&<button className="primary" onClick={completeScan}>Confirm and issue card</button>}<button className="secondary" onClick={cancelScan}>Cancel</button></div></section>}
    <ListState list={list}><DataTable exportTitle="Access Cards" rows={list.data?.items ?? []} columns={[['resident_name','Main resident'],['household_member_name','Card holder'],['relationship','Relationship'],['unit_number','Unit'],['card_uid','Card UID'],['card_label','Label'],['status','Status'],['deactivated_reason','Reason'],['updated_at','Updated','date']]} action={actions} /></ListState>
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
    const hikconnectServerAddress=prompt('Hik-Connect access server hostname/IP (optional)',String(row.hikconnect_server_address??''))??String(row.hikconnect_server_address??'');
    const hikconnectDeviceSerial=prompt('Hik-Connect device serial (optional)',String(row.hikconnect_device_serial??serialNumber))??String(row.hikconnect_device_serial??serialNumber);
    const hikconnectVerificationCode=prompt(row.hikconnect_verification_code_configured?'New Hik-Connect verification code (leave blank to keep current)':'Hik-Connect verification code (optional)','')??'';
    try { await api(`/api/access/devices/${row.id}`,{ method:'PATCH',body:JSON.stringify({ name,vendor,gateName,model,firmware,serialNumber,hikconnectServerAddress,hikconnectDeviceSerial,hikconnectVerificationCode: hikconnectVerificationCode || undefined,direction:row.direction,profileKey:row.profile_key,connectionPattern:row.connection_pattern,listenerFormat:row.listener_format,status:row.status }) });list.reload(); }
    catch(reason){setError(reason instanceof Error?reason.message:'Device update failed');}
  }
  async function remove(row:Row) { if(!confirm(`Delete ${String(row.name)}? Credentials will be revoked while historical gate events remain.`))return;try{await api(`/api/access/devices/${row.id}`,{ method:'DELETE' });list.reload();setError('');}catch(reason){setError(reason instanceof Error?reason.message:'Delete failed');} }
  async function rotate(row:Row){if(!confirm(`Rotate the ingest secret for ${String(row.name)}? The old endpoint will stop working immediately.`))return;try{setCredentials(await api<Row>(`/api/access/devices/${row.id}/rotate-secret`,{ method:'POST' }));}catch(reason){setError(reason instanceof Error?reason.message:'Secret rotation failed');}}
  async function downloadSiteSync(row:Row){if(!confirm(`Generate a new one-time site synchronizer for ${String(row.name)}? Any previously generated site-sync key for this device will stop working.`))return;setError('');try{const response=await fetch(`/api/access/devices/${row.id}/site-sync-installer`,{ method:'POST',credentials:'include' });if(!response.ok){const data=await response.json().catch(()=>({ error:`Request failed (${response.status})` })) as { error?:string };throw new Error(data.error||`Request failed (${response.status})`);}const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`estatemate-site-sync-${String(row.id).slice(0,8)}.sh`;link.click();URL.revokeObjectURL(url);}catch(reason){setError(reason instanceof Error?reason.message:'Could not generate site synchronizer');}}
  return <PagePanel title="Access-control devices" subtitle="Hikvision MinMoe, card/fingerprint terminals, DS-K2800 controllers and validated third-party devices" action={operator?<button className="primary" onClick={() => setShow(!show)}>Register device</button>:null}>
    <Notice tone="warning"><strong>Gateway choice:</strong> direct HTTPS Listening needs no local hardware but is usually event-only. Two-way ISUP can use a small headless x86_64 Ubuntu gateway appliance on the device LAN; Arduino/ESP32 cannot run the official Linux SDK, and Raspberry Pi requires an ARM64 SDK from Hikvision. Never expose ISAPI directly to the Internet.</Notice>
    <Notice tone="info"><strong>Hik-Connect:</strong> save the terminal’s access-server hostname/IP, device serial and verification code here. The code is encrypted and never displayed again. These details alone do not grant third-party command access; official ISUP SDK or approved Hikvision OpenAPI credentials are still required.</Notice>
    {error && <Notice tone="error">{error}</Notice>}
    {credentials && <section className="credential-box"><p className="eyebrow">COPY NOW — SHOWN ONCE</p><h3>Device event endpoint</h3><code>{String(credentials.endpoint)}</code>{Boolean(credentials.workerEndpoint)&&<p>Direct Worker fallback: <code>{String(credentials.workerEndpoint)}</code></p>}<p>Profile: <code>{String((credentials.profile as Row | undefined)?.label ?? '')}</code></p><p>Connection: <code>{String(credentials.connectionPattern??'')}</code></p>{Boolean(credentials.username)&&<p>Username: <code>{String(credentials.username)}</code></p>}<p>Secret: <code>{String(credentials.secret)}</code></p><p>{String(credentials.warning??'')}</p><button className="secondary" onClick={() => navigator.clipboard.writeText(String(credentials.endpoint))}>Copy endpoint</button></section>}
    {show && <FormCard title="Register an Internet-connected access device" onSubmit={submit}>
      <label>Display name<input name="name" placeholder="Gate 1 terminal" required /></label><label>Vendor<input name="vendor" defaultValue="Hikvision" /></label>
      <label>Gate name<input name="gateName" placeholder="Main gate" required /></label>
      <label>Direction<select name="direction"><option value="entry">Entry</option><option value="exit">Exit</option><option value="both">Both</option></select></label>
      <label>Model<input name="model" list="access-models" placeholder="DS-K1T808MFWX-B or DS-K2802" /><datalist id="access-models"><option value="DS-K1T808MFWX-B" /><option value="DS-K2802" /><option value="DS-K2602T" /><option value="DS-K1T807EBWX-QRE1" /><option value="DS-K1T502DBWX-QRE1" /><option value="DS-K1T341CMFW" /><option value="DS-K1T671M" /><option value="DS-K1T680DFG" /></datalist></label>
      <label>Firmware<input name="firmware" placeholder="Full version and build" /></label><label>Serial number<input name="serialNumber" /></label>
      <label>Hik-Connect access server<input name="hikconnectServerAddress" placeholder="dev.hik-connect.com or server IP" /></label><label>Hik-Connect device serial<input name="hikconnectDeviceSerial" /></label><label>Hik-Connect verification code<input name="hikconnectVerificationCode" type="password" minLength={6} maxLength={32} autoComplete="new-password" /><small>Encrypted at rest and never returned by the API.</small></label>
      <label>Series profile<select name="profileKey"><option value="auto">Auto-detect from model (recommended)</option>{profiles.data?.items.map((profile) => <option key={String(profile.key)} value={String(profile.key)}>{String(profile.label)}</option>)}</select></label>
      <label>Connection pattern<select name="connectionPattern"><option value="">Use profile recommendation (recommended)</option><option value="direct_http_listener">Direct Cloudflare HTTP Listening</option><option value="render_http_bridge">Render free HTTPS relay (optional; sleeps)</option><option value="hikvision_cloud_openapi">Hikvision cloud/OpenAPI</option><option value="offsite_isup_gateway">Dedicated ISUP gateway (local appliance or off-site)</option><option value="isapi_bridge">ISAPI bridge (cross-platform)</option><option value="windows_agent">Windows agent (ISAPI)</option><option value="isapi_windows_agent">ISAPI Windows agent (combined)</option><option value="manual_sync">Manual synchronization</option></select></label>
      <label>Listener format<select name="listenerFormat"><option value="auto">Auto-detect</option><option value="json">JSON</option><option value="xml">XML</option><option value="multipart">Multipart</option></select></label>
      <button className="primary">Register</button>
    </FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['name','Device'],['vendor','Vendor'],['model','Model'],['profile_key','Series profile'],['connection_pattern','Connection'],['hikconnect_server_address','Hik-Connect server'],['hikconnect_verification_code_configured','Verification code'],['sync_agent_configured','Site sync'],['isapi_agent_name','ISAPI agent'],['isapi_host','ISAPI host'],['last_isapi_sync_status','ISAPI sync'],['gate_name','Gate'],['direction','Direction'],['status','Status'],['last_seen_at','Last event','date'],['pending_operations','Manual pending'],['queued_operations','Queued ops']]} action={operator?(row)=><div className="row-actions"><button className="text" onClick={()=>edit(row)}>Edit</button>{row.connection_pattern==='offsite_isup_gateway'&&<button className="text" onClick={()=>downloadSiteSync(row)}>Download site sync</button>}{user.role==='admin'&&<button className="text" onClick={()=>rotate(row)}>Rotate ingest secret</button>}<button className="text danger" onClick={()=>remove(row)}>Delete</button></div>:undefined} /></ListState>
  </PagePanel>;
}

function IsapiBridge({ user }: { user: User }) {
  const operator = user.role === 'admin' || user.role === 'manager';
  const agents = useList('/api/isapi/agents');
  const deviceConfigs = useList('/api/isapi/device-configs');
  const devices = useAsync<{ items: Row[] }>(() => api('/api/access/device-options'), []);
  const logs = useList('/api/isapi/sync-logs?limit=50');
  const [showAgent, setShowAgent] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [credentials, setCredentials] = useState<Row | null>(null);
  const [error, setError] = useState('');

  async function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string,string>;
    try {
      const result = await api<Row>('/api/isapi/agents', { method: 'POST', body: JSON.stringify(values) });
      setCredentials(result); setShowAgent(false); agents.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Failed to create agent'); }
  }

  async function rotateAgent(row: Row) {
    if (!confirm(`Rotate secret for agent ${String(row.name)}? Old secret stops working immediately.`)) return;
    try { setCredentials(await api<Row>(`/api/isapi/agents/${row.id}/rotate-secret`, { method: 'POST' })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Rotate failed'); }
  }

  async function downloadInstaller(row: Row) {
    if (!confirm(`Generate new installer for ${String(row.name)}? Previous installer keys will be invalidated and secret rotated.`)) return;
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

  return <PagePanel title="ISAPI Bridge & Windows Agent" subtitle="Windows service and cross-platform ISAPI bridge for automatic card provisioning" action={operator ? <div className="row-actions"><button className="primary" onClick={() => setShowAgent(!showAgent)}>Register agent</button><button className="secondary" onClick={() => setShowLink(!showLink)}>Link device to agent</button></div> : null}>
    <Notice tone="info"><strong>What this does:</strong> Install a small agent on a Windows PC (or Linux) on the same LAN as Hikvision devices. The agent polls Cloudflare for pending card operations (facility-fee expiry, new cards) and applies them via ISAPI (HTTP Digest) directly to the device. No SDK required. Keep ISAPI devices and agent on same VLAN; never expose ISAPI to the Internet.</Notice>
    <Notice tone="warning"><strong>Connection patterns:</strong> For devices managed by this bridge, set connection pattern to <code>isapi_bridge</code>, <code>windows_agent</code>, or <code>isapi_windows_agent</code>. Operations will then be queued as <code>pending</code> instead of <code>manual_action_required</code> and picked up by the linked agent.</Notice>
    {error && <Notice tone="error">{error}</Notice>}
    {credentials && <section className="credential-box"><p className="eyebrow">COPY NOW — SHOWN ONCE</p><h3>ISAPI Agent Secret</h3><p>Name: <code>{String(credentials.name)}</code></p><p>Platform: <code>{String(credentials.platform)}</code></p>{Boolean(credentials.secret) && <p>Secret: <code>{String(credentials.secret)}</code></p>}<p>{String(credentials.warning ?? '')}</p><button className="secondary" onClick={() => navigator.clipboard.writeText(String(credentials.secret))}>Copy secret</button></section>}
    {showAgent && <FormCard title="Register ISAPI bridge / Windows agent" onSubmit={submitAgent}>
      <label>Agent name<input name="name" placeholder="Estate Office Windows PC" required /></label>
      <label>Hostname<input name="hostname" placeholder="WIN-OFFICE-01 or 192.168.1.10" /></label>
      <label>Platform<select name="platform"><option value="windows">Windows (recommended)</option><option value="linux">Linux</option><option value="darwin">macOS</option><option value="other">Other</option></select></label>
      <label>Version<input name="version" placeholder="1.0.0" /></label>
      <button className="primary">Register agent</button>
    </FormCard>}
    {showLink && <FormCard title="Link device to ISAPI agent" onSubmit={submitLink}>
      <label>Device<select name="deviceId" required><option value="">Select device</option>{devices.data?.items.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.gate_name)} — {String(d.name)} ({String(d.model)}) [{String(d.connection_pattern)}]</option>)}</select></label>
      <label>Agent<select name="agentId"><option value="">Select agent (optional - can set later)</option>{agents.data?.items.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.name)} — {String(a.platform)} ({String(a.status)})</option>)}</select></label>
      <label>ISAPI host (LAN IP)<input name="isapiHost" placeholder="192.168.1.100" required /></label>
      <label>ISAPI port<input name="isapiPort" type="number" min={1} max={65535} defaultValue={80} /></label>
      <label>ISAPI username<input name="isapiUsername" defaultValue="admin" /></label>
      <label>ISAPI password<input name="isapiPassword" type="password" placeholder="Device admin password" /><small>Encrypted at rest, never returned.</small></label>
      <label>Protocol<select name="protocol"><option value="http">HTTP (port 80)</option><option value="https">HTTPS (port 443)</option></select></label>
      <label>Sync enabled<input name="syncEnabled" type="checkbox" defaultChecked /></label>
      <button className="primary">Link device</button>
    </FormCard>}

    <section className="panel"><div className="panel-title"><div><p className="eyebrow">Registered agents</p><h3>ISAPI bridge agents</h3></div><button className="secondary sm" onClick={() => agents.reload()}>Refresh</button></div>
      <ListState list={agents}><DataTable rows={agents.data?.items ?? []} columns={[['name','Agent'],['hostname','Hostname'],['platform','Platform'],['status','Status'],['last_seen_at','Last heartbeat','date'],['last_ip','Last IP'],['linked_devices','Linked devices'],['pending_operations','Pending ops']]} action={operator ? (row) => <div className="row-actions"><button className="text" onClick={() => downloadInstaller(row)}>Download installer</button>{user.role==='admin' && <button className="text" onClick={() => rotateAgent(row)}>Rotate secret</button>}<button className="text danger" onClick={() => removeAgent(row)}>Delete</button></div> : undefined} /></ListState>
    </section>

    <section className="panel"><div className="panel-title"><div><p className="eyebrow">Device mappings</p><h3>ISAPI device configs</h3></div><button className="secondary sm" onClick={() => deviceConfigs.reload()}>Refresh</button></div>
      <ListState list={deviceConfigs}><DataTable rows={deviceConfigs.data?.items ?? []} columns={[['device_name','Device'],['gate_name','Gate'],['connection_pattern','Connection'],['device_status','Device status'],['isapi_host','ISAPI host'],['isapi_port','Port'],['isapi_username','ISAPI user'],['protocol','Protocol'],['sync_enabled','Sync enabled'],['agent_name','Agent'],['agent_status','Agent status'],['last_sync_at','Last sync','date'],['last_sync_status','Sync status'],['last_error','Last error']]} action={operator ? (row) => <div className="row-actions"><button className="text danger" onClick={() => removeLink(row)}>Remove</button></div> : undefined} /></ListState>
    </section>

    <section className="panel"><div className="panel-title"><div><p className="eyebrow">Audit trail</p><h3>ISAPI sync logs (recent 50)</h3></div><button className="secondary sm" onClick={() => logs.reload()}>Refresh</button></div>
      <ListState list={logs}><DataTable rows={logs.data?.items ?? []} columns={[['created_at','Time','date'],['device_name','Device'],['agent_name','Agent'],['operation_type','Operation'],['status','Status'],['message','Message'],['duration_ms','Duration ms']]} /></ListState>
    </section>

    <section className="panel callout"><p className="eyebrow">Windows agent quick reference</p><h3>Install on Windows (Administrator PowerShell)</h3>
      <ol>
        <li>Register agent above and <strong>Download installer</strong> (PowerShell <code>.ps1</code>).</li>
        <li>Run installer as Administrator: <code>powershell -ExecutionPolicy Bypass -File .\estatemate-isapi-agent-xxxx.ps1</code></li>
        <li>Edit <code>C:\EstateMate\ISAPI-Agent\isapi-devices.json</code> with LAN IPs and ISAPI passwords.</li>
        <li>Install Node.js 22+ and copy <code>isapi-bridge/agent.mjs</code> to agent folder, or use compiled exe.</li>
        <li>Create service: <code>sc.exe create EstateMateISAPIAgent binPath= &quot;C:\Program Files\nodejs\node.exe C:\EstateMate\ISAPI-Agent\agent.mjs --config C:\EstateMate\ISAPI-Agent\agent-config.json&quot; start= auto</code></li>
        <li><code>sc.exe start EstateMateISAPIAgent</code> and verify in portal that agent shows <code>online</code>.</li>
      </ol>
      <p><strong>Test ISAPI manually:</strong> <code>curl --digest -u admin:password http://192.168.1.100/ISAPI/System/deviceInfo</code></p>
      <p><strong>Security:</strong> Keep agent and devices on same VLAN, no port forwarding. Config ACL restricted to Administrators.</p>
    </section>
  </PagePanel>;
}

function Operations() {
  const list = useList('/api/access/operations?limit=100');
  async function mark(id: unknown, status: 'applied'|'failed') { await api(`/api/access/operations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); list.reload(); }
  return <PagePanel title="Hardware actions" subtitle="Changes that must reach each physical terminal">
    <Notice tone="warning">With HTTP Listening only, apply these changes in the terminal UI, iVMS-4200, or an approved Hikvision cloud command channel. Then mark them applied here.</Notice>
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['device_name','Device'],['credential_kind','Credential'],['operation','Action'],['card_uid','Number'],['status','Status'],['created_at','Created','date'],['error_message','Error']]} action={(row) => <div className="row-actions"><button className="text" onClick={() => mark(row.id, 'applied')}>Mark applied</button><button className="text danger" onClick={() => mark(row.id, 'failed')}>Failed</button></div>} /></ListState>
  </PagePanel>;
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
    {portal.data&&<FormCard title="Portal identity, theme and recommended defaults" onSubmit={savePortal}><label>Portal name<input name="portal_name" defaultValue={portal.data.portal_name||'EstateMate'} required /></label><label>Estate name<input name="estate_name" defaultValue={portal.data.estate_name||'EstateMate Estate'} required /></label><label>Short mark<input name="portal_short_name" maxLength={4} defaultValue={portal.data.portal_short_name||'EM'} required /></label><label>Tagline<input name="portal_tagline" defaultValue={portal.data.portal_tagline} /></label><label className="span-2">Welcome text<textarea name="portal_welcome_text" rows={3} defaultValue={portal.data.portal_welcome_text} /></label><label>Theme mode<select name="theme_mode" defaultValue={portal.data.theme_mode||'light'}><option value="light">Light (recommended)</option><option value="dark">Dark</option><option value="system">Follow device</option></select></label><label>Corner style<select name="theme_corner_style" defaultValue={portal.data.theme_corner_style||'comfortable'}><option value="comfortable">Comfortable (recommended)</option><option value="compact">Compact</option><option value="rounded">Rounded</option></select></label><label>Primary colour<input name="theme_primary_color" type="color" defaultValue={portal.data.theme_primary_color||'#1769e0'} /></label><label>Accent colour<input name="theme_accent_color" type="color" defaultValue={portal.data.theme_accent_color||'#35d07f'} /></label><label>Navigation colour<input name="theme_navigation_color" type="color" defaultValue={portal.data.theme_navigation_color||'#0d1b37'} /></label><label>Surface colour<input name="theme_surface_color" type="color" defaultValue={portal.data.theme_surface_color||'#ffffff'} /></label><label>Support email<input name="support_email" type="email" defaultValue={portal.data.support_email} /></label><label>Support phone<input name="support_phone" defaultValue={portal.data.support_phone} /></label><label>Timezone<input name="estate_timezone" defaultValue={portal.data.estate_timezone||'Africa/Lagos'} /></label><label>Currency<input name="currency" defaultValue={portal.data.currency||'NGN'} maxLength={3} /></label><label>Default visitor hours<input name="visitor_default_duration_hours" type="number" min="1" max="168" defaultValue={portal.data.visitor_default_duration_hours||'8'} /></label><label>Gate decision policy<select name="visitor_gate_policy" defaultValue="security_approval"><option value="security_approval">Show details, then Security approves (recommended)</option></select></label><label>Visitor credential format<select name="visitor_credential_format" defaultValue="qr_code128_pin"><option value="qr_code128_pin">QR + Code 128 + PIN (recommended)</option></select></label><label>Card scan timeout (minutes)<input name="card_scan_timeout_minutes" type="number" min="1" max="30" defaultValue={portal.data.card_scan_timeout_minutes||'5'} /></label><label className="span-2">Render bridge HTTPS origin<input name="render_bridge_url" type="url" placeholder="https://estatemate-access-bridge.onrender.com" defaultValue={portal.data.render_bridge_url} /><small>Optional HTTPS event relay only. It sleeps after 15 idle minutes and cannot host ISUP/TCP; use the dedicated Linux gateway package for two-way ISUP.</small></label><button className="primary">Save portal customisation</button></FormCard>}
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

function useList(url: string) {
  return useAsync<ListResponse<Row>>(() => api(url), [url]);
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

type Column = [string, string, ('date'|'money')?];
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

function cell(value: unknown, key: string, format?: 'date'|'money'): ReactNode {
  if (format === 'date') return readableDate(value);
  if (format === 'money') return money(value);
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
  return ({ dashboard: '◫', residents: '●', properties: '⌂', residency: '♙', imports: '⇩', bills: '₦', visitors: '↔', maintenance: '◇', notices: '!', cards: '▤', events: '⌁', devices: '▣', isapi: '⧉', operations: '↻', settings: '⚙' })[section] ?? '•';
}

export default App;
