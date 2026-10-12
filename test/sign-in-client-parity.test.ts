import { describe, expect, it } from 'vitest';

/**
 * Remember me, view password and forgotten passwords now exist on every client
 * — the portal in a browser, the Windows app that opens the portal, and the
 * phone — and a failure says the same thing wherever a person meets it.
 *
 * This is the drift guard. The portal's `sign-in-errors.ts` supplies the words,
 * the Android client repeats them, the Windows dashboard carries the portal's
 * own icons, and the launchers say which client asked. Change one side alone
 * and these fail.
 */

async function readSource(path: string): Promise<string> {
  const fs = await import(['node:', 'fs'].join('')) as { readFileSync(path: string, encoding: string): string };
  return fs.readFileSync(path, 'utf8');
}

const WEB_ERRORS = 'apps/web/src/sign-in-errors.ts';
const WEB_APP = 'apps/web/src/App.tsx';
const WEB_API = 'apps/web/src/api.ts';
const ANDROID_ERRORS = 'apps/android/app/src/main/java/com/estatemate/app/SignInErrors.kt';
const ANDROID_APP = 'apps/android/app/src/main/java/com/estatemate/app/MainActivity.kt';
const ANDROID_MENU = 'apps/android/app/src/main/java/com/estatemate/app/Menu.kt';
const ANDROID_API = 'apps/android/app/src/main/java/com/estatemate/app/data/remote/EstateMateApi.kt';
const ANDROID_AUTH_STORE = 'apps/android/app/src/main/java/com/estatemate/app/data/AuthStore.kt';
const ANDROID_REPOSITORY = 'apps/android/app/src/main/java/com/estatemate/app/data/EstateRepository.kt';
const WINDOWS_DASHBOARD = 'bridge-apps/windows/dashboard/EstateMateBridge.ps1';
const WINDOWS_LAUNCHER = 'client-apps/windows/EstateMate.vbs';

/**
 * Every sentence the portal shows when the Worker named the reason — the same
 * sentences the phone must show, because a person reads them on both.
 */
const SHARED_SENTENCES = [
  "Can't reach the estate server",
  'You appear to be offline, or the estate server is unreachable from this network.',
  'Check your data or Wi-Fi connection, then try again. Nothing you entered was lost.',
  'Too many attempts',
  'Wait a few minutes before trying again.',
  'Sign-in details not accepted',
  'Check the email address and password issued by your estate office. Passwords are case-sensitive.',
  'This account is deactivated',
  'Only an Administrator or Manager can reactivate an account. Ownership, bills and gate history are kept while it is off.',
  'This account has expired',
  'Sample logins last 24 hours. Ask the estate office for a new account or a temporary password.',
  'That code was not accepted',
  'Codes are eight characters, do not use 0, O, 1, I or L, and stop working once they are used or expired.',
  'That code has expired',
  'Ask for a new one — a fresh code is created straight away.',
  'Choose a stronger password',
  'Use at least 12 characters. A short phrase you can remember beats a short password you cannot.',
  'Check what was entered',
  'Your session ended',
  'This happens when a password is changed, an account is deactivated, or a session runs out of time.',
  'Sign in again to continue.',
  'The estate server is unavailable',
  'Nothing was changed. Try again in a moment.',
  'The estate server had a problem',
  'The server could not complete that request. Nothing was changed.',
  'Not allowed',
  'Your role does not cover this action. Ask an Administrator if you need it.',
  'Something went wrong',
  'The request could not be completed. Try again in a moment.',
];

/** The same three conveniences, in the same words, on every client. */
const SHARED_SIGN_IN_COPY = [
  'Remember me',
  'Forgot password?',
  'This device stays signed in for 30 days. Do not use it on a shared computer.',
  'Keeps you signed in for 30 days on this device.',
  'At least 12 characters. A phrase you can remember beats a short password you cannot.',
];

/** The first `'…'` literal after `key` on the same line. */
function navGlyph(source: string, key: string): string {
  const block = source.slice(source.indexOf('function navIcon'));
  const match = block.match(new RegExp(`\\b${key}:\\s*'([^']+)'`));
  expect(match, `navIcon() no longer names ${key}`).toBeTruthy();
  return match![1]!;
}

