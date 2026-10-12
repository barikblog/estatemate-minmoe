package com.estatemate.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.print.PrintHelper
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.estatemate.app.data.remote.PortalConfigDto
import com.estatemate.app.data.remote.VisitorPassCreated
import com.google.gson.JsonObject
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.oned.Code128Writer
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.ceil

/**
 * The issued visitor pass — the Android twin of the portal's own pass.
 *
 * `apps/web/src/App.tsx` shows a pass as a printable card and
 * `apps/web/src/pass-export.ts` draws the same pass onto a 900px canvas to share
 * it as a PNG or a one-page PDF. This file draws that same canvas here: the same
 * palette, the same layout and the same words, so a pass issued from the phone
 * is the pass the portal issues — QR code and Code 128 barcode of the unique
 * number, the keypad PIN, the validity window, purpose and remark, the gate
 * scope, the security policy and the Sornix footer. The rendered bitmap *is*
 * what the person sees and what "Share image", "Share PDF" and "Print" hand on.
 */

// The palette and copy of apps/web/src/pass-export.ts. Kept as constants — and
// checked against the portal's file by test/client-visitor-pass-parity.test.ts —
// so one pass cannot quietly start looking different on the two platforms.
internal const val PASS_INK_HEX = "#14213d"
internal const val PASS_MUTED_HEX = "#68748a"
internal const val PASS_BLUE_HEX = "#1769e0"
internal const val PASS_LINE_HEX = "#dfe6ef"
internal const val PASS_POLICY =
    "Security must scan and review this pass before accepting entry. Device recognition requires a compatible, configured reader."
internal const val PASS_FOOTER = "Powered by sornix.com.ng (WhatsApp: +2348100065868)"
internal const val PASS_EYEBROW = "ESTATE VISITOR PASS"
internal const val PASS_CREDENTIAL_LABEL = "Unique visitor number"
internal const val PASS_GATE_EVERY = "Valid at every gate — entry and exit"
internal const val PASS_PORTAL_NAME = "Sornix EstateOS"
internal const val PASS_SHORT_NAME = "SE"

private const val PASS_WIDTH = 900f
private const val PASS_PAD = 56f

private val PassInk = android.graphics.Color.parseColor(PASS_INK_HEX)
private val PassMuted = android.graphics.Color.parseColor(PASS_MUTED_HEX)
private val PassBlue = android.graphics.Color.parseColor(PASS_BLUE_HEX)
private val PassLine = android.graphics.Color.parseColor(PASS_LINE_HEX)

private val PassDateFormat = DateTimeFormatter.ofPattern("dd MMM yyyy, HH:mm")

/**
 * One pass as the portal renders it: every string the card shows.
 *
 * Built from the create response (`VisitorPassCreated`) or from a pass-list row,
 * both of which name the same fields in slightly different casings — the row is
 * the Worker's snake_case SQL columns, the create response its camelCase JSON.
 */
data class VisitorPassDetails(
    val visitorName: String,
    val host: String,
    val property: String,
    val credential: String,
    val pin: String,
    val fromText: String,
    val untilText: String,
    val purpose: String,
    val remark: String,
    val visitsUsed: Int,
    val visitTimes: Int,
    val gateText: String,
) {
    val visitsText: String get() = "$visitsUsed of $visitTimes visit(s) used"
}

/**
 * What the form knows and the Worker's create response does not: the host and
 * property as they read on the phone, the gate scope and the resolved purpose
 * label. Combined with `VisitorPassCreated` into a [VisitorPassDetails].
 */
data class VisitorPassContext(
    val visitorName: String,
    val host: String,
    val property: String,
    val gateText: String,
    val purpose: String,
    val remark: String,
    val visitTimes: Int,
    val validFrom: String,
    val validUntil: String,
)

/** A proof file the form picked, uploaded just before the pass is created. */
data class ProofUpload(val uri: android.net.Uri, val name: String)

/** The visitor's window as the pass prints it: '12 Oct 2026, 10:00'. */
internal fun passDateText(value: String?): String {
    val raw = value?.trim().orEmpty()
    if (raw.isEmpty()) return "—"
    val instant = runCatching { Instant.parse(raw) }.getOrNull()
    if (instant != null) return PassDateFormat.format(instant.atZone(ZoneId.systemDefault()))
    val local = runCatching { LocalDateTime.parse(raw.replace(' ', 'T')) }.getOrNull()
        ?: runCatching { LocalDateTime.parse(raw) }.getOrNull()
    return if (local != null) PassDateFormat.format(local) else raw
}

