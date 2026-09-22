import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, ListResponse, User, api, money, readableDate } from './api';

type Row = Record<string, unknown>;
type Section = 'dashboard' | 'residents' | 'properties' | 'bills' | 'visitors' | 'maintenance' | 'community' | 'cards' | 'events' | 'devices' | 'operations' | 'settings';

interface NavItem { id: Section; label: string; roles?: User['role'][] }
const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'residents', label: 'People', roles: ['admin', 'cashier', 'security'] },
  { id: 'properties', label: 'Properties', roles: ['admin', 'cashier', 'security'] },
  { id: 'bills', label: 'Bills & payments', roles: ['admin', 'cashier', 'resident'] },
  { id: 'visitors', label: 'Visitors' },
  { id: 'maintenance', label: 'Maintenance', roles: ['admin', 'resident'] },
  { id: 'community', label: 'Community' },
  { id: 'cards', label: 'Access cards', roles: ['admin', 'cashier', 'resident'] },
  { id: 'events', label: 'Gate activity', roles: ['admin', 'security', 'resident'] },
  { id: 'devices', label: 'MinMoe devices', roles: ['admin', 'security'] },
  { id: 'operations', label: 'Hardware actions', roles: ['admin'] },
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

function Login({ onLogin }: { onLogin: (user: User) => void }) {
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
      <div className="brand-mark">EM</div>
      <p className="eyebrow">ONE ESTATE. ONE VIEW.</p>
      <h1>Welcome to<br />EstateMate.</h1>
      <p className="auth-intro">Manage residents, visitors, accounts and gate access from a single, secure workspace.</p>
      <div className="brand-proof"><span className="pulse-dot" /> Cloud and gate operations connected</div>
    </section>
    <section className="auth-panel form-panel">
      <form className="login-card" onSubmit={submit}>
        <span className="mini-logo">EM</span>
        <h2>Sign in</h2>
        <p>Use the account issued by your estate administrator.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
        <button className="primary wide" disabled={loading}>{loading ? 'Signing in…' : 'Continue'}</button>
        <small>Protected by an encrypted, role-based session.</small>
      </form>
    </section>
  </main>;
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info'|'error'|'success'|'warning' }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [section, setSection] = useState<Section>('dashboard');
  const [checking, setChecking] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api<{ user: User }>('/api/auth/me').then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setChecking(false));
  }, []);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }

  if (checking) return <div className="splash"><div className="brand-mark">EM</div><span>Loading EstateMate…</span></div>;
  if (!user) return <Login onLogin={setUser} />;

  const availableNav = navItems.filter((item) => !item.roles || item.roles.includes(user.role));
  const current = availableNav.find((item) => item.id === section) ?? availableNav[0]!;
  if (current.id !== section) setSection(current.id);

  return <div className="app-shell">
    <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
      <header className="side-brand"><span className="mini-logo">EM</span><strong>EstateMate</strong><button className="icon-button close-menu" onClick={() => setMenuOpen(false)}>×</button></header>
      <p className="nav-caption">WORKSPACE</p>
      <nav>{availableNav.map((item) => <button key={item.id} className={section === item.id ? 'nav-active' : ''} onClick={() => { setSection(item.id); setMenuOpen(false); }}><span className="nav-icon">{navIcon(item.id)}</span>{item.label}</button>)}</nav>
      <footer className="user-card"><span className="avatar">{initials(user.name)}</span><span><strong>{user.name}</strong><small>{user.role}</small></span><button className="icon-button" title="Sign out" onClick={logout}>↗</button></footer>
    </aside>
    {menuOpen && <button className="scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
    <main className="workspace">
      <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)}>☰</button><div><p className="eyebrow">{user.role} workspace</p><h1>{current.label}</h1></div><div className="top-status"><span className="pulse-dot" /> System online</div></header>
      <div className="content"><SectionView section={section} user={user} /></div>
    </main>
  </div>;
}

