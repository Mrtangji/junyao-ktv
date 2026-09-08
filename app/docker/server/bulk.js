// 全曲库批量下载（麦动 muse.db 源，最常唱优先）
// =====================================================================
// 移植自 maidong-server/src/bulk.js，适配 junyao 环境：
//  - 目录解析与实时换链复用 muse.js（ensureMuseDb/openDb + resolveMuseUrl，
//    自带广告直链过滤与换设备重试，cloud_url 旧签名不复用）
//  - 落盘到 MV_DIR/ts/（即服务器的 /mv/ts，与 maidong-server 布局一致）：
//    平铺「歌手 - 歌名.ts」（冲突时带 [编号] 系列后缀）；该目录在 MV_DIR 内，
//    扫描曲库后自动入库（scanner 已识别 .ts，文件名可解析出歌名/歌手）
//  - 无需手动导入曲库目录：muse.db 已内置镜像，启动下载时自动解析
//  - 进度持久化在 DATA_DIR/bulk-state.json；区间下载按「已存在文件跳过」
//    天然支持断点续传，服务重启后重新启动同一区间即可继续
//  - /mv/ts 与普通下载的 MV 不同目录，扫库补缺模式只补缺失与损坏的文件，
//    绝不清理目录里的其它文件
// 管理接口（/api/bulk/*，挂载在 index.js，导入/启动/停止需管理员登录）。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const muse = require('./muse');
const dlcfg = require('./dlconfig');
const log = require('./logger');
const { sanitize } = require('./lxmusic').internals;

const DL_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.BULK_CONCURRENCY) || 2)); // 并发下载（每首要先换链，CDN 压力友好）
const STATE_SAVE_EVERY = 5;      // 每完成 n 首落盘一次进度

class BulkDownloader {
  constructor() {
    this.dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.catalogPath = path.join(this.dataDir, 'bulk-catalog.json');
    this.statePath = path.join(this.dataDir, 'bulk-state.json');
    // 批量下载专用目录：MV_DIR/ts/（服务器上的 /mv/ts），与普通 MV 分开
    this.tsDir = path.join(path.resolve(dlcfg.MV_DIR), 'ts');
    this.state = {
      running: false,
      total: 0, done: 0, failed: 0,
      current: '',          // 正在处理的歌
      lastError: '',
      startedAt: null,
      catalog: 0,           // 已导入目录的曲目数
      stopRequested: false,
      mode: 'range',        // range=按区间下载 | scan=扫库补缺
      from: 1, to: 0,
      scanned: 0, have: 0, invalid: 0,   // 扫库补缺进度
    };
    this._loadState();
  }

