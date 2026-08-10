package com.appartners.focuslock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * Listens for wrong password events from DeviceAdminReceiver.
 * Tracks attempt count and triggers intruder capture when threshold is reached.
 */
public class IntruderBroadcastReceiver extends BroadcastReceiver {

    private static final String TAG = "IntruderReceiver";
    private static final String PREFS = "ap_focuslock_prefs";
    private static final String KEY_ATTEMPTS = "wrong_attempts";
    private static final String KEY_MAX_ATTEMPTS = "max_attempts";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        if ("com.appartners.focuslock.WRONG_PASSWORD".equals(action)) {
            int attempts = prefs.getInt(KEY_ATTEMPTS, 0) + 1;
            int maxAttempts = prefs.getInt(KEY_MAX_ATTEMPTS, 3);
            prefs.edit().putInt(KEY_ATTEMPTS, attempts).apply();

            Log.d(TAG, "Wrong attempt #" + attempts + " / max: " + maxAttempts);

            if (attempts >= maxAttempts) {
                // Trigger camera capture via service
                Intent serviceIntent = new Intent(context, IntruderCaptureService.class);
                serviceIntent.putExtra("attempt_count", attempts);
                context.startService(serviceIntent);
                // Reset counter
                prefs.edit().putInt(KEY_ATTEMPTS, 0).apply();
            }
        } else if ("com.appartners.focuslock.PASSWORD_SUCCESS".equals(action)) {
            // Reset attempts on successful unlock
            prefs.edit().putInt(KEY_ATTEMPTS, 0).apply();
        }
    }
}
