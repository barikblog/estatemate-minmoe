package com.estatemate.app

import com.estatemate.app.data.ServerMessageException
import retrofit2.HttpException
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * One vocabulary for everything that can go wrong while signing in, mirroring
 * `apps/web/src/sign-in-errors.ts` so the phone says what the portal says.
 *
 * A phone meets the failures the portal meets — a wrong password, a deactivated
 * account, a Worker that is down — plus one the portal rarely sees: no usable
 * data connection at all, which used to reach the sign-in screen as
 * "Failed to connect to /10.0.2.2:8787". `test/sign-in-client-parity.test.ts`
 * fails if the two files drift apart.
 */

/** Which form asked, because the same code means different next steps. */
enum class SignInContext { Login, Forgot, Reset, ChangePassword, Session }

/** The control to offer beside the message, as in the portal. */
enum class SignInAction { Retry, Forgot, SignIn, None }

data class SignInProblem(
    /** Short heading: what kind of failure this is. */
    val title: String,
    /** What happened, and what to do about it. */
    val message: String,
    /** Extra detail worth showing smaller, when there is any. */
    val hint: String? = null,
    /** The Worker's code, when it sent one. */
    val code: String? = null,
    /** Seconds to wait before trying again, when the Worker asked for a wait. */
    val retryAfterSeconds: Long? = null,
    /** Suggested control to offer beside the message. */
    val action: SignInAction = SignInAction.Retry,
)

/** One line, for the notices every other screen shows. */
fun signInProblemLine(problem: SignInProblem): String =
    problem.hint?.let { "${problem.message} $it" } ?: problem.message

private fun waitSentence(seconds: Long?): String? {
    if (seconds == null || seconds <= 0) return null
    val rounded = seconds.coerceAtLeast(1)
    if (rounded < 60) return "Try again in $rounded second${if (rounded == 1L) "" else "s"}."
    val minutes = (rounded + 59) / 60
    return "Try again in $minutes minute${if (minutes == 1L) "" else "s"}."
}

/** The Worker's sentence, or one of ours when its sentence is a status line. */
private fun serverSentence(error: Throwable, status: Int?): String {
    val message = error.message?.trim().orEmpty()
    val boilerplate = message.isEmpty() ||
        message.matches(Regex("HTTP \\d{3}.*", RegexOption.IGNORE_CASE)) ||
        message.startsWith("Failed to connect", ignoreCase = true)
    if (!boilerplate) return message
    return if (status != null && status >= 500) {
        "The estate server could not complete that request. Nothing was changed."
    } else {
        "The request was refused. Check what you entered and try again."
    }
}

/**
 * The HTTP status behind a failure, however the data layer wrapped it:
 * Retrofit's own `HttpException`, or the repository's `ServerMessageException`
 * when the Worker explained itself. Screens need it to tell a dead session
 * (401) from a form problem the Worker also answers 401 for.
 */
fun Throwable.httpStatus(): Int? = when (this) {
    is HttpException -> code()
    is ServerMessageException -> status
    else -> null
}

/** The Worker's own machine-readable code, when it sent one. */
fun Throwable.apiCode(): String? = (this as? ServerMessageException)?.code

/** True when nothing came back at all: no data, no Wi-Fi, a DNS or VPN problem. */
private fun Throwable.isUnreachable(): Boolean = this is UnknownHostException ||
    this is ConnectException ||
    this is SocketTimeoutException ||
    (this is IOException && httpStatus() == null)

