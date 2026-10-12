package com.estatemate.app

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.estatemate.app.data.EstateRepository
import com.estatemate.app.data.remote.DeviceOptionDto
import com.estatemate.app.data.remote.FacilityBookingBody
import com.estatemate.app.data.remote.FacilityDto
import com.estatemate.app.data.remote.MaintenanceRequestBody
import com.estatemate.app.data.remote.PortalConfigDto
import com.estatemate.app.data.remote.PropertyDto
import com.estatemate.app.data.remote.UserDto
import com.estatemate.app.data.remote.VisitorPassBody
import com.google.gson.JsonObject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The portal's menu, as the phone sees it.
 *
 * Groups, labels and role visibility mirror `navGroups` in `apps/web/src/App.tsx`
 * so a person sees the same menu on both. Gate activity and Properties already
 * have their own tabs, so they are not repeated here. A module with a [path] is
 * read in the app; one without is a portal-only tool and says so.
 */
data class MenuModule(
    val id: String,
    val label: String,
    val group: String,
    /** Roles that see the item; null means every role, as in the portal. */
    val roles: Set<String>? = null,
    /** Worker list endpoint, relative to the base URL. Null for portal-only tools. */
    val path: String? = null,
    val titleKeys: List<String> = listOf("title", "name"),
    val detailKeys: List<String> = emptyList(),
    val webNote: String = "This tool is available on the web portal.",
    /**
     * Roles that may create a record from the phone, and which form they get.
     * Null means the module stays read-only here, exactly as in the portal's
     * own role checks for the matching POST route.
     */
    val createRoles: Set<String>? = null,
    val form: MenuForm? = null,
    val createLabel: String? = null,
    /** Rows of this module can be cancelled by their requester (facility bookings). */
    val cancellableByRequester: Boolean = false,
) {
    fun visibleTo(role: String): Boolean = roles == null || role in roles
    fun creatableBy(role: String): Boolean = form != null && (createRoles == null || role in createRoles)
}

/** The create form behind a module's button. Each mirrors the portal's own form. */
enum class MenuForm { VisitorPass, MaintenanceRequest, FacilityBooking }

private val STAFF_ROLES = setOf("admin", "manager")
private val OFFICE_ROLES = setOf("admin", "manager", "cashier", "security", "resident")

