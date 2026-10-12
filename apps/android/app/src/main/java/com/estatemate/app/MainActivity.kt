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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.estatemate.app.data.EstateRepository
import com.estatemate.app.data.LoginOutcome
import com.estatemate.app.data.local.CachedAccessEvent
import com.estatemate.app.data.remote.DashboardResponse
import com.estatemate.app.data.remote.ForgotPasswordResponse
import com.estatemate.app.data.remote.GateDto
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

// The palette every screen shares, including the Menu's forms (MenuForms.kt).
internal val EstateBlue = Color(0xFF1769E0)
internal val EstateNavy = Color(0xFF0D1B37)
internal val EstateGreen = Color(0xFF35D07F)
internal val EstateBackground = Color(0xFFF4F7FB)

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

/**
 * Which sign-in step is on screen. A forgotten password can be answered without
 * leaving the app: the request records a reference for the estate office, and
 * when the Administrator has turned on self-service it hands out a one-time
 * code that is spent on the next screen.
 */
enum class AuthScreen { SignIn, Forgot, Reset }

data class AppState(
    val checkingSession: Boolean = true,
    val user: UserDto? = null,
    val dashboard: DashboardResponse? = null,
    val properties: List<PropertyDto> = emptyList(),
    val availableProperties: List<PropertyDto> = emptyList(),
    val ownershipRequests: List<OwnershipRequestDto> = emptyList(),
    val tenancies: List<TenancyDto> = emptyList(),
    val householdMembers: List<HouseholdMemberDto> = emptyList(),
    /** A Security officer's gate for this session, shown under the app name. */
    val gateName: String? = null,
    /**
     * Set only between a multi-gate sign-in and the officer's choice: the gates
     * they may work, plus the short-lived token that authorises the exchange.
     */
    val gateOptions: List<GateDto> = emptyList(),
    val gateSelectionToken: String? = null,
    val busy: Boolean = false,
    /** A failure on a signed-in screen, already turned into a sentence. */
    val error: String? = null,
    /** Which sign-in step is showing. */
    val authScreen: AuthScreen = AuthScreen.SignIn,
    /** The sign-in failure, with the reason and the control that fixes it. */
    val signInProblem: SignInProblem? = null,
    /** A line worth reading before the form: a reset code, or a changed password. */
    val notice: String? = null,
    /** What a reset request answered, kept so the code can be re-read. */
    val resetRequest: ForgotPasswordResponse? = null,
    /** The address this phone offers the next time the sign-in screen opens. */
    val rememberedEmail: String? = null,
    /** Whether the last sign-in here asked to be remembered for 30 days. */
    val rememberMe: Boolean = false,
)

private data class RefreshPayload(
    val dashboard: DashboardResponse,
    val properties: List<PropertyDto>,
    val availableProperties: List<PropertyDto>,
    val ownershipRequests: List<OwnershipRequestDto>,
    val tenancies: List<TenancyDto>,
    val householdMembers: List<HouseholdMemberDto>,
    val gateName: String?,
)

@HiltViewModel
class MainViewModel @Inject constructor(private val repository: EstateRepository) : ViewModel() {
    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state.asStateFlow()
    val events = repository.recentEvents.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    init {
        viewModelScope.launch {
            val user = repository.restore()
            _state.value = signedOut().copy(checkingSession = false, user = user)
            if (user != null) refresh()
        }
    }

    /** The signed-out screen, keeping this phone's remembered address and choice. */
    private fun signedOut(problem: SignInProblem? = null, notice: String? = null) = AppState(
        checkingSession = false,
        rememberedEmail = repository.rememberedEmail,
        rememberMe = repository.rememberMe,
        signInProblem = problem,
        notice = notice,
    )

