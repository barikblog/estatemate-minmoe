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
import androidx.compose.foundation.layout.weight
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
    val busy: Boolean = false,
    val error: String? = null,
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
        runCatching {
            val dashboard = repository.dashboard()
            repository.refreshEvents()
            dashboard
        }.onSuccess { dashboard -> _state.value = _state.value.copy(dashboard = dashboard, busy = false) }
            .onFailure { error -> _state.value = _state.value.copy(busy = false, error = error.message ?: "Unable to refresh") }
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
        else -> HomeScreen(state, events, viewModel::refresh, viewModel::logout)
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

private enum class HomeTab(val label: String) { Overview("Overview"), Activity("Gate activity"), Account("Account") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(state: AppState, events: List<CachedAccessEvent>, refresh: () -> Unit, logout: () -> Unit) {
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
