package com.estatemate.app.data.remote

import com.google.gson.annotations.SerializedName
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

data class LoginRequest(val email: String, val password: String)
data class LoginResponse(val token: String, val user: UserDto)
data class UserDto(
    val id: String,
    val name: String,
    val email: String,
    val role: String,
    @SerializedName("property_id") val propertyId: String?,
)
data class MeResponse(val user: UserDto)
data class AccessEventDto(
    val id: String,
    @SerializedName("person_name") val personName: String?,
    @SerializedName("card_uid") val cardUid: String?,
    @SerializedName("device_name") val deviceName: String?,
    @SerializedName("access_point_name") val accessPointName: String?,
    val direction: String?,
    val result: String,
    @SerializedName("device_timestamp") val deviceTimestamp: String,
)
data class AccessCardDto(
    val id: String,
    @SerializedName("card_uid") val cardUid: String,
    @SerializedName("card_label") val cardLabel: String?,
    val status: String,
    @SerializedName("expires_at") val expiresAt: String?,
    @SerializedName("deactivated_reason") val deactivatedReason: String?,
)
data class ListResponse<T>(val items: List<T>, val page: Int, val limit: Int)
data class DashboardResponse(
    val residents: CountDto?,
    val visitors: CountDto?,
    val openMaintenance: CountDto?,
    val todayAccessEvents: CountDto?,
    val residentsInGrace: CountDto?,
    val outstandingBills: MoneyCountDto?,
    val activeVisitors: CountDto?,
    val activeCards: CountDto?,
)
data class CountDto(val count: Int)
data class MoneyCountDto(val count: Int, val amount: Long)
data class PropertyDto(
    val id: String,
    @SerializedName("unit_number") val unitNumber: String,
    val street: String?,
    val block: String?,
    val zone: String?,
    val address: String,
    @SerializedName("owner_name") val ownerName: String?,
    @SerializedName("tenant_name") val tenantName: String?,
    @SerializedName("relationship_type") val relationshipType: String?,
    @SerializedName("billing_responsibility") val billingResponsibility: String?,
    @SerializedName("approved_at") val approvedAt: String?,
)
data class OwnershipRequestDto(
    val id: String,
    @SerializedName("unit_number") val unitNumber: String?,
    val street: String?,
    val address: String?,
    val status: String,
    @SerializedName("request_note") val requestNote: String?,
    @SerializedName("review_note") val reviewNote: String?,
    @SerializedName("created_at") val createdAt: String,
)
data class OwnershipRequestBody(
    val propertyId: String? = null,
    val proposedUnitNumber: String? = null,
    val proposedStreet: String? = null,
    val proposedAddress: String? = null,
    val requestNote: String? = null,
)
data class OwnershipRequestCreated(val id: String, val status: String)
data class OwnershipReviewBody(val status: String, val reviewNote: String? = null)
data class OwnershipReviewResponse(val ok: Boolean, val status: String)
data class ActionResponse(val ok: Boolean)
data class TenancyDto(
    val id: String,
    @SerializedName("property_id") val propertyId: String,
    @SerializedName("unit_number") val unitNumber: String,
    @SerializedName("owner_name") val ownerName: String,
    @SerializedName("tenant_name") val tenantName: String,
    @SerializedName("start_date") val startDate: String,
    @SerializedName("end_date") val endDate: String?,
    @SerializedName("billing_responsibility") val billingResponsibility: String,
    val status: String,
)
data class TenancyRequestBody(
    val propertyId: String,
    val tenantEmail: String,
    val startDate: String,
    val endDate: String? = null,
    val billingResponsibility: String = "owner",
    val requestNote: String? = null,
)
data class TenancyActionBody(val action: String, val billingResponsibility: String? = null, val reviewNote: String? = null)
data class HouseholdMemberDto(
    val id: String,
    @SerializedName("property_id") val propertyId: String,
    @SerializedName("unit_number") val unitNumber: String,
    val name: String,
    val relationship: String,
    @SerializedName("primary_resident_name") val primaryResidentName: String,
    @SerializedName("login_email") val loginEmail: String?,
    @SerializedName("can_create_visitors") val canCreateVisitors: Int,
    @SerializedName("can_view_bills") val canViewBills: Int,
    val status: String,
)
data class HouseholdRequestBody(
    val propertyId: String,
    val name: String,
    val relationship: String,
    val phone: String? = null,
    val email: String? = null,
    val canCreateVisitors: Boolean = false,
    val canViewBills: Boolean = false,
)
data class HouseholdActionBody(val action: String, val canCreateVisitors: Boolean? = null, val canViewBills: Boolean? = null)

interface EstateMateApi {
    @POST("api/auth/login")
    suspend fun login(@Body request: LoginRequest): LoginResponse

    @GET("api/auth/me")
    suspend fun me(): MeResponse

    @GET("api/dashboard")
    suspend fun dashboard(): DashboardResponse

    @GET("api/access/events")
    suspend fun accessEvents(@Query("limit") limit: Int = 50): ListResponse<AccessEventDto>

    @GET("api/access/cards")
    suspend fun cards(@Query("limit") limit: Int = 50): ListResponse<AccessCardDto>

    @GET("api/properties")
    suspend fun properties(@Query("limit") limit: Int = 100): ListResponse<PropertyDto>

    @GET("api/properties/available")
    suspend fun availableProperties(): ListResponse<PropertyDto>

    @GET("api/property-ownership-requests")
    suspend fun ownershipRequests(@Query("limit") limit: Int = 100): ListResponse<OwnershipRequestDto>

    @POST("api/property-ownership-requests")
    suspend fun requestOwnership(@Body request: OwnershipRequestBody): OwnershipRequestCreated

    @PATCH("api/property-ownership-requests/{id}")
    suspend fun reviewOwnership(@Path("id") id: String, @Body review: OwnershipReviewBody): OwnershipReviewResponse

    @GET("api/property-tenancies")
    suspend fun tenancies(@Query("limit") limit: Int = 100): ListResponse<TenancyDto>

    @POST("api/property-tenancies")
    suspend fun createTenancy(@Body request: TenancyRequestBody): OwnershipRequestCreated

    @PATCH("api/property-tenancies/{id}")
    suspend fun tenancyAction(@Path("id") id: String, @Body action: TenancyActionBody): ActionResponse

    @GET("api/household-members")
    suspend fun householdMembers(@Query("limit") limit: Int = 100): ListResponse<HouseholdMemberDto>

    @POST("api/household-members")
    suspend fun createHouseholdMember(@Body request: HouseholdRequestBody): OwnershipRequestCreated

    @PATCH("api/household-members/{id}")
    suspend fun householdAction(@Path("id") id: String, @Body action: HouseholdActionBody): ActionResponse
}