/** What the portal's `visitorPurposeLabel` resolves, so both name the purpose alike. */
internal fun passPurposeLabel(purpose: String?, purposeOther: String?): String {
    val id = purpose?.trim()?.lowercase().orEmpty()
    if (id.isEmpty()) return ""
    if (id == "other") return purposeOther?.trim()?.takeIf { it.isNotEmpty() } ?: "Other"
    return VISITOR_PURPOSE_OPTIONS.firstOrNull { it.first == id }?.second ?: id
}

/** The pass's gate line, as the portal's modal prints it. */
internal fun passGateText(gateScope: String?, deviceName: String?): String =
    if (gateScope == "gate") "Gate device: ${deviceName ?: "Selected device"}" else PASS_GATE_EVERY

/** 'A-01 — Palm Avenue' as the portal's pass prints the property. */
internal fun passPropertyText(unitNumber: String?, propertyId: String?, street: String?): String {
    val base = unitNumber?.takeIf { it.isNotBlank() } ?: propertyId?.takeIf { it.isNotBlank() } ?: "Selected property"
    return if (!street.isNullOrBlank()) "$base — $street" else base
}

/** A pass-list row (`GET /api/visitors`) to a rendered pass, keys and all. */
internal fun passDetailsFromRow(row: JsonObject): VisitorPassDetails {
    fun text(vararg keys: String): String? {
        for (key in keys) {
            val element = row.get(key) ?: continue
            if (element.isJsonNull || !element.isJsonPrimitive) continue
            val value = element.asString.trim()
            if (value.isNotEmpty()) return value
        }
        return null
    }

    fun number(vararg keys: String, fallback: Int): Int = text(*keys)?.toIntOrNull() ?: fallback

    return VisitorPassDetails(
        visitorName = text("visitor_name", "visitorName") ?: "Visitor",
        host = text("resident_name", "residentName") ?: "Estate resident",
        property = passPropertyText(text("unit_number"), text("property_id", "propertyId"), text("street")),
        credential = text("credential_number", "credentialNumber") ?: text("pin").orEmpty(),
        pin = text("pin").orEmpty(),
        fromText = passDateText(text("valid_from", "validFrom")),
        untilText = passDateText(text("valid_until", "validUntil")),
        purpose = passPurposeLabel(text("purpose_of_visit", "purposeOfVisit"), text("purpose_of_visit_other", "purposeOfVisitOther")),
        remark = text("remark").orEmpty(),
        visitsUsed = number("visits_used", "visitsUsed", fallback = 0),
        visitTimes = number("visit_times", "visitTimes", fallback = 1),
        gateText = passGateText(text("gate_scope", "gateScope") ?: "both", text("device_name", "deviceName")),
    )
}

/**
 * The just-created pass: the Worker's codes over the form's own words, with the
 * same `created ?? form` preference the portal gives the validity window.
 */
internal fun visitorPassDetails(context: VisitorPassContext, created: VisitorPassCreated): VisitorPassDetails =
    VisitorPassDetails(
        visitorName = context.visitorName,
        host = context.host,
        property = context.property,
        credential = created.credentialNumber?.takeIf { it.isNotBlank() } ?: created.pin,
        pin = created.pin,
        fromText = passDateText(created.validFrom ?: context.validFrom),
        untilText = passDateText(created.validUntil ?: context.validUntil),
        purpose = context.purpose,
        remark = context.remark,
        visitsUsed = 0,
        visitTimes = created.visitTimes ?: context.visitTimes,
        gateText = context.gateText,
    )

private fun passPaint(textSize: Float, weight: Int, color: Int): Paint {
    val typeface = when {
        weight >= 800 -> Typeface.create("sans-serif-black", Typeface.NORMAL)
        weight >= 700 -> Typeface.create("sans-serif", Typeface.BOLD)
        weight >= 500 -> Typeface.create("sans-serif-medium", Typeface.NORMAL)
        else -> Typeface.create("sans-serif", Typeface.NORMAL)
    }
    return Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.textSize = textSize
        this.typeface = typeface
        this.color = color
    }
}

