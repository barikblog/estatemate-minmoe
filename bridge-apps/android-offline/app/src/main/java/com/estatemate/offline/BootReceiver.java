/*
 * Starts the estate server after a reboot when the operator asked for it
 * (the "Start the server when the device boots" checkbox). BOOT_COMPLETED
 * is one of the exemptions that allow launching a foreground service from
 * the background.
 */
package com.estatemate.offline;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        ServerPrefs prefs = new ServerPrefs(context);
        if (!prefs.startOnBoot()) return;
        ServerLog.append("info", "device booted; starting the estate server");
        Intent start = new Intent(context, OfflineService.class);
        start.setAction(OfflineService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(start);
        } else {
            context.startService(start);
        }
    }
}
