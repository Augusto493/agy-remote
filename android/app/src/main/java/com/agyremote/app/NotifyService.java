package com.agyremote.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Serviço em primeiro plano: mantém um stream aberto com o servidor do PC (/api/events)
 * e mostra uma notificação quando o agy termina uma tarefa ou fica esperando liberação.
 */
public class NotifyService extends Service {
    static final String CH_STATUS = "status";
    static final String CH_ALERTS = "alertas";
    private static final int ID_STATUS = 1;
    private volatile boolean running = false;
    private Thread worker;
    private HttpURLConnection current;

    static void start(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences("agy", MODE_PRIVATE);
        if (p.getString("server_url", "").isEmpty() || p.getString("token", "").isEmpty()) return;
        if (!p.getBoolean("notify", true)) return;
        Intent i = new Intent(ctx, NotifyService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
        } catch (Exception ignored) {}
    }

    static void stop(Context ctx) { ctx.stopService(new Intent(ctx, NotifyService.class)); }

    static void createChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel st = new NotificationChannel(CH_STATUS, "Conexão com o PC", NotificationManager.IMPORTANCE_MIN);
        st.setDescription("Fica visível enquanto o app escuta o PC");
        st.setShowBadge(false);
        NotificationChannel al = new NotificationChannel(CH_ALERTS, "Tarefas do agy", NotificationManager.IMPORTANCE_HIGH);
        al.setDescription("Quando o agy termina ou precisa de você");
        nm.createNotificationChannel(st);
        nm.createNotificationChannel(al);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = statusNotification("Conectando ao PC…");
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ID_STATUS, n);
        if (!running) {
            running = true;
            worker = new Thread(this::loop, "agy-events");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        try { if (current != null) current.disconnect(); } catch (Exception ignored) {}
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private PendingIntent openApp(String convId, int req) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (convId != null) i.putExtra("convId", convId);
        return PendingIntent.getActivity(this, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification statusNotification(String text) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_STATUS) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Agy Remote")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(openApp(null, 0))
                .build();
    }

    private void updateStatus(String text) {
        getSystemService(NotificationManager.class).notify(ID_STATUS, statusNotification(text));
    }

    private void alert(JSONObject ev) {
        if (MainActivity.visible) return; // com o app aberto, a própria tela já mostra
        String type = ev.optString("type");
        String convId = ev.optString("convId", null);
        String title = ev.optString("title", "Conversa");
        String body;
        String head;
        if ("blocked".equals(type)) {
            JSONArray d = ev.optJSONArray("denied");
            String what = d != null && d.length() > 0 ? d.optString(0) : "um comando";
            head = "⚠️ Precisa de você: " + title;
            body = "O agy quis usar " + what + " e está esperando você liberar.";
        } else {
            head = "✅ Pronto: " + title;
            body = ev.optString("text", "");
            if (body.isEmpty()) body = "SUCCESS".equals(ev.optString("status")) ? "Tarefa concluída." : "Terminou: " + ev.optString("status");
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_ALERTS) : new Notification.Builder(this);
        Notification n = b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(head)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(openApp(convId, convId == null ? 1 : convId.hashCode()))
                .build();
        getSystemService(NotificationManager.class).notify(convId == null ? 2 : convId.hashCode(), n);
    }

    private void loop() {
        long backoff = 3000;
        while (running) {
            SharedPreferences p = getSharedPreferences("agy", MODE_PRIVATE);
            String server = p.getString("server_url", ""), token = p.getString("token", "");
            if (server.isEmpty() || token.isEmpty()) { stopSelf(); return; }
            try {
                URL u = new URL(server + "/api/events");
                HttpURLConnection c = (HttpURLConnection) u.openConnection();
                current = c;
                c.setRequestProperty("x-agy-token", token);
                c.setConnectTimeout(10000);
                c.setReadTimeout(70000); // o servidor manda ping a cada 25 s
                int code = c.getResponseCode();
                if (code == 401) { updateStatus("Pareamento expirado — abra o app"); Thread.sleep(60000); continue; }
                if (code != 200) throw new Exception("HTTP " + code);
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while (running && (line = r.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;
                    JSONObject ev = new JSONObject(line);
                    String type = ev.optString("type");
                    if ("hello".equals(type)) { updateStatus("Conectado ao PC " + ev.optString("host")); backoff = 3000; }
                    else if ("done".equals(type) || "blocked".equals(type)) alert(ev);
                }
                c.disconnect();
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                if (!running) return;
                updateStatus("Sem conexão com o PC — tentando de novo");
            }
            try { Thread.sleep(backoff); } catch (InterruptedException e) { return; }
            backoff = Math.min(backoff * 2, 60000);
        }
    }
}
