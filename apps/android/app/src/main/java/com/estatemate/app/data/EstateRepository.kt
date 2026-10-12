package com.estatemate.app.data

import com.estatemate.app.data.local.AccessEventDao
import com.estatemate.app.data.local.CachedAccessEvent
import com.estatemate.app.data.remote.DashboardResponse
import com.estatemate.app.data.remote.EstateMateApi
import com.estatemate.app.data.remote.GateDto
import com.estatemate.app.data.remote.HouseholdActionBody
import com.google.gson.JsonObject
import com.estatemate.app.data.remote.HouseholdMemberDto
import com.estatemate.app.data.remote.HouseholdRequestBody
import com.estatemate.app.data.remote.LoginRequest
import com.estatemate.app.data.remote.OwnershipRequestBody
import com.estatemate.app.data.remote.OwnershipRequestDto
import com.estatemate.app.data.remote.OwnershipReviewBody
import com.estatemate.app.data.remote.PropertyDto
import com.estatemate.app.data.remote.SelectGateRequest
import com.estatemate.app.data.remote.TenancyActionBody
import com.estatemate.app.data.remote.TenancyDto
import com.estatemate.app.data.remote.TenancyRequestBody
import com.estatemate.app.data.remote.UserDto
import kotlinx.coroutines.flow.Flow
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
