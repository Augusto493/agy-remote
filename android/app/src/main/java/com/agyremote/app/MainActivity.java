package com.agyremote.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

/**
 * Casca Android do Agy Remote: abre a interface servida pelo PC (server.js) num WebView.
 * Extras nativos: gravação de voz (o WebView não libera microfone em http da rede local)
 * e notificações (serviço que escuta o PC mesmo com o app fechado).
 */
public class MainActivity extends Activity {
    private static final String PREFS = "agy";
    private static final String KEY_URL = "server_url";
    private static final int REQ_MIC = 10, REQ_NOTIF = 11;
    static volatile boolean visible = false;

    private WebView web;
    private SharedPreferences prefs;
    private MediaRecorder recorder;
    private File recFile;
    private boolean askedNotif = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        NotifyService.createChannels(this);
        getWindow().setStatusBarColor(Color.parseColor("#000000"));
        getWindow().setNavigationBarColor(Color.parseColor("#0D0D0D"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#000000"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " AgyRemoteApp/1.1");
        web.addJavascriptInterface(new Bridge(), "AgyHost");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (isTrusted(u)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            // shouldOverrideUrlLoading não cobre toda navegação (ex.: POST); barra o resto aqui
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (!url.equals("about:blank") && !isTrusted(Uri.parse(url))) {
                    view.stopLoading();
                    showSetup("Endereço bloqueado: não é o servidor configurado.");
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    String msg = err.getDescription() == null ? "erro" : err.getDescription().toString();
                    showSetup("Não consegui falar com o PC (" + msg + "). Confira se o Agy Remote está aberto no PC e se o celular está na mesma rede ou no Tailscale.");
                }
            }
        });
        setContentView(web);

        String url = prefs.getString(KEY_URL, "");
        String conv = getIntent().getStringExtra("convId");
        String h = url.isEmpty() ? null : Uri.parse(url).getHost();
        if (url.isEmpty() || h == null || h.isEmpty() || h.contains("..")) showSetup("");
        else web.loadUrl(conv != null ? url + "/#c=" + conv : url);
        NotifyService.start(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String conv = intent.getStringExtra("convId");
        if (conv != null) web.evaluateJavascript("window.__agyOpen && window.__agyOpen(" + jsStr(conv) + ")", null);
    }

    @Override protected void onResume() { super.onResume(); visible = true; }
    @Override protected void onPause() { super.onPause(); visible = false; }

    private static String jsStr(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    /** Só as páginas do próprio app e do servidor configurado (esquema, host e porta idênticos). */
    private boolean isTrusted(Uri u) {
        if ("file".equals(u.getScheme()))
            return u.toString().startsWith("file:///android_asset/") && !u.getPathSegments().contains("..");
        String server = prefs.getString(KEY_URL, "");
        if (server.isEmpty()) return false;
        Uri s = Uri.parse(server);
        String scheme = u.getScheme(), host = u.getHost();
        return scheme != null && (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))
                && scheme.equalsIgnoreCase(s.getScheme())
                && host != null && host.equalsIgnoreCase(s.getHost())
                && u.getEncodedUserInfo() == null
                && effectivePort(u) == effectivePort(s);
    }

