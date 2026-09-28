/*
 * The estate server's JavaScript runtime: a hidden WebView.
 *
 * Android has no Node.js, but its WebView is a complete Chromium: ES2021,
 * Request/Response, WebCrypto (PBKDF2, HMAC, AES-GCM — everything the
 * Worker's security layer uses) and fetch. The bundle built by
 * scripts/bundle-offline-server.mjs — the repository's actual Worker
 * (src/index.ts) plus the adapter — runs inside it, and this class is the
 * bridge in both directions:
 *
 *   Java → JS : evaluateJavascript("EstateMateOffline.dispatch(id, json)")
 *               (requests, queue drains, cron ticks)
 *   JS → Java : the @JavascriptInterface Native object (database, files,
 *               broadcasts, responses)
 *
 * The page is served from APK assets at https://localhost/ through
 * shouldInterceptRequest: no network is involved, and an https origin on
 * localhost is a secure context, which is what makes crypto.subtle available.
 *
 * WebView timers are throttled when the app is backgrounded, so nothing in
 * the engine schedules work with setTimeout: the queue drain and the hourly
 * cron are driven by Java timers through this class instead.
 */
package com.estatemate.offline;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public final class JsEngine {
    public static final long DISPATCH_TIMEOUT_MS = 60_000;

    private static final class Pending {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile int status;
        volatile String headersJson = "[]";
        volatile byte[] body = new byte[0];
        volatile boolean answered;
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ConcurrentHashMap<Long, Pending> pending = new ConcurrentHashMap<Long, Pending>();
    private final AtomicLong dispatchIds = new AtomicLong(1);
    private volatile WebView webView;
    private volatile CountDownLatch readyLatch = new CountDownLatch(1);
    private volatile boolean started;
    private volatile boolean destroyed;

    public JsEngine(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Installs the Native bridge object before the bundle loads. */
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    public void start(ServerPrefs prefs, Db db, LiveFeedHub hub) {
        if (started) return;
        started = true;
        final NativeBridge nativeBridge = new NativeBridge(prefs, db, hub, this, context.getFilesDir());
        main.post(new Runnable() {
            public void run() {
                if (destroyed) return;
                webView = createWebView(nativeBridge);
                webView.loadUrl("https://localhost/");
                ServerLog.append("info", "engine WebView loading");
            }
        });
    }

    private WebView createWebView(final NativeBridge nativeBridge) {
        WebView view = new WebView(context);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setDomStorageEnabled(false);
        view.addJavascriptInterface(nativeBridge, "Native");
        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, android.webkit.WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("https://localhost/server-bundle.js")) {
                    return assetResponse("server/server-bundle.js", "application/javascript; charset=utf-8");
                }
                if (url.equals("https://localhost/") || url.startsWith("https://localhost/index.html")) {
                    return assetResponse("server/boot.html", "text/html; charset=utf-8");
                }
                return notFound();
            }
        });
        view.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                ServerLog.append("error", "engine renderer died; restarting the WebView");
                main.post(new Runnable() {
                    public void run() {
                        recreate(nativeBridge);
                    }
                });
                return true;
            }
        });
        return view;
    }

    private void recreate(NativeBridge nativeBridge) {
        try {
            if (webView != null) webView.destroy();
        } catch (RuntimeException ignored) {
            /* already gone */
        }
        readyLatch = new CountDownLatch(1);
        webView = createWebView(nativeBridge);
        webView.loadUrl("https://localhost/");
    }

    private WebResourceResponse assetResponse(String assetPath, String mimeType) {
        try {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            java.io.InputStream input = context.getAssets().open(assetPath);
            byte[] chunk = new byte[16384];
            int read;
            while ((read = input.read(chunk)) > 0) buffer.write(chunk, 0, read);
            input.close();
            return new WebResourceResponse(mimeType, "utf-8", new ByteArrayInputStream(buffer.toByteArray()));
        } catch (Exception error) {
            ServerLog.append("error", "missing engine asset " + assetPath + ": " + error);
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new java.util.HashMap<String, String>(),
                new ByteArrayInputStream("not found".getBytes(StandardCharsets.UTF_8)));
    }

    public boolean awaitReady(long timeoutMs) {
        try {
            return readyLatch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public boolean isReady() {
        return readyLatch.getCount() == 0;
    }

    void markReady(String version) {
        ServerLog.append("info", "engine ready (adapter " + version + ")");
        readyLatch.countDown();
    }

    void complete(long id, int status, String headersJson, String bodyB64) {
        Pending entry = pending.remove(id);
        if (entry == null) return;
        entry.status = status;
        entry.headersJson = headersJson == null ? "[]" : headersJson;
        if (bodyB64 != null && !bodyB64.isEmpty()) {
            try {
                entry.body = Base64.getDecoder().decode(bodyB64);
            } catch (IllegalArgumentException error) {
                ServerLog.append("warn", "response " + id + " had a bad body encoding");
                entry.body = new byte[0];
            }
        }
        entry.answered = true;
        entry.latch.countDown();
    }

    /** Sends one HTTP request through the Worker; blocking with a timeout. */
    public WebServer.Response dispatch(WebServer.Request request) {
        if (!isReady()) {
            return WebServer.Response.json(503, "{\"error\":\"The estate engine is still starting; retry in a moment\"}");
        }
        final long id = dispatchIds.getAndIncrement();
        Pending entry = new Pending();
        pending.put(id, entry);
        String payload;
        try {
            JSONObject json = new JSONObject();
            json.put("method", request.method);
            json.put("url", request.url());
            JSONArray headers = new JSONArray();
            for (String[] header : request.headers) {
                JSONArray pair = new JSONArray();
                pair.put(header[0]);
                pair.put(header[1]);
                headers.put(pair);
            }
            json.put("headers", headers);
            json.put("bodyB64", Base64.getEncoder().encodeToString(request.body));
            payload = json.toString();
        } catch (Exception error) {
            pending.remove(id);
            return WebServer.Response.json(500, "{\"error\":\"Could not encode the request\"}");
        }
        final String call = ("EstateMateOffline.dispatch(" + id + "," + payload + ");")
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029");
        main.post(new Runnable() {
            public void run() {
                WebView view = webView;
                if (view != null) view.evaluateJavascript(call, null);
            }
        });
        try {
            if (!entry.latch.await(DISPATCH_TIMEOUT_MS, TimeUnit.MILLISECONDS) || !entry.answered) {
                pending.remove(id);
                return WebServer.Response.json(503, "{\"error\":\"The estate engine did not answer in time\"}");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            pending.remove(id);
            return WebServer.Response.json(503, "{\"error\":\"Interrupted while the engine was working\"}");
        }
        List<String[]> headers = new ArrayList<String[]>();
        try {
            JSONArray array = new JSONArray(entry.headersJson);
            for (int index = 0; index < array.length(); index += 1) {
                JSONArray pair = array.getJSONArray(index);
                if (pair.length() >= 2) headers.add(new String[] { pair.getString(0), pair.getString(1) });
            }
        } catch (Exception error) {
            ServerLog.append("warn", "response " + id + " had unreadable headers");
        }
        return new WebServer.Response(entry.status, headers, entry.body);
    }

    /** The JS engine never uses setTimeout for these: Java owns the timers. */
    public void requestQueueDrain() {
        evaluate("EstateMateOffline.drainQueue();");
    }

    public void tickCron() {
        evaluate("EstateMateOffline.tickCron();");
    }

    private void evaluate(final String call) {
        if (!isReady()) return;
        main.post(new Runnable() {
            public void run() {
                WebView view = webView;
                if (view != null) view.evaluateJavascript(call, null);
            }
        });
    }

    public void destroy() {
        destroyed = true;
        main.post(new Runnable() {
            public void run() {
                try {
                    if (webView != null) webView.destroy();
                } catch (RuntimeException ignored) {
                    /* already gone */
                }
                webView = null;
            }
        });
    }
}