  _loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      Object.assign(this.state, raw, { running: false, stopRequested: false, current: '' });
    } catch (e) {}
  }

  _saveState() {
    try { fs.writeFileSync(this.statePath, JSON.stringify(this.state)); } catch (e) {}
  }

  /** 解析 muse.db → 按最常唱排序的目录（NDJSON，一行一首）。 */
  async importCatalog() {
    const file = await muse.ensureMuseDb(false);
    const db = muse.openDb(file);
    const rows = db.prepare(
      "SELECT s.filename, s.name, " +
      "(SELECT group_concat(sg.name, '、') FROM song_singer_relations ssr " +
      "INNER JOIN singers sg ON sg.id=ssr.singer_id WHERE ssr.song_id=s.id) AS sn " +
      "FROM songs s WHERE s.deleted_at IS NULL AND s.cloud_url IS NOT NULL AND s.cloud_url != '' " +
      "AND s.filename IS NOT NULL AND s.filename != '' " +
      "ORDER BY s.rec_score DESC, s.local_hot_score DESC, s.hot_score DESC"
    );
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.catalogPath + '.tmp';
    const out = fs.createWriteStream(tmp);
    let n = 0;
    for (const r of rows.iterate()) {
      const no = String(r.filename || '').replace(/\.(ls|ts)$/i, '');
      if (!no) continue;
      const line = JSON.stringify({
        no,
        title: String(r.name || no).trim() || no,
        singer: String(r.sn || '').trim(),
      });
      if (!out.write(line + '\n')) await new Promise((res) => out.once('drain', res));
      n++;
    }
    await new Promise((res) => out.end(res));
    fs.renameSync(tmp, this.catalogPath);
    this._entries = null;      // 目录重建，缓存失效
    this.state.catalog = n;
    this._saveState();
    log.info('BULK', `曲库目录导入完成：${n} 首`);
    return n;
  }

  /** 全部目录条目（[{no,title,singer}]，按最常唱排序），带缓存。 */
  _catalogEntries() {
    if (this._entries) return this._entries;
    const out = [];
    try {
      for (const l of fs.readFileSync(this.catalogPath, 'utf8').split('\n')) {
        if (!l) continue;
        try { out.push(JSON.parse(l)); } catch (e) {}
      }
    } catch (e) {}
    this._entries = out;
    return out;
  }

  /**
   * 启动批量下载（已在跑则拒绝）。曲库目录无需手动导入——muse.db 已内置
   * 镜像，启动时自动解析（目录缓存已存在则直接复用）。
   * @param {object} opts 普通模式 {from, to} 1-based 序号区间（含两端，按最常唱
   *   排序），兼容 {limit}（等价 from=1, to=limit），to 省略=全库；
   *   扫库补缺 {mode:'scan'}：全库比对 MV_DIR/ts 已下载文件，缺失与损坏
   *   （TS 完整性校验不过）的自动进入下载队列补齐，不清理任何其它文件。
   */
  start(opts = {}) {
    if (this.state.running) return { ok: false, error: '批量下载已在进行中' };
    const scan = opts.mode === 'scan';
    const limit = Number(opts.limit) || 0;
    const from = Math.max(1, Math.floor(Number(opts.from) || 1));
    let to = Math.floor(Number(opts.to) || (limit || 0));   // 0 = 全库（_run 里按实际目录长度取）
    if (!Number.isFinite(to) || to < from) to = 0;
    this.state.running = true;
    this.state.stopRequested = false;
    this.state.mode = scan ? 'scan' : 'range';
    this.state.total = 0;
    this.state.done = 0;
    this.state.failed = 0;
    this.state.lastError = '';
    this.state.startedAt = new Date().toISOString();
    this.state.from = from;
    this.state.to = to;
    if (scan) { this.state.scanned = 0; this.state.have = 0; this.state.invalid = 0; }
    this._saveState();
    // 后台跑，不阻塞请求
    this._run().catch((e) => {
      this.state.lastError = String((e && e.message) || e);
      this.state.running = false;
      this._saveState();
      log.error('BULK', '批量下载异常终止: ' + this.state.lastError);
    });
    return { ok: true, from, to: to || null, mode: this.state.mode };
  }

  stop() {
    if (!this.state.running) return { ok: false, error: '没有进行中的批量下载' };
    this.state.stopRequested = true;
    return { ok: true };
  }

  status() {
    return {
      muse: muse.available(),
      catalog: this.state.catalog || 0,
      running: this.state.running,
      mode: this.state.mode || 'range',
      total: this.state.total || 0,
      done: this.state.done || 0,
      failed: this.state.failed || 0,
      current: this.state.current || '',
      lastError: this.state.lastError || '',
      startedAt: this.state.startedAt || null,
      from: this.state.from || 1,
      to: this.state.to || 0,
      scanned: this.state.scanned || 0,
      have: this.state.have || 0,
      invalid: this.state.invalid || 0,
      concurrency: DL_CONCURRENCY,
    };
  }

  /** 落盘文件名候选（确定性，可复现查找）：歌手 - 歌名.ts → [编号] → [编号]b2… */
  _nameCandidates(item) {
    const artist = sanitize(item.singer) || '未知歌手';
    const title = sanitize(item.title) || '未知歌名';
    const base = `${artist} - ${title}`;
    const out = [base, `${base} [${item.no}]`];
    for (let i = 2; i <= 5; i++) out.push(`${base} [${item.no}]b${i}`);
    return out.map((n) => `${n}.ts`);
  }

  /** 该条目已下载？返回 tsDir 中已存在的绝对路径，否则 null。 */
  existingPath(item) {
    for (const name of this._nameCandidates(item)) {
      const p = path.join(this.tsDir, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /** 挑选落盘目标（第一个不存在的候选名），必要时建目录。 */
  _pickTarget(item) {
    for (const name of this._nameCandidates(item)) {
      const p = path.join(this.tsDir, name);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(this.tsDir, { recursive: true });
        return p;
      }
    }
    return null;
  }

  /**
   * TS 完整性校验（轻量，不解析流内容）：大小 > 0 且按 188（或 M2TS 192）字节
   * 整包对齐；首包/尾包/中部抽样包的同步字节必须是 0x47。截断、0 字节、被
   * HTML 错误页覆盖等损坏基本都能拦住。
   */
  checkTsIntegrity(p) {
    try {
      const size = fs.statSync(p).size;
      if (size === 0) return false;
      let pkt = 0;
      if (size % 188 === 0) pkt = 188;
      else if (size % 192 === 0) pkt = 192;
      else return false;
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(1);
        const syncOk = (pos) => { fs.readSync(fd, buf, 0, 1, pos); return buf[0] === 0x47; };
        if (!syncOk(0)) return false;
        if (!syncOk(size - pkt)) return false;
        if (size > pkt * 2 && !syncOk(Math.floor(size / 2 / pkt) * pkt)) return false;
        return true;
      } finally { fs.closeSync(fd); }
    } catch (e) { return false; }
  }

  /** 递归收集 MV_DIR/ts 下所有 .ts 的相对路径（正斜杠），每 200 个让出事件循环。 */
  async _scanDirRels() {
    const out = new Set();
    const walk = async (dir, prefix) => {
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of list) {
        if (this.state.stopRequested) return;
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        const p = path.join(dir, rel);
        if (ent.isDirectory()) await walk(p, rel);
        else if (ent.isFile() && /\.ts$/i.test(ent.name)) out.add(rel.replace(/\\/g, '/'));
        if ((out.size % 200) === 0) await new Promise((r) => setImmediate(r));
      }
    };
    await walk(this.tsDir, '');
    return out;
  }

  /**
   * 扫库补缺：比对目录与 MV_DIR，构建「缺失 + 损坏」补下队列。
   * 损坏文件先删除（腾出候选名），缺失的进入队列；目录里其它文件一律不动。
   * 返回 null 表示用户请求了停止。
   */
  async _buildScanQueue() {
    const entries = this._catalogEntries();
    if (!entries.length) return [];
    const from = Math.max(1, Number(this.state.from) || 1);
    const to = Math.min(entries.length, Number(this.state.to) || from);
    const names = await this._scanDirRels();
    if (this.state.stopRequested) return null;
    const queue = [];
    let scanned = 0, have = 0, invalid = 0;
    for (let i = from - 1; i < to; i++) {
      if (this.state.stopRequested) return null;
      const item = entries[i];
      if (item) {
        scanned++;
        let found = null;
        for (const name of this._nameCandidates(item)) {
          if (names.has(name)) { found = name; break; }
        }
        if (!found) queue.push(item);
        else {
          const p = path.join(this.tsDir, found);
          if (this.checkTsIntegrity(p)) have++;
          else {
            // 损坏：删除待补（删不掉就换候选名下载）
            try { fs.unlinkSync(p); } catch (e) {}
            invalid++;
            queue.push(item);
          }
        }
      }
      if ((scanned % 200) === 0) {
        this.state.scanned = scanned;
        this.state.have = have;
        this.state.invalid = invalid;
        this.state.current = `扫库中 ${scanned}/${to - from + 1}`;
        this._saveState();
        await new Promise((r) => setImmediate(r));   // 让出事件循环，不卡 HTTP 服务
      }
    }
    this.state.scanned = scanned;
    this.state.have = have;
    this.state.invalid = invalid;
    return queue;
  }

  async _run() {
    // 曲库目录就绪（无缓存则现场解析 muse.db，镜像已内置，无需手动导入）
    let entries = this._catalogEntries();
    if (!entries.length) {
      this.state.current = '正在解析曲库目录…';
      this._saveState();
      await this.importCatalog();
      entries = this._catalogEntries();
    }
    const n = entries.length;
    if (!n) throw new Error('muse.db 曲库目录为空（检查 muse.db 是否可用）');
    const from = Math.max(1, Number(this.state.from) || 1);
    let to = Number(this.state.to) || n;
    if (this.state.mode === 'scan') to = n;   // 扫库补缺永远覆盖全库
    to = Math.min(Math.max(to, from), n);
    this.state.from = from;
    this.state.to = to;

    // 构建下载队列：扫库补缺模式全库扫描，普通模式按 [from, to] 区间
    let queue;
    if (this.state.mode === 'scan') {
      const q = await this._buildScanQueue();
      if (!q) {   // 扫描期间请求停止
        this.state.running = false;
        this.state.current = '';
        this._saveState();
        return;
      }
      queue = q;
      this.state.total = queue.length;
      this.state.done = 0;
      this.state.failed = 0;
      this.state.current = '';
      this._saveState();
      log.info('BULK', `扫库补缺：已存在 ${this.state.have}，待补 ${queue.length}`);
    } else {
      queue = entries.slice(from - 1, to);
      this.state.total = queue.length;
      this._saveState();
    }
    let sinceSave = 0;

    const worker = async () => {
      while (queue.length > 0) {
        if (this.state.stopRequested) return;
        const item = queue.shift();
        if (!item) return;
        // 已存在直接跳过；扫库模式下完整性通过也跳过（目录里有重复曲目项，
        // 同一首歌可能被排两次，不能重复下载占成 [编号] 副本）
        const existing = this.existingPath(item);
        if (existing && (this.state.mode !== 'scan' || this.checkTsIntegrity(existing))) { this.state.done++; continue; }
        this.state.current = `${item.title}（${item.singer || '未知歌手'}）`;
        let target = null;
        try {
          const url = await muse.resolveMuseUrl(item.no);
          target = this._pickTarget(item);
          if (!target) { this.state.done++; continue; }
          await this._download(url, target);
          this.state.done++;
        } catch (e) {
          this.state.failed++;
          this.state.lastError = `${item.title}: ${(e && e.message) || e}`;
          if (target) { try { fs.unlinkSync(target + '.part'); } catch (e2) {} }
        }
        if (++sinceSave >= STATE_SAVE_EVERY) { sinceSave = 0; this._saveState(); }
      }
    };

    const workers = Array.from({ length: DL_CONCURRENCY }, () => worker());
    await Promise.all(workers);
    this.state.running = false;
    this.state.current = '';
    this._saveState();
    log.info('BULK', `批量下载结束：完成 ${this.state.done}，失败 ${this.state.failed}`);
    // 结束后自动扫一次曲库把新文件入库（失败不影响下载结果，可手动再扫）
    try {
      const { scanLibrary } = require('./scanner');
      await scanLibrary();
      log.info('BULK', '下载完成，曲库已自动扫描入库');
    } catch (e) { log.error('BULK', '自动扫描失败（请手动扫描曲库）: ' + e.message); }
  }

  _download(url, target, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(target + '.part');
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 60000, headers: { Accept: '*/*' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          file.close();
          return this._download(res.headers.location, target, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close(() => fs.unlink(target + '.part', () => {}));
          return reject(new Error('HTTP ' + res.statusCode));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => fs.rename(target + '.part', target, resolve)));
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', (e) => {
        file.close(() => fs.unlink(target + '.part', () => reject(e)));
      });
    });
  }
}

module.exports = { BulkDownloader };
