package cn.junyao.ktv;

import android.content.Context;

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
    private final int port;
    private volatile boolean running = true;

    LocalMediaServer(Context ctx, int port) {
        this.ctx = ctx.getApplicationContext();
        this.port = port;
        setDaemon(true);
    }

    @Override
    public void run() {
        try {
            ServerSocket ss = new ServerSocket(port, 64, InetAddress.getLoopbackAddress());
            while (running) {
                final Socket s = ss.accept();
                new Thread(() -> handle(s)).start();
            }
        } catch (Exception ignored) {
            // 端口被占用等情况：本机播放不可用，但不影响 App 其它功能
        }
    }

    private void handle(Socket s) {
        InputStream in = null;
        OutputStream out = null;
        InputStream media = null;
        try {
            s.setSoTimeout(8000);
            byte[] buf = new byte[4096];
            int n = s.getInputStream().read(buf);
            if (n <= 0) return;
            String req = new String(buf, 0, n, "UTF-8");
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
            if (item == null) { respond(s, 404, "text/plain", "no such media".getBytes(), null); return; }
            Uri uri = Uri.parse(item.optString("uri"));
            long size = item.optLong("size", -1);
            String mime = mimeOf(item.optString("ext", "mp3"));

            media = ctx.getContentResolver().openInputStream(uri);
            if (media == null) { respond(s, 404, "text/plain", "unavailable".getBytes(), null); return; }

            long start = Math.max(0, rangeStart);
            long end = rangeEnd >= 0 ? rangeEnd : size - 1;
            boolean ranged = rangeStart >= 0 && size > 0;
            if (ranged) skipFully(media, start);
            long len = ranged ? (end - start + 1) : size;

            StringBuilder h = new StringBuilder();
            h.append(ranged ? "HTTP/1.1 206 Partial Content" : "HTTP/1.1 200 OK").append("\r\n");
            h.append("Content-Type: ").append(mime).append("\r\n");
            h.append("Content-Length: ").append(len).append("\r\n");
            h.append("Accept-Ranges: bytes\r\n");
            if (ranged) h.append("Content-Range: bytes ").append(start).append("-").append(end).append("/").append(size).append("\r\n");
            h.append("Connection: close\r\n\r\n");

            out = s.getOutputStream();
            out.write(h.toString().getBytes("UTF-8"));
            if (!"HEAD".equals(method)) {
                byte[] chunk = new byte[32 * 1024];
                long remaining = len < 0 ? Long.MAX_VALUE : len;
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
        o.write(("HTTP/1.1 " + code + " OK\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
        o.write(body);
        o.flush();
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
