package com.appartners.focuslock;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.Toast;

/**
 * Device Admin Receiver - required for screen lock functionality.
 * Register in AndroidManifest.xml with BIND_DEVICE_ADMIN permission.
 */
public class DeviceAdminReceiver extends DeviceAdminReceiver {

    private static final String TAG = "APFocusLockAdmin";

    @Override
    public void onEnabled(Context context, Intent intent) {
        Log.d(TAG, "Device Admin: Enabled - Focus Lock screen lock feature available");
        Toast.makeText(context, "AP FocusLock: Screen lock feature active!", Toast.LENGTH_SHORT).show();
    }

    @Override
    public CharSequence onDisableRequested(Context context, Intent intent) {
        return "AP FocusLock ko disable karne se Focus Lock feature kaam nahi karega.";
    }

    @Override
    public void onDisabled(Context context, Intent intent) {
        Log.d(TAG, "Device Admin: Disabled");
    }

    @Override
    public void onPasswordFailed(Context context, Intent intent) {
        // Wrong unlock attempt - notify the app
        Intent broadcastIntent = new Intent("com.appartners.focuslock.WRONG_PASSWORD");
        context.sendBroadcast(broadcastIntent);
        Log.d(TAG, "Wrong password attempt detected");
    }

    @Override
    public void onPasswordSucceeded(Context context, Intent intent) {
        // Successful unlock - reset attempt counter
        Intent broadcastIntent = new Intent("com.appartners.focuslock.PASSWORD_SUCCESS");
        context.sendBroadcast(broadcastIntent);
    }
}