function SectionView({ section, user }: { section: Section; user: User }) {
  switch (section) {
    case 'dashboard': return <Dashboard user={user} />;
    case 'residents': return <People user={user} />;
    case 'properties': return <Properties user={user} />;
    case 'bills': return <Bills user={user} />;
    case 'visitors': return <Visitors user={user} />;
    case 'maintenance': return <Maintenance user={user} />;
    case 'community': return <Community user={user} />;
    case 'cards': return <Cards user={user} />;
    case 'events': return <AccessEvents user={user} />;
    case 'devices': return <Devices user={user} />;
    case 'operations': return <Operations />;
    case 'settings': return <Settings />;
  }
}

function Dashboard({ user }: { user: User }) {
  const { data, error, loading } = useAsync<Row>(() => api('/api/dashboard'), [user.id]);
  if (loading) return <Loading />;
  if (error) return <Notice tone="error">{error}</Notice>;
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
    <section className="hero-card"><div><p className="eyebrow">Tuesday operations</p><h2>Good day, {user.name.split(' ')[0]}.</h2><p>Here is the latest picture across your estate.</p></div><div className="hero-orb"><span>EM</span></div></section>
    <section className="stat-grid">{cards.map(([label, value, detail]) => <article className="stat-card" key={String(label)}><p>{label}</p><strong>{String(value ?? 0)}</strong><small>{detail}</small></article>)}</section>
    {user.role === 'resident' && Boolean(data?.latestAnnouncement) && <section className="panel"><div className="panel-title"><div><p className="eyebrow">Latest announcement</p><h3>{String((data?.latestAnnouncement as Row).title)}</h3></div></div><p>{String((data?.latestAnnouncement as Row).body)}</p></section>}
    {user.role !== 'resident' && <section className="split-grid"><article className="panel callout"><p className="eyebrow">HARDWARE MODE</p><h3>Direct MinMoe event upload</h3><p>Terminals post gate events straight to Cloudflare. Card changes remain in the hardware-action queue until a supported command channel is confirmed.</p></article><article className="panel"><p className="eyebrow">OPERATIONS TIP</p><h3>Check unresolved device actions</h3><p>HTTP Listening is upload-only on most firmware. Mark each manual terminal update as applied to preserve an accurate audit trail.</p></article></section>}
  </>;
}

function People({ user }: { user: User }) {
  const list = useList('/api/users?limit=50');
  const [showForm, setShowForm] = useState(false);
  return <PagePanel title="People" subtitle="Resident and staff accounts" action={user.role === 'admin' ? <button className="primary" onClick={() => setShowForm(!showForm)}>Add person</button> : null}>
    {showForm && <CreateUser onDone={() => { setShowForm(false); list.reload(); }} />}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['name','Name'],['role','Role'],['email','Email'],['phone','Phone'],['unit_number','Unit'],['status','Status']]} /></ListState>
  </PagePanel>;
}

function CreateUser({ onDone }: { onDone: () => void }) {
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/users', { method: 'POST', body: JSON.stringify(values) }); onDone(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create user'); }
  }
  return <FormCard title="New account" onSubmit={submit} message={message}>
    <label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label><label>Phone<input name="phone" /></label>
    <label>Role<select name="role"><option value="resident">Resident</option><option value="security">Security</option><option value="cashier">Cashier</option><option value="admin">Administrator</option></select></label>
    <label>Property ID<input name="propertyId" placeholder="Optional UUID" /></label><label>Temporary password<input name="password" type="password" minLength={10} required /></label><button className="primary">Create account</button>
  </FormCard>;
}

function Properties({ user }: { user: User }) {
  const list = useList('/api/properties?limit=50');
  const [show, setShow] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/properties', { method: 'POST', body: JSON.stringify(values) }); setShow(false); list.reload();
  }
  return <PagePanel title="Properties" subtitle="Units, addresses and assignments" action={user.role === 'admin' ? <button className="primary" onClick={() => setShow(!show)}>Add property</button> : null}>
    {show && <FormCard title="New property" onSubmit={submit}><label>Unit number<input name="unitNumber" required /></label><label className="span-2">Address<input name="address" required /></label><button className="primary">Save property</button></FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['unit_number','Unit'],['address','Address'],['owner_name','Owner'],['created_at','Created','date']]} /></ListState>
  </PagePanel>;
}