    /**
     * Signs in, handing the Worker this phone's "remember me" choice.
     *
     * A refusal is turned into the same title/sentence/hint pair the portal
     * shows, so a wrong password, a deactivated account, a throttled source and
     * a phone with no signal are four different sentences rather than one
     * status line.
     */
    fun login(email: String, password: String, rememberMe: Boolean) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, error = null, signInProblem = null, notice = null)
        runCatching { repository.login(email, password, rememberMe) }
            .onSuccess { outcome ->
                when (outcome) {
                    is LoginOutcome.SignedIn -> {
                        _state.value = _state.value.copy(
                            user = outcome.user,
                            gateOptions = emptyList(),
                            gateSelectionToken = null,
                            busy = false,
                            rememberedEmail = repository.rememberedEmail,
                            rememberMe = repository.rememberMe,
                        )
                        refresh()
                    }
                    // Not an error: the officer exists and their password was
                    // right; the estate just needs to know which post they are on.
                    is LoginOutcome.GateSelectionRequired -> _state.value = _state.value.copy(
                        busy = false,
                        error = null,
                        signInProblem = null,
                        gateOptions = outcome.gates,
                        gateSelectionToken = outcome.selectionToken,
                    )
                }
            }
            .onFailure { error ->
                _state.value = _state.value.copy(
                    busy = false,
                    signInProblem = describeSignInProblem(error, SignInContext.Login),
                )
            }
    }

    /** Shows the "forgot password" form. */
    fun showForgotPassword() {
        _state.value = _state.value.copy(authScreen = AuthScreen.Forgot, signInProblem = null, notice = null)
    }

    /** Shows the reset-code form for somebody who already has a code. */
    fun showResetCode() {
        _state.value = _state.value.copy(authScreen = AuthScreen.Reset, resetRequest = null, signInProblem = null, notice = null)
    }

    /** Back to the sign-in form, keeping the remembered address. */
    fun backToSignIn() {
        _state.value = _state.value.copy(authScreen = AuthScreen.SignIn, signInProblem = null)
    }

    /**
     * Asks the estate for a way back in. The answer is the same for an address
     * the estate has and one it does not, so nothing here can be used to find
     * out who lives in the estate.
     */
    fun requestPasswordReset(email: String) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, signInProblem = null, notice = null)
        runCatching { repository.forgotPassword(email) }
            .onSuccess { answer ->
                _state.value = _state.value.copy(
                    busy = false,
                    authScreen = AuthScreen.Reset,
                    resetRequest = answer,
                    notice = answer.message,
                    rememberedEmail = email.trim().ifBlank { _state.value.rememberedEmail },
                )
            }
            .onFailure { error ->
                _state.value = _state.value.copy(busy = false, signInProblem = describeSignInProblem(error, SignInContext.Forgot))
            }
    }

    /** Spends a one-time code for a new password, then returns to sign-in. */
    fun resetPassword(email: String, code: String, newPassword: String) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, signInProblem = null, notice = null)
        runCatching { repository.resetPassword(email, code, newPassword) }
            .onSuccess { answer ->
                _state.value = _state.value.copy(
                    busy = false,
                    authScreen = AuthScreen.SignIn,
                    resetRequest = null,
                    notice = answer.message ?: "Your password has been changed, and every other session was signed out.",
                    rememberedEmail = email.trim().ifBlank { _state.value.rememberedEmail },
                    signInProblem = null,
                )
            }
            .onFailure { error ->
                _state.value = _state.value.copy(busy = false, signInProblem = describeSignInProblem(error, SignInContext.Reset))
            }
    }

    /** Exchanges the chosen gate for a session, then loads that gate's data. */
    fun chooseGate(deviceId: String) = viewModelScope.launch {
        val selectionToken = _state.value.gateSelectionToken ?: return@launch
        _state.value = _state.value.copy(busy = true, error = null)
        runCatching { repository.selectGate(selectionToken, deviceId) }
            .onSuccess { user ->
                _state.value = _state.value.copy(
                    user = user,
                    gateOptions = emptyList(),
                    gateSelectionToken = null,
                    busy = false,
                )
                refresh()
            }
            .onFailure { error ->
                _state.value = _state.value.copy(
                    busy = false,
                    signInProblem = describeSignInProblem(error, SignInContext.Login),
                )
            }
    }

    /** Backs out of the gate picker to the sign-in form. */
    fun cancelGateSelection() = viewModelScope.launch {
        repository.logout()
        _state.value = signedOut()
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
            val gateName = if (role == "security") repository.currentGateName() else null
            repository.refreshEvents()
            RefreshPayload(dashboard,properties,available,requests,tenancies,household,gateName)
        }.onSuccess { payload ->
            _state.value = _state.value.copy(
                dashboard = payload.dashboard,
                properties = payload.properties,
                availableProperties = payload.availableProperties,
                ownershipRequests = payload.ownershipRequests,
                tenancies = payload.tenancies,
                householdMembers = payload.householdMembers,
                gateName = payload.gateName,
                busy = false,
            )
        }.onFailure { error -> fail(error, "Unable to refresh") }
    }

    fun requestOwnership(request: OwnershipRequestBody) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, error = null)
        runCatching { repository.requestOwnership(request) }
            .onSuccess { refresh() }
            .onFailure { error -> fail(error, "Ownership request failed") }
    }

    fun reviewOwnership(id: String, approved: Boolean) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, error = null)
        runCatching { repository.reviewOwnership(id, approved) }
            .onSuccess { refresh() }
            .onFailure { error -> fail(error, "Ownership review failed") }
    }

    fun createTenancy(request: TenancyRequestBody) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true,error = null)
        runCatching { repository.createTenancy(request) }.onSuccess { refresh() }
            .onFailure { error -> fail(error, "Tenancy request failed") }
    }

    fun tenancyAction(id: String, action: String, billing: String? = null) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true,error = null)
        runCatching { repository.tenancyAction(id,action,billing) }.onSuccess { refresh() }
            .onFailure { error -> fail(error, "Tenancy action failed") }
    }

    fun createHouseholdMember(request: HouseholdRequestBody) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true,error = null)
        runCatching { repository.createHouseholdMember(request) }.onSuccess { refresh() }
            .onFailure { error -> fail(error, "Household request failed") }
    }

    fun householdAction(id: String, action: String, visitors: Boolean? = null, bills: Boolean? = null) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true,error = null)
        runCatching { repository.householdAction(id,action,visitors,bills) }.onSuccess { refresh() }
            .onFailure { error -> fail(error, "Household action failed") }
    }

    fun logout() = viewModelScope.launch {
        repository.logout()
        _state.value = signedOut(notice = "You have been signed out.")
    }

    /** Changes the signed-in person's own password; every other session ends. */
    fun changePassword(currentPassword: String, newPassword: String) = viewModelScope.launch {
        _state.value = _state.value.copy(busy = true, error = null)
        runCatching { repository.changePassword(currentPassword, newPassword) }
            .onSuccess { message -> _state.value = _state.value.copy(busy = false, error = null, notice = message) }
            .onFailure { error ->
                if (error.httpStatus() == 401 && error.apiCode() == "invalid_credentials") {
                    // A wrong current password is a form problem, not a dead
                    // session: the Worker answers 401 for both, so the code is
                    // what tells them apart.
                    _state.value = _state.value.copy(
                        busy = false,
                        error = signInProblemLine(describeSignInProblem(error, SignInContext.ChangePassword)),
                    )
                    return@onFailure
                }
                fail(error, "Could not change your password")
            }
    }

    /** Clears a one-off notice once the screen has shown it. */
    fun clearNotice() {
        if (_state.value.notice != null) _state.value = _state.value.copy(notice = null)
    }

    /**
     * A 401 anywhere outside sign-in means the session is gone — it expired, the
     * account was deactivated, or the password was changed on another device.
     * The session is cleared and the sign-in screen explains why, instead of
     * every later screen failing silently with a status line.
     */
    private fun fail(error: Throwable, fallback: String) {
        if (error.httpStatus() == 401) {
            viewModelScope.launch { repository.logout() }
            _state.value = signedOut(problem = describeSignInProblem(error, SignInContext.Session))
            return
        }
        _state.value = _state.value.copy(busy = false, error = describeError(error, fallback))
    }
}