    private static int effectivePort(Uri u) {
        if (u.getPort() != -1) return u.getPort();
        return "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }

    private void showSetup(String error) {
        String current = prefs.getString(KEY_URL, "");
        web.loadUrl("file:///android_asset/setup.html?u=" + Uri.encode(current) + "&e=" + Uri.encode(error));
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private boolean hasPerm(String p) {
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean notifAllowed() {
        return Build.VERSION.SDK_INT < 33 || hasPerm(Manifest.permission.POST_NOTIFICATIONS);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code == REQ_NOTIF) NotifyService.start(this);
    }

    // ---------- gravação ----------
    private synchronized boolean startRec() {
        if (!hasPerm(Manifest.permission.RECORD_AUDIO)) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return false;
        }
        try {
            recFile = new File(getCacheDir(), "fala.m4a");
            recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioChannels(1);
            recorder.setAudioSamplingRate(16000);
            recorder.setAudioEncodingBitRate(48000);
            recorder.setOutputFile(recFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            return true;
        } catch (Exception e) {
            releaseRec();
            return false;
        }
    }

    private synchronized void releaseRec() {
        if (recorder != null) { try { recorder.release(); } catch (Exception ignored) {} recorder = null; }
    }

    private synchronized void stopRec(boolean deliver) {
        boolean ok = false;
        if (recorder != null) {
            try { recorder.stop(); ok = true; } catch (Exception ignored) {}
            releaseRec();
        }
        if (!deliver) return;
        String b64 = "";
        if (ok && recFile != null && recFile.exists()) {
            try (FileInputStream in = new FileInputStream(recFile)) {
                byte[] buf = new byte[(int) recFile.length()];
                int off = 0, n;
                while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
                b64 = Base64.encodeToString(buf, Base64.NO_WRAP);
            } catch (IOException ignored) {}
            recFile.delete();
        }
        final String js = "window.__agyAudio && window.__agyAudio(" + jsStr(b64) + ",'m4a')";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    /** Ponte JS → app. */
    private class Bridge {
        @JavascriptInterface
        public void saveServer(String url) {
            String clean = url.trim();
            if (!clean.startsWith("http")) clean = "http://" + clean;
            while (clean.endsWith("/")) clean = clean.substring(0, clean.length() - 1);
            Uri u = Uri.parse(clean);
            String host = u.getHost();
            if (host == null || host.isEmpty() || host.contains("..") || host.startsWith(".") || host.endsWith(".")
                    || !host.matches("[A-Za-z0-9.\\-]+")) {
                final String bad = clean;
                runOnUiThread(() -> web.loadUrl("file:///android_asset/setup.html?u=" + Uri.encode(bad.replaceFirst("^https?://", ""))
                        + "&e=" + Uri.encode("Endereço inválido. Use o formato 192.168.0.10:8790")));
                return;
            }
            final String target = clean;
            prefs.edit().putString(KEY_URL, target).apply();
            runOnUiThread(() -> { web.clearHistory(); web.loadUrl(target); });
        }

        @JavascriptInterface
        public void openSetup() { runOnUiThread(() -> showSetup("")); }

        /** A interface manda o token depois de parear; o serviço de notificações usa ele. */
        @JavascriptInterface
        public void setAuth(String token) {
            if (token == null || token.isEmpty()) return;
            boolean changed = !token.equals(prefs.getString("token", ""));
            prefs.edit().putString("token", token).apply();
            runOnUiThread(() -> {
                if (!notifAllowed() && !askedNotif && Build.VERSION.SDK_INT >= 33) {
                    askedNotif = true;
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
                } else if (changed) {
                    NotifyService.stop(MainActivity.this);
                    NotifyService.start(MainActivity.this);
                } else NotifyService.start(MainActivity.this);
            });
        }

        @JavascriptInterface
        public boolean notificationsEnabled() { return notifAllowed() && prefs.getBoolean("notify", true); }

        @JavascriptInterface
        public void requestNotifications() {
            prefs.edit().putBoolean("notify", true).apply();
            runOnUiThread(() -> {
                if (!notifAllowed() && Build.VERSION.SDK_INT >= 33)
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
                else NotifyService.start(MainActivity.this);
            });
        }

        @JavascriptInterface
        public boolean startRecording() { return startRec(); }

        @JavascriptInterface
        public void stopRecording() { new Thread(() -> stopRec(true)).start(); }

        @JavascriptInterface
        public void cancelRecording() { new Thread(() -> stopRec(false)).start(); }

        @JavascriptInterface
        public int recordingLevel() {
            try { return recorder == null ? 0 : Math.min(100, recorder.getMaxAmplitude() / 120); } catch (Exception e) { return 0; }
        }
    }
}
