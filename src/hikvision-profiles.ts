export type HikvisionProfileKey =
  | 'auto'
  | 'minmoe_value_3xx'
  | 'minmoe_pro_6xx'
  | 'minmoe_ultra_6xx'
  | 'minmoe_turnstile_module'
  | 'qr_terminal_k1t807_k1t502'
  | 'access_terminal_8xx'
  | 'access_terminal_5xx'
  | 'attendance_k1a'
  | 'controller_k2600'
  | 'controller_k2700_k2800'
  | 'generic_network_access'
  | 'generic_isapi';

export type ConnectionPattern =
  | 'direct_http_listener'
  | 'render_http_bridge'
  | 'hikvision_cloud_openapi'
  | 'offsite_isup_gateway'
  | 'manual_sync';

export interface HikvisionProfile {
  key: Exclude<HikvisionProfileKey, 'auto'>;
  label: string;
  family: string;
  description: string;
  modelPatterns: string[];
  devicePattern: 'standalone_terminal' | 'turnstile_module' | 'attendance_terminal' | 'multi_door_controller';
  authenticationMethods: string[];
  supportedConnections: ConnectionPattern[];
  defaultConnection: ConnectionPattern;
  httpListener: {
    expected: boolean;
    formats: Array<'json' | 'xml' | 'multipart'>;
    note: string;
  };
  aliases: {
    eventType: string[];
    eventId: string[];
    timestamp: string[];
    cardUid: string[];
    personName: string[];
    employeeNo: string[];
    status: string[];
    description: string[];
    direction: string[];
    credentialType: string[];
    doorNo: string[];
  };
  grantedPatterns: string[];
  deniedPatterns: string[];
}

const commonAliases: HikvisionProfile['aliases'] = {
  eventType: ['eventType', 'type', 'majorEventType', 'major'],
  eventId: ['eventID', 'eventId', 'serialNo', 'seq', 'eventNo'],
  timestamp: ['dateTime', 'time', 'eventTime', 'occurTime'],
  cardUid: ['cardNo', 'cardNumber', 'credentialNo', 'cardReaderNo'],
  personName: ['name', 'employeeName', 'personName', 'userName'],
  employeeNo: ['employeeNoString', 'employeeNo', 'personId', 'userID'],
  status: ['eventState', 'status', 'currentVerifyMode', 'verifyMode'],
  description: ['eventDescription', 'subEventType', 'minorEventType', 'minor', 'attendanceStatus'],
  direction: ['direction', 'inOutType', 'attendanceStatus', 'enterOrExit'],
  credentialType: ['currentVerifyMode', 'verifyMode', 'credentialType', 'authType'],
  doorNo: ['doorNo', 'doorIndex', 'channelID', 'channelId'],
};

function aliases(overrides: Partial<HikvisionProfile['aliases']> = {}): HikvisionProfile['aliases'] {
  return Object.fromEntries(
    Object.entries(commonAliases).map(([key, values]) => [key, [...(overrides[key as keyof typeof overrides] ?? []), ...values]]),
  ) as unknown as HikvisionProfile['aliases'];
}

const commonGranted = ['granted', 'success', 'legal', 'pass', 'authenticated', 'allowed', 'normal'];
const commonDenied = ['denied', 'invalid', 'failed', 'forbidden', 'illegal', 'expired', 'blacklist', 'blocklist', 'no permission', 'anti-passback'];

