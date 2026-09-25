package com.estatemate.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.estatemate.app.data.EstateRepository
import com.estatemate.app.data.local.CachedAccessEvent
import com.estatemate.app.data.remote.DashboardResponse
import com.estatemate.app.data.remote.HouseholdMemberDto
import com.estatemate.app.data.remote.HouseholdRequestBody
import com.estatemate.app.data.remote.OwnershipRequestBody
import com.estatemate.app.data.remote.OwnershipRequestDto
import com.estatemate.app.data.remote.PropertyDto
import com.estatemate.app.data.remote.TenancyDto
import com.estatemate.app.data.remote.TenancyRequestBody
import com.estatemate.app.data.remote.UserDto
import dagger.hilt.android.AndroidEntryPoint
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Currency
import javax.inject.Inject

private val EstateBlue = Color(0xFF1769E0)
private val EstateNavy = Color(0xFF0D1B37)
private val EstateGreen = Color(0xFF35D07F)
private val EstateBackground = Color(0xFFF4F7FB)

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = MaterialTheme.colorScheme.copy(
                    primary = EstateBlue,
                    secondary = EstateGreen,
                    background = EstateBackground,
                    surface = Color.White,
                ),
            ) { EstateMateApp() }
        }
    }
}

data class AppState(
    val checkingSession: Boolean = true,
    val user: UserDto? = null,
    val dashboard: DashboardResponse? = null,
    val properties: List<PropertyDto> = emptyList(),
    val availableProperties: List<PropertyDto> = emptyList(),
    val ownershipRequests: List<OwnershipRequestDto> = emptyList(),
    val tenancies: List<TenancyDto> = emptyList(),
    val householdMembers: List<HouseholdMemberDto> = emptyList(),
    val busy: Boolean = false,
    val error: String? = null,
)

private data class RefreshPayload(
    val dashboard: DashboardResponse,
    val properties: List<PropertyDto>,
    val availableProperties: List<PropertyDto>,
    val ownershipRequests: List<OwnershipRequestDto>,
    val tenancies: List<TenancyDto>,
    val householdMembers: List<HouseholdMemberDto>,
)

@HiltViewModel
class MainViewModel @Inject constructor(private val repository: EstateRepository) : ViewModel() {
    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state.asStateFlow()
    val events = repository.recentEvents.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    init {
        viewModelScope.launch {
            val user = repository.restore()
            _state.value = AppState(checkingSession = false, user = user)
            if (user != null) refresh()
        }
    }