fun describeSignInProblem(error: Throwable, context: SignInContext): SignInProblem {
    val status = error.httpStatus()
    val code = (error as? ServerMessageException)?.code
    val retryAfter = (error as? ServerMessageException)?.retryAfterSeconds
    val fallback = SignInProblem(
        title = "Something went wrong",
        message = "The request could not be completed. Try again in a moment.",
        action = SignInAction.Retry,
    )

    // No response at all: offline, a blocked host, DNS or VPN trouble, or a
    // connection that died mid-answer. The fix is never "retry" alone.
    if (error.isUnreachable()) {
        return SignInProblem(
            title = "Can't reach the estate server",
            message = "You appear to be offline, or the estate server is unreachable from this network.",
            hint = if (error is SocketTimeoutException) {
                "The server did not answer in time. Check your connection and try again — nothing you entered was lost."
            } else {
                "Check your data or Wi-Fi connection, then try again. Nothing you entered was lost."
            },
            code = "network_unreachable",
            action = SignInAction.Retry,
        )
    }
    if (status == null && code == null) return fallback

    val wait = waitSentence(retryAfter)

    when (code) {
        "too_many_attempts" -> return SignInProblem(
            title = "Too many attempts",
            message = serverSentence(error, status),
            hint = wait ?: "Wait a few minutes before trying again.",
            code = code,
            retryAfterSeconds = retryAfter,
            action = if (context == SignInContext.Login) SignInAction.Forgot else SignInAction.None,
        )
        "invalid_credentials" -> return SignInProblem(
            title = if (context == SignInContext.ChangePassword) "That password is not correct" else "Sign-in details not accepted",
            message = serverSentence(error, status),
            hint = if (context == SignInContext.Login) {
                "Check the email address and password issued by your estate office. Passwords are case-sensitive."
            } else {
                null
            },
            code = code,
            action = if (context == SignInContext.Login) SignInAction.Forgot else SignInAction.None,
        )
        "account_inactive" -> return SignInProblem(
            title = "This account is deactivated",
            message = serverSentence(error, status),
            hint = "Only an Administrator or Manager can reactivate an account. Ownership, bills and gate history are kept while it is off.",
            code = code,
            action = SignInAction.None,
        )
        "account_expired" -> return SignInProblem(
            title = "This account has expired",
            message = serverSentence(error, status),
            hint = "Sample logins last 24 hours. Ask the estate office for a new account or a temporary password.",
            code = code,
            action = SignInAction.None,
        )
        "invalid_reset_code" -> return SignInProblem(
            title = "That code was not accepted",
            message = serverSentence(error, status),
            hint = "Codes are eight characters, do not use 0, O, 1, I or L, and stop working once they are used or expired.",
            code = code,
            action = SignInAction.None,
        )
        "reset_expired" -> return SignInProblem(
            title = "That code has expired",
            message = serverSentence(error, status),
            hint = "Ask for a new one — a fresh code is created straight away.",
            code = code,
            action = SignInAction.Forgot,
        )
        "weak_password" -> return SignInProblem(
            title = "Choose a stronger password",
            message = serverSentence(error, status),
            hint = "Use at least 12 characters. A short phrase you can remember beats a short password you cannot.",
            code = code,
            action = SignInAction.None,
        )
        "validation" -> return SignInProblem(
            title = "Check what was entered",
            message = serverSentence(error, status),
            code = code,
            action = SignInAction.None,
        )
        "session_ended" -> return SignInProblem(
            title = "Your session ended",
            message = serverSentence(error, status),
            hint = "This happens when a password is changed, an account is deactivated, or a session runs out of time.",
            code = code,
            action = SignInAction.SignIn,
        )
        "service_unavailable" -> return SignInProblem(
            title = "The estate server is unavailable",
            message = serverSentence(error, status),
            hint = "Nothing was changed. Try again in a moment.",
            code = code,
            action = SignInAction.Retry,
        )
    }

    return when {
        status == 401 -> SignInProblem(
            title = if (context == SignInContext.Session) "Your session ended" else "That was not accepted",
            message = serverSentence(error, status),
            hint = if (context == SignInContext.Session) "Sign in again to continue." else null,
            code = code,
            action = if (context == SignInContext.Session) SignInAction.SignIn else SignInAction.Retry,
        )
        status == 403 -> SignInProblem(
            title = "Not allowed",
            message = serverSentence(error, status),
            hint = "Your role does not cover this action. Ask an Administrator if you need it.",
            code = code,
            action = SignInAction.None,
        )
        status == 429 -> SignInProblem(
            title = "Too many attempts",
            message = serverSentence(error, status),
            hint = wait,
            code = code,
            retryAfterSeconds = retryAfter,
            action = SignInAction.None,
        )
        status != null && status >= 500 -> SignInProblem(
            title = "The estate server had a problem",
            message = "The server could not complete that request. Nothing was changed.",
            hint = "If it keeps happening, tell the estate office what you were doing at the time.",
            code = code,
            action = SignInAction.Retry,
        )
        else -> SignInProblem(
            title = "That did not work",
            message = serverSentence(error, status),
            code = code,
            action = SignInAction.Retry,
        )
    }
}

/**
 * The message every other screen shows for a failure, whatever produced it: the
 * Worker's own sentence when there is one, our sentence when the network never
 * answered, and the caller's fallback only when even that is empty.
 */
fun describeError(error: Throwable, fallback: String): String =
    signInProblemLine(describeSignInProblem(error, SignInContext.Session))
        .takeIf { it.isNotBlank() } ?: fallback