val MENU_MODULES: List<MenuModule> = listOf(
    MenuModule(
        id = "visitors", label = "Visitor passes", group = "Overview", path = "api/visitors",
        titleKeys = listOf("visitor_name", "visitorName", "name"),
        detailKeys = listOf("status", "purpose_of_visit", "resident_name", "unit_number", "valid_from", "valid_until"),
        // Security and the cashier read the pass list; only the roles the
        // Worker's POST /api/visitors accepts may issue one.
        createRoles = setOf("resident", "admin", "manager"),
        form = MenuForm.VisitorPass,
        createLabel = "New pass",
    ),
    MenuModule(
        id = "cards", label = "Cards & person sync", group = "Access & gates",
        roles = setOf("admin", "manager", "cashier", "resident"), path = "api/access/cards",
        titleKeys = listOf("card_label", "card_uid"),
        detailKeys = listOf("status", "expires_at", "deactivated_reason"),
    ),
    MenuModule(
        id = "devices", label = "Terminals & bridge", group = "Access & gates",
        roles = setOf("admin", "manager", "security"), path = "api/access/devices",
        titleKeys = listOf("name", "device_name"),
        detailKeys = listOf("model", "status", "gate_name", "direction", "profile_key"),
    ),
    MenuModule(
        id = "residents", label = "Residents & households", group = "People & estate",
        roles = OFFICE_ROLES,
        webNote = "Manage residents and households on the web portal. Your own household is under the Properties tab.",
    ),
    MenuModule(
        id = "staff", label = "Staff & shifts", group = "People & estate", roles = STAFF_ROLES,
        path = "api/staff",
        titleKeys = listOf("name", "full_name"),
        detailKeys = listOf("role", "status", "employee_id", "gates", "next_shift"),
    ),
    MenuModule(
        id = "properties", label = "Properties & units", group = "People & estate",
        webNote = "Your units and requests are on the Properties tab.",
    ),
    MenuModule(
        id = "bills", label = "Bills & payments", group = "People & estate",
        roles = setOf("admin", "cashier", "resident"), path = "api/bills",
        titleKeys = listOf("description", "resident_name"),
        detailKeys = listOf("status", "due_date", "amount_minor", "unit_number"),
    ),
    MenuModule(
        id = "maintenance", label = "Maintenance requests", group = "People & estate", roles = OFFICE_ROLES,
        path = "api/maintenance",
        titleKeys = listOf("description"),
        detailKeys = listOf("status", "resident_name", "unit_number", "created_at"),
        createRoles = setOf("resident", "admin", "manager"),
        form = MenuForm.MaintenanceRequest,
        createLabel = "Report an issue",
    ),
    MenuModule(
        id = "bookings", label = "Facility bookings", group = "People & estate", roles = OFFICE_ROLES,
        path = "api/facility-bookings",
        titleKeys = listOf("facility_name", "purpose"),
        detailKeys = listOf("status", "starts_at", "requester_name", "unit_number"),
        createRoles = setOf("resident", "admin", "manager"),
        form = MenuForm.FacilityBooking,
        createLabel = "Book a facility",
        // The Worker lets the requester or an operator cancel a pending or
        // approved booking, and nobody else.
        cancellableByRequester = true,
    ),
    MenuModule(
        id = "notices", label = "Notices", group = "Community & admin", path = "api/notices",
        titleKeys = listOf("title"),
        detailKeys = listOf("severity", "status", "author_name", "published_from"),
    ),
    MenuModule(
        id = "documents", label = "Documents & policies", group = "Community & admin", path = "api/documents",
        titleKeys = listOf("title"),
        detailKeys = listOf("category", "status"),
    ),
    MenuModule(
        id = "emergency", label = "Emergency contacts", group = "Community & admin",
        path = "api/emergency-contacts",
        titleKeys = listOf("name"),
        detailKeys = listOf("category", "phone", "status"),
    ),
    MenuModule(
        id = "settings", label = "Settings & imports", group = "Community & admin", roles = STAFF_ROLES,
        webNote = "Settings and CSV imports are administrator tools on the web portal.",
    ),
)

data class ModuleListState(
    val loading: Boolean = false,
    val items: List<JsonObject> = emptyList(),
    val error: String? = null,
    /** The module id these items belong to, so a previous module's rows are never shown. */
    val loadedFor: String? = null,
    /** The requester's properties, for the forms that must name one. */
    val properties: List<PropertyDto> = emptyList(),
    /** Active facilities, for the booking picker. */
    val facilities: List<FacilityDto> = emptyList(),
    /** The estate's validity window and timezone, read from /api/portal-config. */
    val config: PortalConfigDto? = null,
    /** Gate devices, for the visitor pass form's "Preferred gate device" picker. */
    val devices: List<DeviceOptionDto> = emptyList(),
)

/**
 * What the last create or cancel did.
 *
 * [formSubmitted] closes the form the request came from while [message] stays
 * behind as a notice beside the list — the same rhythm as the portal, which
 * hides the form and leaves the result on the page.
 */
data class FormFeedback(
    val busy: Boolean = false,
    val message: String? = null,
    val error: String? = null,
    val formSubmitted: Boolean = false,
)

// A pass the Worker just issued is kept as a VisitorPassDetails until dismissed:
// the PIN and the unique number exist nowhere else in the app, and the pass —
// the same card the portal renders — is what the resident shows, prints or
// shares with the visitor.

/** The visitor purposes the Worker accepts, with the portal's own labels. */
val VISITOR_PURPOSE_OPTIONS: List<Pair<String, String>> = listOf(
    "family_social" to "Family or social visit",
    "delivery" to "Delivery or collection",
    "service_repair" to "Service, repair or maintenance",
    "business" to "Business or official",
    "domestic_staff" to "Domestic staff or caregiver",
    "event" to "Event or celebration",
    "other" to "Other — state it below",
)

