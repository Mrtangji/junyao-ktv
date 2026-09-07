package cn.junyao.ktv;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 君耀KTV 安卓端：WebView 壳。
 * 启动自动扫描局域网找服务器（默认端口 8080）；找不到或连不上时自动进入本地模式
 * （加载打包在 assets/tv 的页面，只保留本机音频扫描与播放能力）。
 * 可随时按遥控器菜单键（MENU），或在 TV 页右下角 设置→服务器地址 里重新配置。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "ktv";
    private static final String KEY_SERVER = "server";
    private static final String LOCAL_PAGE = "file:///android_asset/tv/index.html?local=1";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_MIC = 2001;
    private static final int REQ_TREE = 1002;
    private static final int[] SCAN_PORTS = {8080};

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCb;
    private PermissionRequest pendingPermission;
    private LocalMediaServer mediaServer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        // 本地媒体服务：WebView 里本机曲库经 127.0.0.1:8090 流式播放
        mediaServer = new LocalMediaServer(this, 8090);
        mediaServer.start();

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // 首页自动播放/自动续播
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(true);
        // 放开跨源 fetch（本机曲库桥接页面需访问 127.0.0.1:8090 本地流服务）
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);

        web.addJavascriptInterface(new Bridge(), "KtvBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // 主框架加载服务器失败（服务器没开/地址失效）→ 自动降级本地模式。
                // 该重载在所有 API 级别都只对主框架回调，子资源失败不会误触发；
                // file:// 本地页自身出错不再回落，避免死循环。
                if (failingUrl != null && failingUrl.startsWith("http")) {
                    Toast.makeText(MainActivity.this, "服务器连接失败，已进入本地模式", Toast.LENGTH_LONG).show();
                    prefs.edit().remove(KEY_SERVER).apply();
                    loadLocal();
                }
            }
        });
        web.setWebChromeClient(new ChromeClient());

        String sv = prefs.getString(KEY_SERVER, "");
        if (sv.isEmpty()) scanLan(); // 首次启动：自动扫描，找不到直接进本地模式
        else loadServer(sv);
    }

    /** 沉浸式全屏：隐藏状态栏/导航栏，下滑临时呼出 */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    private void hideSystemUi() {
        android.view.View d = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController ic = d.getWindowInsetsController();
            if (ic != null) {
                ic.hide(android.view.WindowInsets.Type.statusBars() | android.view.WindowInsets.Type.navigationBars());
                ic.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            d.setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                    | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    private void loadServer(String sv) {
        if (!sv.startsWith("http")) sv = "http://" + sv;
        web.loadUrl(sv + "/tv");
    }

    /** 本地模式：加载打包在 assets 里的 TV 页（页面按 file: 协议自动切本地模式） */
    private void loadLocal() {
        web.loadUrl(LOCAL_PAGE);
    }

    private boolean hasServer() {
        String sv = prefs.getString(KEY_SERVER, "");
        return !sv.isEmpty();
    }

    /** 服务器选择菜单（MENU 键 / 设置入口）。must=true（尚无任何可用页面）时不可取消。 */
    private void showMenu(boolean must) {
        final String[] items = {"🔍 扫描局域网查找服务器", "✏️ 手动输入服务器地址", "📱 本地模式（无服务器）"};
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("君耀KTV · 连接服务器")
                .setCancelable(!must)
                .setItems(items, (d, w) -> {
                    if (w == 0) scanLan();
                    else if (w == 1) askServerDialog(must);
                    else { prefs.edit().remove(KEY_SERVER).apply(); loadLocal(); }
                });
        if (!must) b.setNegativeButton("取消", null);
        b.show();
    }

    /** 手动输入服务器地址，例如 192.168.1.50:8080 */
    private void askServerDialog(final boolean must) {
        final EditText et = new EditText(this);
        et.setSingleLine(true);
        et.setHint("例如 192.168.1.50:8080");
        et.setText(prefs.getString(KEY_SERVER, ""));
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setView(et)
                .setPositiveButton("连接", (d, w) -> {
                    String v = et.getText().toString().trim();
                    if (v.isEmpty()) { askServerDialog(must); return; }
                    prefs.edit().putString(KEY_SERVER, v).apply();
                    loadServer(v);
                });
        if (must) b.setNegativeButton("退出", (d, w) -> finish());
        else b.setNegativeButton("取消", null);
        b.show();
    }

    // ---------- 局域网扫描：对本网段 2~254 逐个探测 8080 端口的 /api/stats ----------

    private void scanLan() {
        final String prefix = lanPrefix();
        if (prefix == null) {
            String cur = web.getUrl();
            if (cur != null && cur.startsWith("http")) {
                Toast.makeText(this, "未获取到本机 IP，请手动输入服务器地址", Toast.LENGTH_LONG).show();
                showMenu(false);
            } else {
                Toast.makeText(this, "未获取到本机 IP，已进入本地模式", Toast.LENGTH_LONG).show();
                loadLocal();
            }
            return;
        }
        final AlertDialog progress = new AlertDialog.Builder(this)
                .setTitle("正在扫描局域网…")
                .setMessage("网段 " + prefix + "x（端口 " + SCAN_PORTS[0] + "）")
                .setCancelable(false)
                .show();

        final ExecutorService pool = Executors.newFixedThreadPool(64);
        final List<Future<String>> futures = new ArrayList<>();
        for (int i = 2; i < 255; i++)
            for (final int port : SCAN_PORTS) {
                final String host = prefix + i;
                futures.add(pool.submit(() -> probe(host, port)));
            }
        pool.shutdown();

        // 扫描放在后台线程，完成后回 UI 线程
        new Thread(() -> {
            String found = null;
            for (Future<String> f : futures) {
                try {
                    String r = f.get(12, TimeUnit.SECONDS);
                    if (r != null && found == null) found = r;
                } catch (Exception ignored) {}
            }
            final String result = found;
            runOnUiThread(() -> {
                try { progress.dismiss(); } catch (Exception ignored) {}
                if (result != null) {
                    prefs.edit().putString(KEY_SERVER, result).apply();
                    Toast.makeText(MainActivity.this, "已找到服务器：" + result, Toast.LENGTH_SHORT).show();
                    loadServer(result);
                } else {
                    // 找不到服务器：若当前已在服务器页上则仅提示；否则自动进入本地模式
                    String cur = web.getUrl();
                    boolean onServerPage = cur != null && cur.startsWith("http");
                    if (onServerPage) {
                        Toast.makeText(MainActivity.this, "未发现 KTV 服务器，请确认与服务器在同一局域网", Toast.LENGTH_LONG).show();
                        showMenu(false);
                    } else {
                        Toast.makeText(MainActivity.this, "未发现 KTV 服务器，已进入本地模式", Toast.LENGTH_LONG).show();
                        prefs.edit().remove(KEY_SERVER).apply();
                        loadLocal();
                    }
                }
            });
        }).start();
    }

    /** 探测 http://host:port/api/stats 返回 200 且包含 songCount 即认定是本服务 */
    private String probe(String host, int port) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + host + ":" + port + "/api/stats").openConnection();
            c.setConnectTimeout(400);
            c.setReadTimeout(400);
            if (c.getResponseCode() == 200) {
                java.io.InputStream in = c.getInputStream();
                byte[] buf = new byte[512];
                int n = in.read(buf);
                if (n > 0 && new String(buf, 0, n, "UTF-8").contains("songCount")) return host + ":" + port;
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
        return null;
    }

    /** 取本机局域网 IPv4 的前三段，如 192.168.1. */
    private String lanPrefix() {
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        String ip = a.getHostAddress();
                        return ip.substring(0, ip.lastIndexOf('.') + 1);
                    }
                }
            }
        } catch (Exception ignored) {}
        // 有 WiFi 权限时的兜底（部分设备网卡枚举拿不到）
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            int ip = wm.getConnectionInfo().getIpAddress();
            if (ip != 0) return ((ip & 0xff)) + "." + ((ip >> 8) & 0xff) + "." + ((ip >> 16) & 0xff) + ".";
        } catch (Exception ignored) {}
        return null;
    }

    // ---------- 按键：菜单键重新配置服务器；返回键走网页历史 ----------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            showMenu(false);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ---------- WebView 文件选择（设置里"选择音频文件"）与麦克风权限（评分模式） ----------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER && fileCb != null) {
            Uri[] out = null;
            if (data != null && data.getData() != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                } else {
                    out = new Uri[]{data.getData()};
                }
            }
            fileCb.onReceiveValue(out);
            fileCb = null;
        } else if (requestCode == REQ_TREE && resultCode == RESULT_OK && data != null && data.getData() != null) {
            // SAF 文件夹选择成功：持久化读权限 → 后台递归扫描音频 → 通知页面刷新
            try {
                getContentResolver().takePersistableUriPermission(data.getData(),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}
            Toast.makeText(this, "正在扫描本机曲库…", Toast.LENGTH_SHORT).show();
            LocalMusicStore.scanAsync(this, data.getData(), count ->
                    runOnUiThread(() -> web.evaluateJavascript(
                            "window.localScanDone&&localScanDone(" + count + ")", null)));
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_MIC && pendingPermission != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED)
                pendingPermission.grant(pendingPermission.getResources());
            else
                pendingPermission.deny();
            pendingPermission = null;
        } else {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        }
    }

    private class ChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCb != null) fileCb.onReceiveValue(null);
            fileCb = cb;
            // 按网页声明的 accept 类型决定过滤：音频导入用 audio/*，
            // LX 音源(.js/text/javascript)等其它类型放开为 */*，否则 js 文件选不中
            String type = "audio/*";
            String[] accepts = params.getAcceptTypes();
            if (accepts != null) {
                for (String a : accepts) {
                    if (a == null) continue;
                    String t = a.trim().toLowerCase();
                    if (!t.isEmpty() && !t.startsWith("audio/") && !t.matches("\\.(mp3|flac|m4a|aac|wav|ogg|opus)")) {
                        type = "*/*";
                        break;
                    }
                }
            }
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(type);
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(Intent.createChooser(i, type.equals("audio/*") ? "选择音频文件" : "选择文件"), REQ_FILE_CHOOSER);
            } catch (Exception e) {
                fileCb = null;
                return false;
            }
            return true;
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> {
                boolean mic = false;
                for (String r : request.getResources())
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) mic = true;
                if (!mic) { request.deny(); return; }
                if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingPermission = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                } else {
                    request.grant(request.getResources());
                }
            });
        }
    }

    // ---------- JS 桥：TV 页设置面板里的「服务器地址」行 ----------

    private class Bridge {
        @JavascriptInterface
        public String getServer() {
            return prefs.getString(KEY_SERVER, "");
        }

        @JavascriptInterface
        public boolean isLocal() {
            String u = web.getUrl();
            return u == null || u.startsWith("file:");
        }

        @JavascriptInterface
        public void editServer() {
            runOnUiThread(() -> showMenu(false));
        }

        /** 打开系统文件夹选择器（SAF 目录树），扫完回调 window.localScanDone(n) */
        @JavascriptInterface
        public void pickMusicFolder() {
            runOnUiThread(() -> {
                try {
                    startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_TREE);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "本系统不支持文件夹选择器", Toast.LENGTH_LONG).show();
                }
            });
        }

        /** 本机曲库索引 JSON：[{id,name,ext,size,uri}] */
        @JavascriptInterface
        public String localListJson() {
            return LocalMusicStore.listJson(MainActivity.this);
        }

        /** 本机音频播放地址（127.0.0.1 本地流服务，带 Range 支持拖动进度） */
        @JavascriptInterface
        public String localPlayUrl(int id) {
            return "http://127.0.0.1:8090/local/" + id;
        }

        /** 清空本机曲库索引 */
        @JavascriptInterface
        public boolean clearLocal() {
            return LocalMusicStore.clear(MainActivity.this);
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