    fun login(email: String, password: String) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, error = null)
        runCatching { repository.login(email, password) }
            .onSuccess { user -> _state.value = _state.value.copy(user = user, busy = false); refresh() }
            .onFailure { error -> _state.value = _state.value.copy(busy = false, error = error.message ?: "Login failed") }
    }

    fun refresh() = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, error = null)
        val role = _state.value.user?.role
        runCatching {
            val dashboard = repository.dashboard()
            val properties = repository.properties()
            val available = if (role == "resident") repository.availableProperties() else emptyList()
            val requests = if (role == "resident" || role == "admin" || role == "manager") repository.ownershipRequests() else emptyList()
            val tenancies = if (role == "resident" || role == "admin" || role == "manager") repository.tenancies() else emptyList()
            val household = if (role == "resident" || role == "admin" || role == "manager") repository.householdMembers() else emptyList()
            repository.refreshEvents()
            RefreshPayload(dashboard,properties,available,requests,tenancies,household)
        }.onSuccess { payload ->
            _state.value = _state.value.copy(
                dashboard = payload.dashboard,
                properties = payload.properties,
                availableProperties = payload.availableProperties,
                ownershipRequests = payload.ownershipRequests,
                tenancies = payload.tenancies,
                householdMembers = payload.householdMembers,
                busy = false,
            )
        }.onFailure { error -> _state.value = _state.value.copy(busy = false, error = error.message ?: "Unable to refresh") }
    }

    fun requestOwnership(request: OwnershipRequestBody) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, error = null)
        runCatching { repository.requestOwnership(request) }
            .onSuccess { refresh() }
            .onFailure { error -> _state.value = _state.value.copy(busy = false, error = error.message ?: "Ownership request failed") }
    }

    fun reviewOwnership(id: String, approved: Boolean) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, error = null)
        runCatching { repository.reviewOwnership(id, approved) }
            .onSuccess { refresh() }
            .onFailure { error -> _state.value = _state.value.copy(busy = false, error = error.message ?: "Ownership review failed") }
    }

    fun createTenancy(request: TenancyRequestBody) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true,error = null)
        runCatching { repository.createTenancy(request) }.onSuccess { refresh() }
            .onFailure { error -> _state.value = _state.value.copy(busy = false,error = error.message ?: "Tenancy request failed") }
    }

    fun tenancyAction(id: String, action: String, billing: String? = null) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true,error = null)
        runCatching { repository.tenancyAction(id,action,billing) }.onSuccess { refresh() }
            .onFailure { error -> _state.value = _state.value.copy(busy = false,error = error.message ?: "Tenancy action failed") }
    }

    fun createHouseholdMember(request: HouseholdRequestBody) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true,error = null)
        runCatching { repository.createHouseholdMember(request) }.onSuccess { refresh() }
            .onFailure { error -> _state.value = _state.value.copy(busy = false,error = error.message ?: "Household request failed") }
    }

    fun householdAction(id: String, action: String, visitors: Boolean? = null, bills: Boolean? = null) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true,error = null)
        runCatching { repository.householdAction(id,action,visitors,bills) }.onSuccess { refresh() }
            .onFailure { error -> _state.value = _state.value.copy(busy = false,error = error.message ?: "Household action failed") }
    }

    fun logout() = viewModelScope.launch {
        repository.logout()
        _state.value = AppState(checkingSession = false)
    }
}

@Composable
fun EstateMateApp(viewModel: MainViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val events by viewModel.events.collectAsState()
    when {
        state.checkingSession -> FullScreenLoading()
        state.user == null -> LoginScreen(state.busy, state.error, viewModel::login)
        else -> HomeScreen(state,events,viewModel::refresh,viewModel::requestOwnership,viewModel::reviewOwnership,viewModel::createTenancy,viewModel::tenancyAction,viewModel::createHouseholdMember,viewModel::householdAction,viewModel::logout)
    }
}

@Composable
private fun FullScreenLoading() {
    Box(Modifier.fillMaxSize().background(EstateNavy), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Logo()
            CircularProgressIndicator(color = Color.White)
        }
    }
}