/** The person types a terminal files an account under, with the portal's own labels. */
val VISITOR_PERSON_TYPES: List<Pair<String, String>> = listOf(
    "visitor" to "Visitor",
    "normal" to "Normal user",
)

/** The wording a picker uses, where there is room to explain the choice (the portal's `VISITOR_PERSON_TYPE_CHOICES`). */
val VISITOR_PERSON_TYPE_CHOICES: List<Pair<String, String>> = listOf(
    "visitor" to "Visitor (recommended)",
    "normal" to "Normal user — terminals that refuse the visitor type",
)

/** What the portal's `visitorPurposeLabel` resolves, so both name the purpose alike. */
fun visitorPurposeLabel(purpose: String?, purposeOther: String?): String =
    passPurposeLabel(purpose, purposeOther)

/** What the portal's `visitorPersonTypeLabel` resolves, for the pass list. */
fun visitorPersonTypeLabel(value: String?): String {
    val type = value?.trim()?.lowercase().orEmpty()
    return VISITOR_PERSON_TYPES.firstOrNull { it.first == type }?.second ?: type
}

/** The maintenance scopes the Worker accepts, with the portal's own labels. */
val MAINTENANCE_SCOPES: List<Pair<String, String>> = listOf(
    "personal" to "Personal / Residence",
    "street" to "Street",
    "block" to "Block",
    "zone" to "Zone",
    "estate" to "Entire Estate",
)

/** One pass admits the visitor at least once and at most ten times. */
const val VISIT_TIMES_MIN = 1
const val VISIT_TIMES_MAX = 10

/** A pass window is at least a day and never longer than the Worker's ceiling. */
const val VISITOR_VALIDITY_MIN_DAYS = 1
const val VISITOR_VALIDITY_MAX_CEILING_DAYS = 30
const val VISITOR_DEFAULT_VALIDITY_DAYS = 1
const val VISITOR_DEFAULT_MAX_VALIDITY_DAYS = 7

/**
 * The estate's visitor window: the default a new pass gets and the longest it
 * may be, both in whole days and both inside the ceiling the API enforces.
 */
fun visitorValidityDays(config: PortalConfigDto?): Pair<Int, Int> {
    fun clamp(value: String?, fallback: Int): Int {
        val days = value?.trim()?.toIntOrNull() ?: return fallback
        return days.coerceIn(VISITOR_VALIDITY_MIN_DAYS, VISITOR_VALIDITY_MAX_CEILING_DAYS)
    }
    val defaultDays = clamp(config?.visitorDefaultValidityDays, VISITOR_DEFAULT_VALIDITY_DAYS)
    val maxDays = maxOf(defaultDays, clamp(config?.visitorMaxValidityDays, maxOf(VISITOR_DEFAULT_MAX_VALIDITY_DAYS, defaultDays)))
    return defaultDays to maxDays
}

@HiltViewModel
class ModulesViewModel @Inject constructor(private val repository: EstateRepository) : ViewModel() {
    private val _state = MutableStateFlow(ModuleListState())
    val state: StateFlow<ModuleListState> = _state.asStateFlow()

    private val _feedback = MutableStateFlow(FormFeedback())
    val feedback: StateFlow<FormFeedback> = _feedback.asStateFlow()

    private val _issuedPass = MutableStateFlow<VisitorPassDetails?>(null)
    val issuedPass: StateFlow<VisitorPassDetails?> = _issuedPass.asStateFlow()

