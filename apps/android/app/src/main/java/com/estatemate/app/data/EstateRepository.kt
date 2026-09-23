package com.estatemate.app.data

import com.estatemate.app.data.local.AccessEventDao
import com.estatemate.app.data.local.CachedAccessEvent
import com.estatemate.app.data.remote.DashboardResponse
import com.estatemate.app.data.remote.EstateMateApi
import com.estatemate.app.data.remote.HouseholdActionBody
import com.estatemate.app.data.remote.HouseholdMemberDto
import com.estatemate.app.data.remote.HouseholdRequestBody
import com.estatemate.app.data.remote.LoginRequest
import com.estatemate.app.data.remote.OwnershipRequestBody
import com.estatemate.app.data.remote.OwnershipRequestDto
import com.estatemate.app.data.remote.OwnershipReviewBody
import com.estatemate.app.data.remote.PropertyDto
import com.estatemate.app.data.remote.TenancyActionBody
import com.estatemate.app.data.remote.TenancyDto
import com.estatemate.app.data.remote.TenancyRequestBody
import com.estatemate.app.data.remote.UserDto
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class EstateRepository @Inject constructor(
    private val api: EstateMateApi,
    private val authStore: AuthStore,
    private val eventDao: AccessEventDao,
) {
    val recentEvents: Flow<List<CachedAccessEvent>> = eventDao.observeRecent()

    suspend fun login(email: String, password: String): UserDto =
        api.login(LoginRequest(email.trim(), password)).also { authStore.token = it.token }.user

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
