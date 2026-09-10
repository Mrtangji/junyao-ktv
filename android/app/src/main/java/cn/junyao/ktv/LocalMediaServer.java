package cn.junyao.ktv;

import android.content.Context;
import android.net.Uri;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;

/**
 * 极简本地媒体服务：只监听 127.0.0.1:8090（不暴露到局域网），提供
 * GET /local/&lt;id&gt; 从 ContentResolver 流式输出本机音频，带 Range 支持
 * （<audio>/<video> 拖动进度必需）。供 WebView 里的本机曲库播放用。
 */
final class LocalMediaServer extends Thread {

    private final Context ctx;
    private final int basePort;
    private volatile boolean running = true;
    private volatile int actualPort = -1;

    LocalMediaServer(Context ctx, int port) {
        this.ctx = ctx.getApplicationContext();
        this.basePort = port;
        setDaemon(true);
    }

    /** 实际监听的端口（端口被占用时会在 basePort..basePort+9 之间顺延）；-1=启动失败 */
    int getPort() { return actualPort; }

    @Override
    public void run() {
        // 端口被占用（旧进程没释放、其它 App 占用等）是"本地播放连不上"的头号原因：
        // 原先写死 8090，一旦 bind 失败就静默退出，视频元素拿到的是连接拒绝 → 笼统报
        // "格式不支持"。这里顺延到 basePort+9，总能起一个；真实端口经 getPort() 暴露给页面。
        for (int p = basePort; p < basePort + 10; p++) {
            try {
                ServerSocket ss = new ServerSocket(p, 64, InetAddress.getLoopbackAddress());
                actualPort = p;
                while (running) {
                    final Socket s = ss.accept();
                    new Thread(() -> handle(s)).start();
                }
                return;
            } catch (Exception ignored) {
                // 该端口不可用，试下一个
            }
        }
        actualPort = -1; // 全部失败：本机播放不可用，但不影响 App 其它功能
    }