    fun load(module: MenuModule) {
        val path = module.path ?: return
        _state.update { ModuleListState(loading = true, loadedFor = module.id) }
        viewModelScope.launch {
            // The forms need more than the list: a property to name, the estate's
            // validity window, and the facilities a booking may target. Fetched
            // with the module so a form never opens on empty pickers.
            val support = runCatching { loadSupport(module) }.getOrElse { Support() }
            runCatching { repository.moduleItems(path) }
                .onSuccess { rows ->
                    _state.update { current ->
                        if (current.loadedFor != module.id) {
                            current
                        } else {
                            ModuleListState(
                                items = rows,
                                loadedFor = module.id,
                                properties = support.properties,
                                facilities = support.facilities,
                                config = support.config,
                                devices = support.devices,
                            )
                        }
                    }
                }
                .onFailure { error ->
                    _state.update { current ->
                        if (current.loadedFor != module.id) {
                            current
                        } else {
                            ModuleListState(
                                error = error.message?.takeIf { it.isNotBlank() } ?: "Could not load this list.",
                                loadedFor = module.id,
                                properties = support.properties,
                                facilities = support.facilities,
                                config = support.config,
                                devices = support.devices,
                            )
                        }
                    }
                }
        }
    }

    private data class Support(
        val properties: List<PropertyDto> = emptyList(),
        val facilities: List<FacilityDto> = emptyList(),
        val config: PortalConfigDto? = null,
        val devices: List<DeviceOptionDto> = emptyList(),
    )

    private suspend fun loadSupport(module: MenuModule): Support = when (module.form) {
        MenuForm.VisitorPass -> Support(
            properties = repository.properties(),
            config = repository.portalConfig(),
            devices = repository.deviceOptions(),
        )
        MenuForm.MaintenanceRequest -> Support(properties = repository.properties())
        MenuForm.FacilityBooking -> Support(
            facilities = repository.activeFacilities(),
            config = repository.portalConfig(),
        )
        null -> Support()
    }

    /** Clears the last result so an opened form starts blank rather than on an old message. */
    fun clearFeedback() {
        _feedback.value = FormFeedback()
    }

    fun dismissIssuedPass() {
        _issuedPass.value = null
    }

    /**
     * Issues a pass and keeps the rendered pass the visitor needs.
     *
     * The PIN and unique number are generated by the Worker and the pass — QR
     * code, barcode, PIN and all — is shown once it is issued, exactly as the
     * portal opens its pass modal after a create. The resident's proof files are
     * uploaded first (the portal uploads them in the same submit) and travel
     * with the request as `proofKeys`.
     */
    fun createVisitorPass(
        request: VisitorPassBody,
        context: VisitorPassContext,
        proofs: List<ProofUpload> = emptyList(),
    ) = viewModelScope.launch {
        _feedback.value = FormFeedback(busy = true)
        runCatching {
            val proofKeys = proofs.map { repository.uploadProofFile(it.uri, it.name, "visitor-proofs") }
            repository.createVisitorPass(request.copy(proofKeys = proofKeys.ifEmpty { null }))
        }
            .onSuccess { created ->
                _issuedPass.value = visitorPassDetails(context, created)
                _feedback.value = FormFeedback(
                    message = "Pass created and the visitor account is live on the estate terminals. It is deleted from all of them automatically when validity ends; the pass record stays. Share the QR/barcode and unique number with the visitor.",
                    formSubmitted = true,
                )
                reload()
            }
            .onFailure { fail(it) }
    }

    fun createMaintenanceRequest(request: MaintenanceRequestBody) = viewModelScope.launch {
        _feedback.value = FormFeedback(busy = true)
        runCatching { repository.createMaintenanceRequest(request) }
            .onSuccess {
                _feedback.value = FormFeedback(message = "Maintenance request submitted.", formSubmitted = true)
                reload()
            }
            .onFailure { fail(it) }
    }

    /** Books a facility; the Worker decides whether it is confirmed or pending approval. */
    fun createFacilityBooking(request: FacilityBookingBody) = viewModelScope.launch {
        _feedback.value = FormFeedback(busy = true)
        runCatching { repository.createFacilityBooking(request) }
            .onSuccess { created ->
                _feedback.value = FormFeedback(
                    message = if (created.status == "approved") "Booking confirmed." else "Booking submitted for approval.",
                    formSubmitted = true,
                )
                reload()
            }
            .onFailure { fail(it) }
    }

