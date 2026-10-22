package com.movement.squat;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(WorkoutScreenPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
