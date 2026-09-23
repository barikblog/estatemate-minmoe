import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, ListResponse, User, api, money, readableDate } from './api';

type Row = Record<string, unknown>;
type Section = 'dashboard' | 'residents' | 'properties' | 'residency' | 'bills' | 'visitors' | 'maintenance' | 'notices' | 'cards' | 'events' | 'devices' | 'operations' | 'settings';

interface NavItem { id: Section; label: string; roles?: User['role'][] }
const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'residents', label: 'People', roles: ['admin', 'cashier', 'security'] },
  { id: 'properties', label: 'Properties', roles: ['admin', 'cashier', 'security', 'resident'] },
  { id: 'residency', label: 'Tenancy & household', roles: ['admin', 'resident'] },
  { id: 'bills', label: 'Bills & payments', roles: ['admin', 'cashier', 'resident'] },
  { id: 'visitors', label: 'Visitors' },
  { id: 'maintenance', label: 'Maintenance', roles: ['admin', 'resident'] },
  { id: 'notices', label: 'Estate notices' },
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

  useEffect(() => {
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
    {popupNotices[0] && <EstateNoticePopup notice={popupNotices[0]} remaining={popupNotices.length - 1} onAcknowledge={acknowledgePopup} />}
  </div>;
}

function SectionView({ section, user }: { section: Section; user: User }) {
  switch (section) {
    case 'dashboard': return <Dashboard user={user} />;
    case 'residents': return <People user={user} />;
    case 'properties': return <Properties user={user} />;
    case 'residency': return <Residency user={user} />;
    case 'bills': return <Bills user={user} />;
    case 'visitors': return <Visitors user={user} />;
    case 'maintenance': return <Maintenance user={user} />;
    case 'notices': return <EstateNotices user={user} />;
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
    {user.role === 'resident' && Boolean(data?.latestNotice) && <section className="panel"><div className="panel-title"><div><p className="eyebrow">Latest estate notice</p><h3>{String((data?.latestNotice as Row).title)}</h3></div></div><p>{String((data?.latestNotice as Row).body)}</p></section>}
    {user.role !== 'resident' && <section className="split-grid"><article className="panel callout"><p className="eyebrow">HARDWARE MODE</p><h3>Direct MinMoe event upload</h3><p>Terminals post gate events straight to Cloudflare. Card changes remain in the hardware-action queue until a supported command channel is confirmed.</p></article><article className="panel"><p className="eyebrow">OPERATIONS TIP</p><h3>Check unresolved device actions</h3><p>HTTP Listening is upload-only on most firmware. Mark each manual terminal update as applied to preserve an accurate audit trail.</p></article></section>}
  </>;
}

function People({ user }: { user: User }) {
  const list = useList('/api/users?limit=50');
  const [showForm, setShowForm] = useState(false);
  return <PagePanel title="People" subtitle="Resident and staff accounts" action={user.role === 'admin' ? <button className="primary" onClick={() => setShowForm(!showForm)}>Add person</button> : null}>
    {showForm && <CreateUser onDone={() => { setShowForm(false); list.reload(); }} />}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['name','Name'],['role','Role'],['email','Email'],['phone','Phone'],['unit_numbers','Owned'],['rented_units','Rented'],['dependant_units','Dependant at'],['property_count','Owned count'],['status','Status']]} /></ListState>
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
  const list = useList('/api/properties?limit=100');
  const requests = useAsync<ListResponse<Row>>(
    () => user.role === 'resident' || user.role === 'admin' ? api('/api/property-ownership-requests?limit=100') : Promise.resolve({ items: [], page: 1, limit: 100 }),
    [user.role],
  );
  const transfers = useAsync<ListResponse<Row>>(
    () => user.role === 'resident' || user.role === 'admin' ? api('/api/property-transfers?limit=100') : Promise.resolve({ items: [], page: 1, limit: 100 }),
    [user.role],
  );
  const available = useAsync<{ items: Row[] }>(
    () => user.role === 'resident' || user.role === 'admin' ? api('/api/properties/available') : Promise.resolve({ items: [] }),
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
    const body = requestMode === 'existing'
      ? { propertyId: form.get('propertyId'), requestNote: form.get('requestNote') }
      : { proposedUnitNumber: form.get('proposedUnitNumber'), proposedStreet: form.get('proposedStreet'), proposedAddress: form.get('proposedAddress'), requestNote: form.get('requestNote') };
    try { await api('/api/property-ownership-requests', { method: 'POST', body: JSON.stringify(body) }); setShowRequest(false); setMessage('Ownership request submitted for administrator approval.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not submit ownership request'); }
  }
  async function assignOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/property-ownerships', { method: 'POST', body: JSON.stringify(values) }); setShowAssign(false); setAssignPropertyId(''); setMessage('Property owner assigned.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not assign property owner'); }
  }
  async function requestTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/property-transfers', { method: 'POST', body: JSON.stringify(values) }); setShowTransfer(false); setMessage('Ownership transfer submitted for administrator approval.'); refresh(); }
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

  const actions = (row: Row) => <div className="row-actions">
    {(user.role === 'admin' || user.role === 'cashier' || row.relationship_type === 'owner' || (row.relationship_type === 'tenant' && row.billing_responsibility === 'tenant')) && <a className="text" href={`/api/properties/${row.id}/statement?format=csv`}>Statement</a>}
    {user.role === 'admin' && <><button className="text" onClick={() => editProperty(row)}>Edit</button>{row.ownership_id ? <button className="text danger" onClick={() => revokeOwner(row)}>Remove owner</button> : <button className="text" onClick={() => { setAssignPropertyId(String(row.id)); setShowAssign(true); }}>Assign owner</button>}</>}
  </div>;
  const pending = requests.data?.items.filter((request) => request.status === 'pending') ?? [];
  const pendingTransfers = transfers.data?.items.filter((transfer) => transfer.status === 'pending') ?? [];
  const transferable = list.data?.items.filter((property) => property.ownership_id && (user.role === 'admin' || property.relationship_type === 'owner')) ?? [];

  return <PagePanel title={user.role === 'resident' ? 'My properties' : 'Properties'} subtitle="Ownership, occupancy, zones, statements and transfer history" action={<div className="row-actions">
    {(user.role === 'resident' || user.role === 'admin') && <button className="secondary" onClick={() => setShowTransfer(!showTransfer)}>Transfer ownership</button>}
    {user.role === 'resident' && <button className="primary" onClick={() => setShowRequest(!showRequest)}>Request another property</button>}
    {user.role === 'admin' && <><button className="secondary" onClick={() => setShowAssign(!showAssign)}>Assign owner</button><button className="primary" onClick={() => setShowAdd(!showAdd)}>Add property</button></>}
  </div>}>
    {message && <Notice tone={message.includes('Could not') || message.includes('already') ? 'error' : 'success'}>{message}</Notice>}
    {showAdd && <FormCard title="New property" onSubmit={addProperty}><label>Unit number<input name="unitNumber" required /></label><label>Street<input name="street" required /></label><label>Block<input name="block" /></label><label>Zone<input name="zone" /></label><label>Address<input name="address" required /></label><button className="primary">Save property</button></FormCard>}
    {showAssign && <FormCard title="Assign an unowned property" onSubmit={assignOwner}><label>Property<select name="propertyId" value={assignPropertyId} onChange={(event) => setAssignPropertyId(event.target.value)} required><option value="">Select property</option>{available.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)}</option>)}</select></label><label>Resident email<input name="residentEmail" type="email" required /></label><button className="primary">Assign owner</button></FormCard>}
    {showRequest && <FormCard title="Request another property" onSubmit={requestProperty}><label>Request type<select value={requestMode} onChange={(event) => setRequestMode(event.target.value as 'existing'|'propose')}><option value="existing">Existing unowned property</option><option value="propose">Propose a new property</option></select></label>{requestMode === 'existing' ? <label>Available property<select name="propertyId" required><option value="">Select property</option>{available.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)}, {String(property.address)}</option>)}</select></label> : <><label>Unit number<input name="proposedUnitNumber" required /></label><label>Street<input name="proposedStreet" required /></label><label>Address<input name="proposedAddress" required /></label></>}<label className="span-2">Note<textarea name="requestNote" rows={3} /></label><button className="primary">Submit for approval</button></FormCard>}
    {showTransfer && <FormCard title="Transfer legal ownership" onSubmit={requestTransfer}><label>Property<select name="propertyId" required><option value="">Select property</option>{transferable.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.owner_name)}</option>)}</select></label><label>New owner email<input name="newOwnerEmail" type="email" required /></label><label>Effective date<input name="effectiveDate" type="date" required /></label><label className="span-2">Transfer note<textarea name="requestNote" rows={3} /></label><button className="primary">Submit transfer</button></FormCard>}
    {user.role === 'admin' && pending.length > 0 && <section className="approval-queue"><h3>Ownership approvals</h3><DataTable rows={pending} columns={[['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['request_note','Note'],['created_at','Requested','date'],['status','Status']]} action={(row) => <div className="row-actions"><button className="text" onClick={() => reviewRequest(row.id,'approved')}>Approve</button><button className="text danger" onClick={() => reviewRequest(row.id,'rejected')}>Reject</button></div>} /></section>}
    {user.role === 'admin' && pendingTransfers.length > 0 && <section className="approval-queue"><h3>Ownership transfer approvals</h3><DataTable rows={pendingTransfers} columns={[['unit_number','Unit'],['from_owner_name','Current owner'],['to_owner_name','New owner'],['effective_date','Effective'],['request_note','Note'],['status','Status']]} action={(row) => <div className="row-actions"><button className="text" onClick={() => reviewTransfer(row.id,'approve')}>Approve</button><button className="text danger" onClick={() => reviewTransfer(row.id,'reject')}>Reject</button></div>} /></section>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={user.role === 'resident' ? [['unit_number','Unit'],['zone','Zone'],['block','Block'],['street','Street'],['relationship_type','Relationship'],['main_resident_name','Main resident'],['billing_responsibility','Bill payer']] : [['unit_number','Unit'],['zone','Zone'],['block','Block'],['street','Street'],['owner_name','Owner'],['tenant_name','Tenant'],['billing_responsibility','Bill payer']]} action={actions} /></ListState>
    {requests.data && requests.data.items.length > 0 && <section className="request-history"><h3>Ownership request history</h3><DataTable rows={requests.data.items} columns={[['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['status','Status'],['review_note','Review note'],['created_at','Requested','date']]} /></section>}
    {transfers.data && transfers.data.items.length > 0 && <section className="request-history"><h3>Ownership transfer history</h3><DataTable rows={transfers.data.items} columns={[['unit_number','Unit'],['from_owner_name','From'],['to_owner_name','To'],['effective_date','Effective'],['status','Status'],['review_note','Review note']]} /></section>}
  </PagePanel>;
}


function Residency({ user }: { user: User }) {
  const properties = useList('/api/properties?limit=100');
  const tenancies = useList('/api/property-tenancies?limit=100');
  const household = useList('/api/household-members?limit=100');
  const [showTenancy, setShowTenancy] = useState(false);
  const [showMember, setShowMember] = useState(false);
  const [message, setMessage] = useState('');
  function refresh() { properties.reload(); tenancies.reload(); household.reload(); }
  async function addTenancy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const values = Object.fromEntries(new FormData(event.currentTarget));
    try { const result = await api<{ status:string }>('/api/property-tenancies',{ method:'POST',body:JSON.stringify(values) }); setShowTenancy(false); setMessage(result.status === 'active' ? 'Tenant assigned.' : 'Tenant nomination submitted for administrator approval.'); refresh(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not create tenancy'); }
  }
  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(''); const form = new FormData(event.currentTarget);
    const body = { propertyId:form.get('propertyId'),primaryResidentId:form.get('primaryResidentId') || undefined,name:form.get('name'),relationship:form.get('relationship'),dateOfBirth:form.get('dateOfBirth') || undefined,phone:form.get('phone'),email:form.get('email'),canCreateVisitors:form.get('canCreateVisitors') === 'on',canViewBills:form.get('canViewBills') === 'on',requestNote:form.get('requestNote') };
    try { const result = await api<{ status:string }>('/api/household-members',{ method:'POST',body:JSON.stringify(body) }); setShowMember(false); setMessage(result.status === 'active' ? 'Household member added.' : 'Household member submitted for administrator approval.'); refresh(); }
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
  const tenancyActions = user.role === 'admin' ? (row:Row) => <div className="row-actions">{row.status === 'pending' && <><button className="text" onClick={() => tenancyAction(row,'approve')}>Approve</button><button className="text danger" onClick={() => tenancyAction(row,'reject')}>Reject</button></>}{row.status === 'active' && <><button className="text" onClick={() => tenancyAction(row,'update')}>Billing</button><button className="text danger" onClick={() => tenancyAction(row,'end')}>End</button></>}</div> : undefined;
  const memberActions = user.role === 'admin' ? (row:Row) => <div className="row-actions">{row.status === 'pending' && <><button className="text" onClick={() => memberAction(row,'approve')}>Approve</button><button className="text danger" onClick={() => memberAction(row,'reject')}>Reject</button></>}{row.status === 'active' && <><button className="text" onClick={() => memberAction(row,'update')}>Permissions</button>{!row.linked_user_id && <button className="text" onClick={() => createMemberLogin(row)}>Add login</button>}<button className="text danger" onClick={() => memberAction(row,'deactivate')}>Deactivate</button></>}</div> : undefined;
  return <PagePanel title="Tenancy & household" subtitle="Main tenants, rented apartments, dependants, domestic staff and delegated permissions" action={<div className="row-actions"><button className="secondary" onClick={() => setShowMember(!showMember)}>Add dependant</button><button className="primary" onClick={() => setShowTenancy(!showTenancy)}>{user.role === 'admin' ? 'Assign tenant' : 'Nominate tenant'}</button></div>}>
    <Notice tone="info"><strong>Rented apartment:</strong> legal ownership remains with the owner. The approved tenant becomes the main resident for the tenancy dates. The administrator chooses whether future property bills go to the owner or tenant.</Notice>
    {message && <Notice tone={message.includes('Could not') || message.includes('failed') ? 'error' : 'success'}>{message}</Notice>}
    {showTenancy && <FormCard title={user.role === 'admin' ? 'Assign a tenant' : 'Nominate a tenant for approval'} onSubmit={addTenancy}><label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.owner_name ?? property.relationship_type)}</option>)}</select></label><label>Tenant email<input name="tenantEmail" type="email" required /></label><label>Start date<input name="startDate" type="date" required /></label><label>End date<input name="endDate" type="date" /></label><label>Bill responsibility<select name="billingResponsibility"><option value="owner">Legal owner</option><option value="tenant">Main tenant</option></select></label><label className="span-2">Note<textarea name="requestNote" rows={3} /></label><button className="primary">{user.role === 'admin' ? 'Assign tenant' : 'Submit nomination'}</button></FormCard>}
    {showMember && <FormCard title="Add a dependant or household member" onSubmit={addMember}><label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.main_resident_name ?? property.owner_name)}</option>)}</select></label>{user.role === 'admin' && <label>Main resident ID<input name="primaryResidentId" placeholder="Optional; resolved automatically" /></label>}<label>Full name<input name="name" required /></label><label>Relationship<select name="relationship"><option value="spouse">Spouse</option><option value="child">Child</option><option value="parent">Parent</option><option value="relative">Relative</option><option value="domestic_staff">Domestic staff</option><option value="caregiver">Caregiver</option><option value="other">Other</option></select></label><label>Date of birth<input name="dateOfBirth" type="date" /></label><label>Phone<input name="phone" /></label><label>Email<input name="email" type="email" /></label><label className="check"><input name="canCreateVisitors" type="checkbox" /> May create visitors after login</label><label className="check"><input name="canViewBills" type="checkbox" /> May view bills after login</label><label className="span-2">Note<textarea name="requestNote" rows={3} /></label><button className="primary">{user.role === 'admin' ? 'Add member' : 'Submit for approval'}</button></FormCard>}
    {user.role === 'admin' && (pendingTenancies.length > 0 || pendingMembers.length > 0) && <section className="approval-queue"><h3>Pending residency approvals</h3><p>{pendingTenancies.length} tenancy nomination(s) and {pendingMembers.length} household member(s) are waiting.</p></section>}
    <section className="residency-section"><h3>Tenancies</h3><ListState list={tenancies}><DataTable rows={tenancies.data?.items ?? []} columns={[['unit_number','Unit'],['owner_name','Legal owner'],['tenant_name','Main tenant'],['start_date','Starts'],['end_date','Ends'],['billing_responsibility','Bill payer'],['status','Status']]} action={tenancyActions} /></ListState></section>
    <section className="residency-section"><h3>Dependants and household members</h3><ListState list={household}><DataTable rows={household.data?.items ?? []} columns={[['name','Name'],['relationship','Relationship'],['unit_number','Unit'],['primary_resident_name','Main resident'],['login_email','Login'],['can_create_visitors','Visitors'],['can_view_bills','Bills'],['status','Status']]} action={memberActions} /></ListState></section>
  </PagePanel>;
}


function Bills({ user }: { user: User }) {
  const list = useList('/api/bills?limit=50');
  const groups = useAsync<{ streets:Row[];blocks:Row[];zones:Row[] }>(() => user.role === 'resident' ? Promise.resolve({ streets:[],blocks:[],zones:[] }) : api('/api/property-groups'), [user.role]);
  const imports = useAsync<ListResponse<Row>>(() => user.role === 'resident' ? Promise.resolve({ items: [], page: 1, limit: 20 }) : api('/api/imports?limit=20'), [user.role]);
  const [showBatch, setShowBatch] = useState(false);
  const [targetType, setTargetType] = useState<'street'|'block'|'zone'>('street');
  const [showImport, setShowImport] = useState(false);
  const [message, setMessage] = useState('');

  async function createStreetBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get('amount'));
    const body = {
      name: form.get('name'), targetType, targets: form.getAll('targets'), amountMinor: Math.round(amount * 100),
      dueDate: form.get('dueDate'), billType: form.get('billType'), description: form.get('description'),
    };
    try {
      const result = await api<{ billCount:number;targetType:string;targets:string[] }>('/api/bills/batch', { method: 'POST', body: JSON.stringify(body) });
      setMessage(`${result.billCount} bill${result.billCount === 1 ? '' : 's'} created for ${result.targetType}: ${result.targets.join(', ')}.`);
      setShowBatch(false); list.reload();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Batch billing failed'); }
  }

  const staff = user.role === 'admin' || user.role === 'cashier';
  const targetRows = targetType === 'block' ? groups.data?.blocks : targetType === 'zone' ? groups.data?.zones : groups.data?.streets;
  return <PagePanel title="Bills & payments" subtitle={user.role === 'resident' ? 'Your charges and payment status' : 'Estate receivables, grouped billing and historical imports'} action={staff ? <div className="row-actions"><button className="secondary" onClick={() => setShowImport(!showImport)}>Import CSV</button><button className="primary" onClick={() => setShowBatch(!showBatch)}>Create grouped bills</button></div> : null}>
    {message && <Notice tone={message.includes('created') ? 'success' : 'error'}>{message}</Notice>}
    {showBatch && <FormCard title="Create bills for selected property groups" onSubmit={createStreetBatch}>
      <label>Batch name<input name="name" placeholder="2026 facility fee" required /></label>
      <label>Amount (NGN)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
      <label>Due date<input name="dueDate" type="date" required /></label>
      <label>Bill type<input name="billType" defaultValue="facility_fee" required /></label>
      <label>Group by<select value={targetType} onChange={(event) => setTargetType(event.target.value as 'street'|'block'|'zone')}><option value="street">Street</option><option value="block">Block</option><option value="zone">Zone</option></select></label>
      <label className="span-2">Description<input name="description" /></label>
      <fieldset className="street-picker span-2"><legend>{targetType[0].toUpperCase()+targetType.slice(1)}s to bill</legend>{groups.loading && <small>Loading property groups…</small>}{targetRows?.map((group) => <label className="check" key={String(group.value)}><input type="checkbox" name="targets" value={String(group.value)} /> <span>{String(group.value)} <small>({String(group.property_count)} properties)</small></span></label>)}{!groups.loading && !targetRows?.length && <Notice tone="warning">Add {targetType} details to properties before using this billing group.</Notice>}</fieldset>
      <button className="primary">Create grouped bills</button>
    </FormCard>}
    {showImport && <section className="import-grid">
      <CsvImporter kind="bills" title="Import existing bills" onDone={() => { list.reload(); imports.reload(); }} />
      <CsvImporter kind="payments" title="Import resident payments" onDone={() => { list.reload(); imports.reload(); }} />
    </section>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['bill_type','Type'],['batch_name','Batch'],['external_reference','External ref.'],['amount_minor','Amount','money'],['paid_minor','Paid','money'],['due_date','Due'],['status','Status']]} /></ListState>
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

