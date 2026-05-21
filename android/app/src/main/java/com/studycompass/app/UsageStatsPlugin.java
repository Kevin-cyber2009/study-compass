package com.studycompass.app;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@CapacitorPlugin(name = "UsageStats")
public class UsageStatsPlugin extends Plugin {
    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasUsageAccess());
        call.resolve(result);
    }

    @PluginMethod
    public void openUsageSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void getUsageStats(PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("Usage access has not been granted.");
            return;
        }

        int days = Math.max(1, Math.min(30, call.getInt("days", 1)));
        Calendar calendar = Calendar.getInstance();
        long end = calendar.getTimeInMillis();
        calendar.add(Calendar.DAY_OF_YEAR, -days);
        long start = calendar.getTimeInMillis();

        UsageStatsManager manager = (UsageStatsManager) getContext().getSystemService(Context.USAGE_STATS_SERVICE);
        Map<String, Long> usageByPackage = collectForegroundUsage(manager, start, end);
        Map<String, Long> lastUsedByPackage = collectLastUsed(manager, start, end);

        if (usageByPackage.isEmpty()) {
            usageByPackage = collectDailyUsageFallback(manager, start, end);
        }

        List<Map.Entry<String, Long>> sorted = new ArrayList<>(usageByPackage.entrySet());
        sorted.sort((left, right) -> Long.compare(right.getValue(), left.getValue()));

        JSArray apps = new JSArray();
        PackageManager packageManager = getContext().getPackageManager();
        int limit = Math.min(sorted.size(), 50);

        for (int index = 0; index < limit; index++) {
            Map.Entry<String, Long> entry = sorted.get(index);
            String packageName = entry.getKey();
            long totalMs = entry.getValue();
            long minutes = Math.max(1, Math.round(totalMs / 60000.0));

            JSObject app = new JSObject();
            app.put("packageName", packageName);
            app.put("name", getAppLabel(packageManager, packageName));
            app.put("minutes", minutes);
            app.put("totalMs", totalMs);
            app.put("lastUsed", lastUsedByPackage.getOrDefault(packageName, 0L));
            app.put("type", classifyPackage(packageName));
            app.put("effect", classifyEffect(packageName));
            apps.put(app);
        }

        JSObject result = new JSObject();
        result.put("granted", true);
        result.put("apps", apps);
        result.put("from", start);
        result.put("to", end);
        result.put("totalApps", sorted.size());
        call.resolve(result);
    }

    private Map<String, Long> collectForegroundUsage(UsageStatsManager manager, long start, long end) {
        Map<String, Long> usageByPackage = new HashMap<>();
        Map<String, Long> foregroundStartByPackage = new HashMap<>();
        UsageEvents events = manager.queryEvents(start, end);
        UsageEvents.Event event = new UsageEvents.Event();

        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            String packageName = event.getPackageName();
            if (shouldIgnorePackage(packageName)) continue;

            if (isForegroundEvent(event.getEventType())) {
                foregroundStartByPackage.put(packageName, Math.max(start, event.getTimeStamp()));
            } else if (isBackgroundEvent(event.getEventType())) {
                Long foregroundStart = foregroundStartByPackage.remove(packageName);
                if (foregroundStart == null) continue;

                long duration = Math.max(0L, Math.min(end, event.getTimeStamp()) - foregroundStart);
                if (duration > 0L) {
                    usageByPackage.put(packageName, usageByPackage.getOrDefault(packageName, 0L) + duration);
                }
            }
        }

        for (Map.Entry<String, Long> entry : foregroundStartByPackage.entrySet()) {
            long duration = Math.max(0L, end - entry.getValue());
            if (duration > 0L) {
                usageByPackage.put(entry.getKey(), usageByPackage.getOrDefault(entry.getKey(), 0L) + duration);
            }
        }

        return usageByPackage;
    }

    private Map<String, Long> collectDailyUsageFallback(UsageStatsManager manager, long start, long end) {
        List<UsageStats> stats = manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end);
        Map<String, Long> usageByPackage = new HashMap<>();

        for (UsageStats item : stats) {
            long foregroundMs = item.getTotalTimeInForeground();
            String packageName = item.getPackageName();
            if (foregroundMs <= 0 || shouldIgnorePackage(packageName)) continue;
            usageByPackage.put(packageName, usageByPackage.getOrDefault(packageName, 0L) + foregroundMs);
        }

        return usageByPackage;
    }

    private Map<String, Long> collectLastUsed(UsageStatsManager manager, long start, long end) {
        Map<String, Long> lastUsedByPackage = new HashMap<>();
        UsageEvents events = manager.queryEvents(start, end);
        UsageEvents.Event event = new UsageEvents.Event();

        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            String packageName = event.getPackageName();
            if (shouldIgnorePackage(packageName)) continue;
            if (isForegroundEvent(event.getEventType())) {
                lastUsedByPackage.put(packageName, event.getTimeStamp());
            }
        }

        return lastUsedByPackage;
    }

    private boolean isForegroundEvent(int eventType) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && eventType == UsageEvents.Event.ACTIVITY_RESUMED) {
            return true;
        }
        return eventType == UsageEvents.Event.MOVE_TO_FOREGROUND;
    }

    private boolean isBackgroundEvent(int eventType) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && eventType == UsageEvents.Event.ACTIVITY_PAUSED) {
            return true;
        }
        return eventType == UsageEvents.Event.MOVE_TO_BACKGROUND;
    }

    private boolean shouldIgnorePackage(String packageName) {
        return packageName == null || packageName.equals(getContext().getPackageName()) || packageName.startsWith("com.android.systemui");
    }

    private boolean hasUsageAccess() {
        try {
            AppOpsManager appOps = (AppOpsManager) getContext().getSystemService(Context.APP_OPS_SERVICE);
            int mode;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                mode = appOps.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    android.os.Process.myUid(),
                    getContext().getPackageName()
                );
            } else {
                mode = appOps.checkOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    android.os.Process.myUid(),
                    getContext().getPackageName()
                );
            }

            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private String getAppLabel(PackageManager packageManager, String packageName) {
        try {
            ApplicationInfo info = packageManager.getApplicationInfo(packageName, 0);
            return packageManager.getApplicationLabel(info).toString();
        } catch (PackageManager.NameNotFoundException error) {
            return packageName;
        }
    }

    private String classifyPackage(String packageName) {
        String lower = packageName.toLowerCase();
        if (lower.contains("youtube") || lower.contains("tiktok") || lower.contains("instagram") || lower.contains("facebook")) {
            return "Giải trí";
        }
        if (lower.contains("docs") || lower.contains("classroom") || lower.contains("quizlet") || lower.contains("notion")) {
            return "Học tập";
        }
        return "Khác";
    }

    private String classifyEffect(String packageName) {
        String lower = packageName.toLowerCase();
        if (lower.contains("youtube") || lower.contains("tiktok") || lower.contains("instagram") || lower.contains("facebook")) {
            return "Cần kiểm soát";
        }
        if (lower.contains("docs") || lower.contains("classroom") || lower.contains("quizlet") || lower.contains("notion")) {
            return "Hỗ trợ học";
        }
        return "Theo dõi thêm";
    }
}