function Bills({ user }: { user: User }) {
  const list = useList('/api/bills?limit=50');
  return <PagePanel title="Bills & payments" subtitle={user.role === 'resident' ? 'Your charges and payment status' : 'Estate receivables and collections'}>
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['resident_name','Resident'],['unit_number','Unit'],['bill_type','Type'],['amount_minor','Amount','money'],['paid_minor','Paid','money'],['due_date','Due'],['status','Status']]} /></ListState>
  </PagePanel>;
}

function Visitors({ user }: { user: User }) {
  const list = useList('/api/visitors?limit=50');
  const [show, setShow] = useState(false);
  const [result, setResult] = useState('');
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setResult(''); const raw = Object.fromEntries(new FormData(event.currentTarget));
    try { const created = await api<{ pin: string }>('/api/visitors', { method: 'POST', body: JSON.stringify(raw) }); setResult(`Pass created. PIN: ${created.pin}`); list.reload(); }
    catch (reason) { setResult(reason instanceof Error ? reason.message : 'Failed'); }
  }
  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setResult(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { const checked = await api<{ visitor: Row; action: string }>('/api/visitors/check', { method: 'POST', body: JSON.stringify(values) }); setResult(`${String(checked.visitor.visitor_name)} checked ${checked.action}.`); list.reload(); }
    catch (reason) { setResult(reason instanceof Error ? reason.message : 'Failed'); }
  }
  return <PagePanel title="Visitors" subtitle="Issue passes and manage arrivals" action={(user.role === 'resident' || user.role === 'admin') ? <button className="primary" onClick={() => setShow(!show)}>New pass</button> : null}>
    {result && <Notice tone={result.includes('created') || result.includes('checked') ? 'success' : 'error'}>{result}</Notice>}
    {show && <FormCard title="Create visitor pass" onSubmit={create}><label>Visitor name<input name="visitorName" required /></label><label>Phone<input name="visitorPhone" /></label>{user.role === 'admin' && <label>Resident ID<input name="residentId" required /></label>}<label>Valid from<input name="validFrom" type="datetime-local" required /></label><label>Valid until<input name="validUntil" type="datetime-local" required /></label><button className="primary">Issue pass</button></FormCard>}
    {(user.role === 'security' || user.role === 'admin') && <FormCard title="Gate check" onSubmit={check}><label>Six-digit PIN<input name="pin" inputMode="numeric" pattern="[0-9]{6}" required /></label><label>Action<select name="action"><option value="in">Check in</option><option value="out">Check out</option></select></label><button className="primary">Verify pass</button></FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['visitor_name','Visitor'],['resident_name','Resident'],['unit_number','Unit'],['pin','PIN'],['status','Status'],['valid_until','Valid until','date']]} /></ListState>
  </PagePanel>;
}

function Maintenance({ user }: { user: User }) {
  const list = useList('/api/maintenance?limit=50');
  const [show, setShow] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/maintenance', { method: 'POST', body: JSON.stringify(values) }); setShow(false); list.reload();
  }
  return <PagePanel title="Maintenance" subtitle="Requests and work status" action={<button className="primary" onClick={() => setShow(!show)}>New request</button>}>
    {show && <FormCard title="Report a maintenance issue" onSubmit={submit}><label className="span-2">Description<textarea name="description" rows={4} required /></label>{user.role === 'admin' && <label>Resident ID<input name="residentId" required /></label>}<button className="primary">Submit request</button></FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['resident_name','Resident'],['description','Description'],['status','Status'],['ai_urgency','Urgency'],['created_at','Reported','date']]} /></ListState>
  </PagePanel>;
}