describe('every client handles sign-in the same way', () => {
  it('gives the phone the portal\'s own sentences for a refused sign-in', async () => {
    const web = await readSource(WEB_ERRORS);
    const android = await readSource(ANDROID_ERRORS);

    for (const sentence of SHARED_SENTENCES) {
      expect(web, `the portal is missing "${sentence}"`).toContain(sentence);
      expect(android, `the phone is missing "${sentence}"`).toContain(sentence);
    }
  });

  it('maps every reason the Worker can send', async () => {
    const web = await readSource(WEB_ERRORS);
    const android = await readSource(ANDROID_ERRORS);

    // The Worker's codes, as `src/sign-in.ts` defines them. Both clients must
    // have an answer for each; a new code with no branch shows a bare status.
    for (const code of [
      'invalid_credentials', 'account_inactive', 'account_expired', 'too_many_attempts',
      'invalid_reset_code', 'reset_expired', 'weak_password', 'validation',
      'session_ended', 'service_unavailable',
    ]) {
      expect(web, `the portal no longer maps ${code}`).toContain(`'${code}'`);
      expect(android, `the phone no longer maps ${code}`).toContain(`"${code}"`);
    }

    // The portal is the source of the wording and owns the structured problem;
    // the phone keeps the same title/message/hint/action shape.
    for (const field of ['title', 'message', 'hint', 'code', 'retryAfterSeconds', 'action']) {
      expect(web).toContain(field);
      expect(android).toContain(field);
    }
    for (const action of ["'retry'", "'forgot'", "'sign-in'", "'none'"]) {
      expect(web, `the portal no longer offers ${action}`).toContain(action);
    }
    for (const action of ['SignInAction.Retry', 'SignInAction.Forgot', 'SignInAction.SignIn', 'SignInAction.None']) {
      expect(android, `the phone no longer offers ${action}`).toContain(action);
    }
  });

  it('offers remember me, view password and forgot password on the portal, the phone and the desktop app', async () => {
    const web = await readSource(WEB_APP);
    const android = await readSource(ANDROID_APP);
    const androidStore = await readSource(ANDROID_AUTH_STORE);
    const launcher = await readSource(WINDOWS_LAUNCHER);
    const dashboard = await readSource(WINDOWS_DASHBOARD);

    // The portal: a checkbox, a field that can be looked at, and a whole
    // forgotten-password flow that reaches the Worker.
    expect(web).toContain('type="checkbox"');
    expect(web).toContain('PasswordField');
    expect(web).toContain('/api/auth/forgot-password');
    expect(web).toContain('/api/auth/reset-password');

    // The phone: the same three, with the reset answered without leaving the app.
    for (const copy of [...SHARED_SIGN_IN_COPY.slice(0, 2)]) {
      expect(android, `the phone is missing "${copy}"`).toContain(copy);
    }
    expect(android).toContain('Checkbox(');
    expect(android).toContain('VisibilityOff');
    expect(android).toContain('AuthScreen.Forgot');
    expect(android).toContain('ForgotPasswordScreen');
    expect(android).toContain('ResetPasswordScreen');

    // Remember me is a device convenience, never a credential: the address and
    // the choice are kept, the password never is.
    expect(androidStore).toContain('rememberedEmail');
    expect(androidStore).toContain('EncryptedSharedPreferences');
    expect(androidStore).toContain('volatileToken');
    expect(web).toContain('JSON.stringify({ email, remember: true })');
    expect(web).not.toMatch(/localStorage\.setItem\([^)]*password/i);
    expect(androidStore).not.toMatch(/putString\([^)]*password/i);

    // The desktop app opens the portal, tagged as the desktop client, and the
    // dashboard has its own way to the sign-in and reset screens.
    expect(launcher).toContain('client=desktop');
    expect(launcher).toContain('openUrl');
    expect(dashboard).toContain('OpenPortalButton');
    expect(dashboard).toContain('OpenResetsButton');
    expect(dashboard).toContain("Open-PortalWindow 'resets'");
  });

  it('says which client asked, so the estate office sees where a request came from', async () => {
    const web = await readSource(WEB_APP);
    const api = await readSource(ANDROID_API);
    const repository = await readSource(ANDROID_REPOSITORY);
    const dashboard = await readSource(WINDOWS_DASHBOARD);
    const launcher = await readSource(WINDOWS_LAUNCHER);

    // The Worker accepts exactly these three names (`SIGN_IN_CLIENTS`).
    for (const client of ['portal', 'desktop', 'android']) {
      expect(web, `the portal can no longer report "${client}"`).toContain(`'${client}'`);
    }
    expect(web).toContain('function signInClient()');
    expect(launcher).toContain('openUrl = openUrl & "?client=desktop"');
    expect(dashboard).toContain("'client=desktop'");
    expect(api).toContain('client: String = "android"');
    expect(repository).toContain('client = "android"');
  });

  it('carries "remember me" through to the Worker on both clients', async () => {
    const web = await readSource(WEB_APP);
    const api = await readSource(ANDROID_API);
    const repository = await readSource(ANDROID_REPOSITORY);

    expect(web).toContain('rememberMe, client: signInClient()');
    expect(api).toContain('val rememberMe: Boolean = false');
    expect(api).toContain('val rememberMe: Boolean? = null');
    expect(repository).toContain('suspend fun forgotPassword');
    expect(repository).toContain('rememberMe: Boolean');
    expect(repository).toContain('storeSession');
  });

  it('paints the dashboard rail with the portal\'s own icons', async () => {
    const web = await readSource(WEB_APP);
    const dashboard = await readSource(WINDOWS_DASHBOARD);

    // The rail reuses navIcon()'s characters, written as code points because
    // Windows PowerShell 5.1 reads a UTF-8 file without a BOM as ANSI.
    for (const key of ['dashboard', 'settings', 'operations']) {
      const glyph = navGlyph(web, key);
      const codePoint = glyph.codePointAt(0)!.toString(16).toUpperCase();
      expect(dashboard, `the rail no longer draws navIcon()'s ${key} glyph`).toContain(`[char]0x${codePoint}`);
    }

    // Three sections on the rail, one visible at a time, and a handler that
    // swaps them — the portal's sidebar behaviour in WinForms.
    expect([...dashboard.matchAll(/New-NavButton \$rail/g)].length).toBe(3);
    expect(dashboard).toContain('function Show-DashboardSection');
    expect(dashboard).toContain("Show-DashboardSection 'Status'");
    expect(dashboard).toContain('SectionPages');
    expect(dashboard).toContain('SectionButtons');
  });

  it('names every module on the phone with an icon, as the portal does', async () => {
    const menu = await readSource(ANDROID_MENU);
    const start = menu.indexOf('val MENU_MODULES');
    const modules = menu.slice(start, menu.indexOf('\n)', start) + 2);
    const entries = modules.split('MenuModule(').slice(1);
    expect(entries.length).toBeGreaterThanOrEqual(12);

    // Every module picks a tile, the tile is declared, and the tile is drawn:
    // an id with no icon is the phone's menu slipping back to plain text.
    const declared = menu.slice(menu.indexOf('enum class MenuIcon'), menu.indexOf('private fun MenuIcon.image()'));
    const drawn = menu.slice(menu.indexOf('private fun MenuIcon.image()'), menu.indexOf('data class MenuModule('));
    for (const entry of entries) {
      const id = entry.match(/id = "([a-z-]+)"/)?.[1];
      expect(id, 'a menu module has no id').toBeTruthy();
      const icon = entry.match(/icon = MenuIcon\.([A-Za-z]+)/)?.[1];
      expect(icon, `the phone's menu shows ${id} without an icon`).toBeTruthy();
      expect(declared, `MenuIcon.${icon} is not declared`).toContain(icon!);
      expect(drawn, `MenuIcon.${icon} is not drawn`).toContain(`MenuIcon.${icon} ->`);
    }

    // The list and the module header both draw it, and the tile is tinted by
    // the group the module belongs to, as the portal's rail is.
    expect([...menu.matchAll(/module\.icon\.image\(\)/g)].length).toBeGreaterThanOrEqual(2);
    expect(menu).toContain('module.iconTint()');
    expect(menu).toContain('ImageVector');
  });

  it('opens the portal on the reset queue from the desktop dashboard', async () => {
    const web = await readSource(WEB_APP);
    const dashboard = await readSource(WINDOWS_DASHBOARD);

    // The button builds a deep link; the portal has to honour it, and the
    // office-only rule has to survive the link.
    expect(dashboard).toContain('function New-PortalLink');
    expect(dashboard).toContain('&section=');
    expect(web).toContain('function initialSection()');
    expect(web).toContain("get('section')");
    expect(web).toContain("case 'resets'");
    expect(web).toMatch(/case 'resets': return \['admin','manager'\]\.includes\(user\.role\)/);
  });

  it('keeps the dashboard a PowerShell file Windows will run', async () => {
    const dashboard = await readSource(WINDOWS_DASHBOARD);

    // CRLF throughout, ASCII only (no BOM, no stray glyphs): Windows
    // PowerShell 5.1 needs both, and the self-test runs on the same file.
    expect(dashboard).toContain('\r\n');
    expect(dashboard.replace(/\r\n/g, '')).not.toContain('\n');
    expect(dashboard).not.toMatch(/[^\r\n\x20-\x7E]/);
    expect(dashboard).toContain('$SelfTest');
    expect(dashboard).toContain('New-PortalLink');
  });

  it('keeps the portal honest about what a 401 means', async () => {
    const api = await readSource(WEB_API);

    // A 401 outside the sign-in routes is a lost session and must be reported;
    // a wrong password on the sign-in routes is a form problem, not a bounce.
    expect(api).toContain('sessionEndedHandler');
    expect(api).toContain("path.startsWith('/api/auth/')");
    expect(api).toContain('isSignInPath(path)');
  });
});
