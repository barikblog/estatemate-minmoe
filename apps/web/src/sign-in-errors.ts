import { ApiError, isOffline } from './api';

/**
 * One vocabulary for everything that can go wrong while signing in, shared by
 * the portal, the Windows app that opens it, and the phone.
 *
 * The three clients used to show whatever the browser or the fetch layer
 * happened to say — `TypeError: Failed to fetch`, `Request failed (500)`,
 * `HTTP 401` — which tells a resident nothing and an operator less. A failure
 * now arrives as a title, a sentence that says what to do next, and an optional
 * hint, and the Worker's own wording is preferred whenever it sent one because
 * it knows things this file cannot (which gate, which bill, which rule).
 */

/** Which form asked, because the same code means different next steps. */
export type SignInContext = 'login' | 'forgot' | 'reset' | 'change-password' | 'session';

export interface SignInProblem {
  /** Short heading: what kind of failure this is. */
  title: string;
  /** What happened, and what to do about it. */
  message: string;
  /** Extra detail worth showing smaller, when there is any. */
  hint: string | null;
  /** The Worker's code, when it sent one. */
  code: string | null;
  /** Seconds to wait before trying again, when the Worker asked for a wait. */
  retryAfterSeconds: number | null;
  /** Suggested control to offer beside the message. */
  action: 'retry' | 'forgot' | 'sign-in' | 'none';
}

function waitSentence(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) return `Try again in ${rounded} second${rounded === 1 ? '' : 's'}.`;
  const minutes = Math.ceil(rounded / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

function serverSentence(error: ApiError): string {
  const message = error.message.trim();
  // `fetch` failures and unknown statuses produce messages worth replacing.
  if (!message || /^Request failed \(\d+\)$/i.test(message) || /failed to fetch/i.test(message)) {
    return error.status >= 500
      ? 'The estate server could not complete that request. Nothing was changed.'
      : 'The request was refused. Check what you entered and try again.';
  }
  return message;
}

export function describeSignInProblem(reason: unknown, context: SignInContext): SignInProblem {
  const fallback: SignInProblem = {
    title: 'Something went wrong',
    message: 'The request could not be completed. Try again in a moment.',
    hint: null,
    code: null,
    retryAfterSeconds: null,
    action: 'retry',
  };

  // No response at all: offline, a filtered or blocked host, DNS/VPN trouble,
  // or a connection that died mid-response. The fix is never "retry" alone.
  if (!(reason instanceof ApiError)) {
    if (reason instanceof Error && reason.name === 'AbortError') {
      return { ...fallback, title: 'That took too long', message: 'The estate server did not answer in time. Check your connection and try again.', action: 'retry' };
    }
    return fallback;
  }

  if (isOffline(reason) || reason.code === 'network_unreachable') {
    return {
      title: "Can't reach the estate server",
      message: 'You appear to be offline, or the estate server is unreachable from this network.',
      hint: 'Check your data or Wi-Fi connection, then try again. Nothing you entered was lost.',
      code: reason.code,
      retryAfterSeconds: null,
      action: 'retry',
    };
  }

  const wait = waitSentence(reason.retryAfterSeconds);

  switch (reason.code) {
    case 'too_many_attempts':
      return {
        title: 'Too many attempts',
        message: serverSentence(reason),
        hint: wait ?? 'Wait a few minutes before trying again.',
        code: reason.code,
        retryAfterSeconds: reason.retryAfterSeconds,
        action: context === 'login' ? 'forgot' : 'none',
      };
    case 'invalid_credentials':
      return {
        title: context === 'change-password' ? 'That password is not correct' : 'Sign-in details not accepted',
        message: serverSentence(reason),
        hint: context === 'login'
          ? 'Check the email address and password issued by your estate office. Passwords are case-sensitive.'
          : null,
        code: reason.code,
        retryAfterSeconds: null,
        action: context === 'login' ? 'forgot' : 'none',
      };
    case 'account_inactive':
      return {
        title: 'This account is deactivated',
        message: serverSentence(reason),
        hint: 'Only an Administrator or Manager can reactivate an account. Ownership, bills and gate history are kept while it is off.',
        code: reason.code,
        retryAfterSeconds: null,
        action: 'none',
      };
    case 'account_expired':
      return {
        title: 'This account has expired',
        message: serverSentence(reason),
        hint: 'Sample logins last 24 hours. Ask the estate office for a new account or a temporary password.',
        code: reason.code,
        retryAfterSeconds: null,
        action: 'none',
      };
    case 'invalid_reset_code':
      return {
        title: 'That code was not accepted',
        message: serverSentence(reason),
        hint: 'Codes are eight characters, do not use 0, O, 1, I or L, and stop working once they are used or expired.',
        code: reason.code,
        retryAfterSeconds: null,
        action: 'none',
      };
    case 'reset_expired':
      return {
        title: 'That code has expired',
        message: serverSentence(reason),
        hint: 'Ask for a new one — a fresh code is created straight away.',
        code: reason.code,
        retryAfterSeconds: null,
        action: 'forgot',
      };
    case 'weak_password':
      return {
        title: 'Choose a stronger password',
        message: serverSentence(reason),
        hint: 'Use at least 12 characters. A short phrase you can remember beats a short password you cannot.',
        code: reason.code,
        retryAfterSeconds: null,
        action: 'none',
      };
    case 'validation':
      return {
        title: 'Check what was entered',
        message: serverSentence(reason),
        hint: null,
        code: reason.code,
        retryAfterSeconds: null,
        action: 'none',
      };
    case 'session_ended':
      return {
        title: 'Your session ended',
        message: serverSentence(reason),
        hint: 'This happens when a password is changed, an account is deactivated, or a session runs out of time.',
        code: reason.code,
        retryAfterSeconds: null,
        action: 'sign-in',
      };
    case 'service_unavailable':
      return {
        title: 'The estate server is unavailable',
        message: serverSentence(reason),
        hint: 'Nothing was changed. Try again in a moment.',
        code: reason.code,
        retryAfterSeconds: null,
        action: 'retry',
      };
    default:
      break;
  }

  if (reason.status === 401) {
    return {
      title: context === 'session' ? 'Your session ended' : 'That was not accepted',
      message: serverSentence(reason),
      hint: context === 'session' ? 'Sign in again to continue.' : null,
      code: reason.code,
      retryAfterSeconds: null,
      action: context === 'session' ? 'sign-in' : 'retry',
    };
  }
  if (reason.status === 403) {
    return {
      title: 'Not allowed',
      message: serverSentence(reason),
      hint: 'Your role does not cover this action. Ask an Administrator if you need it.',
      code: reason.code,
      retryAfterSeconds: null,
      action: 'none',
    };
  }
  if (reason.status === 429) {
    return { title: 'Too many attempts', message: serverSentence(reason), hint: wait, code: reason.code, retryAfterSeconds: reason.retryAfterSeconds, action: 'none' };
  }
  if (reason.status >= 500) {
    return {
      title: 'The estate server had a problem',
      message: 'The server could not complete that request. Nothing was changed.',
      hint: reason.message && !/request failed/i.test(reason.message) ? reason.message : 'If it keeps happening, tell the estate office what you were doing at the time.',
      code: reason.code,
      retryAfterSeconds: null,
      action: 'retry',
    };
  }
  return {
    title: 'That did not work',
    message: serverSentence(reason),
    hint: null,
    code: reason.code,
    retryAfterSeconds: null,
    action: 'retry',
  };
}

/** One line, for the toast-style notices the rest of the portal uses. */
export function signInProblemLine(problem: SignInProblem): string {
  return problem.hint ? `${problem.message} ${problem.hint}` : problem.message;
}
