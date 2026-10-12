package com.estatemate.app.data.remote

import com.google.gson.JsonObject
import com.google.gson.annotations.SerializedName
import okhttp3.RequestBody
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Url

/**
 * Sign-in body.
 *
 * [rememberMe] asks the Worker for a 30-day session instead of a working day,
 * and [client] tells it which app is asking so a password-reset request can be
 * recorded with where it came from.
 */
data class LoginRequest(
    val email: String,
    val password: String,
    val rememberMe: Boolean = false,
    val client: String = "android",
)

/** Body of `POST /api/auth/forgot-password`; the Worker answers 202 either way. */
data class ForgotPasswordRequest(val email: String, val client: String = "android")

/**
 * What a reset request answered with.
 *
 * `delivery` is `office` (the estate office issues a temporary password) or
 * `self_service` (a one-time [code] was created and is shown here). A request
 * for an address the estate does not have answers in exactly the same shape, so
 * nothing on this screen can reveal which addresses exist.
 */
data class ForgotPasswordResponse(
    val reference: String,
    val delivery: String,
    val email: String? = null,
    val code: String? = null,
    val codeMinutes: Int? = null,
    val expiresAt: String? = null,
    val message: String? = null,
)

/** Body of `POST /api/auth/reset-password`, which spends a one-time code. */
data class ResetPasswordRequest(val email: String, val code: String, val newPassword: String)
data class ResetPasswordResponse(val ok: Boolean, val message: String? = null)

/**
 * Body of `POST /api/auth/change-password`. The answer carries a replacement
 * token: changing a password ends every session that existed before it, this
 * one included, so the new one has to be stored straight away.
 */
data class ChangePasswordRequest(val currentPassword: String, val newPassword: String)
data class ChangePasswordResponse(val ok: Boolean, val token: String? = null, val message: String? = null)

/** What issuing a temporary password answers with; the password exists once. */
data class IssuedPasswordResponse(
    val ok: Boolean,
    val reference: String,
    val personName: String,
    val email: String,
    val temporaryPassword: String,
    val message: String? = null,
)

/**
 * A Security officer with assigned gates does not receive a session from login.
 * The Worker instead returns [requiresGateSelection] with the [gates] they may
 * work and a short-lived [selectionToken] to exchange through selectGate.
 *
 * [token] is therefore nullable: Gson does not enforce Kotlin nullability, so a
 * missing field would otherwise arrive as null behind a non-null type and be
 * stored as an absent session, making every later call fail with 401.
 */
data class LoginResponse(
    val token: String?,
    val user: UserDto,
    @SerializedName("requiresGateSelection") val requiresGateSelection: Boolean?,
    @SerializedName("selectionToken") val selectionToken: String?,
    val gates: List<GateDto>?,
    /** Echoed by the Worker so the app can store the session the way it was asked for. */
    val rememberMe: Boolean? = null,
)

data class GateDto(
    val id: String,
    val name: String?,
    @SerializedName("gate_name") val gateName: String?,
    val direction: String?,
)

data class SelectGateRequest(
    @SerializedName("selectionToken") val selectionToken: String,
    @SerializedName("deviceId") val deviceId: String,
)

data class SelectGateResponse(val token: String, val user: UserDto, val gate: GateDto?)
data class UserDto(
    val id: String,
    val name: String,
    val email: String,
    val role: String,
    @SerializedName("property_id") val propertyId: String?,
)
/**
 * The signed-in user, plus the gate a Security officer's session is scoped to.
 * The gate is absent for every other role (and for an officer on an estate with
 * no active gate device), so it is nullable rather than defaulted.
 */
data class MeResponse(val user: UserDto, val gate: GateDto? = null)
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

