/*
 * Restarts the bridge after a reboot when the operator asked for it. A phone or
 * tablet on a gate is unattended; a power cut must not leave the estate without
 * card updates or gate events until someone opens the app.
 */
package com.estatemate.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        if (!BridgePrefs.autoStart(context)) {
            BridgeLog.append("info", "auto-start disabled; not starting after boot");
            return;
        }
        try {
            Intent start = new Intent(context, BridgeService.class).setAction(BridgeService.ACTION_START);
            if (android.os.Build.VERSION.SDK_INT >= 26) context.startForegroundService(start);
            else context.startService(start);
            BridgeLog.append("info", "bridge restarted after boot");
        } catch (RuntimeException error) {
            BridgeLog.append("warn", "could not start after boot: " + error.getMessage());
        }
    }
}
