package com.movement.squat;

import android.app.Activity;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WorkoutScreen")
public class WorkoutScreenPlugin extends Plugin {
    @PluginMethod
    public void setEnabled(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is unavailable");
            return;
        }
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        activity.runOnUiThread(() -> {
            if (enabled) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }
}
