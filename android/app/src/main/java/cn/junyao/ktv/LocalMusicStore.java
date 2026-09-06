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
            try {
                walk(app, DocumentsContract.getTreeDocumentId(treeUri), treeUri, out);
            } catch (Exception ignored) {}
            JSONArray arr = new JSONArray();
            for (JSONObject o : out) arr.put(o);
            try {
                FileOutputStream fos = new FileOutputStream(indexFile(app));
                fos.write(arr.toString().getBytes(StandardCharsets.UTF_8));
                fos.close();
            } catch (Exception ignored) {}
            if (cb != null) cb.onDone(out.size());
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
        if (c == null) return;
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

    private static long crc32(String s) {
        CRC32 crc = new CRC32();
        crc.update(s.getBytes(StandardCharsets.UTF_8));
        return crc.getValue();
    }
}