@Composable
fun EstateMateApp(viewModel: MainViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val events by viewModel.events.collectAsState()
    when {
        state.checkingSession -> FullScreenLoading()
        state.user != null -> HomeScreen(state,events,viewModel::refresh,viewModel::requestOwnership,viewModel::reviewOwnership,viewModel::createTenancy,viewModel::tenancyAction,viewModel::createHouseholdMember,viewModel::householdAction,viewModel::changePassword,viewModel::clearNotice,viewModel::logout)
        // A Security officer with several posts: the session does not exist until
        // one is chosen, so this is a step of signing in, not an error screen.
        state.gateSelectionToken != null && state.gateOptions.isNotEmpty() ->
            GatePickerScreen(
                gates = state.gateOptions,
                busy = state.busy,
                problem = state.signInProblem,
                onChoose = viewModel::chooseGate,
                onCancel = viewModel::cancelGateSelection,
            )
        state.authScreen == AuthScreen.Forgot -> ForgotPasswordScreen(
            busy = state.busy,
            problem = state.signInProblem,
            initialEmail = state.rememberedEmail.orEmpty(),
            onRequest = viewModel::requestPasswordReset,
            onHaveCode = viewModel::showResetCode,
            onBack = viewModel::backToSignIn,
        )
        state.authScreen == AuthScreen.Reset -> ResetPasswordScreen(
            busy = state.busy,
            problem = state.signInProblem,
            request = state.resetRequest,
            initialEmail = state.rememberedEmail.orEmpty(),
            onReset = viewModel::resetPassword,
            onRequestAnother = viewModel::requestPasswordReset,
            onBack = viewModel::backToSignIn,
        )
        else -> LoginScreen(
            busy = state.busy,
            problem = state.signInProblem,
            notice = state.notice,
            initialEmail = state.rememberedEmail.orEmpty(),
            initialRememberMe = state.rememberMe,
            onLogin = viewModel::login,
            onForgotPassword = viewModel::showForgotPassword,
        )
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
        Text(stringResource(R.string.app_mark), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun LoginScreen(
    busy: Boolean,
    problem: SignInProblem?,
    notice: String?,
    initialEmail: String,
    initialRememberMe: Boolean,
    onLogin: (String, String, Boolean) -> Unit,
    onForgotPassword: () -> Unit,
) {
    // The remembered address seeds the field; after that the field is the
    // person's own, so a later redraw never overwrites what they are typing.
    var email by remember { mutableStateOf(initialEmail) }
    var password by remember { mutableStateOf("") }
    var rememberMe by remember { mutableStateOf(initialRememberMe) }
    var revealed by remember { mutableStateOf(false) }
    val canSubmit = !busy && email.isNotBlank() && password.isNotBlank()
    val submit = { if (canSubmit) onLogin(email, password, rememberMe) }

    Box(Modifier.fillMaxSize().background(EstateBackground).padding(24.dp), contentAlignment = Alignment.Center) {
        Card(shape = RoundedCornerShape(22.dp), colors = CardDefaults.cardColors(containerColor = Color.White), elevation = CardDefaults.cardElevation(8.dp)) {
            Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(15.dp)) {
                Logo()
                Column {
                    Text(stringResource(R.string.app_name), color = EstateBlue, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold)
                    Text("Welcome back", fontSize = 30.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy)
                    Text(stringResource(R.string.sign_in_subtitle), color = Color(0xFF68748A))
                }
                if (notice != null) NoticeCard(notice, tone = EstateGreen)
                if (problem != null) SignInProblemCard(problem)
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email address") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = if (revealed) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                    trailingIcon = {
                        // View password: showing what was typed is what stops a
                        // phone keyboard from locking somebody out of their own
                        // account over an invisible character.
                        IconButton(onClick = { revealed = !revealed }) {
                            Icon(
                                if (revealed) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                if (revealed) "Hide password" else "Show password",
                                tint = Color(0xFF6A7790),
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = rememberMe, onCheckedChange = { rememberMe = it })
                    Column(Modifier.weight(1f)) {
                        Text("Remember me", fontWeight = FontWeight.SemiBold, color = EstateNavy, fontSize = 13.sp)
                        Text(
                            if (rememberMe) {
                                "This device stays signed in for 30 days. Do not use it on a shared computer."
                            } else {
                                "Keeps you signed in for 30 days on this device."
                            },
                            color = Color(0xFF6A7790),
                            fontSize = 11.sp,
                        )
                    }
                }
                Button(onClick = submit, enabled = canSubmit, modifier = Modifier.fillMaxWidth().height(52.dp), colors = ButtonDefaults.buttonColors(containerColor = EstateBlue)) {
                    if (busy) CircularProgressIndicator(Modifier.height(21.dp), strokeWidth = 2.dp, color = Color.White) else Text("Continue", fontWeight = FontWeight.Bold)
                }
                TextButton(onClick = onForgotPassword, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Forgot password?") }
            }
        }
    }
}

/**
 * The portal's failure panel, on the phone: what kind of failure it was, the
 * Worker's own sentence, what to do about it, and the control that does it.
 */
@Composable
private fun SignInProblemCard(problem: SignInProblem) {
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFFDF2F2)), shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(problem.title, fontWeight = FontWeight.ExtraBold, color = Color(0xFFA52B36), fontSize = 14.sp)
            Text(problem.message, color = Color(0xFF7B2B33), fontSize = 12.sp)
            if (problem.hint != null) Text(problem.hint, color = Color(0xFF7B2B33), fontSize = 11.sp)
        }
    }
}

