package com.estatemate.app.data

import android.content.Context
import android.net.Uri
import com.estatemate.app.data.local.AccessEventDao
import com.estatemate.app.data.local.CachedAccessEvent
import com.estatemate.app.data.remote.BookingActionBody
import com.estatemate.app.data.remote.DashboardResponse
import com.estatemate.app.data.remote.DeviceOptionDto
import com.estatemate.app.data.remote.EstateMateApi
import com.estatemate.app.data.remote.FacilityBookingBody
import com.estatemate.app.data.remote.FacilityBookingCreated
import com.estatemate.app.data.remote.FacilityDto
import com.estatemate.app.data.remote.GateDto
import com.estatemate.app.data.remote.HouseholdActionBody
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.estatemate.app.data.remote.HouseholdMemberDto
import com.estatemate.app.data.remote.HouseholdRequestBody
import com.estatemate.app.data.remote.LoginRequest
import com.estatemate.app.data.remote.MaintenanceRequestBody
import com.estatemate.app.data.remote.OwnershipRequestBody
import com.estatemate.app.data.remote.OwnershipRequestDto
import com.estatemate.app.data.remote.OwnershipReviewBody
import com.estatemate.app.data.remote.PortalConfigDto
import com.estatemate.app.data.remote.PropertyDto
import com.estatemate.app.data.remote.SelectGateRequest
import com.estatemate.app.data.remote.TenancyActionBody
import com.estatemate.app.data.remote.TenancyDto
import com.estatemate.app.data.remote.TenancyRequestBody
import com.estatemate.app.data.remote.UserDto
import com.estatemate.app.data.remote.VisitorPassBody
import com.estatemate.app.data.remote.VisitorPassCreated
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The two ways a sign-in can end.
 *
 * A Security officer posted at exactly one gate is scoped to that gate
 * automatically. An officer with several posts has to say which one they are
 * working before a session exists at all: the Worker answers with a short-lived
 * selection token and the gates they may pick from, and the client shows that
 * list and exchanges the choice through /api/auth/select-gate. Treating the
 * second case as a failure (as this app used to) left every multi-gate officer
 * unable to sign in on the phone.
 */
sealed interface LoginOutcome {
    data class SignedIn(val user: UserDto) : LoginOutcome
    data class GateSelectionRequired(val selectionToken: String, val gates: List<GateDto>) : LoginOutcome
}