/** Wraps on whitespace the way the portal's `wrapText` does. */
private fun wrapPassText(paint: Paint, text: String, maxWidth: Float): List<String> {
    val lines = mutableListOf<String>()
    var line = ""
    for (word in text.split(Regex("\\s+")).filter { it.isNotEmpty() }) {
        val candidate = if (line.isEmpty()) word else "$line $word"
        if (line.isNotEmpty() && paint.measureText(candidate) > maxWidth) {
            lines.add(line)
            line = word
        } else {
            line = candidate
        }
    }
    if (line.isNotEmpty()) lines.add(line)
    return lines
}

/** Draws a ZXing BitMatrix at 1:1 pixels, run by run. */
private fun drawMatrix(canvas: Canvas, matrix: BitMatrix, left: Float, top: Float, color: Int) {
    val paint = Paint().apply { this.color = color }
    val width = matrix.width
    val height = matrix.height
    var row = 0
    while (row < height) {
        var col = 0
        while (col < width) {
            if (matrix.get(col, row)) {
                var end = col + 1
                while (end < width && matrix.get(end, row)) end++
                canvas.drawRect(left + col, top + row, left + end, top + row + 1, paint)
                col = end
            } else {
                col++
            }
        }
        row++
    }
}

/**
 * Draws the pass and returns where its content ends. Called twice: once on a
 * throwaway canvas to measure the height, once for real — so the layout maths
 * can never disagree with what is drawn.
 */
private fun drawPass(canvas: Canvas, details: VisitorPassDetails, portalName: String, shortName: String): Float {
    canvas.drawColor(android.graphics.Color.WHITE)

    fun text(value: String, x: Float, y: Float, size: Float, weight: Int, color: Int = PassInk, align: Paint.Align = Paint.Align.LEFT) {
        val paint = passPaint(size, weight, color)
        paint.textAlign = align
        canvas.drawText(value, x, y, paint)
    }

    fun centered(value: String, y: Float, size: Float, weight: Int, color: Int = PassInk) =
        text(value, PASS_WIDTH / 2, y, size, weight, color, Paint.Align.CENTER)

    fun panel(x: Float, y: Float, width: Float, height: Float, fill: Int) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = fill }
        canvas.drawRoundRect(RectF(x, y, x + width, y + height), 12f, 12f, paint)
    }

    fun rule(y: Float) {
        val paint = Paint().apply { color = PassLine; strokeWidth = 1f }
        canvas.drawLine(PASS_PAD, y, PASS_WIDTH - PASS_PAD, y, paint)
    }

    val innerWidth = PASS_WIDTH - PASS_PAD * 2
    val policyLines = wrapPassText(passPaint(19f, 400, PassMuted), PASS_POLICY, innerWidth)
    val detailPaint = passPaint(21f, 400, PassInk)
    val detailLines = mutableListOf<String>()
    if (details.purpose.isNotBlank()) detailLines += wrapPassText(detailPaint, "Purpose of visit:  ${details.purpose}", innerWidth)
    if (details.remark.isNotBlank()) detailLines += wrapPassText(detailPaint, "Remark:  ${details.remark}", innerWidth)
    detailLines += wrapPassText(detailPaint, details.visitsText, innerWidth)

    val credential = details.credential.ifBlank { details.pin }
    val hasCode = credential.isNotBlank()
    val qrMatrix: BitMatrix? = if (hasCode) {
        QRCodeWriter().encode(
            credential,
            BarcodeFormat.QR_CODE,
            300,
            300,
            mapOf<EncodeHintType, Any>(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 1),
        )
    } else {
        null
    }
    val barcodeMatrix: BitMatrix? = if (hasCode) {
        Code128Writer().encode(
            credential,
            BarcodeFormat.CODE_128,
            (innerWidth - 120).toInt(),
            96,
            emptyMap<EncodeHintType, Any>(),
        )
    } else {
        null
    }

    var y = PASS_PAD

    // Header: estate mark, pass type and the estate's name.
    val markSize = 74f
    panel(PASS_PAD, y, markSize, markSize, PassBlue)
    text(shortName.ifBlank { PASS_SHORT_NAME }, PASS_PAD + markSize / 2, y + markSize / 2 + 9, 26f, 800, android.graphics.Color.WHITE, Paint.Align.CENTER)
    text(PASS_EYEBROW, PASS_PAD + markSize + 24, y + 32, 15f, 800, PassBlue)
    text(portalName.ifBlank { PASS_PORTAL_NAME }, PASS_PAD + markSize + 24, y + 62, 26f, 700)
    y += 96f + 34f

    // Visitor, host and property.
    text(details.visitorName.ifBlank { "Visitor" }, PASS_PAD, y + 40, 46f, 800)
    y += 62f
    if (details.host.isNotBlank()) {
        text("Host:  ${details.host}", PASS_PAD, y + 26, 23f, 600)
        text("Property:  ${details.property}", PASS_PAD, y + 58, 23f, 600)
        y += 66f
    }
    y += 30f
    rule(y)
    y += 30f

    // QR then Code 128 — the two scanner formats the gate accepts.
    if (qrMatrix != null) {
        drawMatrix(canvas, qrMatrix, (PASS_WIDTH - qrMatrix.width) / 2f, y, PassInk)
    }
    y += 300f + 26f
    if (barcodeMatrix != null) {
        drawMatrix(canvas, barcodeMatrix, (PASS_WIDTH - barcodeMatrix.width) / 2f, y, PassInk)
    }
    y += 96f + 22f

    centered(credential, y + 42, 40f, 800)
    centered(PASS_CREDENTIAL_LABEL, y + 70, 17f, 500, PassMuted)
    y += 78f + 28f

    if (details.pin.isNotBlank()) {
        val pinLabel = "Keypad PIN:  ${details.pin}"
        val pinWidth = maxOf(280f, passPaint(24f, 700, PassInk).measureText(pinLabel) + 56f)
        panel((PASS_WIDTH - pinWidth) / 2, y, pinWidth, 54f, android.graphics.Color.parseColor("#eef4fc"))
        centered(pinLabel, y + 36, 24f, 700)
        y += 62f + 26f
    }

    // Validity window.
    val boxWidth = (innerWidth - 20f) / 2f
    panel(PASS_PAD, y, boxWidth, 88f, android.graphics.Color.parseColor("#f1f5fa"))
    panel(PASS_PAD + boxWidth + 20f, y, boxWidth, 88f, android.graphics.Color.parseColor("#f1f5fa"))
    text("VALID FROM", PASS_PAD + 18f, y + 30, 13f, 800, PassMuted)
    text(details.fromText, PASS_PAD + 18f, y + 62, 20f, 700)
    text("VALID UNTIL", PASS_PAD + boxWidth + 38f, y + 30, 13f, 800, PassMuted)
    text(details.untilText, PASS_PAD + boxWidth + 38f, y + 62, 20f, 700)
    y += 96f + 26f

    // Purpose, remark and the visit count — the portal's pass shows these too.
    for (line in detailLines) {
        text(line, PASS_PAD, y + 22, 21f, 400)
        y += 30f
    }
    y += 18f

    if (details.gateText.isNotBlank()) {
        centered(details.gateText, y + 20, 20f, 700, PassBlue)
        y += 34f
    }

    for (line in policyLines) {
        centered(line, y + 22, 19f, 400, PassMuted)
        y += 29f
    }

    y += 26f
    rule(y)
    centered(PASS_FOOTER, y + 44, 19f, 700, PassMuted)
    return y + 78f
}