@Composable
private fun Logo() {
    Box(Modifier.background(EstateBlue, RoundedCornerShape(16.dp)).padding(17.dp), contentAlignment = Alignment.Center) {
        Text("EM", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun LoginScreen(busy: Boolean, error: String?, onLogin: (String, String) -> Unit) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Box(Modifier.fillMaxSize().background(EstateBackground).padding(24.dp), contentAlignment = Alignment.Center) {
        Card(shape = RoundedCornerShape(22.dp), colors = CardDefaults.cardColors(containerColor = Color.White), elevation = CardDefaults.cardElevation(8.dp)) {
            Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(17.dp)) {
                Logo()
                Column {
                    Text("Welcome back", fontSize = 30.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy)
                    Text("Sign in to your estate workspace", color = Color(0xFF68748A))
                }
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email address") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), modifier = Modifier.fillMaxWidth())
                Button(onClick = { onLogin(email, password) }, enabled = !busy && email.isNotBlank() && password.isNotBlank(), modifier = Modifier.fillMaxWidth().height(52.dp), colors = ButtonDefaults.buttonColors(containerColor = EstateBlue)) {
                    if (busy) CircularProgressIndicator(Modifier.height(21.dp), strokeWidth = 2.dp, color = Color.White) else Text("Continue", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

private enum class HomeTab(val label: String) { Overview("Overview"), Properties("Properties"), Activity("Gate activity"), Account("Account") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(
    state: AppState,
    events: List<CachedAccessEvent>,
    refresh: () -> Unit,
    requestOwnership: (OwnershipRequestBody) -> Unit,
    reviewOwnership: (String, Boolean) -> Unit,
    createTenancy: (TenancyRequestBody) -> Unit,
    tenancyAction: (String, String, String?) -> Unit,
    createHouseholdMember: (HouseholdRequestBody) -> Unit,
    householdAction: (String, String, Boolean?, Boolean?) -> Unit,
    logout: () -> Unit,
) {
    var tab by remember { mutableStateOf(HomeTab.Overview) }
    Scaffold(
        containerColor = EstateBackground,
        topBar = {
            TopAppBar(
                title = { Column { Text("EstateMate", fontWeight = FontWeight.ExtraBold); Text(state.user?.role.orEmpty().replaceFirstChar(Char::uppercase), fontSize = 11.sp, color = Color(0xFF6A7790)) } },
                actions = {
                    IconButton(onClick = refresh) { Icon(Icons.Outlined.Refresh, "Refresh") }
                    IconButton(onClick = logout) { Icon(Icons.Outlined.Logout, "Sign out") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.White),
            )
        },
        bottomBar = {
            NavigationBar(containerColor = Color.White) {
                HomeTab.entries.forEach { destination ->
                    NavigationBarItem(
                        selected = tab == destination,
                        onClick = { tab = destination },
                        icon = { Icon(if (destination == HomeTab.Activity) Icons.Outlined.Badge else Icons.Outlined.Dashboard, null) },
                        label = { Text(destination.label) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                HomeTab.Overview -> Overview(state)
                HomeTab.Properties -> Properties(state,requestOwnership,reviewOwnership,createTenancy,tenancyAction,createHouseholdMember,householdAction)
                HomeTab.Activity -> Activity(events)
                HomeTab.Account -> Account(state.user!!, logout)
            }
            if (state.busy) CircularProgressIndicator(Modifier.align(Alignment.TopCenter).padding(8.dp))
        }
    }
}

@Composable
private fun Overview(state: AppState) {
    val user = state.user ?: return
    val dashboard = state.dashboard
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
        item {
            Card(colors = CardDefaults.cardColors(containerColor = EstateBlue), shape = RoundedCornerShape(20.dp)) {
                Column(Modifier.padding(25.dp)) {
                    Text("ONE ESTATE. ONE VIEW.", color = EstateGreen, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold)
                    Spacer(Modifier.height(8.dp))
                    Text("Good day, ${user.name.substringBefore(' ')}.", color = Color.White, fontSize = 29.sp, fontWeight = FontWeight.ExtraBold)
                    Text("Your latest estate operations at a glance.", color = Color.White.copy(alpha = .75f))
                }
            }
        }
        if (state.error != null) item { Text(state.error, color = MaterialTheme.colorScheme.error) }
        if (user.role == "resident") {
            item { MetricCard("Outstanding bills", dashboard?.outstandingBills?.count ?: 0, formatNaira(dashboard?.outstandingBills?.amount ?: 0)) }
            item { MetricCard("Active visitors", dashboard?.activeVisitors?.count ?: 0, "Current passes") }
            item { MetricCard("Active access cards", dashboard?.activeCards?.count ?: 0, "Ready at the gate") }
        } else {
            item { MetricCard("Active residents", dashboard?.residents?.count ?: 0, "Estate accounts") }
            item { MetricCard("Visitors on site", dashboard?.visitors?.count ?: 0, "Active or checked in") }
            item { MetricCard("Open maintenance", dashboard?.openMaintenance?.count ?: 0, "Needs attention") }
            item { MetricCard("Gate events today", dashboard?.todayAccessEvents?.count ?: 0, "All MinMoe terminals") }
            item { MetricCard("Residents in grace", dashboard?.residentsInGrace?.count ?: 0, "Facility-fee window") }
        }
    }
}

@Composable
private fun MetricCard(label: String, value: Int, detail: String) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(15.dp)) {
        Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text(label, color = Color(0xFF68748A), fontWeight = FontWeight.SemiBold); Text(detail, color = Color(0xFF98A2B2), fontSize = 11.sp) }
            Text(value.toString(), color = EstateNavy, fontSize = 30.sp, fontWeight = FontWeight.ExtraBold)
        }
    }
}

@Composable
private fun Properties(
    state: AppState,
    requestOwnership: (OwnershipRequestBody) -> Unit,
    reviewOwnership: (String, Boolean) -> Unit,
    createTenancy: (TenancyRequestBody) -> Unit,
    tenancyAction: (String, String, String?) -> Unit,
    createHouseholdMember: (HouseholdRequestBody) -> Unit,
    householdAction: (String, String, Boolean?, Boolean?) -> Unit,
) {
    val resident = state.user?.role == "resident"
    var unitNumber by remember { mutableStateOf("") }
    var street by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var tenancyPropertyId by remember { mutableStateOf("") }
    var tenantEmail by remember { mutableStateOf("") }
    var tenancyStart by remember { mutableStateOf("") }
    var memberPropertyId by remember { mutableStateOf("") }
    var memberName by remember { mutableStateOf("") }
    var memberRelationship by remember { mutableStateOf("child") }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
        item { Text(if (resident) "My properties" else "Estate properties", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy) }
        if (state.error != null) item { Text(state.error, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
        if (state.properties.isEmpty()) item { Text("No approved properties yet.", color = Color(0xFF68748A)) }
        items(state.properties, key = { "property-${it.id}" }) { property ->
            Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(14.dp)) {
                Column(Modifier.fillMaxWidth().padding(17.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(property.unitNumber, fontSize = 19.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy)
                    Text(listOfNotNull(property.zone,property.block,property.street,property.address).joinToString(" · "), color = Color(0xFF68748A), fontSize = 12.sp)
                    if (property.ownerName != null) Text("Owner: ${property.ownerName}", color = EstateBlue, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                    if (property.tenantName != null) Text("Main tenant: ${property.tenantName} · bills: ${property.billingResponsibility}", color = Color(0xFF68748A), fontSize = 12.sp)
                    if (property.relationshipType != null) Text("Your relationship: ${property.relationshipType}", color = Color(0xFF137444), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    if (!resident || property.relationshipType == "owner") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { tenancyPropertyId = property.id }) { Text("Rent out") }
                        Button(onClick = { memberPropertyId = property.id }) { Text("Add dependant") }
                    }
                }
            }
        }
        if (resident) {
            item { Text("Request an existing unowned property", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = EstateNavy, modifier = Modifier.padding(top = 10.dp)) }
            if (state.availableProperties.isEmpty()) item { Text("No unowned properties are currently available. You can propose one below.", color = Color(0xFF68748A), fontSize = 12.sp) }
            items(state.availableProperties, key = { "available-${it.id}" }) { property ->
                Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(13.dp)) {
                    Row(Modifier.fillMaxWidth().padding(15.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Column(Modifier.weight(1f)) { Text(property.unitNumber, fontWeight = FontWeight.Bold); Text(property.street.orEmpty(), color = Color(0xFF68748A), fontSize = 11.sp) }
                        Button(onClick = { requestOwnership(OwnershipRequestBody(propertyId = property.id)) }, enabled = !state.busy) { Text("Request") }
                    }
                }
            }
            item {
                Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(14.dp)) {
                    Column(Modifier.fillMaxWidth().padding(17.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Propose a new property", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = EstateNavy)
                        OutlinedTextField(unitNumber, { unitNumber = it }, label = { Text("Unit number") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        OutlinedTextField(street, { street = it }, label = { Text("Street") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        OutlinedTextField(address, { address = it }, label = { Text("Address") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        OutlinedTextField(note, { note = it }, label = { Text("Note to administrator") }, modifier = Modifier.fillMaxWidth())
                        Button(
                            onClick = { requestOwnership(OwnershipRequestBody(proposedUnitNumber = unitNumber, proposedStreet = street, proposedAddress = address, requestNote = if (note.isBlank()) null else note)) },
                            enabled = !state.busy && unitNumber.isNotBlank() && street.isNotBlank() && address.isNotBlank(),
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Submit for approval") }
                    }
                }
            }
        }
        if (state.ownershipRequests.isNotEmpty()) {
            item { Text(if (resident) "My request history" else "Ownership approvals", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = EstateNavy, modifier = Modifier.padding(top = 10.dp)) }
            items(state.ownershipRequests, key = { "request-${it.id}" }) { request ->
                Card(colors = CardDefaults.cardColors(containerColor = if (request.status == "pending") Color(0xFFFFFBF2) else Color.White), shape = RoundedCornerShape(13.dp)) {
                    Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(request.unitNumber ?: "Proposed property", fontWeight = FontWeight.Bold)
                        Text(listOfNotNull(request.street, request.address).joinToString(" · "), color = Color(0xFF68748A), fontSize = 11.sp)
                        Text(request.status.replaceFirstChar(Char::uppercase), color = if (request.status == "approved") Color(0xFF137444) else EstateBlue, fontWeight = FontWeight.Bold, fontSize = 11.sp)
                        if (request.reviewNote != null) Text(request.reviewNote, color = Color(0xFF68748A), fontSize = 11.sp)
                        if (!resident && request.status == "pending") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { reviewOwnership(request.id, true) }, enabled = !state.busy) { Text("Approve") }
                            Button(onClick = { reviewOwnership(request.id, false) }, enabled = !state.busy, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Reject") }
                        }
                    }
                }
            }
        }
        if (tenancyPropertyId.isNotBlank()) item {
            Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(14.dp)) {
                Column(Modifier.fillMaxWidth().padding(17.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(if (resident) "Nominate a tenant" else "Assign a tenant", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    OutlinedTextField(tenantEmail,{ tenantEmail=it },label={ Text("Tenant account email") },modifier=Modifier.fillMaxWidth(),singleLine=true)
                    OutlinedTextField(tenancyStart,{ tenancyStart=it },label={ Text("Start date (YYYY-MM-DD)") },modifier=Modifier.fillMaxWidth(),singleLine=true)
                    Button(onClick={ createTenancy(TenancyRequestBody(tenancyPropertyId,tenantEmail,tenancyStart)) },enabled=!state.busy && tenantEmail.isNotBlank() && tenancyStart.isNotBlank(),modifier=Modifier.fillMaxWidth()) { Text(if (resident) "Submit tenancy" else "Assign tenant") }
                }
            }
        }
        if (state.tenancies.isNotEmpty()) {
            item { Text("Tenancies",fontSize=18.sp,fontWeight=FontWeight.Bold,color=EstateNavy,modifier=Modifier.padding(top=10.dp)) }
            items(state.tenancies,key={ "tenancy-${it.id}" }) { tenancy ->
                Card(colors=CardDefaults.cardColors(containerColor=if(tenancy.status=="pending") Color(0xFFFFFBF2) else Color.White),shape=RoundedCornerShape(13.dp)) {
                    Column(Modifier.fillMaxWidth().padding(15.dp),verticalArrangement=Arrangement.spacedBy(5.dp)) {
                        Text("${tenancy.unitNumber}: ${tenancy.tenantName}",fontWeight=FontWeight.Bold)
                        Text("Owner ${tenancy.ownerName} · bills ${tenancy.billingResponsibility}",fontSize=11.sp,color=Color(0xFF68748A))
                        Text("${tenancy.startDate} — ${tenancy.endDate ?: "open"} · ${tenancy.status}",fontSize=11.sp,color=EstateBlue)
                        if(!resident && tenancy.status=="pending") Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            Button(onClick={ tenancyAction(tenancy.id,"approve",tenancy.billingResponsibility) }) { Text("Approve") }
                            Button(onClick={ tenancyAction(tenancy.id,"reject",null) },colors=ButtonDefaults.buttonColors(containerColor=MaterialTheme.colorScheme.error)) { Text("Reject") }
                        }
                        if(!resident && tenancy.status=="active") Button(onClick={ tenancyAction(tenancy.id,"end",null) },colors=ButtonDefaults.buttonColors(containerColor=MaterialTheme.colorScheme.error)) { Text("End tenancy") }
                    }
                }
            }
        }
        if (memberPropertyId.isNotBlank()) item {
            Card(colors=CardDefaults.cardColors(containerColor=Color.White),shape=RoundedCornerShape(14.dp)) {
                Column(Modifier.fillMaxWidth().padding(17.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    Text("Add dependant",fontSize=18.sp,fontWeight=FontWeight.Bold)
                    OutlinedTextField(memberName,{memberName=it},label={Text("Full name")},modifier=Modifier.fillMaxWidth(),singleLine=true)
                    OutlinedTextField(memberRelationship,{memberRelationship=it},label={Text("Relationship: child, spouse, parent…")},modifier=Modifier.fillMaxWidth(),singleLine=true)
                    Button(onClick={ createHouseholdMember(HouseholdRequestBody(memberPropertyId,memberName,memberRelationship)) },enabled=!state.busy && memberName.isNotBlank() && memberRelationship.isNotBlank(),modifier=Modifier.fillMaxWidth()) { Text(if(resident) "Submit for approval" else "Add dependant") }
                }
            }
        }
        if (state.householdMembers.isNotEmpty()) {
            item { Text("Dependants and household",fontSize=18.sp,fontWeight=FontWeight.Bold,color=EstateNavy,modifier=Modifier.padding(top=10.dp)) }
            items(state.householdMembers,key={ "member-${it.id}" }) { member ->
                Card(colors=CardDefaults.cardColors(containerColor=if(member.status=="pending") Color(0xFFFFFBF2) else Color.White),shape=RoundedCornerShape(13.dp)) {
                    Column(Modifier.fillMaxWidth().padding(15.dp),verticalArrangement=Arrangement.spacedBy(5.dp)) {
                        Text("${member.name} · ${member.relationship}",fontWeight=FontWeight.Bold)
                        Text("${member.unitNumber} · main resident ${member.primaryResidentName}",fontSize=11.sp,color=Color(0xFF68748A))
                        Text("${member.status} · visitors ${if(member.canCreateVisitors==1) "allowed" else "not allowed"}",fontSize=11.sp,color=EstateBlue)
                        if(!resident && member.status=="pending") Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            Button(onClick={ householdAction(member.id,"approve",true,false) }) { Text("Approve") }
                            Button(onClick={ householdAction(member.id,"reject",null,null) },colors=ButtonDefaults.buttonColors(containerColor=MaterialTheme.colorScheme.error)) { Text("Reject") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Activity(events: List<CachedAccessEvent>) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Recent gate activity", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy) }
        if (events.isEmpty()) item { Text("No access events have been cached yet.", color = Color(0xFF68748A)) }
        items(events, key = { it.id }) { event ->
            Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(13.dp)) {
                Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                    Box(Modifier.background(if (event.result == "granted") Color(0xFFE3F8EC) else Color(0xFFFDEBED), RoundedCornerShape(12.dp)).padding(12.dp)) {
                        Text(if (event.result == "granted") "✓" else "×", color = if (event.result == "granted") Color(0xFF137444) else Color(0xFFA52B36), fontWeight = FontWeight.Black)
                    }
                    Column(Modifier.weight(1f)) {
                        Text(event.personName ?: event.cardUid ?: "Unknown credential", fontWeight = FontWeight.Bold)
                        Text(event.deviceName ?: "MinMoe terminal", color = Color(0xFF68748A), fontSize = 12.sp)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(event.result.replaceFirstChar(Char::uppercase), color = if (event.result == "granted") Color(0xFF137444) else Color(0xFFA52B36), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        Text(formatInstant(event.deviceTimestamp), color = Color(0xFF98A2B2), fontSize = 10.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun Account(user: UserDto, logout: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Logo()
        Text(user.name, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold)
        Text(user.email, color = Color(0xFF68748A))
        Text("Role: ${user.role.replaceFirstChar(Char::uppercase)}", color = EstateBlue, fontWeight = FontWeight.Bold)
        Spacer(Modifier.weight(1f))
        Button(onClick = logout, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = EstateNavy)) { Icon(Icons.Outlined.Logout, null); Spacer(Modifier.padding(4.dp)); Text("Sign out") }
    }
}

private fun formatNaira(minor: Long): String = NumberFormat.getCurrencyInstance().apply { currency = Currency.getInstance("NGN") }.format(minor / 100.0)
private fun formatInstant(value: String): String = runCatching { DateTimeFormatter.ofPattern("dd MMM, HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(value)) }.getOrDefault(value)