@Singleton
class EstateRepository @Inject constructor(
    private val api: EstateMateApi,
    private val authStore: AuthStore,
    private val eventDao: AccessEventDao,
    @ApplicationContext private val context: Context,
) {
    val recentEvents: Flow<List<CachedAccessEvent>> = eventDao.observeRecent()

    /** Signs in, storing the session token before returning the signed-in user. */
    suspend fun login(email: String, password: String): LoginOutcome {
        val response = api.login(LoginRequest(email.trim(), password))
        response.token?.let {
            authStore.token = it
            return LoginOutcome.SignedIn(response.user)
        }
        val selectionToken = response.selectionToken
        val gates = response.gates.orEmpty()
        if (response.requiresGateSelection == true && selectionToken != null && gates.isNotEmpty()) {
            val onlyGate = gates.singleOrNull()
            if (onlyGate != null) {
                // One post: nothing to choose, so do not make the officer choose.
                return LoginOutcome.SignedIn(selectGate(selectionToken, onlyGate.id))
            }
            return LoginOutcome.GateSelectionRequired(selectionToken, gates)
        }
        throw IllegalStateException("Sign-in did not return a session. Please try again.")
    }

    /** Exchanges a gate choice for a session scoped to that gate. */
    suspend fun selectGate(selectionToken: String, deviceId: String): UserDto {
        val selected = api.selectGate(SelectGateRequest(selectionToken, deviceId))
        authStore.token = selected.token
        return selected.user
    }

    /** The gate this session is scoped to, when it is scoped to one. */
    suspend fun currentGateName(): String? {
        val gate = api.me().gate ?: return null
        return gate.gateName ?: gate.name
    }

    suspend fun restore(): UserDto? = if (authStore.token == null) null else runCatching { api.me().user }.getOrElse {
        authStore.token = null
        null
    }

    suspend fun dashboard(): DashboardResponse = api.dashboard()
    suspend fun properties(): List<PropertyDto> = api.properties().items
    suspend fun availableProperties(): List<PropertyDto> = api.availableProperties().items
    suspend fun ownershipRequests(): List<OwnershipRequestDto> = api.ownershipRequests().items
    suspend fun requestOwnership(request: OwnershipRequestBody) = api.requestOwnership(request)
    suspend fun reviewOwnership(id: String, approved: Boolean) = api.reviewOwnership(id, OwnershipReviewBody(if (approved) "approved" else "rejected"))
    suspend fun tenancies(): List<TenancyDto> = api.tenancies().items
    suspend fun createTenancy(request: TenancyRequestBody) = api.createTenancy(request)
    suspend fun tenancyAction(id: String, action: String, billing: String? = null) = api.tenancyAction(id, TenancyActionBody(action,billing))
    suspend fun householdMembers(): List<HouseholdMemberDto> = api.householdMembers().items
    suspend fun createHouseholdMember(request: HouseholdRequestBody) = api.createHouseholdMember(request)
    suspend fun householdAction(id: String, action: String, visitors: Boolean? = null, bills: Boolean? = null) = api.householdAction(id, HouseholdActionBody(action,visitors,bills))

    /** Rows of a Menu module's list endpoint. Throws on failure so the screen can say what went wrong. */
    suspend fun moduleItems(path: String): List<JsonObject> = api.moduleItems(path).items

    /** Estate settings the resident forms read: validity window and estate timezone. */
    suspend fun portalConfig(): PortalConfigDto = serverMessage { api.portalConfig() }

    /** Gate devices a pass may be scoped to — the form's "Preferred gate device" picker. */
    suspend fun deviceOptions(): List<DeviceOptionDto> = serverMessage { api.deviceOptions().items }

    /**
     * Uploads one supporting proof the way the portal does — the file bytes as
     * the body, with its name and category in headers — and returns the storage
     * key the Worker will accept in `proofKeys`.
     *
     * The 4 MB ceiling is checked here first so a phone does not push a file the
     * Worker will refuse, and the refusal uses the Worker's own wording.
     */
    suspend fun uploadProofFile(uri: Uri, displayName: String, category: String): String {
        val bytes = withContext(Dispatchers.IO) {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } ?: throw ServerMessageException("Could not read $displayName from this phone.")
        if (bytes.isEmpty()) throw ServerMessageException("$displayName is empty.")
        if (bytes.size > MAX_PROOF_FILE_BYTES) throw ServerMessageException("File exceeds the 4 MB upload limit")
        val contentType = (context.contentResolver.getType(uri) ?: "application/pdf").lowercase()
        val stored = serverMessage {
            api.uploadFile(bytes.toRequestBody(contentType.toMediaTypeOrNull()), displayName, category)
        }
        return stored.proofKey() ?: throw ServerMessageException("The upload of $displayName did not return a storage key.")
    }

    suspend fun createVisitorPass(request: VisitorPassBody): VisitorPassCreated = serverMessage { api.createVisitorPass(request) }

    suspend fun createMaintenanceRequest(request: MaintenanceRequestBody) = serverMessage { api.createMaintenanceRequest(request) }

    /** Facilities a booking may target. Only active ones are ever offered. */
    suspend fun activeFacilities(): List<FacilityDto> = serverMessage { api.facilities().items.filter { it.status == "active" } }

    suspend fun createFacilityBooking(request: FacilityBookingBody): FacilityBookingCreated = serverMessage { api.createFacilityBooking(request) }

    /** Cancels a booking; the Worker allows the requester or an operator. */
    suspend fun cancelFacilityBooking(id: String) = serverMessage { api.facilityBookingAction(id, BookingActionBody("cancel")) }

    /**
     * Runs an API call and, when the Worker refuses it, re-throws with the
     * message it sent.
     *
     * Every write route answers a refusal with `{ error: "…" }` and a 4xx, which
     * Retrofit surfaces as "HTTP 400 Bad Request" — useless to somebody who
     * needs to know that a window overlaps an existing booking or that a
     * purpose must be described. A 401 is deliberately left alone: the app
     * matches on it to return to sign-in.
     */
    private suspend fun <T> serverMessage(block: suspend () -> T): T = try {
        block()
    } catch (error: HttpException) {
        val text = if (error.code() == 401) null else runCatching { error.response()?.errorBody()?.string() }.getOrNull()
        val message = text?.let { runCatching { JsonParser.parseString(it).asJsonObject.get("error")?.asString }.getOrNull() }
        if (message.isNullOrBlank()) throw error else throw ServerMessageException(message, error)
    }

    suspend fun refreshEvents() {
        val events = api.accessEvents().items.map {
            CachedAccessEvent(it.id, it.personName, it.cardUid, it.deviceName, it.result, it.deviceTimestamp)
        }
        eventDao.replace(events)
    }

    suspend fun logout() {
        authStore.token = null
        eventDao.clear()
    }
}

/**
 * A refusal the Worker explained (`{ error: "…" }`), carried as an ordinary
 * exception so the same `message(error, fallback)` path every screen already
 * uses shows the estate's own words instead of a status line.
 */
class ServerMessageException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** The Worker's per-file ceiling (`MAX_GITHUB_FILE_SIZE` in `src/github-storage.ts`). */
private const val MAX_PROOF_FILE_BYTES = 4 * 1024 * 1024

/** The `key` of a `/api/files` upload response, or null when the body is not what the Worker promised. */
private fun JsonObject.proofKey(): String? =
    get("key")?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() }