/** Renders the pass to a PNG-able bitmap at the portal's 900px width. */
fun renderVisitorPassBitmap(details: VisitorPassDetails, portalName: String = PASS_PORTAL_NAME, shortName: String = PASS_SHORT_NAME): Bitmap {
    val probe = Bitmap.createBitmap(PASS_WIDTH.toInt(), 8, Bitmap.Config.ARGB_8888)
    val bottom = drawPass(Canvas(probe), details, portalName, shortName)
    probe.recycle()
    val bitmap = Bitmap.createBitmap(PASS_WIDTH.toInt(), ceil(bottom + PASS_PAD).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    drawPass(Canvas(bitmap), details, portalName, shortName)
    return bitmap
}

private fun passCacheDir(context: Context): File = File(context.cacheDir, "passes").apply { mkdirs() }

internal fun writePassPng(context: Context, bitmap: Bitmap, credential: String): File {
    val file = File(passCacheDir(context), "visitor-pass-$credential.png")
    file.outputStream().use { stream -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream) }
    return file
}

/** One page of A4 (595×842pt) with the pass fitted inside the portal's 24pt margin. */
internal fun writePassPdf(context: Context, bitmap: Bitmap, credential: String): File {
    val file = File(passCacheDir(context), "visitor-pass-$credential.pdf")
    val document = PdfDocument()
    try {
        val pageWidth = 595
        val pageHeight = 842
        val page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, 1).create())
        val canvas = page.canvas
        val margin = 24f
        val scale = minOf((pageWidth - margin * 2) / bitmap.width, (pageHeight - margin * 2) / bitmap.height)
        canvas.translate((pageWidth - bitmap.width * scale) / 2f, (pageHeight - bitmap.height * scale) / 2f)
        canvas.scale(scale, scale)
        canvas.drawBitmap(bitmap, 0f, 0f, null)
        document.finishPage(page)
        file.outputStream().use { stream -> document.writeTo(stream) }
    } finally {
        document.close()
    }
    return file
}

