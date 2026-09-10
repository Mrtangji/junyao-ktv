package cn.junyao.ktv;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
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
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
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
import org.json.JSONObject;
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
    // 本机曲库选中的 SAF 目录树（持久化，用于「授权自检 / 一键重新授权」）
    private static final String KEY_TREE = "tree_uri";
    private static final String LOCAL_PAGE = "file:///android_asset/tv/index.html?local=1";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_MIC = 2001;
    private static final int REQ_TREE = 1002;
    private static final int REQ_MIC_NATIVE = 2002;
    private static final int[] SCAN_PORTS = {8080};

    // 原生麦克风采集（唱歌评分用）：不走浏览器的 getUserMedia，因此不受
    // "必须 HTTPS 安全上下文"的限制——HTTP 局域网、甚至本地模式都能评分。
    // 16kHz 单声道足够覆盖人声音域（65~1050Hz 远低于 8k 奈奎斯特频率），
    // 1024 采样 ≈ 64ms 窗口，对 65Hz 仍有 4 个完整周期。
    private static final int MIC_RATE = 16000;
    private static final int MIC_WIN = 1024;
    private static final double MIC_MIN_HZ = 65, MIC_MAX_HZ = 1050;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCb;
    private PermissionRequest pendingPermission;
    private LocalMediaServer mediaServer;
    private Thread micThread;
    private volatile boolean micRunning;

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
            public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                // 服务器使用自签证书（HTTPS 8443，麦克风评分需要 HTTPS），局域网内直接信任
                handler.proceed();
            }
            // Bug修复：只有"主框架"加载失败才做 HTTPS→HTTP→本地模式 的降级。
            // 旧写法只覆写了已废弃的 onReceivedError(WebView,int,String,String)，而这个
            // 重载在 Android 6 及更早的系统上是"任何资源失败都会回调"——电视盒子网络
            // 稍有不稳，一个字体/图片子资源加载失败就会把整个 App 踢到 HTTP 甚至本地模式，
            // 结果就是：网页端明明能用的功能（麦克风评分、LX 音源），在盒子上全都不可用。
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && !request.isForMainFrame()) return;
                onMainFrameError(request != null && request.getUrl() != null ? request.getUrl().toString() : null);
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT >= 23) return; // 新回调已处理，避免重复降级
                onMainFrameError(failingUrl);
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

    /** HTTPS 回退目标（旧镜像只有 HTTP 8080 时用），加载前设置 */
    private String httpFallbackUrl;
    private boolean httpFallbackUsed;

    private void loadServer(String sv) {
        // 统一取「host[:port]」形式；优先走 HTTPS 8443（自签，麦克风评分需要安全上下文），
        // 失败自动回退 HTTP（旧镜像只有 8080）。
        String host = sv.replaceFirst("^https?://", "").replaceFirst("/.*$", "");
        if (!host.matches(".*:\\d+$")) host = host + ":8080";
        String httpsHost = host.replaceFirst(":8080$", ":8443");
        httpFallbackUrl = "http://" + host + "/tv";
        httpFallbackUsed = false;
        web.loadUrl("https://" + httpsHost + "/tv");
    }

    /** 本地模式：加载打包在 assets 里的 TV 页（页面按 file: 协议自动切本地模式） */
    private void loadLocal() {
        web.loadUrl(LOCAL_PAGE);
    }

    /**
     * 主框架加载失败时的降级：HTTPS(8443) 失败 → 试 HTTP(8080) → 还失败才进本地模式。
     * 只在主框架失败时调用（见 WebViewClient 里的两个 onReceivedError 重载）。
     */
    private void onMainFrameError(String failingUrl) {
        if (failingUrl != null && failingUrl.startsWith("https") && httpFallbackUrl != null && !httpFallbackUsed) {
            httpFallbackUsed = true;
            Toast.makeText(this, "HTTPS(8443) 不可用，改用 HTTP", Toast.LENGTH_LONG).show();
            web.loadUrl(httpFallbackUrl);
            return;
        }
        if (failingUrl != null && failingUrl.startsWith("http")) {
            Toast.makeText(this, "服务器连接失败，已进入本地模式", Toast.LENGTH_LONG).show();
            prefs.edit().remove(KEY_SERVER).apply();
            loadLocal();
        }
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
            // SAF 文件夹选择成功 → 后台递归扫描音频，扫完通知页面刷新。
            // 关键：必须先 takePersistableUriPermission 把读权限持久化，否则拿到的只是
            // 临时授权——Activity 一重建（电视盒子上切后台再回来、系统回收内存）或 App
            // 一重启，授权就没了，表现为「曲库列表还在、点播放却报文件夹授权已失效」。
            Uri tree = data.getData();
            // mode flags 必须取自返回 Intent（系统在这里声明它实际授予了什么），只保留
            // READ/WRITE 位；传错 flag 会让 takePersistableUriPermission 直接抛异常。
            int takeFlags = data.getFlags()
                    & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if (takeFlags == 0) takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION;
            boolean persisted = false;
            try {
                getContentResolver().takePersistableUriPermission(tree, takeFlags);
                persisted = true;
            } catch (Exception e) {
                persisted = false; // 不静默：下面据此提示，避免用户反复"扫描了却播不了"
            }
            prefs.edit().putString(KEY_TREE, tree.toString()).apply();
            Toast.makeText(this,
                    persisted ? "正在扫描本机曲库…" : "系统未授予持久权限；若重启后无法播放，请重新选一次文件夹",
                    Toast.LENGTH_LONG).show();
            LocalMusicStore.scanAsync(this, tree, count ->
                    runOnUiThread(() -> web.evaluateJavascript(
                            "window.localScanDone&&localScanDone(" + count + ")", null)));
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    /** 文件夹选择 Intent：带上持久化授权所需的全套 flag（缺 PERSISTABLE 就只有临时授权） */
    private Intent treePickerIntent() {
        Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        return it;
    }

    /** 该目录树是否仍持有「持久化」读授权（App 重启、Activity 重建后靠它继续读文件） */
    private boolean hasPersistedTree(Uri tree) {
        try {
            for (android.content.UriPermission p : getContentResolver().getPersistedUriPermissions()) {
                if (p.isReadPermission() && p.getUri().equals(tree)) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_MIC_NATIVE) {
            // 原生评分采集的麦克风权限结果
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startMicCapture();
            } else {
                micError("麦克风权限被拒绝，请在系统设置里允许本应用录音");
            }
            return;
        }
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

    // ---------- 原生麦克风采集 + MPM 音高检测（唱歌评分，无需 HTTPS） ----------
    // 浏览器里的 getUserMedia 被"安全上下文"卡着（必须 HTTPS 或 localhost），
    // 局域网 HTTP 下拿不到麦克风。App 是 WebView 壳，干脆自己用 AudioRecord 采，
    // 在 Java 侧把音高算出来，只把 (频率, 置信度, 音量) 三个数通过 JS 桥喂给页面
    // ——比往 JS 里灌 PCM 便宜得多，也彻底不依赖内核的 WebRTC 实现。

    private void jsCall(String code) {
        runOnUiThread(() -> { try { web.evaluateJavascript(code, null); } catch (Exception ignored) {} });
    }

    private void micError(String msg) {
        jsCall("window.onNativeMicError&&onNativeMicError(" + jsQuote(msg) + ")");
    }

    private static String jsQuote(String s) {
        return "\"" + String.valueOf(s).replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ") + "\"";
    }

    private static double round3(double v) { return Math.round(v * 1000.0) / 1000.0; }

    /** 页面打开评分时调用：先要权限，再起采集线程 */
    void requestMicStart() {
        runOnUiThread(() -> {
            if (micRunning) return;
            if (Build.VERSION.SDK_INT >= 23 &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC_NATIVE);
            } else {
                startMicCapture();
            }
        });
    }

    void requestMicStop() { stopMicCapture(); }

    private void startMicCapture() {
        stopMicCapture();
        try {
            int min = AudioRecord.getMinBufferSize(MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) min = MIC_WIN * 2 * 4;
            final int bufBytes = Math.max(min, MIC_WIN * 2);
            final AudioRecord rec = new AudioRecord(MediaRecorder.AudioSource.MIC, MIC_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes);
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                rec.release();
                micError("本机没有可用的麦克风（或已被其它应用占用）");
                return;
            }
            micRunning = true;
            micThread = new Thread(() -> {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
                short[] pcm = new short[MIC_WIN];
                double[] frame = new double[MIC_WIN];
                try {
                    rec.startRecording();
                    while (micRunning) {
                        int got = 0;
                        while (micRunning && got < MIC_WIN) {
                            int n = rec.read(pcm, got, MIC_WIN - got);
                            if (n <= 0) break;
                            got += n;
                        }
                        if (!micRunning || got < MIC_WIN) continue;
                        double sum = 0;
                        for (int i = 0; i < MIC_WIN; i++) { frame[i] = pcm[i] / 32768.0; sum += frame[i] * frame[i]; }
                        double rms = Math.sqrt(sum / MIC_WIN);
                        // 静音帧直接上报"没在唱"，省掉 O(W×maxTau) 的定音高计算
                        if (rms <= 0.01) { jsCall("window.onNativeMicFrame&&onNativeMicFrame(0,0," + round3(rms) + ")"); continue; }
                        double[] p = mpmPitch(frame, MIC_RATE);
                        if (p == null) jsCall("window.onNativeMicFrame&&onNativeMicFrame(0,0," + round3(rms) + ")");
                        else jsCall("window.onNativeMicFrame&&onNativeMicFrame(" + round3(p[0]) + "," + round3(p[1]) + "," + round3(rms) + ")");
                    }
                } catch (Exception e) {
                    micError("麦克风采集失败：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
                } finally {
                    try { rec.stop(); } catch (Exception ignored) {}
                    rec.release();
                }
            }, "ktv-mic");
            micThread.start();
        } catch (Exception e) {
            micError("麦克风初始化失败：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
    }

    private void stopMicCapture() {
        micRunning = false;
        Thread t = micThread;
        micThread = null;
        if (t != null && t != Thread.currentThread()) {
            try { t.join(300); } catch (InterruptedException ignored) {}
        }
    }

    /**
     * McLeod Pitch Method（与 tv 页 scoreMPM、服务端 pitch.js 同一算法）。
     * 只扫 [rate/1050, rate/65] 这段 tau：复杂度从 O(W²) 降到 W×(rate/65)，
     * 16kHz/1024 窗口下约 25 万次乘法，电视盒子也跑得动。
     * 返回 {频率Hz, 置信度}，判定不出音高返回 null。
     */
    private static double[] mpmPitch(double[] x, double rate) {
        final int W = x.length;
        int maxTau = (int) (rate / MIC_MIN_HZ);
        if (maxTau > W - 2) maxTau = W - 2;
        double[] nsdf = new double[maxTau + 1];
        for (int tau = 0; tau <= maxTau; tau++) {
            double acf = 0, div = 0;
            for (int i = 0; i < W - tau; i++) {
                double a = x[i], b = x[i + tau];
                acf += a * b;
                div += a * a + b * b;
            }
            nsdf[tau] = div > 0 ? 2 * acf / div : 0;
        }
        int s = 0;
        while (s <= maxTau && nsdf[s] > 0) s++;
        while (s <= maxTau && nsdf[s] <= 0) s++;
        if (s >= maxTau) return null;
        double maxV = -1;
        java.util.ArrayList<double[]> peaks = new java.util.ArrayList<>();
        for (int tau = s; tau < maxTau; tau++) {
            double v = nsdf[tau];
            if (v > 0 && v >= nsdf[tau - 1] && v >= nsdf[tau + 1]) {
                peaks.add(new double[]{tau, v});
                if (v > maxV) maxV = v;
            }
        }
        if (peaks.isEmpty() || maxV < 0.5) return null;
        // 与 JS 版一致：取第一个达到 0.9×最大值 的峰（避免八度跳变）
        double th = 0.9 * maxV, t0 = -1, v0 = -1;
        for (double[] p : peaks) if (p[1] >= th) { t0 = p[0]; v0 = p[1]; break; }
        if (t0 < 0) return null;
        int i0 = (int) t0;
        double vl = i0 - 1 >= 0 ? nsdf[i0 - 1] : 0;
        double vr = i0 + 1 <= maxTau ? nsdf[i0 + 1] : 0;
        double den = 2 * (2 * v0 - vl - vr);
        double sh = den != 0 ? (vr - vl) / den : 0;
        double freq = rate / (t0 + sh);
        if (freq < MIC_MIN_HZ || freq > MIC_MAX_HZ) return null;
        return new double[]{freq, v0};
    }

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
                    // 这几个 flag 缺一不可：
                    //  · READ/WRITE      —— 读写许可
                    //  · PERSISTABLE     —— 允许 takePersistableUriPermission 长期保留授权，
                    //                       缺它则只有临时授权，Activity 一重建就失效
                    //  · PREFIX          —— 授权覆盖该目录树下所有子文档，否则只能访问
                    //                       目录节点本身、访问子文件会抛 SecurityException
                    startActivityForResult(treePickerIntent(), REQ_TREE);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "本系统不支持文件夹选择器", Toast.LENGTH_LONG).show();
                }
            });
        }

        /**
         * 本机曲库授权状态：none=没选过目录 / ok=授权有效 / lost=选过但授权已失效。
         * 页面据此决定是提示「重新授权」还是直接「重新扫描」。
         */
        @JavascriptInterface
        public String localAuthState() {
            String saved = prefs.getString(KEY_TREE, null);
            if (saved == null) return "none";
            if (hasPersistedTree(Uri.parse(saved))) return "ok";
            return "lost";
        }

        /**
         * 一键恢复本机曲库：授权还在就直接重扫（不弹选择器），授权丢了才重新拉起
         * 文件夹选择器。这样 App 重启/Activity 重建后用户不必再翻一遍目录。
         */
        @JavascriptInterface
        public void relinkFolder() {
            runOnUiThread(() -> {
                String saved = prefs.getString(KEY_TREE, null);
                if (saved != null) {
                    Uri tree = Uri.parse(saved);
                    if (hasPersistedTree(tree)) {
                        Toast.makeText(MainActivity.this, "正在按原文件夹重新扫描…", Toast.LENGTH_SHORT).show();
                        LocalMusicStore.scanAsync(MainActivity.this, tree, count ->
                                runOnUiThread(() -> web.evaluateJavascript(
                                        "window.localScanDone&&localScanDone(" + count + ")", null)));
                        return;
                    }
                    Toast.makeText(MainActivity.this, "需要重新授权原来的文件夹", Toast.LENGTH_SHORT).show();
                }
                try {
                    startActivityForResult(treePickerIntent(), REQ_TREE);
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

        /** 本机音频播放地址（127.0.0.1 本地流服务，带 Range 支持拖动进度）。
         *  用实际端口（服务可能顺延到 8091+），避免写死 8090 在端口冲突时连不上。 */
        @JavascriptInterface
        public String localPlayUrl(int id) {
            int p = mediaServer != null ? mediaServer.getPort() : 8090;
            if (p <= 0) p = 8090;
            return "http://127.0.0.1:" + p + "/local/" + id;
        }

        /** 本地流服务实际监听端口；-1 表示启动失败（本机播放不可用）。页面据此判断兜底。 */
        @JavascriptInterface
        public int localServerPort() {
            return mediaServer != null ? mediaServer.getPort() : -1;
        }

        /** 本机音频的 content:// URI（SAF 文档 URI，带持久授权）。
         *  页面优先用它直连媒体框架播放，绕过本地 HTTP 服务与 file://→http 安全策略，最稳；
         *  返回 null（索引失效/授权丢失）时页面回落 http 本地服务并提示重新授权。 */
        @JavascriptInterface
        public String localPlayContentUri(int id) {
            try {
                JSONObject item = LocalMusicStore.byId(MainActivity.this, id);
                if (item == null) return null;
                String uri = item.optString("uri", null);
                if (uri == null || uri.isEmpty()) return null;
                // 兜底续一次持久授权（万一系统回收了也尽量续上），失败不影响返回 URI
                try {
                    getContentResolver().takePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) {}
                return uri;
            } catch (Exception e) {
                return null;
            }
        }

        /** 清空本机曲库索引 */
        @JavascriptInterface
        public boolean clearLocal() {
            return LocalMusicStore.clear(MainActivity.this);
        }

        /** 唱歌评分：启动原生麦克风采集（不依赖 HTTPS/getUserMedia） */
        @JavascriptInterface
        public void startMic() { requestMicStart(); }

        /** 唱歌评分：停止原生麦克风采集 */
        @JavascriptInterface
        public void stopMic() { requestMicStop(); }
    }

    @Override
    protected void onDestroy() {
        stopMicCapture();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