function Community({ user }: { user: User }) {
  const list = useList('/api/posts?limit=40');
  const [show, setShow] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const values = Object.fromEntries(form); const body = { ...values, isAnnouncement: form.get('isAnnouncement') === 'on' };
    await api('/api/posts', { method: 'POST', body: JSON.stringify(body) }); setShow(false); list.reload();
  }
  return <PagePanel title="Community" subtitle="News and resident conversations" action={<button className="primary" onClick={() => setShow(!show)}>Write post</button>}>
    {show && <FormCard title="New post" onSubmit={submit}><label>Title<input name="title" required /></label>{user.role === 'admin' && <label className="check"><input name="isAnnouncement" type="checkbox" /> Mark as announcement</label>}<label className="span-2">Message<textarea name="body" rows={4} required /></label><button className="primary">Publish</button></FormCard>}
    <div className="post-grid">{list.data?.items.map((post) => <article className={post.is_announcement ? 'post announcement' : 'post'} key={String(post.id)}>{Boolean(post.is_announcement) && <span className="pill blue">Announcement</span>}<h3>{String(post.title)}</h3><p>{String(post.body)}</p><small>{String(post.author_name)} · {readableDate(post.created_at)}</small></article>)}</div>
  </PagePanel>;
}

function Cards({ user }: { user: User }) {
  const list = useList('/api/access/cards?limit=50');
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/access/cards', { method: 'POST', body: JSON.stringify(values) }); setShow(false); list.reload(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Failed'); }
  }
  async function change(id: unknown, status: string) {
    if (!confirm(`Set this card to ${status}?`)) return;
    await api(`/api/access/cards/${id}`, { method: 'PATCH', body: JSON.stringify({ status, reason: 'Portal administrator action' }) }); list.reload();
  }
  const actions = user.role === 'admin' ? (row: Row) => <div className="row-actions">{row.status === 'active' ? <button className="text danger" onClick={() => change(row.id, 'suspended')}>Suspend</button> : <button className="text" onClick={() => change(row.id, 'active')}>Activate</button>}</div> : undefined;
  return <PagePanel title="Access cards" subtitle="Credential status, fee enforcement and audit" action={user.role === 'admin' ? <button className="primary" onClick={() => setShow(!show)}>Issue card</button> : null}>
    {message && <Notice tone="error">{message}</Notice>}
    {show && <FormCard title="Issue a physical card" onSubmit={submit}><label>Resident ID<input name="residentId" required /></label><label>Card UID / number<input name="cardUid" required /></label><label>Label<input name="cardLabel" placeholder="Household member" /></label><button className="primary">Issue card</button></FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['resident_name','Resident'],['unit_number','Unit'],['card_uid','Card UID'],['card_label','Label'],['status','Status'],['deactivated_reason','Reason'],['updated_at','Updated','date']]} action={actions} /></ListState>
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
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['result','Result'],['person_name','Person'],['employee_no','Employee no.'],['credential_type','Method'],['card_uid','Card'],['device_name','Device'],['access_point_name','Access point'],['door_no','Door'],['direction','Direction'],['device_timestamp','Time','date']]} /></ListState>
  </PagePanel>;
}

function Devices({ user }: { user: User }) {
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
  return <PagePanel title="MinMoe devices" subtitle="Internet-connected terminal health and event ingestion" action={user.role === 'admin' ? <button className="primary" onClick={() => setShow(!show)}>Register device</button> : null}>
    <Notice tone="warning"><strong>No-PC mode:</strong> HTTP Listening sends events to EstateMate, but it does not provide a return command channel. Do not expose the terminal’s ISAPI port to the public Internet.</Notice>
    {error && <Notice tone="error">{error}</Notice>}
    {credentials && <section className="credential-box"><p className="eyebrow">COPY NOW — SHOWN ONCE</p><h3>Device event endpoint</h3><code>{String(credentials.endpoint)}</code><p>Profile: <code>{String((credentials.profile as Row | undefined)?.label ?? '')}</code></p><p>Connection: <code>{String(credentials.connectionPattern)}</code></p><p>Username: <code>{String(credentials.username)}</code></p><p>Secret: <code>{String(credentials.secret)}</code></p><button className="secondary" onClick={() => navigator.clipboard.writeText(String(credentials.endpoint))}>Copy endpoint</button></section>}
    {show && <FormCard title="Register Hikvision access device" onSubmit={submit}>
      <label>Display name<input name="name" placeholder="Gate 1 terminal" required /></label>
      <label>Gate name<input name="gateName" placeholder="Main gate" required /></label>
      <label>Direction<select name="direction"><option value="entry">Entry</option><option value="exit">Exit</option><option value="both">Both</option></select></label>
      <label>Model<input name="model" placeholder="DS-K1T341CMFW" /></label>
      <label>Firmware<input name="firmware" placeholder="Full version and build" /></label>
      <label>Serial number<input name="serialNumber" /></label>
      <label>Series profile<select name="profileKey"><option value="auto">Auto-detect from model</option>{profiles.data?.items.map((profile) => <option key={String(profile.key)} value={String(profile.key)}>{String(profile.label)}</option>)}</select></label>
      <label>Connection pattern<select name="connectionPattern"><option value="direct_http_listener">Direct HTTP Listening</option><option value="hikvision_cloud_openapi">Hikvision cloud/OpenAPI</option><option value="offsite_isup_gateway">Off-site ISUP gateway</option><option value="manual_sync">Manual synchronization</option></select></label>
      <label>Listener format<select name="listenerFormat"><option value="auto">Auto-detect</option><option value="json">JSON</option><option value="xml">XML</option><option value="multipart">Multipart</option></select></label>
      <button className="primary">Register</button>
    </FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['name','Device'],['model','Model'],['profile_key','Series profile'],['connection_pattern','Connection'],['gate_name','Gate'],['direction','Direction'],['status','Status'],['last_seen_at','Last event','date'],['pending_operations','Pending actions']]} /></ListState>
  </PagePanel>;
}