/** A list endpoint whose body is only `{ items }` (no paging fields). Rows stay generic: the Menu renders the columns a module declares. */
data class ItemsResponse(val items: List<JsonObject> = emptyList())
data class DashboardResponse(
    val residents: CountDto?,
    val visitors: CountDto?,
    val openMaintenance: CountDto?,
    val todayAccessEvents: CountDto?,
    val residentsInGrace: CountDto?,
    val outstandingBills: MoneyCountDto?,
    val activeVisitors: CountDto?,
    val activeCards: CountDto?,
    /** Residents only: the newest active estate notice, shown on the dashboard. */
    val latestNotice: NoticeDto? = null,
)
data class NoticeDto(
    val id: String,
    val title: String,
    val body: String,
    val severity: String?,
    @SerializedName("created_at") val createdAt: String?,
    /** 0/1 from the Worker, so the app can mark a notice the resident has read. */
    val acknowledged: Int? = null,
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

/**
 * The estate settings a resident's forms depend on. Values arrive as strings
 * because the Worker stores them in the key/value `settings` table, so the
 * validity window is parsed rather than trusted.
 */
data class PortalConfigDto(
    @SerializedName("estate_timezone") val estateTimeZone: String? = null,
    @SerializedName("visitor_default_validity_days") val visitorDefaultValidityDays: String? = null,
    @SerializedName("visitor_max_validity_days") val visitorMaxValidityDays: String? = null,
    @SerializedName("visitor_person_type") val visitorPersonType: String? = null,
    /** The pass header's branding, as the portal's own pass modal prints it. */
    @SerializedName("portal_name") val portalName: String? = null,
    @SerializedName("portal_short_name") val portalShortName: String? = null,
)

/**
 * What `POST /api/visitors` answers with. The six-digit [pin] and the
 * [credentialNumber] are generated by the Worker and shown to the requester to
 * pass on to the visitor; they are never chosen here.
 */
data class VisitorPassCreated(
    val id: String,
    val propertyId: String? = null,
    val pin: String,
    val qrToken: String? = null,
    val credentialNumber: String? = null,
    val validFrom: String? = null,
    val validUntil: String? = null,
    val visitTimes: Int? = null,
    val purposeOfVisitLabel: String? = null,
)

/** Body of `POST /api/visitors`. Datetimes are the portal's naive `yyyy-MM-ddTHH:mm` wall-clock strings. */
data class VisitorPassBody(
    val visitorName: String,
    val visitorPhone: String? = null,
    /** Operators only: the resident the pass is issued for. Residents are the session's own user. */
    val residentId: String? = null,
    val propertyId: String? = null,
    /** Operators only: scope the pass to one gate device. Blank or absent means every gate. */
    val deviceId: String? = null,
    val validFrom: String,
    val validUntil: String,
    val purposeOfVisit: String? = null,
    val purposeOfVisitOther: String? = null,
    val visitTimes: Int? = null,
    val remark: String? = null,
    /** Operators only: the person type filed on the terminals (`visitor` or `normal`). */
    val personType: String? = null,
    val requireGateIdVerification: Boolean = false,
    /** Storage keys of the resident's identity/invitation proofs, as the portal posts them. */
    val proofKeys: List<String>? = null,
)

/** `POST /api/maintenance` answers with the row it wrote, not a status. */
data class MaintenanceCreated(
    val id: String,
    val propertyId: String? = null,
    val scopeType: String? = null,
    val scopeTarget: String? = null,
)

/** Body of `POST /api/maintenance`; `scopeType` is one of personal/street/block/zone/estate. */
data class MaintenanceRequestBody(
    val description: String,
    val residentId: String? = null,
    val propertyId: String? = null,
    val scopeType: String = "personal",
    val scopeTarget: String? = null,
)

/** Body of `POST /api/facility-bookings`. */
data class FacilityBookingBody(
    val facilityId: String,
    val propertyId: String? = null,
    val startsAt: String,
    val endsAt: String,
    val purpose: String? = null,
    val attendees: Int? = null,
    val contactPhone: String? = null,
    /** Operators only: the resident the booking is for. */
    val requesterId: String? = null,
)

data class FacilityBookingCreated(
    val id: String,
    val status: String,
    val estimatedCostMinor: Long? = null,
    val depositMinor: Long? = null,
    val requiresPayment: Boolean? = null,
)

/** `PATCH /api/facility-bookings/:id`. A requester may cancel; operators may decide. */
data class BookingActionBody(val action: String, val note: String? = null)

data class FacilityDto(
    val id: String,
    val name: String,
    val location: String? = null,
    val capacity: Int? = null,
    @SerializedName("hourly_rate_minor") val hourlyRateMinor: Long? = null,
    @SerializedName("deposit_minor") val depositMinor: Long? = null,
    @SerializedName("requires_approval") val requiresApproval: Int? = null,
    @SerializedName("requires_payment") val requiresPayment: Int? = null,
    @SerializedName("min_notice_hours") val minNoticeHours: Int? = null,
    @SerializedName("max_hours_per_booking") val maxHoursPerBooking: Int? = null,
    @SerializedName("rules") val rules: String? = null,
    val status: String,
)

/** `/api/facilities` answers with `{ items }` only, so it has no paging fields. */
data class FacilitiesResponse(val items: List<FacilityDto> = emptyList())

/**
 * One gate device offered by `/api/access/device-options`, for the pass form's
 * "Preferred gate device" picker — the same rows and the same QR/PIN wording the
 * portal's create form shows.
 */
data class DeviceOptionDto(
    val id: String,
    val name: String,
    val vendor: String? = null,
    val model: String? = null,
    @SerializedName("gate_name") val gateName: String? = null,
    val supportsQr: Boolean? = null,
)

/** `/api/access/device-options` answers with `{ items }` only. */
data class DeviceOptionsResponse(val items: List<DeviceOptionDto> = emptyList())

interface EstateMateApi {
    @POST("api/auth/login")
    suspend fun login(@Body request: LoginRequest): LoginResponse

    @POST("api/auth/select-gate")
    suspend fun selectGate(@Body request: SelectGateRequest): SelectGateResponse

    /**
     * Records a forgotten password. The estate has no mail server, so the answer
     * carries either a reference for the estate office or, where the
     * Administrator enabled it, a one-time code this screen shows.
     */
    @POST("api/auth/forgot-password")
    suspend fun forgotPassword(@Body request: ForgotPasswordRequest): ForgotPasswordResponse

    /** Spends the one-time code for a new password. */
    @POST("api/auth/reset-password")
    suspend fun resetPassword(@Body request: ResetPasswordRequest): ResetPasswordResponse

    /** Changes the signed-in person's own password and returns their new session. */
    @POST("api/auth/change-password")
    suspend fun changePassword(@Body request: ChangePasswordRequest): ChangePasswordResponse

    /**
     * Issues a temporary password for a queued reset request (Administrator or
     * Manager). Their other sessions are ended and the password is shown once.
     */
    @POST("api/password-resets/{id}/issue")
    suspend fun issuePasswordReset(@Path("id") id: String): IssuedPasswordResponse

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

    /** Estate settings for the forms (validity window, estate timezone). */
    @GET("api/portal-config")
    suspend fun portalConfig(): PortalConfigDto

    /** Gate devices a pass may be scoped to — the form's "Preferred gate device" picker. */
    @GET("api/access/device-options")
    suspend fun deviceOptions(): DeviceOptionsResponse

    /**
     * Uploads one supporting proof exactly as the portal does: the raw file
     * bytes as the body, with the name and category in headers. Answers with
     * the stored-file record, whose `key` becomes a `proofKeys` entry.
     */
    @POST("api/files")
    suspend fun uploadFile(
        @Body body: RequestBody,
        @Header("X-Filename") filename: String,
        @Header("X-File-Category") category: String,
    ): JsonObject

    @POST("api/visitors")
    suspend fun createVisitorPass(@Body request: VisitorPassBody): VisitorPassCreated

    @POST("api/maintenance")
    suspend fun createMaintenanceRequest(@Body request: MaintenanceRequestBody): MaintenanceCreated

    /** Active facilities only for a resident; operators also see retired ones. */
    @GET("api/facilities")
    suspend fun facilities(): FacilitiesResponse

    @POST("api/facility-bookings")
    suspend fun createFacilityBooking(@Body request: FacilityBookingBody): FacilityBookingCreated

    /** Cancel a pending or approved booking. The requester or an operator may. */
    @PATCH("api/facility-bookings/{id}")
    suspend fun facilityBookingAction(@Path("id") id: String, @Body action: BookingActionBody): ActionResponse

    /** Read-only list for a Menu module; [path] is relative to the Worker base URL, e.g. `api/bills`. */
    @GET
    suspend fun moduleItems(@Url path: String, @Query("limit") limit: Int = 50): ItemsResponse
}