    /** Cancels a pending or approved booking. Only the requester or an operator may. */
    fun cancelBooking(id: String) = viewModelScope.launch {
        _feedback.value = FormFeedback(busy = true)
        runCatching { repository.cancelFacilityBooking(id) }
            .onSuccess {
                _feedback.value = FormFeedback(message = "Booking cancelled.")
                reload()
            }
            .onFailure { fail(it) }
    }

    private fun fail(error: Throwable) {
        _feedback.value = FormFeedback(error = error.message?.takeIf { it.isNotBlank() } ?: "That did not go through. Please try again.")
    }

    /** Re-reads the module the last action belongs to, so the list shows the change. */
    private fun reload() {
        val module = MENU_MODULES.firstOrNull { it.id == _state.value.loadedFor } ?: return
        load(module)
    }
}

/** The Menu tab: the portal's groups, filtered to what this role can open. */
@Composable
fun MenuTab(user: UserDto, modules: ModulesViewModel = hiltViewModel()) {
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    var formFor by rememberSaveable { mutableStateOf<String?>(null) }
    val current = MENU_MODULES.firstOrNull { it.id == openId && it.visibleTo(user.role) }
    if (current == null) {
        MenuList(user.role) { openId = it.id }
        return
    }
    // A form belongs to one module, so opening another one closes it. Keeping
    // the id rather than a flag is what makes that true without a write during
    // composition.
    val formOpen = formFor == current.id
    val state by modules.state.collectAsState()
    val feedback by modules.feedback.collectAsState()
    val issuedPass by modules.issuedPass.collectAsState()
    LaunchedEffect(current.id) { modules.load(current) }
    // A create that went through closes its form and leaves the result as a
    // notice beside the list, the way the portal hides the form.
    LaunchedEffect(feedback.formSubmitted) { if (feedback.formSubmitted) formFor = null }
    BackHandler { if (formOpen) formFor = null else openId = null }
    ModuleDetail(
        module = current,
        user = user,
        state = state,
        feedback = feedback,
        issuedPass = issuedPass,
        formOpen = formOpen,
        onToggleForm = {
            if (formOpen) {
                formFor = null
            } else {
                modules.clearFeedback()
                formFor = current.id
            }
        },
        onDismissIssuedPass = modules::dismissIssuedPass,
        onBack = { if (formOpen) formFor = null else openId = null },
        onRefresh = { modules.load(current) },
        onCreateVisitorPass = modules::createVisitorPass,
        onCreateMaintenance = modules::createMaintenanceRequest,
        onCreateBooking = modules::createFacilityBooking,
        onCancelBooking = modules::cancelBooking,
    )
}

@Composable
private fun MenuList(role: String, onOpen: (MenuModule) -> Unit) {
    val visible = MENU_MODULES.filter { it.visibleTo(role) }
    val groups = visible.groupBy { it.group }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Text("Menu", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = Color(0xFF0D1B37)) }
        item { Text("Everything your role can open in Sornix EstateOS.", color = Color(0xFF6A7790)) }
        if (visible.isEmpty()) item { Text("No menu items are available for this role.", color = Color(0xFF6A7790)) }
        groups.forEach { (group, entries) ->
            item {
                Text(
                    group.uppercase(),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = Color(0xFF6A7790),
                    modifier = Modifier.padding(top = 10.dp),
                )
            }
            items(entries) { module -> ModuleRow(module) { onOpen(module) } }
        }
    }
}

@Composable
private fun ModuleRow(module: MenuModule, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(module.label, fontWeight = FontWeight.Bold, color = Color(0xFF0D1B37))
                Text(
                    if (module.path != null) "Open in the app" else "Use the web portal",
                    fontSize = 12.sp,
                    color = Color(0xFF6A7790),
                )
            }
            Icon(Icons.Outlined.ChevronRight, null, tint = Color(0xFF6A7790))
        }
    }
}

