package com.estatemate.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import com.estatemate.app.data.remote.FacilityBookingBody
import com.estatemate.app.data.remote.FacilityDto
import com.estatemate.app.data.remote.MaintenanceRequestBody
import com.estatemate.app.data.remote.PortalConfigDto
import com.estatemate.app.data.remote.PropertyDto
import com.estatemate.app.data.remote.UserDto
import com.estatemate.app.data.remote.VisitorPassBody
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The resident's create forms.
 *
 * Field for field these are the portal's own forms (`apps/web/src/App.tsx`,
 * the Visitors / Maintenance / FacilityBookings panels) and they post the same
 * shapes the Worker accepts: naive `yyyy-MM-ddTHH:mm` wall-clock datetimes, the
 * portal's purpose and scope values, and the resident's own id only when an
 * operator is acting for somebody else. What the Worker refuses comes back in
 * its own words and lands in the form, not as "HTTP 400".
 */

private val FormSubdued = Color(0xFF6A7790)
private val FieldPattern = "yyyy-MM-dd'T'HH:mm"

/** A create form's card: a title, a way out, and the fields. */
@Composable
fun FormCard(title: String, onClose: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = EstateNavy, modifier = Modifier.weight(1f))
                IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, "Close form") }
            }
            content()
        }
    }
}

/** The result of the last action, beside the list the way the portal leaves it. */
@Composable
fun ResultNotice(text: String, error: Boolean) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = if (error) Color(0xFFFDEBED) else Color(0xFFE3F8EC)),
    ) {
        Text(
            text,
            color = if (error) Color(0xFFA52B36) else Color(0xFF137444),
            fontSize = 13.sp,
            modifier = Modifier.padding(14.dp),
        )
    }
}

/**
 * The pass the Worker just issued.
 *
 * The PIN and the unique number exist nowhere else in the app — the list only
 * repeats the visitor's name and window — so this panel is what the resident
 * reads to the visitor, and it stays until dismissed.
 */
@Composable
fun IssuedPassCard(pass: IssuedPass, onDismiss: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = EstateNavy),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("VISITOR PASS ISSUED", color = EstateGreen, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold)
            Text(pass.visitorName, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
            Spacer(Modifier.height(2.dp))
            Text("PIN for the terminal keypad", color = Color.White.copy(alpha = 0.7f), fontSize = 11.sp)
            Text(pass.pin, color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.Black)
            pass.credentialNumber?.let { Text("Unique number $it", color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp) }
            val window = listOfNotNull(
                pass.validFrom?.let(::formatInstant),
                pass.validUntil?.let(::formatInstant),
            ).joinToString(" → ")
            if (window.isNotBlank()) Text("Valid $window", color = Color.White.copy(alpha = 0.85f), fontSize = 12.sp)
            pass.visitTimes?.let { times ->
                Text("Usable $times time${if (times == 1) "" else "s"}", color = Color.White.copy(alpha = 0.85f), fontSize = 12.sp)
            }
            Text(
                "Share the PIN or the unique number with your visitor. Security previews the pass at the gate and verifies ID where the estate requires it before entry.",
                color = Color.White.copy(alpha = 0.75f),
                fontSize = 11.sp,
            )
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("Done", color = EstateGreen) }
        }
    }
}

/** A line of explanation under a field — the small print the portal also shows. */
@Composable
fun FieldHint(text: String) {
    Text(text, fontSize = 11.sp, color = FormSubdued, modifier = Modifier.padding(start = 4.dp, top = 2.dp))
}

