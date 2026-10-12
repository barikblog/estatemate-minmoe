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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
) {
    fun visibleTo(role: String): Boolean = roles == null || role in roles
}

private val STAFF_ROLES = setOf("admin", "manager")
private val OFFICE_ROLES = setOf("admin", "manager", "cashier", "security", "resident")

val MENU_MODULES: List<MenuModule> = listOf(
    MenuModule(
        id = "visitors", label = "Visitor passes", group = "Overview", path = "api/visitors",
        titleKeys = listOf("visitor_name", "visitorName", "name"),
        detailKeys = listOf("status", "purpose_of_visit", "resident_name", "unit_number", "valid_from", "valid_until"),
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
    ),
    MenuModule(
        id = "bookings", label = "Facility bookings", group = "People & estate", roles = OFFICE_ROLES,
        path = "api/facility-bookings",
        titleKeys = listOf("facility_name", "purpose"),
        detailKeys = listOf("status", "starts_at", "requester_name", "unit_number"),
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
)

@HiltViewModel
class ModulesViewModel @Inject constructor(private val repository: EstateRepository) : ViewModel() {
    private val _state = MutableStateFlow(ModuleListState())
    val state: StateFlow<ModuleListState> = _state.asStateFlow()

    fun load(module: MenuModule) {
        val path = module.path ?: return
        _state.update { ModuleListState(loading = true, loadedFor = module.id) }
        viewModelScope.launch {
            runCatching { repository.moduleItems(path) }
                .onSuccess { rows ->
                    _state.update { current ->
                        if (current.loadedFor == module.id) ModuleListState(items = rows, loadedFor = module.id) else current
                    }
                }
                .onFailure { error ->
                    _state.update { current ->
                        if (current.loadedFor == module.id) {
                            ModuleListState(
                                error = error.message?.takeIf { it.isNotBlank() } ?: "Could not load this list.",
                                loadedFor = module.id,
                            )
                        } else {
                            current
                        }
                    }
                }
        }
    }
}

/** The Menu tab: the portal's groups, filtered to what this role can open. */
@Composable
fun MenuTab(role: String, modules: ModulesViewModel = hiltViewModel()) {
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    val current = MENU_MODULES.firstOrNull { it.id == openId && it.visibleTo(role) }
    if (current == null) {
        MenuList(role) { openId = it.id }
    } else {
        BackHandler { openId = null }
        LaunchedEffect(current.id) { modules.load(current) }
        val state by modules.state.collectAsState()
        ModuleDetail(
            module = current,
            state = state,
            onBack = { openId = null },
            onRefresh = { modules.load(current) },
        )
    }
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
    state: ModuleListState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
) {
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
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                module.path == null -> Text(module.webNote, color = Color(0xFF6A7790), modifier = Modifier.padding(12.dp))
                state.loading || state.loadedFor != module.id ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                state.error != null -> Text(
                    state.error,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(12.dp),
                )
                state.items.isEmpty() -> Text(
                    "Nothing to show yet.",
                    color = Color(0xFF6A7790),
                    modifier = Modifier.padding(12.dp),
                )
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.items) { row -> RowCard(module, row) }
                }
            }
        }
    }
}

@Composable
private fun RowCard(module: MenuModule, row: JsonObject) {
    val title = module.titleKeys.firstNotNullOfOrNull { row.displayText(it) } ?: "Item"
    val details = module.detailKeys.mapNotNull { row.displayText(it) }
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
        }
    }
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