function Operations() {
  const list = useList('/api/access/operations?limit=100');
  async function mark(id: unknown, status: 'applied'|'failed') { await api(`/api/access/operations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); list.reload(); }
  return <PagePanel title="Hardware actions" subtitle="Changes that must reach each physical terminal">
    <Notice tone="warning">With HTTP Listening only, apply these changes in the terminal UI, iVMS-4200, or an approved Hikvision cloud command channel. Then mark them applied here.</Notice>
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['device_name','Device'],['operation','Action'],['card_uid','Card'],['status','Status'],['created_at','Created','date'],['error_message','Error']]} action={(row) => <div className="row-actions"><button className="text" onClick={() => mark(row.id, 'applied')}>Mark applied</button><button className="text danger" onClick={() => mark(row.id, 'failed')}>Failed</button></div>} /></ListState>
  </PagePanel>;
}

function Settings() {
  const list = useList('/api/settings');
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const value = String(form.get('value') ?? '');
    try { await api('/api/settings/facility_fee_grace_period_days', { method: 'PUT', body: JSON.stringify({ value }) }); setMessage('Grace period updated.'); list.reload(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Failed'); }
  }
  return <PagePanel title="Settings" subtitle="Estate-wide operational rules">
    {message && <Notice tone={message.includes('updated') ? 'success' : 'error'}>{message}</Notice>}
    <FormCard title="Facility-fee enforcement" onSubmit={submit}><label>Grace period (days)<input name="value" type="number" min="0" max="365" defaultValue={String(list.data?.items.find((item) => item.key === 'facility_fee_grace_period_days')?.value ?? '7')} required /></label><button className="primary">Save rule</button></FormCard>
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['key','Setting'],['value','Value'],['updated_at','Updated','date']]} /></ListState>
  </PagePanel>;
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
function DataTable({ rows, columns, action }: { rows: Row[]; columns: Column[]; action?: (row: Row) => ReactNode }) {
  if (!rows.length) return <div className="empty"><div>◇</div><h3>Nothing here yet</h3><p>New records will appear in this view.</p></div>;
  return <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column[0]}>{column[1]}</th>)}{action && <th />}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{columns.map(([key,, format]) => <td key={key}>{cell(row[key], key, format)}</td>)}{action && <td>{action(row)}</td>}</tr>)}</tbody></table></div>;
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

function initials(name: string): string { return name.split(/\s+/).slice(0,2).map((part) => part[0]).join('').toUpperCase(); }
function navIcon(section: Section): string {
  return ({ dashboard: '◫', residents: '●', properties: '⌂', bills: '₦', visitors: '↔', maintenance: '◇', community: '≡', cards: '▤', events: '⌁', devices: '▣', operations: '↻', settings: '⚙' })[section];
}

export default App;