/**
 * A picker that reads as a text field, so the forms look the same on both
 * platforms. [options] pairs the value sent to the Worker with what a person
 * reads; [selected] is the current value.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> EstateDropdown(
    label: String,
    options: List<Pair<T, String>>,
    selected: T?,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    hint: String? = null,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier) {
        ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (enabled) expanded = it }) {
            OutlinedTextField(
                value = options.firstOrNull { it.first == selected }?.second ?: "",
                onValueChange = {},
                readOnly = true,
                enabled = enabled,
                singleLine = true,
                label = { Text(label) },
                trailingIcon = { Icon(Icons.Outlined.ArrowDropDown, null) },
                modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
            )
            ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                options.forEach { (value, text) ->
                    DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(value); expanded = false })
                }
            }
        }
        if (hint != null) FieldHint(hint)
    }
}

/** The resident ID field the portal asks an operator for on the forms it allows them to use. */
@Composable
private fun OperatorResidentField(operator: Boolean, residentId: String, onChange: (String) -> Unit) {
    if (!operator) return
    OutlinedTextField(
        value = residentId,
        onValueChange = onChange,
        label = { Text("Resident ID") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    FieldHint("The resident this is created for — from the Residents page on the web portal.")
}

/**
 * Which property the record belongs to.
 *
 * A resident owns, rents or lives in these; when there is exactly one the
 * Worker resolves it by itself and the form says which one it will use, and
 * with several the picker decides. An operator gets the estate's list plus the
 * Worker's own "the resident's property" resolution.
 */
@Composable
private fun PropertyField(
    operator: Boolean,
    properties: List<PropertyDto>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    val options = properties.map { it.id to it.formLabel() }
    when {
        operator -> EstateDropdown(
            label = "Property",
            options = listOf("" to "Automatic — the resident's own property") + options,
            selected = selected,
            onSelect = onSelect,
            modifier = Modifier.fillMaxWidth(),
        )
        properties.size == 1 -> FieldHint("Property: ${properties.first().formLabel()}")
        properties.size > 1 -> EstateDropdown(
            label = "Property",
            options = options,
            selected = selected.ifBlank { properties.first().id },
            onSelect = onSelect,
            modifier = Modifier.fillMaxWidth(),
        )
        else -> FieldHint("No property is linked to your account yet, so the estate office will need to link one before this can be approved.")
    }
}

/** '12 Palm Avenue — Block C' as the portal's own property selects read. */
private fun PropertyDto.formLabel(): String = listOfNotNull(
    unitNumber.takeIf { it.isNotBlank() },
    listOfNotNull(street, block).firstOrNull { it.isNotBlank() },
).joinToString(" — ").ifBlank { address }

/**
 * Issues a visitor pass — the portal's "Create visitor pass" form.
 *
 * The validity window comes from the estate's own settings: the number of days
 * defaults to what an administrator configured and can never exceed the
 * maximum they set, and moving the start (or the number of days) moves the end
 * with it, exactly as the portal's form behaves.
 */
@Composable
fun VisitorPassForm(
    user: UserDto,
    properties: List<PropertyDto>,
    config: PortalConfigDto?,
    feedback: FormFeedback,
    onSubmit: (VisitorPassBody, String) -> Unit,
) {
    val operator = user.role == "admin" || user.role == "manager"
    val zone = remember(config?.estateTimeZone) { estateZone(config?.estateTimeZone) }
    val (defaultDays, maxDays) = visitorValidityDays(config)

    var name by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var residentId by rememberSaveable { mutableStateOf("") }
    var propertyId by rememberSaveable { mutableStateOf("") }
    var validFrom by rememberSaveable(zone) { mutableStateOf(localDateTimeInput(System.currentTimeMillis(), zone)) }
    // 0 means "whatever the estate's default is", so a settings change that
    // arrives with the config still lands on the right number of days.
    var validityChoice by rememberSaveable { mutableStateOf(0) }
    var untilEdited by rememberSaveable { mutableStateOf("") }
    var purpose by rememberSaveable { mutableStateOf("") }
    var purposeOther by rememberSaveable { mutableStateOf("") }
    var times by rememberSaveable { mutableStateOf(VISIT_TIMES_MIN) }
    var remark by rememberSaveable { mutableStateOf("") }
    var idCheck by rememberSaveable { mutableStateOf(false) }

    val days = validityChoice.takeIf { it in VISITOR_VALIDITY_MIN_DAYS..maxDays } ?: defaultDays
    val derivedUntil = remember(validFrom, days) { addDays(validFrom, days) }
    val validUntil = untilEdited.ifBlank { derivedUntil }
    val chosenProperty = propertyId.ifBlank { properties.singleOrNull()?.id.orEmpty() }
    val visitTimesOptions = (VISIT_TIMES_MIN..VISIT_TIMES_MAX).map { it to it.toString() }
    val validityOptions = (VISITOR_VALIDITY_MIN_DAYS..maxDays).map { it to "$it day${if (it == 1) "" else "s"}" }

    OutlinedTextField(name, { name = it }, label = { Text("Visitor name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(phone, { phone = it }, label = { Text("Phone") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    OperatorResidentField(operator, residentId, { residentId = it })
    PropertyField(operator, properties, propertyId, { propertyId = it })
    OutlinedTextField(
        validFrom,
        { validFrom = it },
        label = { Text("Valid from") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    FieldHint("The estate reads this as ${estateClockLabel(validFrom)} (${zone.id}). Format: YYYY-MM-DDTHH:mm.")
    EstateDropdown(
        label = "Validity period",
        options = validityOptions,
        selected = days,
        onSelect = { validityChoice = it },
        modifier = Modifier.fillMaxWidth(),
        hint = "Defaults to $defaultDays day${if (defaultDays == 1) "" else "s"}; $maxDays day${if (maxDays == 1) "" else "s"} is the longest this estate allows.",
    )
    OutlinedTextField(
        validUntil,
        { untilEdited = it },
        label = { Text("Valid until") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    FieldHint("Moves with the start and the validity period until you type your own time.")
    EstateDropdown(
        label = "Purpose of visit",
        options = VISITOR_PURPOSE_OPTIONS,
        selected = purpose.takeIf { it.isNotBlank() },
        onSelect = {
            purpose = it
            if (it != "other") purposeOther = ""
        },
        modifier = Modifier.fillMaxWidth(),
    )
    if (purpose == "other") {
        OutlinedTextField(
            purposeOther,
            { purposeOther = it },
            label = { Text("State the purpose") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        FieldHint("Shown on the pass and to the officer at the gate.")
    }
    OutlinedTextField(
        remark,
        { remark = it },
        label = { Text("Remark") },
        placeholder = { Text("Anything the gate should know — vehicle, arrival time, who to call") },
        modifier = Modifier.fillMaxWidth(),
    )
    EstateDropdown(
        label = "Visit times",
        options = visitTimesOptions,
        selected = times,
        onSelect = { times = it },
        modifier = Modifier.fillMaxWidth(),
        hint = "How many times this pass may be used at the gate.",
    )
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Gate ID / invitation verification", fontWeight = FontWeight.SemiBold, color = EstateNavy, fontSize = 14.sp)
            Text(
                "On, security must verify the visitor's physical ID or invitation and upload the gate photo before access. Off, verification stays optional.",
                fontSize = 11.sp,
                color = FormSubdued,
            )
        }
        Switch(checked = idCheck, onCheckedChange = { idCheck = it })
    }
    FieldHint("A six-digit PIN is generated with the pass — the visitor types it on the terminal keypad. It is shown here once the pass is issued.")
    Button(
        onClick = {
            onSubmit(
                VisitorPassBody(
                    visitorName = name.trim(),
                    visitorPhone = phone.trim().takeIf { it.isNotEmpty() },
                    residentId = residentId.trim().takeIf { it.isNotEmpty() },
                    propertyId = chosenProperty.takeIf { it.isNotEmpty() },
                    validFrom = validFrom.trim(),
                    validUntil = validUntil.trim(),
                    purposeOfVisit = purpose.takeIf { it.isNotEmpty() },
                    purposeOfVisitOther = purposeOther.trim().takeIf { purpose == "other" && it.isNotEmpty() },
                    visitTimes = times,
                    remark = remark.trim().takeIf { it.isNotEmpty() },
                    requireGateIdVerification = idCheck,
                ),
                name.trim(),
            )
        },
        enabled = !feedback.busy && name.isNotBlank() && validFrom.isNotBlank() && validUntil.isNotBlank(),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (feedback.busy) "Issuing pass…" else "Issue secure pass", fontWeight = FontWeight.Bold) }
}

/**
 * Reports a maintenance issue — the portal's "Report a maintenance issue" form,
 * with the same scopes and the same rule that a street, block or zone request
 * has to name which one.
 */
@Composable
fun MaintenanceForm(
    user: UserDto,
    properties: List<PropertyDto>,
    feedback: FormFeedback,
    onSubmit: (MaintenanceRequestBody) -> Unit,
) {
    val operator = user.role == "admin" || user.role == "manager"
    var scope by rememberSaveable { mutableStateOf("personal") }
    var scopeTarget by rememberSaveable { mutableStateOf("") }
    var residentId by rememberSaveable { mutableStateOf("") }
    var propertyId by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }

    val needsTarget = scope == "street" || scope == "block" || scope == "zone"
    // The portal asks a resident for their property on a personal request only,
    // and the Worker resolves it by itself when it is left out — sending one
    // for a street request would ask it to check a permission it has no reason
    // to check.
    val chosenProperty = if (operator || scope == "personal") {
        propertyId.ifBlank { properties.singleOrNull()?.id.orEmpty() }
    } else {
        ""
    }
    val targetLabel = when (scope) {
        "street" -> "Street name / label"
        "block" -> "Block name / label"
        "zone" -> "Zone name / label"
        else -> "Which one"
    }
    val targetHint = when (scope) {
        "street" -> "e.g. Palm Avenue"
        "block" -> "e.g. Block C"
        "zone" -> "e.g. Zone 2"
        else -> ""
    }

    EstateDropdown(
        label = "Maintenance scope",
        options = MAINTENANCE_SCOPES,
        selected = scope,
        onSelect = {
            scope = it
            if (it == "personal" || it == "estate") scopeTarget = ""
        },
        modifier = Modifier.fillMaxWidth(),
    )
    FieldHint("Personal covers your own residence; the rest report a shared fault the estate should fix.")
    if (needsTarget) {
        OutlinedTextField(
            scopeTarget,
            { scopeTarget = it },
            label = { Text(targetLabel) },
            placeholder = { Text(targetHint) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    OperatorResidentField(operator, residentId, { residentId = it })
    // The portal asks a resident for their property on a personal request and
    // leaves it to the Worker otherwise.
    if (operator || scope == "personal") {
        PropertyField(operator, properties, propertyId, { propertyId = it })
    }
    OutlinedTextField(
        description,
        { description = it },
        label = { Text("What needs fixing?") },
        modifier = Modifier.fillMaxWidth(),
    )
    Button(
        onClick = {
            onSubmit(
                MaintenanceRequestBody(
                    description = description.trim(),
                    residentId = residentId.trim().takeIf { it.isNotEmpty() },
                    propertyId = chosenProperty.takeIf { it.isNotEmpty() },
                    scopeType = scope,
                    scopeTarget = scopeTarget.trim().takeIf { it.isNotEmpty() },
                ),
            )
        },
        enabled = !feedback.busy && description.isNotBlank() && (!needsTarget || scopeTarget.isNotBlank()),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (feedback.busy) "Submitting…" else "Submit request", fontWeight = FontWeight.Bold) }
}

/**
 * Books a facility — the portal's "Reserve a facility" form.
 *
 * A date plus a start and an end time, combined into the naive
 * `yyyy-MM-ddTHH:mm` datetimes the Worker parses against the estate's timezone
 * (the portal's booking form currently posts bare times the API cannot read —
 * the app deliberately sends the full window).
 */
@Composable
fun BookingForm(
    facilities: List<FacilityDto>,
    config: PortalConfigDto?,
    feedback: FormFeedback,
    onSubmit: (FacilityBookingBody) -> Unit,
) {
    val zone = remember(config?.estateTimeZone) { estateZone(config?.estateTimeZone) }
    var facilityId by rememberSaveable { mutableStateOf("") }
    // Today on the estate's calendar: a resident travelling in another timezone
    // must not book yesterday's date by accident.
    var date by rememberSaveable(zone) { mutableStateOf(LocalDate.now(zone).toString()) }
    var startsAt by rememberSaveable { mutableStateOf("10:00") }
    var endsAt by rememberSaveable { mutableStateOf("12:00") }
    var purpose by rememberSaveable { mutableStateOf("") }
    var attendees by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }

    val facility = facilities.firstOrNull { it.id == facilityId }
    val options = facilities.map { it.id to it.pickerLabel() }

    if (facilities.isEmpty()) {
        FieldHint("No facility is open for booking yet. The estate office adds them on the web portal.")
    } else {
        EstateDropdown(
            label = "Facility",
            options = options,
            selected = facilityId.takeIf { it.isNotBlank() },
            onSelect = { facilityId = it },
            modifier = Modifier.fillMaxWidth(),
        )
    }
    facility?.let { f ->
        val notes = listOfNotNull(
            f.capacity?.let { "Seats $it" },
            f.maxHoursPerBooking?.let { "At most $it hour${if (it == 1) "" else "s"} per booking" },
            f.minNoticeHours?.takeIf { it > 0 }?.let { "Needs $it hours notice" },
            if ((f.requiresApproval ?: 1) == 1) "Approval required" else "Instant confirmation",
            f.hourlyRateMinor?.takeIf { it > 0 }?.let { "NGN %,.2f per hour".format(it / 100.0) },
            f.depositMinor?.takeIf { it > 0 }?.let { "Deposit NGN %,.2f".format(it / 100.0) },
        )
        FieldHint(notes.joinToString(" · "))
        f.rules?.takeIf { it.isNotBlank() }?.let { FieldHint(it) }
    }
    OutlinedTextField(date, { date = it }, label = { Text("Date (YYYY-MM-DD)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(
            startsAt,
            { startsAt = it },
            label = { Text("Starts at") },
            singleLine = true,
            modifier = Modifier.weight(1f),
        )
        OutlinedTextField(
            endsAt,
            { endsAt = it },
            label = { Text("Ends at") },
            singleLine = true,
            modifier = Modifier.weight(1f),
        )
    }
    FieldHint(
        bookingWindow(date, startsAt, endsAt)
            ?.let { "Your window: $it, in estate time (${zone.id})." }
            ?: "Use YYYY-MM-DD for the date and HH:mm (24-hour) for the times.",
    )
    OutlinedTextField(
        purpose,
        { purpose = it },
        label = { Text("Purpose / event title") },
        placeholder = { Text("Family birthday / tennis match / committee meeting") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        attendees,
        { attendees = it.filter(Char::isDigit) },
        label = { Text("Expected attendees") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(phone, { phone = it }, label = { Text("Contact phone") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Button(
        onClick = {
            onSubmit(
                FacilityBookingBody(
                    facilityId = facilityId,
                    startsAt = "${date.trim()}T${startsAt.trim()}",
                    endsAt = "${date.trim()}T${endsAt.trim()}",
                    purpose = purpose.trim().takeIf { it.isNotEmpty() },
                    attendees = attendees.trim().toIntOrNull(),
                    contactPhone = phone.trim().takeIf { it.isNotEmpty() },
                ),
            )
        },
        enabled = !feedback.busy && facilityId.isNotBlank() && date.isNotBlank() && startsAt.isNotBlank() && endsAt.isNotBlank() && purpose.isNotBlank(),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (feedback.busy) "Submitting…" else "Submit booking", fontWeight = FontWeight.Bold) }
    Spacer(Modifier.height(2.dp))
    FieldHint("The estate decides the fee; a facility that charges raises the bill once the booking is approved.")
}

/** 'Estate Clubhouse Hall · seats 60' for the booking picker. */
private fun FacilityDto.pickerLabel(): String = listOfNotNull(
    name,
    capacity?.let { "seats $it" },
    location?.takeIf { it.isNotBlank() },
).joinToString(" · ")

/** The estate's zone, or the phone's own when the estate has not set one. */
private fun estateZone(name: String?): ZoneId =
    runCatching { ZoneId.of(name.orEmpty().trim()) }.getOrDefault(ZoneId.systemDefault())

/** Wall-clock text (`yyyy-MM-ddTHH:mm`) for an instant, as the portal's datetime-local inputs produce. */
private fun localDateTimeInput(millis: Long, zone: ZoneId): String =
    LocalDateTime.ofInstant(Instant.ofEpochMilli(millis), zone).format(DateTimeFormatter.ofPattern(FieldPattern))

/** Reads the form's wall-clock text, tolerating a space instead of the `T`. */
private fun readWallClock(text: String): LocalDateTime? {
    val normalized = text.trim().replace(' ', 'T')
    if (normalized.isEmpty()) return null
    return runCatching { LocalDateTime.parse(normalized, DateTimeFormatter.ofPattern(FieldPattern)) }
        .recoverCatching { LocalDateTime.parse(normalized) }
        .getOrNull()
}

/** The end of a window that starts at [from] and lasts [days], in the same text form. */
private fun addDays(from: String, days: Int): String =
    readWallClock(from)?.plusDays(days.toLong())?.format(DateTimeFormatter.ofPattern(FieldPattern)).orEmpty()

/** '2026-10-12 10:00 → 12:00' once the three booking fields make sense, otherwise null. */
private fun bookingWindow(date: String, startsAt: String, endsAt: String): String? {
    val start = readWallClock("$date $startsAt") ?: return null
    val end = readWallClock("$date $endsAt") ?: return null
    if (!end.isAfter(start)) return null
    val format = DateTimeFormatter.ofPattern("dd MMM, HH:mm")
    return "${start.format(format)} → ${end.format(format)}"
}

/** What the estate clock says the typed start means, so a wrong year or a typo is visible. */
private fun estateClockLabel(text: String): String =
    readWallClock(text)?.format(DateTimeFormatter.ofPattern("EEE dd MMM yyyy, HH:mm")) ?: "not a readable datetime yet"
