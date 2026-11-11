package de.tobiwald.scribitmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Hält die App am Leben, während der Roboter zeichnet:
 * Benachrichtigung, Wake-Lock und WLAN-Lock.
 */
public class JobService extends Service {
    private static final String CHANNEL = "job";
    private static final int NOTIFICATION_ID = 7;
    private static JobService instance;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static void start(Context c, String text) {
        Intent i = new Intent(c, JobService.class).putExtra("text", text);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Exception ignored) {
            // z.B. wenn Android den Start verbietet; die Zeichnung läuft trotzdem weiter
        }
    }

    public static void update(String text) {
        JobService s = instance;
        if (s == null) return;
        NotificationManager nm = (NotificationManager) s.getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, s.build(text));
    }

    public static void stop(Context c) {
        try {
            c.stopService(new Intent(c, JobService.class));
        } catch (Exception ignored) {
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        String text = intent != null ? intent.getStringExtra("text") : null;
        Notification n = build(text == null ? "Zeichnet…" : text + " läuft");
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "scribitmobile:job");
                wakeLock.acquire(8L * 60 * 60 * 1000);
            }
        }
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "scribitmobile:wifi");
                wifiLock.acquire();
            }
        }
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    Notification build(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Zeichenauftrag", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_stat_pen)
                .setContentTitle("Scribit Mobile")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
                .build();
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wakeLock = null;
        wifiLock = null;
        instance = null;
        super.onDestroy();
    }
}