/** A one-off line worth reading before the form: a code, or a result. */
@Composable
private fun NoticeCard(text: String, tone: Color) {
    Card(colors = CardDefaults.cardColors(containerColor = tone.copy(alpha = 0.12f)), shape = RoundedCornerShape(14.dp)) {
        Text(text, Modifier.fillMaxWidth().padding(15.dp), color = EstateNavy, fontSize = 12.sp)
    }
}

/** The "forgot password" form: an address, and the two ways forward. */
@Composable
private fun ForgotPasswordScreen(
    busy: Boolean,
    problem: SignInProblem?,
    initialEmail: String,
    onRequest: (String) -> Unit,
    onHaveCode: () -> Unit,
    onBack: () -> Unit,
) {
    var email by remember { mutableStateOf(initialEmail) }
    Box(Modifier.fillMaxSize().background(EstateBackground).padding(24.dp), contentAlignment = Alignment.Center) {
        Card(shape = RoundedCornerShape(22.dp), colors = CardDefaults.cardColors(containerColor = Color.White), elevation = CardDefaults.cardElevation(8.dp)) {
            Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(15.dp)) {
                Logo()
                Column {
                    Text("FORGOT PASSWORD", color = EstateBlue, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold)
                    Text("Get back in", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy)
                    Text(
                        "Tell us the email address your estate account uses. Nothing is sent to it — the estate has no mail server — so the reset is delivered through the estate office instead.",
                        color = Color(0xFF68748A),
                        fontSize = 13.sp,
                    )
                }
                if (problem != null) SignInProblemCard(problem)
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email address") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Done), modifier = Modifier.fillMaxWidth())
                Button(onClick = { onRequest(email) }, enabled = !busy && email.isNotBlank(), modifier = Modifier.fillMaxWidth().height(52.dp), colors = ButtonDefaults.buttonColors(containerColor = EstateBlue)) {
                    if (busy) CircularProgressIndicator(Modifier.height(21.dp), strokeWidth = 2.dp, color = Color.White) else Text("Send my request", fontWeight = FontWeight.Bold)
                }
                OutlinedButton(onClick = onHaveCode, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("I already have a code") }
                TextButton(onClick = onBack, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Back to sign in") }
            }
        }
    }
}