@Composable
private fun ModuleDetail(
    module: MenuModule,
    user: UserDto,
    state: ModuleListState,
    feedback: FormFeedback,
    issuedPass: VisitorPassDetails?,
    formOpen: Boolean,
    onToggleForm: () -> Unit,
    onDismissIssuedPass: () -> Unit,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onCreateVisitorPass: (VisitorPassBody, VisitorPassContext, List<ProofUpload>) -> Unit,
    onCreateMaintenance: (MaintenanceRequestBody) -> Unit,
    onCreateBooking: (FacilityBookingBody) -> Unit,
    onCancelBooking: (String) -> Unit,
) {
    // Which booking is one tap away from being cancelled, so a mis-tap can
    // never cancel somebody's reservation by itself.
    var confirmCancelId by rememberSaveable { mutableStateOf<String?>(null) }
    // A pass opened from a row of the list — the portal's "View pass" button.
    var viewedPass by remember { mutableStateOf<VisitorPassDetails?>(null) }
    val shownPass = viewedPass ?: issuedPass
    if (shownPass != null) {
        VisitorPassDialog(
            details = shownPass,
            config = state.config,
            onDismiss = {
                viewedPass = null
                onDismissIssuedPass()
            },
        )
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Outlined.ArrowBack, "Back to menu") }
            Text(
                module.label,
                fontSize = 22.sp,
                fontWeight = FontWeight.ExtraBold,
                color = Color(0xFF0D1B37),
                modifier = Modifier.weight(1f),
            )
            if (module.path != null) IconButton(onClick = onRefresh) { Icon(Icons.Outlined.Refresh, "Refresh") }
        }
        if (module.path == null) {
            Text(module.webNote, color = Color(0xFF6A7790), modifier = Modifier.padding(12.dp))
            return@Column
        }
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (module.creatableBy(user.role)) {
                item {
                    if (formOpen) {
                        FormCard(title = module.createLabel ?: "New record", onClose = onToggleForm) {
                            when (module.form) {
                                MenuForm.VisitorPass -> VisitorPassForm(user, state.properties, state.devices, state.config, feedback, onCreateVisitorPass)
                                MenuForm.MaintenanceRequest -> MaintenanceForm(user, state.properties, feedback, onCreateMaintenance)
                                MenuForm.FacilityBooking -> BookingForm(state.facilities, state.config, feedback, onCreateBooking)
                                null -> Unit
                            }
                        }
                    } else {
                        Button(onClick = onToggleForm, enabled = !feedback.busy, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Outlined.Add, null)
                            Spacer(Modifier.width(8.dp))
                            Text(module.createLabel ?: "New record")
                        }
                    }
                }
            }
            feedback.message?.let { text -> item { ResultNotice(text, error = false) } }
            feedback.error?.let { text -> item { ResultNotice(text, error = true) } }
            when {
                state.loading || state.loadedFor != module.id -> item {
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                }
                state.error != null -> item {
                    Text(state.error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp))
                }
                state.items.isEmpty() -> item {
                    Text("Nothing to show yet.", color = Color(0xFF6A7790), modifier = Modifier.padding(12.dp))
                }
                else -> items(state.items) { row ->
                    RowCard(module, row, user) {
                        if (module.id == "visitors") {
                            TextButton(onClick = { viewedPass = passDetailsFromRow(row) }) { Text("View pass") }
                        } else {
                            BookingRowAction(
                                module = module,
                                row = row,
                                user = user,
                                busy = feedback.busy,
                                confirming = confirmCancelId != null && confirmCancelId == row.rawText("id"),
                                onConfirming = { confirming -> confirmCancelId = if (confirming) row.rawText("id") else null },
                                onCancel = onCancelBooking,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * A row's own action, when the module has one.
 *
 * Only facility bookings do: the Worker lets the requester or an operator
 * cancel a pending or approved booking, and nobody cancel anything else, so the
 * button appears for exactly those rows and no others.
 */
@Composable
private fun BookingRowAction(
    module: MenuModule,
    row: JsonObject,
    user: UserDto,
    busy: Boolean,
    confirming: Boolean,
    onConfirming: (Boolean) -> Unit,
    onCancel: (String) -> Unit,
) {
    if (!module.cancellableByRequester) return
    val id = row.rawText("id") ?: return
    val status = row.rawText("status")
    if (status != "pending" && status != "approved") return
    val mine = row.rawText("requester_id") == user.id
    if (!mine && user.role !in STAFF_ROLES) return
    if (confirming) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Cancel this booking?", fontSize = 12.sp, color = Color(0xFF6A7790))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { onConfirming(false); onCancel(id) },
                    enabled = !busy,
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text("Yes, cancel") }
                TextButton(onClick = { onConfirming(false) }, enabled = !busy) { Text("Keep it") }
            }
        }
    } else {
        TextButton(onClick = { onConfirming(true) }, enabled = !busy) { Text("Cancel booking") }
    }
}