export const HIKVISION_PROFILES: HikvisionProfile[] = [
  {
    key: 'minmoe_value_3xx',
    label: 'MinMoe Value Series (K1T3xx)',
    family: 'MinMoe Value',
    description: 'K1T320/321/331/341/342/343/344 and regional suffix variants.',
    modelPatterns: ['^DS-K1T3', '^K1T3'],
    devicePattern: 'standalone_terminal',
    authenticationMethods: ['face', 'card', 'fingerprint', 'PIN', 'QR where fitted'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'hikvision_cloud_openapi', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'direct_http_listener',
    httpListener: { expected: true, formats: ['json', 'xml', 'multipart'], note: 'Availability and HTTPS/auth options vary by firmware build.' },
    aliases: aliases({ cardUid: ['cardNoString'], employeeNo: ['employeeNo'] }),
    grantedPatterns: [...commonGranted, 'legalCardPass', 'faceMatch'],
    deniedPatterns: [...commonDenied, 'invalidCard', 'faceMismatch'],
  },
  {
    key: 'minmoe_pro_6xx',
    label: 'MinMoe Pro Series (K1T6xx)',
    family: 'MinMoe Pro',
    description: 'K1T671/672/673 and related Pro variants.',
    modelPatterns: ['^DS-K1T67', '^K1T67'],
    devicePattern: 'standalone_terminal',
    authenticationMethods: ['face', 'card', 'fingerprint', 'PIN', 'QR', 'mobile credential where fitted'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'hikvision_cloud_openapi', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'direct_http_listener',
    httpListener: { expected: true, formats: ['json', 'xml', 'multipart'], note: 'Confirm firmware upload format and certificate validation.' },
    aliases: aliases({ credentialType: ['mask', 'helmet', 'recognitionMode'] }),
    grantedPatterns: [...commonGranted, 'legalCardPass', 'faceMatch', 'multiVerifyPass'],
    deniedPatterns: [...commonDenied, 'invalidCard', 'faceMismatch', 'multiVerifyFailed'],
  },
  {
    key: 'minmoe_ultra_6xx',
    label: 'MinMoe Ultra Series (K1T68x and Ultra K1T67x)',
    family: 'MinMoe Ultra',
    description: 'K1T680/681 and Ultra-labelled K1T67x variants; explicit selection overrides model auto-detection.',
    modelPatterns: ['^DS-K1T68', '^K1T68'],
    devicePattern: 'standalone_terminal',
    authenticationMethods: ['face', 'card', 'fingerprint', 'PIN', 'QR', 'palm/iris where fitted'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'hikvision_cloud_openapi', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'direct_http_listener',
    httpListener: { expected: true, formats: ['json', 'xml', 'multipart'], note: 'Large image events are accepted only up to the configured request limit.' },
    aliases: aliases({ credentialType: ['irisMode', 'palmMode', 'recognitionMode'] }),
    grantedPatterns: [...commonGranted, 'legalCardPass', 'faceMatch', 'palmMatch', 'irisMatch'],
    deniedPatterns: [...commonDenied, 'invalidCard', 'faceMismatch', 'palmMismatch', 'irisMismatch'],
  },
  {
    key: 'minmoe_turnstile_module',
    label: 'MinMoe face module for turnstiles',
    family: 'MinMoe Module',
    description: 'Embedded/turnstile face-recognition modules. Channel and direction mapping must be configured explicitly.',
    modelPatterns: ['^DS-K560', '^DS-K567', '^DS-K3.*FACE'],
    devicePattern: 'turnstile_module',
    authenticationMethods: ['face', 'card', 'QR where fitted'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'direct_http_listener',
    httpListener: { expected: true, formats: ['json', 'xml', 'multipart'], note: 'Verify whether the turnstile controller or face module owns the event upload.' },
    aliases: aliases({ direction: ['laneDirection'], doorNo: ['laneNo', 'barrierNo'] }),
    grantedPatterns: [...commonGranted, 'faceMatch', 'barrierOpen'],
    deniedPatterns: [...commonDenied, 'faceMismatch', 'barrierDenied'],
  },
  {
    key: 'qr_terminal_k1t807_k1t502',
    label: 'QR-capable K1T807 / K1T502 terminal',
    family: 'QR Access Terminal',
    description: 'DS-K1T807 QRE1 and DS-K1T502 QR/CQR/QRE1 variants with an integrated or fitted QR reader.',
    modelPatterns: ['^DS-K1T807.*QR', '^K1T807.*QR', '^DS-K1T502.*(QR|CQR)', '^K1T502.*(QR|CQR)'],
    devicePattern: 'standalone_terminal',
    authenticationMethods: ['card', 'PIN', 'QR', 'fingerprint/Bluetooth where fitted'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'direct_http_listener',
    httpListener: { expected: true, formats: ['json', 'xml', 'multipart'], note: 'Provision the numeric visitor credential to the terminal before relying on its QR reader.' },
    aliases: aliases({ cardUid: ['cardNoString', 'qrCode'], credentialType: ['qrCodeMode'] }),
    grantedPatterns: [...commonGranted, 'legalCardPass', 'qrCodePass'],
    deniedPatterns: [...commonDenied, 'invalidCard', 'invalidQRCode'],
  },
  {
    key: 'access_terminal_8xx',
    label: 'K1T8xx card/fingerprint terminal',
    family: 'Card / Fingerprint Terminal',
    description: 'DS-K1T801/802/804/805/808 and related variants. DS-K1T808MFWX-B supports card, fingerprint and PIN, not an integrated QR camera.',
    modelPatterns: ['^DS-K1T8', '^K1T8'],
    devicePattern: 'standalone_terminal',
    authenticationMethods: ['card', 'fingerprint where fitted', 'PIN'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'direct_http_listener',
    httpListener: { expected: true, formats: ['json', 'xml', 'multipart'], note: 'ISAPI/ISUP support depends on model and firmware; use PIN or card because most K1T8xx models have no QR scanner.' },
    aliases: aliases({ cardUid: ['cardNoString'] }),
    grantedPatterns: [...commonGranted, 'legalCardPass', 'fingerprintPass'],
    deniedPatterns: [...commonDenied, 'invalidCard', 'fingerprintMismatch'],
  },
  {
    key: 'access_terminal_5xx',
    label: 'K1T5xx access terminal',
    family: 'Access Terminal',
    description: 'K1T500/502 and related card/face access-terminal variants.',
    modelPatterns: ['^DS-K1T5', '^K1T5'],
    devicePattern: 'standalone_terminal',
    authenticationMethods: ['card', 'face where fitted', 'fingerprint where fitted', 'PIN'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'direct_http_listener',
    httpListener: { expected: true, formats: ['json', 'xml', 'multipart'], note: 'The K1T502 family documents HTTP/HTTPS event alarm upload; verify each regional firmware.' },
    aliases: aliases({ cardUid: ['cardNoString'] }),
    grantedPatterns: [...commonGranted, 'legalCardPass'],
    deniedPatterns: [...commonDenied, 'invalidCard'],
  },
  {
    key: 'attendance_k1a',
    label: 'K1A attendance / access terminal',
    family: 'Time Attendance',
    description: 'K1A-series attendance terminals when used for access events.',
    modelPatterns: ['^DS-K1A', '^K1A'],
    devicePattern: 'attendance_terminal',
    authenticationMethods: ['face', 'card', 'fingerprint', 'PIN'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'direct_http_listener',
    httpListener: { expected: true, formats: ['json', 'xml', 'multipart'], note: 'Attendance check-in/out labels are normalized to entry/exit when present.' },
    aliases: aliases({ direction: ['attendanceStatus', 'label'], timestamp: ['attendanceTime'] }),
    grantedPatterns: [...commonGranted, 'checkIn', 'checkOut'],
    deniedPatterns: [...commonDenied],
  },
  {
    key: 'controller_k2600',
    label: 'DS-K2600 network access controller',
    family: 'Network Controller',
    description: 'DS-K2601/2602/2604 multi-door controllers with reader/door channel mapping.',
    modelPatterns: ['^DS-K260', '^K260'],
    devicePattern: 'multi_door_controller',
    authenticationMethods: ['card', 'PIN', 'reader-dependent biometrics'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'offsite_isup_gateway',
    httpListener: { expected: false, formats: ['json', 'xml'], note: 'EHome/ISUP or a management platform is common; confirm direct HTTP host notification on the actual firmware.' },
    aliases: aliases({ doorNo: ['doorNo', 'cardReaderNo'], direction: ['cardReaderKind'] }),
    grantedPatterns: [...commonGranted, 'legalCardPass', 'normalCard'],
    deniedPatterns: [...commonDenied, 'invalidCard', 'interlock', 'antiPassback'],
  },
  {
    key: 'controller_k2700_k2800',
    label: 'DS-K2700 / K2800 controller family',
    family: 'Network Controller',
    description: 'Multi-door access controllers; capabilities differ significantly by generation and suffix.',
    modelPatterns: ['^DS-K27', '^DS-K28', '^K27', '^K28'],
    devicePattern: 'multi_door_controller',
    authenticationMethods: ['card', 'PIN', 'reader-dependent biometrics'],
    supportedConnections: ['offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'offsite_isup_gateway',
    httpListener: { expected: false, formats: ['json', 'xml'], note: 'Do not select direct mode until HTTP Host/Listening is confirmed in the controller firmware.' },
    aliases: aliases({ doorNo: ['doorNo', 'readerNo'], direction: ['readerDirection'] }),
    grantedPatterns: [...commonGranted, 'legalCardPass', 'normalCard'],
    deniedPatterns: [...commonDenied, 'invalidCard', 'interlock', 'antiPassback'],
  },
  {
    key: 'generic_network_access',
    label: 'Other network access-control device',
    family: 'Vendor-neutral network access',
    description: 'Explicit profile for a non-Hikvision controller or terminal that can send authenticated JSON/XML HTTP events using mapped common fields.',
    modelPatterns: [],
    devicePattern: 'standalone_terminal',
    authenticationMethods: ['card', 'PIN', 'QR or biometrics when provided by the device'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'manual_sync'],
    defaultConnection: 'manual_sync',
    httpListener: { expected: false, formats: ['json', 'xml', 'multipart'], note: 'Validate a real event sample before enabling production decisions or automatic commands.' },
    aliases: aliases(),
    grantedPatterns: commonGranted,
    deniedPatterns: commonDenied,
  },
  {
    key: 'generic_isapi',
    label: 'Generic Hikvision ISAPI access device',
    family: 'Generic ISAPI',
    description: 'Conservative fallback for unlisted models. Events are retained with unknown values instead of guessed mappings.',
    modelPatterns: ['.*'],
    devicePattern: 'standalone_terminal',
    authenticationMethods: ['unknown'],
    supportedConnections: ['direct_http_listener', 'render_http_bridge', 'offsite_isup_gateway', 'manual_sync'],
    defaultConnection: 'manual_sync',
    httpListener: { expected: false, formats: ['json', 'xml', 'multipart'], note: 'Run the device-profile validation procedure before production.' },
    aliases: aliases(),
    grantedPatterns: commonGranted,
    deniedPatterns: commonDenied,
  },
];

export function getHikvisionProfile(key: string | null | undefined): HikvisionProfile {
  return HIKVISION_PROFILES.find((profile) => profile.key === key)
    ?? HIKVISION_PROFILES.find((profile) => profile.key === 'generic_isapi')!;
}

export function resolveHikvisionProfile(model: string | null | undefined, requested: string | null | undefined): HikvisionProfile {
  if (requested && requested !== 'auto') return getHikvisionProfile(requested);
  const normalized = model?.trim().toUpperCase() ?? '';
  return HIKVISION_PROFILES.find((profile) => profile.key !== 'generic_isapi' && profile.modelPatterns.some((pattern) => new RegExp(pattern, 'i').test(normalized)))
    ?? getHikvisionProfile('generic_isapi');
}

export function isConnectionSupported(profile: HikvisionProfile, pattern: string): pattern is ConnectionPattern {
  return profile.supportedConnections.includes(pattern as ConnectionPattern);
}