    private void handle(Socket s) {
        InputStream in = null;
        OutputStream out = null;
        InputStream media = null;
        try {
            // 读请求头超时放宽到 30s：电视盒子上视频元素偶尔分段发请求头，8s 太激进会
            // 把正常请求误杀成连接关闭 → 媒体框架拿到半截响应 → 报"格式不支持"。
            // 注意：此超时只作用于"读请求"，流式写媒体不受影响（写无超时，由连接关闭标记结束）。
            s.setSoTimeout(30000);
            // 循环读满请求头（单次 read 可能只拿到半截，导致 Range 头丢失）
            java.io.ByteArrayOutputStream head = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            InputStream is = s.getInputStream();
            int n;
            while ((n = is.read(buf)) > 0) {
                head.write(buf, 0, n);
                String soFar = head.toString("UTF-8");
                if (soFar.contains("\r\n\r\n") || head.size() > 16384) break;
            }
            String req = head.toString("UTF-8");
            if (req.isEmpty()) return;
            String line = req.split("\r\n")[0];
            String[] parts = line.split(" ");
            String method = parts[0];
            String path = parts.length > 1 ? parts[1] : "/";
            // Range 请求头
            long rangeStart = -1, rangeEnd = -1;
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("Range:\\s*bytes=(\\d+)-(\\d*)").matcher(req);
            if (m.find()) {
                rangeStart = Long.parseLong(m.group(1));
                if (!m.group(2).isEmpty()) rangeEnd = Long.parseLong(m.group(2));
            }

            if (!path.startsWith("/local/")) { respond(s, 404, "text/plain", "not found".getBytes(), null); return; }
            int id;
            try {
                id = Integer.parseInt(URLDecoder.decode(path.substring(7), "UTF-8"));
            } catch (Exception e) { respond(s, 400, "text/plain", "bad id".getBytes(), null); return; }

            JSONObject item = LocalMusicStore.byId(ctx, id);
            if (item == null) { respond(s, 404, "text/plain", "stale index: no such media".getBytes(), null); return; }
            Uri uri = Uri.parse(item.optString("uri"));
            long size = item.optLong("size", -1);
            String mime = mimeOf(item.optString("ext", "mp3"));

            // SAF 授权丢失(重装/清理后)与文件打不开分别给 403/503，前端据此提示重新扫描
            try {
                media = ctx.getContentResolver().openInputStream(uri);
            } catch (SecurityException se) {
                respond(s, 403, "text/plain", "permission lost: rescan folder".getBytes(), null); return;
            } catch (Exception e) {
                respond(s, 503, "text/plain", "cannot open media".getBytes(), null); return;
            }
            if (media == null) { respond(s, 503, "text/plain", "cannot open media".getBytes(), null); return; }

            long start = Math.max(0, rangeStart);
            long end = rangeEnd >= 0 ? rangeEnd : size - 1;
            // size 未知(部分 SAF 文档报告 0/-1)时不能走 Range/Content-Length：
            // 直接 200 + 流式输出到结尾，由连接关闭标记结束，否则视频会解码失败
            boolean ranged = rangeStart >= 0 && size > 0;
            boolean knownSize = size > 0;
            if (ranged) skipFully(media, start);
            Long len = ranged ? Long.valueOf(end - start + 1) : (knownSize ? Long.valueOf(size) : null);

            StringBuilder h = new StringBuilder();
            h.append(ranged ? "HTTP/1.1 206 Partial Content" : "HTTP/1.1 200 OK").append("\r\n");
            h.append("Content-Type: ").append(mime).append("\r\n");
            if (len != null) h.append("Content-Length: ").append(len).append("\r\n");
            h.append("Accept-Ranges: bytes\r\n");
            h.append("Access-Control-Allow-Origin: *\r\n");
            if (ranged) h.append("Content-Range: bytes ").append(start).append("-").append(end).append("/").append(size).append("\r\n");
            h.append("Connection: close\r\n\r\n");

            out = s.getOutputStream();
            out.write(h.toString().getBytes("UTF-8"));
            if (!"HEAD".equals(method)) {
                byte[] chunk = new byte[32 * 1024];
                long remaining = len == null ? Long.MAX_VALUE : len;
                while (remaining > 0 && (n = media.read(chunk, 0, (int) Math.min(chunk.length, remaining))) > 0) {
                    out.write(chunk, 0, n);
                    remaining -= n;
                }
            }
            out.flush();
        } catch (Exception ignored) {
        } finally {
            try { if (media != null) media.close(); } catch (Exception ignored) {}
            try { if (out != null) out.close(); } catch (Exception ignored) {}
            try { if (in != null) in.close(); } catch (Exception ignored) {}
            try { s.close(); } catch (Exception ignored) {}
        }
    }

    private void respond(Socket s, int code, String type, byte[] body, Void unused) throws Exception {
        OutputStream o = s.getOutputStream();
        o.write(("HTTP/1.1 " + code + " " + reasonOf(code) + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length + "\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
        o.write(body);
        o.flush();
    }

    private static String reasonOf(int code) {
        switch (code) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 503: return "Service Unavailable";
            default: return "Error";
        }
    }

    private static String mimeOf(String ext) {
        switch (ext) {
            case "flac": return "audio/flac";
            case "m4a": return "audio/mp4";
            case "aac": return "audio/aac";
            case "wav": return "audio/wav";
            case "ogg":
            case "opus": return "audio/ogg";
            default: return "audio/mpeg";
        }
    }

    private static void skipFully(InputStream in, long count) throws Exception {
        byte[] skip = new byte[32 * 1024];
        while (count > 0) {
            long n = in.skip(count);
            if (n > 0) { count -= n; continue; }
            int r = in.read(skip, 0, (int) Math.min(skip.length, count));
            if (r < 0) return;
            count -= r;
        }
    }
}