@Composable
private fun RowCard(module: MenuModule, row: JsonObject, user: UserDto, action: (@Composable () -> Unit)? = null) {
    val title = module.titleKeys.firstNotNullOfOrNull { row.displayText(it) } ?: "Item"
    val details = moduleRowDetails(module, row, user)
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(title, fontWeight = FontWeight.Bold, color = Color(0xFF0D1B37))
            if (details.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(details.joinToString(" · "), fontSize = 12.sp, color = Color(0xFF6A7790))
            }
            if (action != null) {
                Spacer(Modifier.height(6.dp))
                action()
            }
        }
    }
}

/**
 * One row's printable details. Visitor passes are composed the way the portal's
 * own table composes them — purpose label, visit count, the staff-only gate,
 * person type, device and device-account columns, then status and validity —
 * while every other module shows the columns it declares.
 */
private fun moduleRowDetails(module: MenuModule, row: JsonObject, user: UserDto): List<String> =
    if (module.id == "visitors") visitorRowDetails(row, user.role == "admin" || user.role == "manager" || user.role == "security")
    else module.detailKeys.mapNotNull { row.displayText(it) }

/** The portal's `Visitor Passes` table columns, in the portal's own order. */
private fun visitorRowDetails(row: JsonObject, staff: Boolean): List<String> {
    fun text(vararg keys: String): String? {
        for (key in keys) {
            val value = row.rawText(key)?.trim().orEmpty()
            if (value.isNotEmpty()) return value
        }
        return null
    }

    val details = mutableListOf<String>()
    listOfNotNull(
        text("resident_name", "residentName"),
        text("unit_number"),
        visitorPurposeLabel(text("purpose_of_visit", "purposeOfVisit"), text("purpose_of_visit_other", "purposeOfVisitOther")).ifEmpty { "—" },
        "${text("visits_used", "visitsUsed") ?: "0"} of ${text("visit_times", "visitTimes") ?: "1"}",
        text("credential_number", "credentialNumber"),
    ).forEach { details += it }
    if (staff) {
        val gateScope = text("gate_scope", "gateScope") ?: "both"
        listOfNotNull(
            if (gateScope == "gate") "Selected gate only" else "Every gate, entry and exit",
            visitorPersonTypeLabel(text("person_type", "personType")),
            text("device_name", "deviceName"),
            text("device_account_state"),
        ).forEach { details += it }
    }
    listOfNotNull(
        text("status"),
        text("valid_until", "validUntil")?.let { passDateText(it) },
    ).forEach { details += it }
    return details
}

/** The raw string of a column, for decisions rather than for display. */
private fun JsonObject.rawText(key: String): String? {
    val element = get(key) ?: return null
    if (element.isJsonNull || !element.isJsonPrimitive) return null
    return element.asString
}

/**
 * A printable value for one column. Money arrives in minor units (`*_minor`), so it
 * is shown as major units with the estate currency; null, empty and nested values
 * are skipped rather than shown as raw JSON.
 */
private fun JsonObject.displayText(key: String): String? {
    val element = get(key) ?: return null
    if (element.isJsonNull || !element.isJsonPrimitive) return null
    val raw = element.asString.takeIf { it.isNotBlank() } ?: return null
    if (key.endsWith("_minor")) {
        val minor = raw.toDoubleOrNull() ?: return null
        return "NGN %,.2f".format(minor / 100.0)
    }
    return raw
}