/**
 * The reset form.
 *
 * An office request shows its reference — the thing to quote when contacting
 * the estate office — and a self-service request shows the one-time code to
 * type below. A code handed out before arriving here works just as well, which
 * is why the form is reachable on its own.
 */
@Composable
private fun ResetPasswordScreen(
    busy: Boolean,
    problem: SignInProblem?,
    request: ForgotPasswordResponse?,
    initialEmail: String,
    onReset: (String, String, String) -> Unit,
    onRequestAnother: (String) -> Unit,
    onBack: () -> Unit,
) {
    var email by remember { mutableStateOf(initialEmail) }
    var code by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var revealed by remember { mutableStateOf(false) }
    // A stable local so the branches below can smart-cast: the code and the
    // reference are only read when the Worker actually sent them.
    val asked = request
    val canSubmit = !busy && email.isNotBlank() && code.isNotBlank() && newPassword.isNotBlank() && newPassword == confirmPassword

    Box(Modifier.fillMaxSize().background(EstateBackground).padding(24.dp), contentAlignment = Alignment.Center) {
        Card(shape = RoundedCornerShape(22.dp), colors = CardDefaults.cardColors(containerColor = Color.White), elevation = CardDefaults.cardElevation(8.dp)) {
            Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(15.dp)) {
                Logo()
                Column {
                    Text("RESET PASSWORD", color = EstateBlue, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold)
                    Text("Choose a new password", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy)
                }
                if (problem != null) SignInProblemCard(problem)
                when {
                    asked == null -> Text(
                        "Enter the one-time code below and choose a new password.",
                        color = Color(0xFF68748A),
                        fontSize = 13.sp,
                    )
                    asked.code != null -> {
                        NoticeCard("ONE-TIME CODE\n${asked.code}", tone = EstateBlue)
                        Text(
                            asked.message ?: "Enter the one-time code below and choose a new password. " +
                                "It stops working once used, and the estate office can see that you asked.",
                            color = Color(0xFF68748A),
                            fontSize = 12.sp,
                        )
                    }
                    else -> {
                        Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFFFFBF2)), shape = RoundedCornerShape(14.dp)) {
                            Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("Your reference", fontWeight = FontWeight.ExtraBold, color = EstateNavy, fontSize = 14.sp)
                                Text(asked.reference, color = EstateBlue, fontSize = 22.sp, fontWeight = FontWeight.ExtraBold)
                                Text(
                                    asked.message ?: "The estate office will issue your temporary password. " +
                                        "Quote the reference below when you contact them.",
                                    color = Color(0xFF68748A),
                                    fontSize = 11.sp,
                                )
                            }
                        }
                        Text(
                            "If the office has already sent you a temporary password, sign in with it and change it from your account.",
                            color = Color(0xFF68748A),
                            fontSize = 12.sp,
                        )
                    }
                }
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email address") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    value = code,
                    onValueChange = { entered -> code = normaliseResetCode(entered) },
                    label = { Text("One-time code") },
                    singleLine = true,
                    // Codes are printed without 0, O, 1, I or L, so the keyboard
                    // never has to offer characters the estate does not use.
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = newPassword,
                    onValueChange = { newPassword = it },
                    label = { Text("New password") },
                    singleLine = true,
                    visualTransformation = if (revealed) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    trailingIcon = {
                        IconButton(onClick = { revealed = !revealed }) {
                            Icon(
                                if (revealed) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                if (revealed) "Hide password" else "Show password",
                                tint = Color(0xFF6A7790),
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("At least 12 characters. A phrase you can remember beats a short password you cannot.", color = Color(0xFF6A7790), fontSize = 11.sp)
                OutlinedTextField(
                    value = confirmPassword,
                    onValueChange = { confirmPassword = it },
                    label = { Text("Repeat the new password") },
                    singleLine = true,
                    visualTransformation = if (revealed) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    isError = confirmPassword.isNotBlank() && confirmPassword != newPassword,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (confirmPassword.isNotBlank() && confirmPassword != newPassword) {
                    Text("The two new passwords do not match.", color = MaterialTheme.colorScheme.error, fontSize = 11.sp)
                }
                Button(
                    onClick = { onReset(email, code, newPassword) },
                    enabled = canSubmit,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = EstateBlue),
                ) {
                    if (busy) CircularProgressIndicator(Modifier.height(21.dp), strokeWidth = 2.dp, color = Color.White) else Text("Set my new password", fontWeight = FontWeight.Bold)
                }
                OutlinedButton(onClick = { onRequestAnother(email) }, enabled = !busy && email.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Ask again") }
                TextButton(onClick = onBack, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Back to sign in") }
            }
        }
    }
}

/** The Worker's reset-code alphabet, uppercased and without its separators. */
private fun normaliseResetCode(entered: String): String =
    entered.uppercase().filter { it.isLetterOrDigit() }.take(8)

private fun HomeTab.icon() = when (this) {
    HomeTab.Activity -> Icons.Outlined.Badge
    HomeTab.Menu -> Icons.Outlined.Apps
    else -> Icons.Outlined.Dashboard
}

private enum class HomeTab(val label: String) { Overview("Overview"), Properties("Properties"), Menu("Menu"), Activity("Gate activity"), Account("Account") }

/**
 * Shown to a Security officer who is posted at more than one gate: the Worker
 * issues no session until one is chosen, and every gate-scoped read (activity,
 * the live feed, visitor checks) follows the choice.
 */
@Composable
private fun GatePickerScreen(
    gates: List<GateDto>,
    busy: Boolean,
    problem: SignInProblem?,
    onChoose: (String) -> Unit,
    onCancel: () -> Unit,
) {
    Column(Modifier.fillMaxSize().background(EstateBackground).padding(22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Logo()
        Text("Which gate are you working?", fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy)
        Text("You are posted at more than one gate. Your shift is recorded against the one you choose.", color = Color(0xFF68748A), fontSize = 13.sp)
        if (problem != null) SignInProblemCard(problem)
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(gates, key = { it.id }) { gate ->
                val label = gate.gateName ?: gate.name ?: "Gate"
                Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(14.dp)) {
                    Row(Modifier.fillMaxWidth().padding(17.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(label, fontWeight = FontWeight.Bold, color = EstateNavy)
                            if (gate.direction != null) Text("Direction: ${gate.direction}", fontSize = 11.sp, color = Color(0xFF68748A))
                        }
                        Button(onClick = { onChoose(gate.id) }, enabled = !busy) { Text("Start shift") }
                    }
                }
            }
        }
        Button(onClick = onCancel, enabled = !busy, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = EstateNavy)) { Text("Back to sign in") }
        if (busy) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    }
}

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
    changePassword: (String, String) -> Unit,
    clearNotice: () -> Unit,
    logout: () -> Unit,
) {
    var tab by remember { mutableStateOf(HomeTab.Overview) }
    Scaffold(
        containerColor = EstateBackground,
        topBar = {
            TopAppBar(
                title = {
                    val subtitle = listOfNotNull(
                        state.user?.role?.takeIf { it.isNotBlank() }?.replaceFirstChar(Char::uppercase),
                        state.gateName,
                    ).joinToString(" · ")
                    Column {
                        Text(stringResource(R.string.app_name), fontWeight = FontWeight.ExtraBold)
                        Text(subtitle, fontSize = 11.sp, color = Color(0xFF6A7790))
                    }
                },
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
                        icon = { Icon(destination.icon(), null) },
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
                HomeTab.Menu -> MenuTab(state.user!!)
                HomeTab.Activity -> Activity(events)
                HomeTab.Account -> Account(state.user!!, state.gateName, state.busy, state.error, state.notice, changePassword, clearNotice, logout)
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
            dashboard?.latestNotice?.let { notice ->
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(15.dp)) {
                        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("ESTATE NOTICE", color = EstateBlue, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold)
                            Text(notice.title, fontWeight = FontWeight.Bold, color = EstateNavy)
                            Text(notice.body, color = Color(0xFF68748A), fontSize = 12.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
                            if (notice.acknowledged == 0) Text("Not yet acknowledged", color = Color(0xFFA52B36), fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
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
private fun Account(
    user: UserDto,
    gateName: String?,
    busy: Boolean,
    error: String?,
    notice: String?,
    changePassword: (String, String) -> Unit,
    clearNotice: () -> Unit,
    logout: () -> Unit,
) {
    var currentPassword by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var revealed by remember { mutableStateOf(false) }
    val matches = newPassword.isNotBlank() && newPassword == confirmPassword
    Column(
        Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Logo()
        Text(user.name, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold)
        Text(user.email, color = Color(0xFF68748A))
        Text("Role: ${user.role.replaceFirstChar(Char::uppercase)}", color = EstateBlue, fontWeight = FontWeight.Bold)
        if (gateName != null) Text("Gate: $gateName", color = EstateNavy, fontWeight = FontWeight.SemiBold)
        // The address the app talks to is baked in at build time; showing it here
        // is what support asks for first, and what proves a build points at the
        // estate's own Worker rather than a placeholder.
        Text("${stringResource(R.string.server_label)}: ${BuildConfig.API_BASE_URL}", color = Color(0xFF98A2B2), fontSize = 11.sp)
        if (notice != null) {
            NoticeCard(notice, tone = EstateGreen)
            TextButton(onClick = clearNotice) { Text("Dismiss") }
        }
        if (error != null) SignInProblemCard(
            SignInProblem(
                title = "That did not work",
                message = error,
                action = SignInAction.Retry,
            ),
        )
        Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(16.dp)) {
            Column(Modifier.fillMaxWidth().padding(17.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Change password", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = EstateNavy)
                Text("Every other device is signed out when you change it, and this phone gets a fresh session.", color = Color(0xFF68748A), fontSize = 11.sp)
                OutlinedTextField(value = currentPassword, onValueChange = { currentPassword = it }, label = { Text("Current password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    value = newPassword,
                    onValueChange = { newPassword = it },
                    label = { Text("New password") },
                    singleLine = true,
                    visualTransformation = if (revealed) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { revealed = !revealed }) {
                            Icon(
                                if (revealed) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                if (revealed) "Hide password" else "Show password",
                                tint = Color(0xFF6A7790),
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = confirmPassword,
                    onValueChange = { confirmPassword = it },
                    label = { Text("Repeat the new password") },
                    singleLine = true,
                    visualTransformation = if (revealed) VisualTransformation.None else PasswordVisualTransformation(),
                    isError = confirmPassword.isNotBlank() && !matches,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (confirmPassword.isNotBlank() && !matches) {
                    Text("The two new passwords do not match.", color = MaterialTheme.colorScheme.error, fontSize = 11.sp)
                }
                Button(
                    onClick = {
                        changePassword(currentPassword, newPassword)
                        currentPassword = ""
                        newPassword = ""
                        confirmPassword = ""
                    },
                    enabled = !busy && currentPassword.isNotBlank() && matches,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Change password") }
            }
        }
        Spacer(Modifier.height(6.dp))
        Button(onClick = logout, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = EstateNavy)) { Icon(Icons.Outlined.Logout, null); Spacer(Modifier.padding(4.dp)); Text("Sign out") }
    }
}

private fun formatNaira(minor: Long): String = NumberFormat.getCurrencyInstance().apply { currency = Currency.getInstance("NGN") }.format(minor / 100.0)
internal fun formatInstant(value: String): String = runCatching { DateTimeFormatter.ofPattern("dd MMM, HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(value)) }.getOrDefault(value)