function Visitors({ user }: { user: User }) {
  const list = useList('/api/visitors?limit=50');
  const properties = useList('/api/properties?limit=100');
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
    {show && <FormCard title="Create visitor pass" onSubmit={create}><label>Visitor name<input name="visitorName" required /></label><label>Phone<input name="visitorPhone" /></label>{user.role === 'admin' && <label>Resident ID<input name="residentId" required /></label>}{user.role === 'resident' ? <label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)}</option>)}</select></label> : <label>Property ID<input name="propertyId" required /></label>}<label>Valid from<input name="validFrom" type="datetime-local" required /></label><label>Valid until<input name="validUntil" type="datetime-local" required /></label><button className="primary">Issue pass</button></FormCard>}
    {(user.role === 'security' || user.role === 'admin') && <FormCard title="Gate check" onSubmit={check}><label>Six-digit PIN<input name="pin" inputMode="numeric" pattern="[0-9]{6}" required /></label><label>Action<select name="action"><option value="in">Check in</option><option value="out">Check out</option></select></label><button className="primary">Verify pass</button></FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['visitor_name','Visitor'],['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['pin','PIN'],['status','Status'],['valid_until','Valid until','date']]} /></ListState>
  </PagePanel>;
}

function Maintenance({ user }: { user: User }) {
  const list = useList('/api/maintenance?limit=50');
  const properties = useList('/api/properties?limit=100');
  const [show, setShow] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/maintenance', { method: 'POST', body: JSON.stringify(values) }); setShow(false); list.reload();
  }
  return <PagePanel title="Maintenance" subtitle="Requests and work status" action={<button className="primary" onClick={() => setShow(!show)}>New request</button>}>
    {show && <FormCard title="Report a maintenance issue" onSubmit={submit}><label className="span-2">Description<textarea name="description" rows={4} required /></label>{user.role === 'admin' && <label>Resident ID<input name="residentId" required /></label>}{user.role === 'resident' ? <label>Property<select name="propertyId" required><option value="">Select property</option>{properties.data?.items.map((property) => <option key={String(property.id)} value={String(property.id)}>{String(property.unit_number)} — {String(property.street)}</option>)}</select></label> : <label>Property ID<input name="propertyId" required /></label>}<button className="primary">Submit request</button></FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['resident_name','Resident'],['unit_number','Unit'],['street','Street'],['description','Description'],['status','Status'],['ai_urgency','Urgency'],['created_at','Reported','date']]} /></ListState>
  </PagePanel>;
}

