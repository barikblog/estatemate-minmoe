package com.estatemate.app.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Where a phone keeps its session, and how long for.
 *
 * "Remember me" is the difference between two real behaviours on a device that
 * other people may pick up:
 *
 *   * remembered — the token is written to encrypted storage, so the app opens
 *     signed in for the 30 days the Worker's session lasts;
 *   * not remembered — the token lives only in memory for as long as the app is
 *     running, so closing it signs the person out.
 *
 * The email address is remembered separately from the session: it is a
 * convenience for the next sign-in, not a credential, and it is kept even when
 * the session is not.
 */
@Singleton
class AuthStore @Inject constructor(@ApplicationContext context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
    private val preferences = EncryptedSharedPreferences.create(
        context,
        "estatemate_session",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    /**
     * The session held only for as long as this process lives. It is what a
     * sign-in that did not ask to be remembered is kept in, and it is checked
     * first so a remembered token from a previous run cannot leak into a
     * session the person did not ask for.
     */
    private var volatileToken: String? = null

    /** True once a sign-in asked to be remembered on this device. */
    var rememberMe: Boolean
        get() = preferences.getBoolean(KEY_REMEMBER_ME, false)
        set(value) {
            preferences.edit().putBoolean(KEY_REMEMBER_ME, value).apply()
        }

    /** The address offered the next time the sign-in screen opens. */
    var rememberedEmail: String?
        get() = preferences.getString(KEY_EMAIL, null)
        set(value) {
            preferences.edit().apply {
                if (value.isNullOrBlank()) remove(KEY_EMAIL) else putString(KEY_EMAIL, value)
            }.apply()
        }

    /** The token every request is authorised with, or null when signed out. */
    var token: String?
        get() = volatileToken ?: preferences.getString(KEY_TOKEN, null)
        set(value) {
            volatileToken = value
            preferences.edit().apply {
                if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, value)
            }.apply()
        }

    /**
     * Records a successful sign-in.
     *
     * A session that was not remembered still has to work for as long as the
     * app is open, so the token is held in memory; only a remembered one is
     * written to disk, which is what "signed out when the app closes" means.
     */
    fun storeSession(token: String, email: String, remember: Boolean) {
        rememberMe = remember
        rememberedEmail = email
        volatileToken = token
        preferences.edit().apply {
            if (remember) putString(KEY_TOKEN, token) else remove(KEY_TOKEN)
        }.apply()
    }

    /** Forgets the session on this device and keeps only the email to prefill. */
    fun clearSession() {
        volatileToken = null
        preferences.edit().remove(KEY_TOKEN).apply()
    }

    private companion object {
        const val KEY_TOKEN = "token"
        const val KEY_EMAIL = "remembered_email"
        const val KEY_REMEMBER_ME = "remember_me"
    }
}
