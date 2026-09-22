package com.estatemate.app.data.remote

import com.google.gson.annotations.SerializedName
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
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
}
