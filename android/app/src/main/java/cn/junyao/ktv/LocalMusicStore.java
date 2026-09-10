package cn.junyao.ktv;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.provider.DocumentsContract;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.CRC32;

/**
 * 本机曲库索引：用户通过 SAF（ACTION_OPEN_DOCUMENT_TREE）选一个文件夹，
 * 递归扫描目录树里的音频文件，把 {id, name, ext, size, uri} 存成 JSON 索引。
 * 音频本体不拷贝——播放时由 LocalMediaServer 按 uri 从 ContentResolver 流式读出。
 * id 用文档 URI 的 CRC32，稳定（同一文件重复扫描 id 不变）。
 */
final class LocalMusicStore {

    interface ScanCallback { void onDone(int count); }

    private static final String[] AUDIO_EXT = {"mp3", "flac", "m4a", "aac", "wav", "ogg", "opus"};
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();

    private LocalMusicStore() {}

    static File indexFile(Context c) {
        return new File(c.getFilesDir(), "local_index.json");
    }

    static String listJson(Context c) {
        try {
            File f = indexFile(c);
            if (!f.exists()) return "[]";
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            byte[] buf = new byte[(int) f.length()];
            int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
            in.close();
            return new String(buf, 0, off, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "[]";
        }
    }

    static JSONObject byId(Context c, int id) {
        try {
            JSONArray arr = new JSONArray(listJson(c));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (o.optInt("id") == id) return o;
            }
        } catch (Exception ignored) {}
        return null;
    }

    static boolean clear(Context c) {
        return indexFile(c).delete();
    }

    static void scanAsync(final Context ctx, final Uri treeUri, final ScanCallback cb) {
        final Context app = ctx.getApplicationContext();
        POOL.execute(() -> {
            List<JSONObject> out = new ArrayList<>();
            boolean ok = true;
            try {
                walk(app, DocumentsContract.getTreeDocumentId(treeUri), treeUri, out);
            } catch (Exception e) {
                // 扫描失败（最常见的是 SAF 授权已失效）时**绝不能覆盖已有索引**：
                // 否则用户点一次重新扫描就把曲库清成 0 首，以为歌全丢了。
                // 保留旧索引，并把失败如实上报给页面（-1）。
                ok = false;
            }
            if (ok) {
                JSONArray arr = new JSONArray();
                for (JSONObject o : out) arr.put(o);
                try {
                    FileOutputStream fos = new FileOutputStream(indexFile(app));
                    fos.write(arr.toString().getBytes(StandardCharsets.UTF_8));
                    fos.close();
                } catch (Exception ignored) {}
            }
            if (cb != null) cb.onDone(ok ? out.size() : -1);
        });
    }

    private static void walk(Context ctx, String parentId, Uri treeUri, List<JSONObject> out) throws Exception {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
        Cursor c = ctx.getContentResolver().query(children, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
        }, null, null, null);
        if (c == null) {
            // query 返回 null = 授权不可用（不是"空目录"，空目录会返回空 Cursor）。
            // 抛出去让上层把这次扫描标记为失败，避免用空结果覆盖掉好索引。
            throw new IllegalStateException("query returned null (folder permission lost?)");
        }
        List<String> subDirs = new ArrayList<>();
        while (c.moveToNext()) {
            String docId = c.getString(0);
            String name = c.getString(1) == null ? "" : c.getString(1);
            String mime = c.getString(2) == null ? "" : c.getString(2);
            long size = c.isNull(3) ? 0 : c.getLong(3);
            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                subDirs.add(docId);
                continue;
            }
            String ext = extOf(name);
            if (ext == null) continue;
            JSONObject o = new JSONObject();
            String uriStr = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString();
            o.put("id", (int) crc32(uriStr));
            o.put("name", name);
            o.put("ext", ext);
            o.put("size", size);
            o.put("uri", uriStr);
            // 文件名不含"歌手 - 歌名"分隔符时，读 ID3 元数据兜底补歌手/歌名
            if (!nameLooksTagged(name)) applyMediaMeta(ctx, o, Uri.parse(uriStr));
            out.add(o);
        }
        c.close();
        for (String dir : subDirs) walk(ctx, dir, treeUri, out);
    }

    private static String extOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return null;
        String ext = name.substring(dot + 1).toLowerCase();
        for (String a : AUDIO_EXT) if (a.equals(ext)) return ext;
        return null;
    }

    /** 文件名里含"歌手 - 歌名"式分隔符（半角/全角连字符、破折号，空格可有可无）→ 前端可直接解析，无需读元数据 */
    private static boolean nameLooksTagged(String name) {
        return name.matches("(?s).*\\S\\s*[-－–—―]+\\s*\\S.*");
    }

    /** 用 MediaMetadataRetriever 读音频标签（ID3 等），补 artist/title 字段到索引项 */
    private static void applyMediaMeta(Context ctx, JSONObject o, Uri uri) {
        android.media.MediaMetadataRetriever mmr = new android.media.MediaMetadataRetriever();
        try {
            mmr.setDataSource(ctx, uri);
            String artist = mmr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_ARTIST);
            if (artist == null || artist.trim().isEmpty() || "<unknown>".equalsIgnoreCase(artist.trim()))
                artist = mmr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST);
            String title = mmr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_TITLE);
            if (artist != null && !artist.trim().isEmpty() && !"<unknown>".equalsIgnoreCase(artist.trim()))
                o.put("artist", artist.trim());
            if (title != null && !title.trim().isEmpty() && !"<unknown>".equalsIgnoreCase(title.trim()))
                o.put("title", title.trim());
        } catch (Exception ignored) {
        } finally {
            try { mmr.release(); } catch (Exception ignored) {}
        }
    }

    private static long crc32(String s) {
        CRC32 crc = new CRC32();
        crc.update(s.getBytes(StandardCharsets.UTF_8));
        return crc.getValue();
    }
}