internal fun shareVisitorPass(context: Context, file: File, mimeType: String, title: String): Boolean {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, title)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    return try {
        context.startActivity(Intent.createChooser(send, "Share visitor pass"))
        true
    } catch (ignored: ActivityNotFoundException) {
        false
    }
}

internal fun printVisitorPass(context: Context, bitmap: Bitmap, credential: String): Boolean = runCatching {
    val helper = PrintHelper(context)
    helper.scaleMode = PrintHelper.SCALE_MODE_FIT
    helper.printBitmap("Visitor pass $credential", bitmap)
}.isSuccess

/**
 * The portal's pass modal, from the phone: the pass itself, the share/print row
 * and the same buttons and words (`apps/web/src/App.tsx`, `VisitorPass`).
 */
@Composable
fun VisitorPassDialog(details: VisitorPassDetails, config: PortalConfigDto?, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val portalName = config?.portalName?.takeIf { it.isNotBlank() } ?: PASS_PORTAL_NAME
    val shortName = config?.portalShortName?.takeIf { it.isNotBlank() } ?: PASS_SHORT_NAME
    var bitmap by remember(details, portalName, shortName) { mutableStateOf<Bitmap?>(null) }
    var status by remember(details) { mutableStateOf("") }

    LaunchedEffect(details, portalName, shortName) {
        bitmap = withContext(Dispatchers.Default) { renderVisitorPassBitmap(details, portalName, shortName) }
    }

    fun prepareAndShare(image: Boolean) {
        val current = bitmap ?: return
        if (details.credential.isBlank()) {
            status = "This pass has no credential to share."
            return
        }
        status = "Preparing the pass file…"
        val credential = details.credential
        scope.launch {
            status = withContext(Dispatchers.Default) {
                runCatching {
                    val file = if (image) writePassPng(context, current, credential) else writePassPdf(context, current, credential)
                    val shared = shareVisitorPass(context, file, if (image) "image/png" else "application/pdf", "Visitor pass $credential")
                    if (shared) "Pass shared." else "Could not open the share sheet on this device."
                }.getOrElse { reason -> reason.message ?: "Could not prepare the pass file" }
            }
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                Modifier
                    .fillMaxWidth(0.96f)
                    .fillMaxHeight(0.92f)
                    .background(Color.White, RoundedCornerShape(16.dp))
                    .padding(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Visitor pass generated",
                        color = EstateNavy,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.ExtraBold,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onDismiss) { Text("✕ Close pass", color = EstateNavy) }
                }
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState()),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    val current = bitmap
                    if (current == null) {
                        Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else {
                        Image(
                            bitmap = current.asImageBitmap(),
                            contentDescription = "Visitor pass for ${details.visitorName}",
                            contentScale = ContentScale.FillWidth,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (status.isNotBlank()) {
                        Text(status, fontSize = 12.sp, color = Color(0xFF6A7790), modifier = Modifier.padding(top = 6.dp))
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { prepareAndShare(image = true) }, enabled = bitmap != null, modifier = Modifier.weight(1f)) {
                        Text("📤 Share image")
                    }
                    Button(onClick = { prepareAndShare(image = false) }, enabled = bitmap != null, modifier = Modifier.weight(1f)) {
                        Text("📄 Share PDF")
                    }
                    Button(
                        onClick = {
                            val current = bitmap ?: return@Button
                            status = if (printVisitorPass(context, current, details.credential)) {
                                ""
                            } else {
                                "Could not open printing on this device."
                            }
                        },
                        enabled = bitmap != null,
                        modifier = Modifier.weight(1f),
                    ) {
                        Text("🖨️ Print")
                    }
                }
                Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                    Text("✕ Done — Close Visitor Pass", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