function EstateNotices({ user }: { user: User }) {
  const list = useList(`/api/notices?limit=50${user.role === 'admin' ? '&scope=all' : ''}`);
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
  return <PagePanel title="General estate notices" subtitle="Official notices shown to every user as an in-app popup" action={user.role === 'admin' ? <button className="primary" onClick={() => setShow(!show)}>Publish notice</button> : null}>
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
    <div className="post-grid">{list.data?.items.map((notice) => <article className={`post estate-notice ${String(notice.severity)}`} key={String(notice.id)}><span className={`pill ${String(notice.severity)}`}>{String(notice.severity)}</span><h3>{String(notice.title)}</h3><p>{String(notice.body)}</p><small>{String(notice.author_name)} · {readableDate(notice.created_at)} · {String(notice.status)}</small><div className="row-actions">{!notice.acknowledged && <button className="text" onClick={() => acknowledge(notice.id)}>Mark as read</button>}{user.role === 'admin' && notice.status === 'active' && <button className="text danger" onClick={() => deactivate(notice.id)}>Deactivate</button>}</div></article>)}</div>
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
    {show && <FormCard title="Issue a physical card" onSubmit={submit}><label>Main resident ID<input name="residentId" placeholder="Use this for a main resident" /></label><label>Household member ID<input name="householdMemberId" placeholder="Or use this for a dependant" /></label><label>Card UID / number<input name="cardUid" required /></label><label>Label<input name="cardLabel" placeholder="Optional card label" /></label><button className="primary">Issue card</button></FormCard>}
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['resident_name','Main resident'],['household_member_name','Card holder'],['relationship','Relationship'],['unit_number','Unit'],['card_uid','Card UID'],['card_label','Label'],['status','Status'],['deactivated_reason','Reason'],['updated_at','Updated','date']]} action={actions} /></ListState>
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
    <ListState list={list}><DataTable rows={list.data?.items ?? []} columns={[['result','Result'],['household_member_name','Household member'],['person_name','Device person'],['resident_name','Main resident'],['employee_no','Employee no.'],['credential_type','Method'],['card_uid','Card'],['device_name','Device'],['access_point_name','Access point'],['door_no','Door'],['direction','Direction'],['device_timestamp','Time','date']]} /></ListState>
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
  const storage = useAsync<Row>(() => api('/api/storage-settings'), []);
  const [message, setMessage] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [storageMessage, setStorageMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const value = String(form.get('value') ?? '');
    try { await api('/api/settings/facility_fee_grace_period_days', { method: 'PUT', body: JSON.stringify({ value }) }); setMessage('Grace period updated.'); list.reload(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Failed'); }
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
  return ({ dashboard: '◫', residents: '●', properties: '⌂', residency: '♙', bills: '₦', visitors: '↔', maintenance: '◇', notices: '!', cards: '▤', events: '⌁', devices: '▣', operations: '↻', settings: '⚙' })[section];
}

export default App;
