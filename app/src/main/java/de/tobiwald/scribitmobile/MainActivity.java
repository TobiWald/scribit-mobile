package de.tobiwald.scribitmobile;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int REQ_FILE = 11;
    private static final int REQ_SAVE = 12;
    private static final int REQ_CAMERA = 13;
    private static final int REQ_NOTIFY = 14;
    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private String pendingSaveText;
    private volatile String sharedFileJson;
    private volatile Network wifiNetwork;
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback netCallback;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        if (Build.VERSION.SDK_INT >= 26) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                ui.post(() -> handlePermission(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                boolean svg = false, img = false;
                String[] accept = params.getAcceptTypes();
                if (accept != null) {
                    for (String a : accept) {
                        if (a == null) continue;
                        if (a.contains("svg")) svg = true;
                        else if (a.startsWith("image")) img = true;
                    }
                }
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(img && !svg ? "image/*" : "*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Datei wählen"), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "ScribitBridge");
        cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        watchWifi();
        web.loadUrl(START_URL);
        handleIntent(getIntent());

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    // Das Scribit-WLAN hat kein Internet. Android schickt Verbindungen dann gern übers Mobilnetz.
    // Deshalb merken wir uns das WLAN und öffnen die Sockets gezielt darüber.
    private void watchWifi() {
        if (cm == null) return;
        if (netCallback != null) {
            try {
                cm.unregisterNetworkCallback(netCallback);
            } catch (Exception ignored) {
            }
        }
        wifiNetwork = null;
        NetworkRequest req = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                wifiNetwork = network;
            }

            @Override
            public void onLost(Network network) {
                if (network.equals(wifiNetwork)) wifiNetwork = null;
            }
        };
        try {
            cm.registerNetworkCallback(req, netCallback);
        } catch (Exception ignored) {
        }
    }

    // Kompletter HTTP-Request in einem Rutsch (Kopf + Inhalt in einem write),
    // weil die Firmware den Inhalt liest, ohne auf weitere TCP-Pakete zu warten.
    private JSONObject doRequest(String method, String host, int port, String path, String body, int timeout) {
        JSONObject out = new JSONObject();
        Socket sock = null;
        try {
            byte[] bodyBytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
            StringBuilder h = new StringBuilder();
            h.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            h.append("Host: ").append(host).append(':').append(port).append("\r\n");
            if ("POST".equals(method)) {
                h.append("Content-Type: text/plain\r\n");
                h.append("Content-Length: ").append(bodyBytes.length).append("\r\n");
            }
            h.append("Connection: close\r\n\r\n");
            byte[] head = h.toString().getBytes(StandardCharsets.US_ASCII);
            byte[] all = new byte[head.length + bodyBytes.length];
            System.arraycopy(head, 0, all, 0, head.length);
            System.arraycopy(bodyBytes, 0, all, head.length, bodyBytes.length);

            Network n = wifiNetwork;
            sock = (n != null) ? n.getSocketFactory().createSocket() : new Socket();
            sock.setTcpNoDelay(true);
            sock.connect(new InetSocketAddress(host, port), Math.min(timeout, 5000));
            sock.setSoTimeout(timeout);
            OutputStream os = sock.getOutputStream();
            os.write(all);
            os.flush();

            InputStream is = sock.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int r;
            try {
                while ((r = is.read(buf)) != -1) bo.write(buf, 0, r);
            } catch (SocketTimeoutException te) {
                if (bo.size() == 0) throw te;
            }
            String resp = new String(bo.toByteArray(), StandardCharsets.UTF_8);
            int status = 0;
            if (resp.startsWith("HTTP/")) {
                int sp = resp.indexOf(' ');
                if (sp > 0 && resp.length() >= sp + 4) {
                    try {
                        status = Integer.parseInt(resp.substring(sp + 1, sp + 4).trim());
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
            int idx = resp.indexOf("\r\n\r\n");
            String bodyOut = idx >= 0 ? resp.substring(idx + 4) : "";
            out.put("status", status);
            out.put("body", bodyOut);
            out.put("via", n != null ? "wifi" : "default");
        } catch (Exception e) {
            try {
                out.put("status", 0);
                out.put("error", e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : ""));
            } catch (Exception ignored) {
            }
        } finally {
            if (sock != null) {
                try {
                    sock.close();
                } catch (IOException ignored) {
                }
            }
        }
        return out;
    }

    private void callJs(final String js) {
        ui.post(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    private void handlePermission(PermissionRequest req) {
        boolean cam = false;
        for (String r : req.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) cam = true;
        }
        if (!cam) {
            req.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            req.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            if (pendingPermission != null) pendingPermission.deny();
            pendingPermission = req;
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA && pendingPermission != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                pendingPermission.deny();
                Toast.makeText(this, "Ohne Kamera-Erlaubnis geht nur „Foto laden“.", Toast.LENGTH_LONG).show();
            }
            pendingPermission = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
        } else if (requestCode == REQ_SAVE) {
            final String text = pendingSaveText;
            pendingSaveText = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && text != null) {
                final Uri uri = data.getData();
                pool.execute(() -> {
                    boolean ok = false;
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os != null) {
                            os.write(text.getBytes(StandardCharsets.UTF_8));
                            ok = true;
                        }
                    } catch (Exception ignored) {
                    }
                    final boolean saved = ok;
                    ui.post(() -> Toast.makeText(this, saved ? "Gespeichert" : "Speichern fehlgeschlagen", Toast.LENGTH_SHORT).show());
                });
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @SuppressWarnings("deprecation")
    private void handleIntent(Intent it) {
        if (it == null || it.getAction() == null) return;
        Uri u = null;
        if (Intent.ACTION_SEND.equals(it.getAction())) {
            Object extra = it.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) u = (Uri) extra;
        } else if (Intent.ACTION_VIEW.equals(it.getAction())) {
            u = it.getData();
        }
        if (u == null) return;
        final Uri uri = u;
        final String type = it.getType() != null ? it.getType() : getContentResolver().getType(uri);
        pool.execute(() -> {
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) return;
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int r;
                while ((r = in.read(buf)) != -1) {
                    bo.write(buf, 0, r);
                    if (bo.size() > 25 * 1024 * 1024) throw new IOException("Datei zu groß");
                }
                byte[] data = bo.toByteArray();
                String name = queryName(uri);
                JSONObject o = new JSONObject();
                o.put("name", name == null ? "Geteilt" : name);
                boolean svg = (type != null && type.contains("svg")) || (name != null && name.toLowerCase().endsWith(".svg"));
                if (svg) {
                    o.put("kind", "svg");
                    o.put("text", new String(data, StandardCharsets.UTF_8));
                } else {
                    o.put("kind", "image");
                    o.put("dataUrl", "data:" + (type != null ? type : "image/jpeg") + ";base64," + Base64.encodeToString(data, Base64.NO_WRAP));
                }
                sharedFileJson = o.toString();
                callJs("window.onSharedFile && window.onSharedFile()");
            } catch (Exception e) {
                ui.post(() -> Toast.makeText(this, "Datei konnte nicht gelesen werden", Toast.LENGTH_LONG).show());
            }
        });
    }

    private String queryName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        }
        return uri.getLastPathSegment();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.onAndroidBack && window.onAndroidBack()) ? '1' : '0'", value -> {
            if (!"\"1\"".equals(value)) finish();
        });
    }

    @Override
    protected void onDestroy() {
        if (cm != null && netCallback != null) {
            try {
                cm.unregisterNetworkCallback(netCallback);
            } catch (Exception ignored) {
            }
        }
        JobService.stop(this);
        if (web != null) web.destroy();
        pool.shutdownNow();
        super.onDestroy();
    }

    /** Wird aus JavaScript als window.ScribitBridge aufgerufen. */
    public class Bridge {
        @JavascriptInterface
        public void request(final String id, final String method, final String host, final int port,
                            final String path, final String body, final int timeout) {
            pool.execute(() -> {
                JSONObject r = doRequest(method, host, port, path, body, timeout);
                callJs("window.__scribitCb(" + JSONObject.quote(id) + "," + JSONObject.quote(r.toString()) + ")");
            });
        }

        // Timer über Android statt JavaScript: läuft auch weiter, wenn die Seite gedrosselt wird
        @JavascriptInterface
        public boolean sleep(final String id, final int ms) {
            ui.postDelayed(() -> {
                if (web != null) web.evaluateJavascript("window.__scribitCb(" + JSONObject.quote(id) + ",'{}')", null);
            }, Math.max(0, ms));
            return true;
        }

        @JavascriptInterface
        public boolean keepScreenOn(final boolean on) {
            ui.post(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
            return true;
        }

        @JavascriptInterface
        public boolean openWifiSettings() {
            ui.post(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS));
                } catch (Exception ignored) {
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean rebindWifi() {
            ui.post(MainActivity.this::watchWifi);
            return true;
        }

        @JavascriptInterface
        public String wifiState() {
            return wifiNetwork != null ? "wifi" : "none";
        }

        @JavascriptInterface
        public String appVersion() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public boolean saveFile(final String name, final String mime, final String content) {
            ui.post(() -> {
                pendingSaveText = content;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "text/plain" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (Exception e) {
                    pendingSaveText = null;
                    Toast.makeText(MainActivity.this, "Speichern nicht möglich", Toast.LENGTH_LONG).show();
                }
            });
            return true;
        }

        @JavascriptInterface
        public String takeSharedFile() {
            String s = sharedFileJson;
            sharedFileJson = null;
            return s == null ? "" : s;
        }

        @JavascriptInterface
        public boolean jobStarted(final String text) {
            ui.post(() -> JobService.start(MainActivity.this, text));
            return true;
        }

        @JavascriptInterface
        public boolean jobProgress(final String text) {
            ui.post(() -> JobService.update(text));
            return true;
        }

        @JavascriptInterface
        public boolean notifyUser(final String text) {
            ui.post(() -> JobService.update(text));
            return true;
        }

        @JavascriptInterface
        public boolean jobStopped(final String text) {
            ui.post(() -> JobService.stop(MainActivity.this));
            return true;
        }
    }
}
