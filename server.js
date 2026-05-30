const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sewage_data.db');
const JSON_DB_FILE = path.join(__dirname, 'sewage_data.json');
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) { if (s.expires < now) sessions.delete(token); }
}, 600000);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); }
}));

// ==================== SQLite 数据层（双驱动：better-sqlite3 / sql.js） ====================
let db;
let dbType;

// sql.js 兼容层：提供与 better-sqlite3 一致的 API
class SqlJsCompat {
  constructor(sqlJsDb, dbPath) {
    this._db = sqlJsDb;
    this._dbPath = dbPath;
    // 定期保存到磁盘（sql.js 是内存数据库）
    this._saveTimer = setInterval(() => this._save(), 30000);
  }

  _save() {
    try {
      const data = this._db.export();
      fs.writeFileSync(this._dbPath, Buffer.from(data));
    } catch (e) { /* ignore save errors */ }
  }

  pragma(cmd) {
    try { this._db.exec('PRAGMA ' + cmd); } catch (e) { /* ignore pragma errors for sql.js */ }
  }

  prepare(sql) {
    const compatDb = this._db;
    return {
      get(...params) {
        const stmt = compatDb.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      },
      all(...params) {
        const stmt = compatDb.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows;
      },
      run(...params) {
        const stmt = compatDb.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        stmt.step();
        const changes = compatDb.getRowsModified();
        stmt.free();
        return { changes };
      }
    };
  }

  transaction(fn) {
    const self = this;
    return function (...args) {
      self._db.exec('BEGIN');
      try {
        const result = fn.apply(this, args);
        self._db.exec('COMMIT');
        return result;
      } catch (e) {
        self._db.exec('ROLLBACK');
        throw e;
      }
    };
  }

  exec(sql) {
    this._db.run(sql);
    // sql.js exec 支持多语句用 this._db.exec(sql)
    // 但 run 更安全（单条），这里保持 run
  }

  close() {
    this._save();
    clearInterval(this._saveTimer);
    this._db.close();
  }
}

// 尝试 better-sqlite3，失败则回退 sql.js
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  dbType = 'better-sqlite3';
  console.log('[DB] Using better-sqlite3');
} catch (e) {
  console.log('[DB] better-sqlite3 unavailable (' + e.message + '), falling back to sql.js');
  const initSqlJs = require('sql.js');
  const SQL = initSqlJs();
  // sql.js 初始化可能是同步的也可能是异步的，统一处理
  const sqlJsInit = SQL.then ? SQL : Promise.resolve(SQL);
  // 注意：这里会在 async IIFE 中完成初始化
  // 为简化流程，在 sql.js 分支下使用同步方式
}

// sql.js 需要异步初始化，包裹整个启动逻辑
if (dbType !== 'better-sqlite3') {
  (async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SqlJsCompat(new SQL.Database(fileBuffer), DB_PATH);
    } else {
      db = new SqlJsCompat(new SQL.Database(), DB_PATH);
    }
    dbType = 'sql.js';
    console.log('[DB] Using sql.js (local dev mode)');
    startServer();
  })();
} else {
  startServer();
}

function startServer() {

// ==================== 角色与权限定义 ====================
const ROLES = {
  '厂长': { canViewAll: true, canFill: false, canEdit: false, canReview: false, canExport: true, canManage: true, isMgmt: true },
  '副厂长': { canViewAll: true, canFill: false, canEdit: false, canReview: false, canExport: true, canManage: true, isMgmt: true },
  '运营管理部': { canViewAll: true, canFill: false, canEdit: false, canReview: false, canExport: true, canManage: false, isOps: true },
  '技术管理部': { canViewAll: true, canFill: false, canEdit: false, canReview: true, canExport: true, canManage: false, isTech: true },
  '文员': { canViewAll: true, canFill: false, canEdit: false, canReview: false, canExport: true, canManage: false, isClerk: true },
  '运营班组': { canViewAll: false, canFill: true, canEdit: false, canReview: false, canExport: false, canManage: false, isOps: true, fillOps: true },
  '化验主管': { canViewAll: false, canFill: false, canEdit: false, canReview: true, canExport: true, canManage: false, isTech: true, reviewLab: true },
  '化验员': { canViewAll: false, canFill: true, canEdit: false, canReview: false, canExport: false, canManage: false, isTech: true, fillLab: true },
};

// 角色可访问的表
function getAccessibleTables(role) {
  const r = ROLES[role] || {};
  if (r.canViewAll) return ['do_inspection','hourly_water','daily_lab','weekly_lab','sludge_special','dewatering','chemical_dosing','chemical_inventory','alerts','tasks','exportLog','users','daily','inspect','lab'];
  if (r.fillOps || r.isOps) return ['do_inspection','hourly_water','dewatering','chemical_dosing','chemical_inventory','tasks','alerts'];
  if (r.fillLab || r.reviewLab || r.isTech) return ['daily_lab','weekly_lab','sludge_special','tasks','alerts'];
  return ['tasks'];
}

// ==================== 字段中文映射 ====================
const CHINESE_FIELDS = {
  do_inspection: { id:'编号', date:'日期', shift:'班次', series:'系列', operator:'操作员', anaerobic:'厌氧池DO(mg/L)', anoxic:'缺氧池DO(mg/L)', aerobic1:'好氧池1DO(mg/L)', aerobic2:'好氧池2DO(mg/L)', aerobic3:'好氧池3DO(mg/L)', aerobic4:'好氧池4DO(mg/L)', remark:'备注', groupId:'班组', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  hourly_water: { id:'编号', date:'日期', hour:'小时', operator:'操作员', inCod:'进水COD(mg/L)', inNh3:'进水氨氮(mg/L)', inTn:'进水总氮(mg/L)', inTp:'进水总磷(mg/L)', inFlow:'进水流量(m³/h)', inPh:'进水pH', outCod:'出水COD(mg/L)', outNh3:'出水氨氮(mg/L)', outTn:'出水总氮(mg/L)', outTp:'出水总磷(mg/L)', outFlow:'出水流量(m³/h)', outPh:'出水pH', groupId:'班组', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  daily_lab: { id:'编号', date:'日期', operator:'化验员', reviewer:'审核人', reviewStatus:'审核状态', ph:'pH', ss:'SS(mg/L)', bod5:'BOD5(mg/L)', cod:'COD(mg/L)', nh3:'氨氮(mg/L)', tn:'总氮(mg/L)', tp:'总磷(mg/L)', fecalColiform:'粪大肠菌群(MPN/L)', sv30:'SV30(%)', svi:'SVI(mL/g)', mlss:'MLSS(mg/L)', microscope:'镜检记录', sv30East:'东系列SV30(%)', sv30West:'西系列SV30(%)', waterTempEast:'东系列水温(°C)', waterTempWest:'西系列水温(°C)', internalReflux:'内回流比(%)', externalReflux:'外回流比(%)', groupId:'班组', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  weekly_lab: { id:'编号', weekStart:'周起始', weekEnd:'周结束', operator:'化验员', chloride:'氯化物(mg/L)', mlvss:'MLVSS(mg/L)', totalSolid:'总固体(mg/L)', dissolvedSolid:'溶解性总固体(mg/L)', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  sludge_special: { id:'编号', date:'日期', batchNo:'批次号', operator:'化验员', waterContent:'污泥含水量(%)', ph:'污泥pH', organicMatter:'污泥有机质(%)', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  dewatering: { id:'编号', date:'日期', operator:'操作员', startTime:'开始时间', endTime:'结束时间', duration:'运行时长(h)', sludgeOutput:'污泥产量(吨)', abnormality:'异常备注', groupId:'班组', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  chemical_dosing: { id:'编号', date:'日期', shift:'班次', operator:'操作员', carbonSource:'碳源(kg)', glucose:'葡萄糖(kg)', pac:'PAC(kg)', anionPam:'阴离子PAM(kg)', cationPam:'阳离子PAM(kg)', naclo:'次氯酸钠(kg)', groupId:'班组', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  chemical_inventory: { id:'编号', date:'日期', operator:'操作员', chemicalType:'药剂类型', type:'操作类型', quantity:'数量(kg)', balance:'库存余额(kg)', supplier:'供应商', batchNo:'批号', remark:'备注', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  alerts: { id:'编号', time:'预警时间', type:'预警类型', level:'预警等级', source:'来源', title:'标题', detail:'详情', status:'状态', resolvedBy:'处理人', resolvedTime:'处理时间' },
  tasks: { id:'编号', title:'任务标题', type:'任务类型', priority:'优先级', status:'状态', assignedTo:'负责人', deadline:'截止日期', remark:'备注', createTime:'创建时间' },
  users: { id:'编号', username:'用户名', name:'姓名', role:'角色', phone:'手机号', groupId:'班组', status:'状态', createTime:'创建时间' },
  exportLog: { id:'编号', table:'导出表', count:'导出条数', operator:'操作员', time:'导出时间' },
};

// ==================== 建表与迁移 ====================
const ALL_TABLES = ['do_inspection','hourly_water','daily_lab','weekly_lab','sludge_special','dewatering','chemical_dosing','chemical_inventory','alerts','tasks','exportLog','users','daily','inspect','lab'];

/** 所有表结构定义：表名 → 列定义字符串 */
const TABLE_SCHEMAS = {
  do_inspection: 'id TEXT PRIMARY KEY, date TEXT, shift TEXT, series TEXT, operator TEXT, anaerobic TEXT, anoxic TEXT, aerobic1 TEXT, aerobic2 TEXT, aerobic3 TEXT, aerobic4 TEXT, remark TEXT, groupId TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  hourly_water: 'id TEXT PRIMARY KEY, date TEXT, hour TEXT, operator TEXT, inCod TEXT, inNh3 TEXT, inTn TEXT, inTp TEXT, inFlow TEXT, inPh TEXT, outCod TEXT, outNh3 TEXT, outTn TEXT, outTp TEXT, outFlow TEXT, outPh TEXT, groupId TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  daily_lab: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, reviewer TEXT, reviewStatus TEXT, ph TEXT, ss TEXT, bod5 TEXT, cod TEXT, nh3 TEXT, tn TEXT, tp TEXT, fecalColiform TEXT, sv30 TEXT, svi TEXT, mlss TEXT, microscope TEXT, sv30East TEXT, sv30West TEXT, waterTempEast TEXT, waterTempWest TEXT, internalReflux TEXT, externalReflux TEXT, groupId TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  weekly_lab: 'id TEXT PRIMARY KEY, weekStart TEXT, weekEnd TEXT, operator TEXT, chloride TEXT, mlvss TEXT, totalSolid TEXT, dissolvedSolid TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  sludge_special: 'id TEXT PRIMARY KEY, date TEXT, batchNo TEXT, operator TEXT, waterContent TEXT, ph TEXT, organicMatter TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  dewatering: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, startTime TEXT, endTime TEXT, duration TEXT, sludgeOutput TEXT, abnormality TEXT, groupId TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  chemical_dosing: 'id TEXT PRIMARY KEY, date TEXT, shift TEXT, operator TEXT, carbonSource TEXT, glucose TEXT, pac TEXT, anionPam TEXT, cationPam TEXT, naclo TEXT, groupId TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  chemical_inventory: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, chemicalType TEXT, type TEXT, quantity TEXT, balance TEXT, supplier TEXT, batchNo TEXT, remark TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  alerts: 'id TEXT PRIMARY KEY, time TEXT, type TEXT, level TEXT, source TEXT, title TEXT, detail TEXT, status TEXT, resolvedBy TEXT, resolvedTime TEXT',
  tasks: 'id TEXT PRIMARY KEY, title TEXT, type TEXT, priority TEXT, status TEXT, assignedTo TEXT, deadline TEXT, remark TEXT, createTime TEXT',
  users: 'id TEXT PRIMARY KEY, username TEXT, name TEXT, role TEXT, phone TEXT, groupId TEXT, status TEXT, password TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  exportLog: 'id TEXT PRIMARY KEY, [table] TEXT, count TEXT, operator TEXT, time TEXT',
  // 兼容旧表
  daily: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, remark TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  inspect: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, remark TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  lab: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, remark TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
};

function initDB() {
  // 建表
  for (const [table, cols] of Object.entries(TABLE_SCHEMAS)) {
    db.prepare('CREATE TABLE IF NOT EXISTS [' + table + '] (' + cols + ')').run();
  }

  // 首次启动：从 JSON 迁移
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (userCount === 0 && fs.existsSync(JSON_DB_FILE)) {
    try {
      const jsonData = JSON.parse(fs.readFileSync(JSON_DB_FILE, 'utf8'));
      console.log('正在从 JSON 迁移数据到 SQLite...');
      const migrateTable = (tableName) => {
        const rows = jsonData[tableName];
        if (!Array.isArray(rows) || rows.length === 0) return;
        const columns = Object.keys(rows[0]);
        const colList = columns.map(c => '[' + c + ']').join(',');
        const placeholders = columns.map(() => '?').join(',');
        const insertStmt = db.prepare('INSERT OR IGNORE INTO [' + tableName + '] (' + colList + ') VALUES (' + placeholders + ')');
        const migrateMany = db.transaction((items) => {
          for (const row of items) {
            const vals = columns.map(c => row[c] !== undefined && row[c] !== null ? String(row[c]) : null);
            insertStmt.run(...vals);
          }
        });
        migrateMany(rows);
        console.log('  迁移 ' + tableName + ': ' + rows.length + ' 条');
      };
      for (const table of Object.keys(TABLE_SCHEMAS)) {
        if (jsonData[table]) migrateTable(table);
      }
      console.log('JSON → SQLite 迁移完成');
    } catch (err) {
      console.error('JSON 迁移失败:', err.message);
    }
  }

  // 初始化预置用户（如果 users 表为空且没有从 JSON 迁移）
  const finalCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (finalCount === 0) {
    const insertUser = db.prepare('INSERT INTO users (id, username, name, role, phone, groupId, status, password, createTime) VALUES (?,?,?,?,?,?,?,?,?)');
    const insertMany = db.transaction((users) => {
      for (const u of users) insertUser.run(...u);
    });
    const now = new Date().toISOString();
    insertMany([
      ['u1', 'cz01', '张厂长', '厂长', '13800000001', '', 'active', '123456', now],
      ['u2', 'fcz01', '李副厂长', '副厂长', '13800000002', '', 'active', '123456', now],
      ['u3', 'yygl01', '王运营主管', '运营管理部', '13800000003', '', 'active', '123456', now],
      ['u4', 'jsgl01', '赵技术主管', '技术管理部', '13800000004', '', 'active', '123456', now],
      ['u5', 'wy01', '陈文员', '文员', '13800000005', '', 'active', '123456', now],
      ['u6', 'wy02', '刘文员', '文员', '13800000006', '', 'active', '123456', now],
      ['u7', 'yyb01a', '周班组1A', '运营班组', '13800000007', 'group1', 'active', '123456', now],
      ['u8', 'yyb01b', '吴班组1B', '运营班组', '13800000008', 'group1', 'active', '123456', now],
      ['u9', 'yyb02a', '郑班组2A', '运营班组', '13800000009', 'group2', 'active', '123456', now],
      ['u10', 'yyb02b', '冯班组2B', '运营班组', '13800000010', 'group2', 'active', '123456', now],
      ['u11', 'yyb03a', '褚班组3A', '运营班组', '13800000011', 'group3', 'active', '123456', now],
      ['u12', 'yyb03b', '卫班组3B', '运营班组', '13800000012', 'group3', 'active', '123456', now],
      ['u13', 'yyb04a', '蒋班组4A', '运营班组', '13800000013', 'group4', 'active', '123456', now],
      ['u14', 'yyb04b', '沈班组4B', '运营班组', '13800000014', 'group4', 'active', '123456', now],
      ['u15', 'hyz01', '韩化验主管', '化验主管', '13800000015', '', 'active', '123456', now],
      ['u16', 'hy01', '杨化验员1', '化验员', '13800000016', '', 'active', '123456', now],
      ['u17', 'hy02', '朱化验员2', '化验员', '13800000017', '', 'active', '123456', now],
      ['u18', 'hy03', '秦化验员3', '化验员', '13800000018', '', 'active', '123456', now],
      ['u19', 'hy04', '许化验员4', '化验员', '13800000019', '', 'active', '123456', now],
      ['u20', 'hy05', '何化验员5', '化验员', '13800000020', '', 'active', '123456', now],
      ['u21', 'hy06', '吕化验员6', '化验员', '13800000021', '', 'active', '123456', now],
      ['u22', 'admin', '系统管理员', '厂长', '13900000000', '', 'active', 'admin123', now],
    ]);
  }
}
initDB();

// ==================== 通用数据访问辅助 ====================
/** 安全获取表所有行 */
function selectAll(table) {
  return db.prepare('SELECT * FROM [' + table + ']').all();
}

/** 根据条件获取行 */
function selectWhere(table, whereClause, params) {
  return db.prepare('SELECT * FROM [' + table + '] WHERE ' + whereClause).all(...(params || []));
}

/** 插入一行 */
function insertRow(table, record) {
  const keys = Object.keys(record);
  const colList = keys.map(k => '[' + k + ']').join(',');
  const placeholders = keys.map(() => '?').join(',');
  const vals = keys.map(k => record[k] !== undefined && record[k] !== null ? String(record[k]) : null);
  db.prepare('INSERT INTO [' + table + '] (' + colList + ') VALUES (' + placeholders + ')').run(...vals);
}

/** 更新一行 */
function updateRow(table, id, updates) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'id') continue;
    sets.push('[' + k + ']=?');
    vals.push(v !== undefined && v !== null ? String(v) : null);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare('UPDATE [' + table + '] SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
}

/** 删除一行 */
function deleteRow(table, id) {
  db.prepare('DELETE FROM [' + table + '] WHERE id=?').run(id);
}

/** 获取一行 */
function getRow(table, id) {
  return db.prepare('SELECT * FROM [' + table + '] WHERE id=?').get(id);
}

// 字段翻译API
app.get('/api/fields/:table', authMiddleware, (req, res) => {
  res.json(CHINESE_FIELDS[req.params.table] || {});
});

// ==================== 认证中间件 ====================
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (session) sessions.delete(token);
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  req.user = session.user;
  req.userRole = session.user.role;
  req.userPermissions = ROLES[session.user.role] || {};
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole) && !ROLES[req.userRole]?.canManage) {
      return res.status(403).json({ error: '无此操作权限' });
    }
    next();
  };
}

// ==================== 认证路由 ====================
app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ? AND status = ?').get(username, password, 'active');
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const token = crypto.randomUUID();
  sessions.set(token, { userId: user.id, user: { id: user.id, username: user.username, name: user.name, role: user.role, groupId: user.groupId, phone: user.phone }, expires: Date.now() + 86400000 });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, groupId: user.groupId, permissions: ROLES[user.role] || {} } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user, permissions: req.userPermissions });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  sessions.delete(token);
  res.json({ success: true });
});

// ==================== 通用CRUD路由 ====================
function crudRoutes(table) {
  // GET 列表（支持分页和筛选）
  app.get('/api/' + table, authMiddleware, (req, res) => {
    if (!ALL_TABLES.includes(table)) return res.status(404).json({ error: '表不存在' });

    let rows;
    // 权限过滤
    if (table === 'users' && !req.userPermissions.canManage) {
      rows = db.prepare('SELECT id, username, name, role, phone, groupId, status, createTime FROM users').all();
    } else if (req.userRole === '运营班组' && req.user.groupId) {
      rows = db.prepare('SELECT * FROM [' + table + '] WHERE groupId = ?').all(req.user.groupId);
      // 也包含 operator 匹配的记录
      const byOperator = db.prepare('SELECT * FROM [' + table + '] WHERE operator = ? OR operator = ?').all(req.user.name, req.user.username);
      const ids = new Set(rows.map(r => r.id));
      for (const r of byOperator) {
        if (!ids.has(r.id)) rows.push(r);
      }
    } else if (req.userRole === '化验员') {
      rows = db.prepare('SELECT * FROM [' + table + '] WHERE operator = ? OR operator = ?').all(req.user.name, req.user.username);
    } else {
      rows = selectAll(table);
    }

    // 查询参数筛选
    if (req.query.date) { rows = rows.filter(r => r.date === req.query.date); }
    if (req.query.dateFrom && req.query.dateTo) { rows = rows.filter(r => r.date >= req.query.dateFrom && r.date <= req.query.dateTo); }
    if (req.query.type) { rows = rows.filter(r => r.type === req.query.type || r.chemicalType === req.query.type); }
    if (req.query.status) { rows = rows.filter(r => r.status === req.query.status); }

    // 分页
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const total = rows.length;
    const start = (page - 1) * limit;
    const paged = rows.slice(start, start + limit);
    res.json({ data: paged, total, page, limit, totalPages: Math.ceil(total / limit) });
  });

  // POST 新增
  app.post('/api/' + table, authMiddleware, (req, res) => {
    const perms = req.userPermissions;
    // 权限检查
    if (table === 'users' && !perms.canManage) return res.status(403).json({ error: '无用户管理权限' });
    const record = req.body;
    record.id = record.id || (table + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    record.createTime = record.createTime || new Date().toISOString();
    if (!record.operator && req.user.name) record.operator = req.user.name;
    if (req.user.groupId && !record.groupId) record.groupId = req.user.groupId;

    insertRow(table, record);

    // 自动触发预警检测
    if (['do_inspection','hourly_water','daily_lab','weekly_lab','chemical_dosing'].includes(table)) {
      checkAlerts(table, record);
    }
    res.json({ success: true, id: record.id });
  });

  // PUT 更新
  app.put('/api/' + table + '/:id', authMiddleware, (req, res) => {
    const existing = getRow(table, req.params.id);
    if (!existing) return res.status(404).json({ error: '记录不存在' });
    // 已提交数据防篡改（运营班组/化验员不可修改他人数据）
    if ((req.userRole === '运营班组' || req.userRole === '化验员') && existing.operator && existing.operator !== req.user.name && existing.operator !== req.user.username) {
      return res.status(403).json({ error: '不可修改他人数据' });
    }
    const updates = { ...req.body, id: req.params.id, updateTime: new Date().toISOString(), updatedBy: req.user.name };
    updateRow(table, req.params.id, updates);
    res.json({ success: true });
  });

  // DELETE 删除
  app.delete('/api/' + table + '/:id', authMiddleware, (req, res) => {
    if (!req.userPermissions.canManage && req.userRole !== '厂长' && req.userRole !== '副厂长') {
      if (table === 'users') return res.status(403).json({ error: '无权限删除用户' });
    }
    const existing = getRow(table, req.params.id);
    if (!existing) return res.status(404).json({ error: '记录不存在' });
    deleteRow(table, req.params.id);
    res.json({ success: true });
  });

  // POST 批量导入
  app.post('/api/' + table + '/bulk', authMiddleware, (req, res) => {
    const records = req.body.records || req.body;
    if (!Array.isArray(records)) return res.status(400).json({ error: '数据格式错误' });
    const bulkInsert = db.transaction((items) => {
      for (const r of items) {
        r.id = r.id || (table + '_b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
        r.createTime = r.createTime || new Date().toISOString();
        if (!r.operator && req.user.name) r.operator = req.user.name;
        insertRow(table, r);
      }
    });
    bulkInsert(records);
    res.json({ success: true, count: records.length });
  });
}

ALL_TABLES.forEach(t => crudRoutes(t));

// ==================== 用户管理API ====================
// 创建用户（厂长/副厂长权限）
app.post('/api/users', authMiddleware, requireRole('厂长', '副厂长'), (req, res) => {
  const { username, name, role, phone, groupId, password } = req.body;
  if (!username || !name || !role || !password) return res.status(400).json({ error: '缺少必填字段' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: '用户名已存在' });
  const id = 'u' + Date.now();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id, username, name, role, phone, groupId, status, password, createTime) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, username, name, role, phone || '', groupId || '', 'active', password, now);
  res.json({ id, username, name, role });
});

// 更新用户
app.put('/api/users/:id', authMiddleware, requireRole('厂长', '副厂长'), (req, res) => {
  const { name, role, phone, groupId, password, status } = req.body;
  const sets = [];
  const vals = [];
  if (name) { sets.push('name=?'); vals.push(name); }
  if (role) { sets.push('role=?'); vals.push(role); }
  if (phone) { sets.push('phone=?'); vals.push(phone); }
  if (groupId !== undefined) { sets.push('groupId=?'); vals.push(groupId); }
  if (password) { sets.push('password=?'); vals.push(password); }
  if (status) { sets.push('status=?'); vals.push(status); }
  if (sets.length === 0) return res.status(400).json({ error: '无更新字段' });
  sets.push('updateTime=?'); vals.push(new Date().toISOString());
  vals.push(req.params.id);
  db.prepare('UPDATE users SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
  res.json({ ok: true });
});

// 删除用户（软删除 - 设为 inactive）
app.delete('/api/users/:id', authMiddleware, requireRole('厂长', '副厂长'), (req, res) => {
  db.prepare('UPDATE users SET status=? WHERE id=?').run('inactive', req.params.id);
  res.json({ ok: true });
});

// ==================== 预警检测引擎 ====================
function checkAlerts(table, record) {
  const now = new Date().toISOString();
  const newAlerts = [];

  if (table === 'hourly_water') {
    if (record.outCod && Number(record.outCod) > 50) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_cod', time: now, type: '水质异常', level: 'high', source: '小时进出水', title: '出水COD超标: ' + record.outCod + 'mg/L', detail: record.date + ' ' + record.hour + ':00 出水COD=' + record.outCod + 'mg/L（一级A标准: ≤50mg/L）', status: 'active' });
    }
    if (record.outNh3 && Number(record.outNh3) > 5) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_nh3', time: now, type: '水质异常', level: 'high', source: '小时进出水', title: '出水氨氮超标: ' + record.outNh3 + 'mg/L', detail: record.date + ' ' + record.hour + ':00 出水氨氮=' + record.outNh3 + 'mg/L（标准: ≤5mg/L）', status: 'active' });
    }
    if (record.outTn && Number(record.outTn) > 15) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_tn', time: now, type: '水质异常', level: 'medium', source: '小时进出水', title: '出水总氮超标: ' + record.outTn + 'mg/L', detail: record.date + ' ' + record.hour + ':00 出水总氮=' + record.outTn + 'mg/L（标准: ≤15mg/L）', status: 'active' });
    }
    if (record.outTp && Number(record.outTp) > 0.5) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_tp', time: now, type: '水质异常', level: 'medium', source: '小时进出水', title: '出水总磷超标: ' + record.outTp + 'mg/L', detail: record.date + ' ' + record.hour + ':00 出水总磷=' + record.outTp + 'mg/L（标准: ≤0.5mg/L）', status: 'active' });
    }
  }

  if (table === 'do_inspection') {
    const checkDO = (val, pool) => {
      if (val !== undefined && val !== null && val !== '') {
        const v = Number(val);
        if (v < 0.5) newAlerts.push({ id: 'alt_' + Date.now() + '_do_low_' + pool, time: now, type: 'DO异常', level: 'high', source: 'DO巡检', title: pool + '溶解氧过低: ' + v + 'mg/L', detail: record.date + ' ' + record.series + '系列 ' + pool + ' DO=' + v + 'mg/L（正常: 0.5-4.0mg/L）', status: 'active' });
        if (v > 4.0) newAlerts.push({ id: 'alt_' + Date.now() + '_do_high_' + pool, time: now, type: 'DO异常', level: 'medium', source: 'DO巡检', title: pool + '溶解氧过高: ' + v + 'mg/L', detail: record.date + ' ' + record.series + '系列 ' + pool + ' DO=' + v + 'mg/L（正常: 0.5-4.0mg/L）', status: 'active' });
      }
    };
    checkDO(record.anaerobic, '厌氧池'); checkDO(record.anoxic, '缺氧池');
    checkDO(record.aerobic1, '好氧池1'); checkDO(record.aerobic2, '好氧池2');
    checkDO(record.aerobic3, '好氧池3'); checkDO(record.aerobic4, '好氧池4');
  }

  if (table === 'daily_lab') {
    if (record.sv30 && (Number(record.sv30) < 15 || Number(record.sv30) > 35)) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_sv30', time: now, type: '污泥异常', level: 'medium', source: '每日化验', title: 'SV30偏离正常区间: ' + record.sv30 + '%', detail: 'SV30=' + record.sv30 + '%（正常: 15-35%）', status: 'active' });
    }
    if (record.svi && (Number(record.svi) < 50 || Number(record.svi) > 150)) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_svi', time: now, type: '污泥异常', level: 'medium', source: '每日化验', title: 'SVI异常: ' + record.svi + 'mL/g', detail: 'SVI=' + record.svi + 'mL/g（正常: 50-150mL/g）', status: 'active' });
    }
    if (record.mlss && (Number(record.mlss) < 2000 || Number(record.mlss) > 6000)) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_mlss', time: now, type: '污泥异常', level: 'medium', source: '每日化验', title: 'MLSS偏离正常区间: ' + record.mlss + 'mg/L', detail: 'MLSS=' + record.mlss + 'mg/L（正常: 2000-6000mg/L）', status: 'active' });
    }
  }

  if (table === 'chemical_dosing') {
    // 投加后检查库存
    const chemicals = ['carbonSource','glucose','pac','anionPam','cationPam','naclo'];
    const typeNames = { carbonSource: '碳源', glucose: '葡萄糖', pac: 'PAC', anionPam: '阴离子PAM', cationPam: '阳离子PAM', naclo: '次氯酸钠' };
    chemicals.forEach(ck => {
      const used = Number(record[ck]) || 0;
      if (used > 0) {
        const balance = getCurrentStock(ck);
        if (balance < 100) {
          newAlerts.push({ id: 'alt_' + Date.now() + '_stock_' + ck, time: now, type: '库存预警', level: 'high', source: '药剂库存', title: typeNames[ck] + '库存不足: ' + balance.toFixed(0) + 'kg', detail: '当前' + typeNames[ck] + '库存仅剩' + balance.toFixed(0) + 'kg，请及时采购补充', status: 'active' });
        } else if (balance < 500) {
          newAlerts.push({ id: 'alt_' + Date.now() + '_stock_low_' + ck, time: now, type: '库存预警', level: 'medium', source: '药剂库存', title: typeNames[ck] + '库存偏低: ' + balance.toFixed(0) + 'kg', detail: '当前' + typeNames[ck] + '库存' + balance.toFixed(0) + 'kg，建议补充', status: 'active' });
        }
      }
    });
  }

  if (newAlerts.length > 0) {
    const insertAlerts = db.transaction((items) => {
      for (const a of items) insertRow('alerts', a);
    });
    insertAlerts(newAlerts);
  }
}

function getCurrentStock(chemicalKey) {
  const records = selectAll('chemical_inventory');
  const totalIn = records.filter(r => r.chemicalType === chemicalKey && r.type === 'in').reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  const totalOut = records.filter(r => r.chemicalType === chemicalKey && (r.type === 'out' || r.type === 'use')).reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  return totalIn - totalOut;
}

// ==================== 业务API ====================

// 预警
app.get('/api/alerts/active', authMiddleware, (req, res) => {
  const active = db.prepare('SELECT * FROM alerts WHERE status = ? ORDER BY time DESC').all('active');
  res.json(active);
});

app.put('/api/alerts/:id/resolve', authMiddleware, (req, res) => {
  const alert = getRow('alerts', req.params.id);
  if (!alert) return res.status(404).json({ error: '预警不存在' });
  updateRow('alerts', req.params.id, { status: 'resolved', resolvedBy: req.user.name, resolvedTime: new Date().toISOString() });
  res.json({ success: true });
});

// 实时信息流
app.get('/api/stream', authMiddleware, (req, res) => {
  const items = [];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const typeNames = { carbonSource: '碳源', glucose: '葡萄糖', pac: 'PAC', anionPam: '阴离子PAM', cationPam: '阳离子PAM', naclo: '次氯酸钠' };

  // 预警
  const activeAlerts = db.prepare('SELECT * FROM alerts WHERE status = ? ORDER BY time DESC LIMIT 20').all('active');
  activeAlerts.forEach(a => {
    items.push({ id: 's_' + a.id, time: a.time, type: '异常', level: a.level, icon: a.level === 'high' ? '🚨' : '⚠️', title: a.title, detail: a.detail, tag: a.type, link: 'alerts' });
  });

  // 最近提交
  const submitSources = [
    { tableName: 'do_inspection', label: 'DO巡检', link: 'fill' },
    { tableName: 'hourly_water', label: '小时进出水', link: 'fill' },
    { tableName: 'daily_lab', label: '每日化验', link: 'fill' },
    { tableName: 'chemical_dosing', label: '药剂投加', link: 'fill' },
    { tableName: 'dewatering', label: '脱泥生产', link: 'fill' },
  ];
  submitSources.forEach(src => {
    const sorted = db.prepare('SELECT * FROM [' + src.tableName + '] ORDER BY createTime DESC LIMIT 5').all();
    sorted.forEach(r => {
      items.push({ id: 'sub_' + r.id, time: r.createTime, type: '报送', level: 'info', icon: '📤', title: src.label + '记录已提交', detail: (r.date || '') + ' ' + (r.operator || ''), tag: src.label, link: src.link });
    });
  });

  // 任务
  const doneTasks = db.prepare("SELECT * FROM tasks WHERE status = '已完成' ORDER BY createTime DESC LIMIT 5").all();
  doneTasks.forEach(t => {
    items.push({ id: 'done_' + t.id, time: t.createTime, type: '动态', level: 'info', icon: '✅', title: '任务完成: ' + t.title, detail: t.type + ' | ' + (t.assignedTo || ''), tag: '任务', link: 'tasks' });
  });
  const urgentTasks = db.prepare("SELECT * FROM tasks WHERE status = '待处理' AND priority = '高' ORDER BY createTime DESC LIMIT 5").all();
  urgentTasks.forEach(t => {
    items.push({ id: 'urg_' + t.id, time: t.createTime, type: '动态', level: 'high', icon: '⏳', title: '待处理: ' + t.title, detail: '截止: ' + (t.deadline || '-'), tag: '紧急', link: 'tasks' });
  });

  // 库存低
  ['carbonSource','glucose','pac','anionPam','cationPam','naclo'].forEach(ck => {
    const bal = getCurrentStock(ck);
    if (bal < 500) {
      items.push({ id: 'stock_' + ck, time: now.toISOString(), type: '异常', level: bal < 100 ? 'high' : 'medium', icon: '📦', title: typeNames[ck] + '库存: ' + bal.toFixed(0) + 'kg', detail: bal < 100 ? '库存严重不足，请立即采购' : '库存偏低，建议补充', tag: '库存', link: 'inventory' });
    }
  });

  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json({ items: items.slice(0, 60), total: items.length, generatedAt: now.toISOString() });
});

// 统计总览
app.get('/api/stats/summary', authMiddleware, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const activeAlerts = db.prepare("SELECT * FROM alerts WHERE status = 'active'").all();
  const pendingTasks = db.prepare("SELECT * FROM tasks WHERE status != '已完成'").all();
  const todayInspection = db.prepare('SELECT * FROM do_inspection WHERE date = ?').all(today);
  const todayHourly = db.prepare('SELECT * FROM hourly_water WHERE date = ?').all(today);
  const todayLab = db.prepare('SELECT * FROM daily_lab WHERE date = ?').all(today);
  const stockAlerts = ['carbonSource','glucose','pac','anionPam','cationPam','naclo'].filter(ck => getCurrentStock(ck) < 500);
  res.json({
    today: { inspection: todayInspection.length, hourly: todayHourly.length, lab: todayLab.length },
    alerts: { active: activeAlerts.length, high: activeAlerts.filter(a => a.level === 'high').length },
    tasks: { pending: pendingTasks.length, urgent: pendingTasks.filter(t => t.priority === '高').length },
    inventory: { lowStock: stockAlerts.length },
    totals: { inspection: db.prepare('SELECT COUNT(*) as cnt FROM do_inspection').get().cnt, hourly: db.prepare('SELECT COUNT(*) as cnt FROM hourly_water').get().cnt, lab: db.prepare('SELECT COUNT(*) as cnt FROM daily_lab').get().cnt, inventory: db.prepare('SELECT COUNT(*) as cnt FROM chemical_inventory').get().cnt }
  });
});

// 趋势数据
app.get('/api/trends', authMiddleware, (req, res) => {
  const range = parseInt(req.query.range) || 7;
  const type = req.query.type || 'water';
  const startDate = new Date(); startDate.setDate(startDate.getDate() - range + 1);
  const dates = []; for (let i = 0; i < range; i++) { const d = new Date(startDate); d.setDate(d.getDate() + i); dates.push(d.toISOString().slice(0, 10)); }

  let series = { labels: dates.map(d => d.slice(5)), datasets: [] };

  if (type === 'water') {
    const data = db.prepare('SELECT * FROM hourly_water WHERE date >= ?').all(dates[0]);
    const dailyAvg = {};
    dates.forEach(d => {
      const dayRecords = data.filter(r => r.date === d);
      if (dayRecords.length > 0) {
        dailyAvg[d] = {
          inCod: avg(dayRecords, 'inCod'), outCod: avg(dayRecords, 'outCod'),
          inNh3: avg(dayRecords, 'inNh3'), outNh3: avg(dayRecords, 'outNh3'),
          inTn: avg(dayRecords, 'inTn'), outTn: avg(dayRecords, 'outTn'),
          inTp: avg(dayRecords, 'inTp'), outTp: avg(dayRecords, 'outTp'),
        };
      }
    });
    series.datasets = [
      { label: '进水COD', data: dates.map(d => dailyAvg[d]?.inCod || null), borderColor: '#3498db', tension: 0.3 },
      { label: '出水COD', data: dates.map(d => dailyAvg[d]?.outCod || null), borderColor: '#e74c3c', tension: 0.3 },
      { label: '进水氨氮', data: dates.map(d => dailyAvg[d]?.inNh3 || null), borderColor: '#2ecc71', tension: 0.3, hidden: true },
      { label: '出水氨氮', data: dates.map(d => dailyAvg[d]?.outNh3 || null), borderColor: '#f39c12', tension: 0.3, hidden: true },
      { label: '出水总氮', data: dates.map(d => dailyAvg[d]?.outTn || null), borderColor: '#9b59b6', tension: 0.3, hidden: true },
      { label: '出水总磷', data: dates.map(d => dailyAvg[d]?.outTp || null), borderColor: '#1abc9c', tension: 0.3, hidden: true },
    ];
  } else if (type === 'do') {
    const data = db.prepare("SELECT * FROM do_inspection WHERE date >= ? AND series = 'east'").all(dates[0]);
    const doMap = {};
    data.forEach(r => { if (!doMap[r.date]) doMap[r.date] = []; doMap[r.date].push(r); });
    const dailyDO = {};
    dates.forEach(d => {
      const recs = doMap[d] || [];
      if (recs.length > 0) {
        dailyDO[d] = { anaerobic: avg(recs, 'anaerobic'), anoxic: avg(recs, 'anoxic'), aerobic1: avg(recs, 'aerobic1'), aerobic2: avg(recs, 'aerobic2'), aerobic3: avg(recs, 'aerobic3'), aerobic4: avg(recs, 'aerobic4') };
      }
    });
    series.datasets = [
      { label: '厌氧池DO', data: dates.map(d => dailyDO[d]?.anaerobic || null), borderColor: '#e74c3c', tension: 0.3 },
      { label: '缺氧池DO', data: dates.map(d => dailyDO[d]?.anoxic || null), borderColor: '#3498db', tension: 0.3 },
      { label: '好氧池1 DO', data: dates.map(d => dailyDO[d]?.aerobic1 || null), borderColor: '#2ecc71', tension: 0.3 },
      { label: '好氧池2 DO', data: dates.map(d => dailyDO[d]?.aerobic2 || null), borderColor: '#f39c12', tension: 0.3 },
      { label: '好氧池3 DO', data: dates.map(d => dailyDO[d]?.aerobic3 || null), borderColor: '#9b59b6', tension: 0.3 },
      { label: '好氧池4 DO', data: dates.map(d => dailyDO[d]?.aerobic4 || null), borderColor: '#1abc9c', tension: 0.3 },
    ];
  } else if (type === 'sludge') {
    const data = db.prepare('SELECT * FROM daily_lab WHERE date >= ?').all(dates[0]);
    const svMap = {}, mlssMap = {};
    data.forEach(r => { svMap[r.date] = Number(r.sv30) || null; mlssMap[r.date] = Number(r.mlss) || null; });
    series.datasets = [
      { label: 'SV30(%)', data: dates.map(d => svMap[d] || null), borderColor: '#e74c3c', tension: 0.3, yAxisID: 'y' },
      { label: 'MLSS(mg/L)', data: dates.map(d => mlssMap[d] || null), borderColor: '#3498db', tension: 0.3, yAxisID: 'y1' },
    ];
  } else if (type === 'chemical') {
    const data = db.prepare('SELECT * FROM chemical_dosing WHERE date >= ?').all(dates[0]);
    const chemMap = {};
    data.forEach(r => { if (!chemMap[r.date]) chemMap[r.date] = []; chemMap[r.date].push(r); });
    const dailyChem = {};
    dates.forEach(d => { const recs = chemMap[d] || []; if (recs.length > 0) { dailyChem[d] = { carbonSource: avg(recs, 'carbonSource'), glucose: avg(recs, 'glucose'), pac: avg(recs, 'pac'), anionPam: avg(recs, 'anionPam'), cationPam: avg(recs, 'cationPam'), naclo: avg(recs, 'naclo') }; } });
    series.datasets = [
      { label: '碳源(kg)', data: dates.map(d => dailyChem[d]?.carbonSource || null), borderColor: '#e74c3c', tension: 0.3 },
      { label: 'PAC(kg)', data: dates.map(d => dailyChem[d]?.pac || null), borderColor: '#3498db', tension: 0.3 },
      { label: '葡萄糖(kg)', data: dates.map(d => dailyChem[d]?.glucose || null), borderColor: '#2ecc71', tension: 0.3, hidden: true },
      { label: '次氯酸钠(kg)', data: dates.map(d => dailyChem[d]?.naclo || null), borderColor: '#9b59b6', tension: 0.3, hidden: true },
    ];
  }
  res.json(series);
});

function avg(arr, key) {
  const vals = arr.map(r => Number(r[key])).filter(v => !isNaN(v));
  return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) / 100 : null;
}

// ==================== 辅助函数：统计均值/趋势 ====================
function trend(arr) {
  if (!arr || arr.length < 3) return '数据不足';
  const first3 = arr.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const last3 = arr.slice(-3).reduce((a, b) => a + b, 0) / 3;
  if (last3 > first3 * 1.05) return '上升';
  if (last3 < first3 * 0.95) return '下降';
  return '稳定';
}

// ==================== 智能加药算法（数据驱动综合判定） ====================
app.get('/api/dosing/analysis', authMiddleware, (req, res) => {
  const autoMode = req.query.auto === '1';

  // ===== Step 1: 获取输入参数（自动或手动） =====
  let inFlow, inCod, inNh3, inTn, inTp, outCod, outNh3, outTn, outTp;
  let dataSource = 'manual';

  if (autoMode) {
    // 自动从最近7天小时进出水数据取均值
    const today = new Date().toISOString().slice(0, 10);
    const d7 = new Date(); d7.setDate(d7.getDate() - 7);
    const dateFrom = d7.toISOString().slice(0, 10);

    const recentWater = db.prepare('SELECT * FROM hourly_water WHERE date >= ? AND date <= ?').all(dateFrom, today);
    const recentLab = db.prepare('SELECT * FROM daily_lab WHERE date >= ? AND date <= ?').all(dateFrom, today);

    if (recentWater.length < 5) {
      return res.status(400).json({ error: '最近7天数据不足（需至少5条记录），请先录入小时进出水数据或切换为手动输入模式' });
    }

    // 取最近24小时作为"当前进水"
    const recent24h = recentWater.filter(r => {
      const d = new Date(r.date + 'T' + String(r.hour).padStart(2, '0') + ':00:00');
      return d >= new Date(Date.now() - 24 * 3600000);
    });
    const sample = recent24h.length >= 4 ? recent24h : recentWater.slice(-24);

    inCod = avg(sample.map(r => Number(r.inCod)).filter(v => v > 0));
    inNh3 = avg(sample.map(r => Number(r.inNh3)).filter(v => v > 0));
    inTn = avg(sample.map(r => Number(r.inTn)).filter(v => v > 0));
    inTp = avg(sample.map(r => Number(r.inTp)).filter(v => v > 0));
    inFlow = avg(sample.map(r => Number(r.inFlow)).filter(v => v > 0));
    outCod = avg(sample.map(r => Number(r.outCod)).filter(v => v > 0));
    outNh3 = avg(sample.map(r => Number(r.outNh3)).filter(v => v > 0));
    outTn = avg(sample.map(r => Number(r.outTn)).filter(v => v > 0));
    outTp = avg(sample.map(r => Number(r.outTp)).filter(v => v > 0));

    dataSource = '近24小时小时进出水数据（自动）';
  } else {
    inFlow = Number(req.query.inFlow) || 0;
    inCod = Number(req.query.inCod) || 0;
    inNh3 = Number(req.query.inNh3) || 0;
    inTn = Number(req.query.inTn) || 0;
    inTp = Number(req.query.inTp) || 0;
    dataSource = '手动输入参数';
  }

  if (!inFlow || !inCod) {
    return res.status(400).json({ error: '缺少必要参数（进水流量、进水COD）' });
  }

  // ===== Step 2: 获取辅助数据 =====
  const d14 = new Date(); d14.setDate(d14.getDate() - 14);
  const d30 = new Date(); d30.setDate(d30.getDate() - 30);
  const date14 = d14.toISOString().slice(0, 10);
  const date30 = d30.toISOString().slice(0, 10);

  const recentWater14 = db.prepare('SELECT * FROM hourly_water WHERE date >= ?').all(date14);
  const recentLab14 = db.prepare('SELECT * FROM daily_lab WHERE date >= ?').all(date14);
  const recentLab30 = db.prepare('SELECT * FROM daily_lab WHERE date >= ?').all(date30);
  const recentDosing = db.prepare('SELECT * FROM chemical_dosing WHERE date >= ? ORDER BY date ASC').all(date14);

  // ===== Step 3: 水质趋势分析 =====
  const waterByDate = {};
  recentWater14.forEach(r => {
    if (!waterByDate[r.date]) waterByDate[r.date] = { inCod: [], inNh3: [], inTn: [], inTp: [], inFlow: [], outCod: [], outNh3: [], outTn: [], outTp: [] };
    const w = waterByDate[r.date];
    if (r.inCod) w.inCod.push(Number(r.inCod));
    if (r.inNh3) w.inNh3.push(Number(r.inNh3));
    if (r.inTn) w.inTn.push(Number(r.inTn));
    if (r.inTp) w.inTp.push(Number(r.inTp));
    if (r.inFlow) w.inFlow.push(Number(r.inFlow));
    if (r.outCod) w.outCod.push(Number(r.outCod));
    if (r.outNh3) w.outNh3.push(Number(r.outNh3));
    if (r.outTn) w.outTn.push(Number(r.outTn));
    if (r.outTp) w.outTp.push(Number(r.outTp));
  });
  const dailyWater = Object.entries(waterByDate).map(([date, vals]) => ({
    date,
    inCod: avg(vals.inCod), inNh3: avg(vals.inNh3), inTn: avg(vals.inTn), inTp: avg(vals.inTp),
    inFlow: avg(vals.inFlow),
    outCod: avg(vals.outCod), outNh3: avg(vals.outNh3), outTn: avg(vals.outTn), outTp: avg(vals.outTp),
  })).sort((a, b) => a.date.localeCompare(b.date));

  const waterTrends = {
    inCod: { trend: trend(dailyWater.map(d => d.inCod).filter(v => v !== null)), avg: avg(dailyWater.map(d => d.inCod).filter(v => v !== null)) },
    inNh3: { trend: trend(dailyWater.map(d => d.inNh3).filter(v => v !== null)), avg: avg(dailyWater.map(d => d.inNh3).filter(v => v !== null)) },
    inTn: { trend: trend(dailyWater.map(d => d.inTn).filter(v => v !== null)), avg: avg(dailyWater.map(d => d.inTn).filter(v => v !== null)) },
    inTp: { trend: trend(dailyWater.map(d => d.inTp).filter(v => v !== null)), avg: avg(dailyWater.map(d => d.inTp).filter(v => v !== null)) },
    outCod: { trend: trend(dailyWater.map(d => d.outCod).filter(v => v !== null)), avg: avg(dailyWater.map(d => d.outCod).filter(v => v !== null)) },
    outNh3: { trend: trend(dailyWater.map(d => d.outNh3).filter(v => v !== null)), avg: avg(dailyWater.map(d => d.outNh3).filter(v => v !== null)) },
    outTn: { trend: trend(dailyWater.map(d => d.outTn).filter(v => v !== null)), avg: avg(dailyWater.map(d => d.outTn).filter(v => v !== null)) },
    outTp: { trend: trend(dailyWater.map(d => d.outTp).filter(v => v !== null)), avg: avg(dailyWater.map(d => d.outTp).filter(v => v !== null)) },
  };

  // 去除效率
  const removalEff = {
    cod: waterTrends.inCod.avg && waterTrends.outCod.avg ? Math.round((1 - waterTrends.outCod.avg / waterTrends.inCod.avg) * 100) : null,
    nh3: waterTrends.inNh3.avg && waterTrends.outNh3.avg ? Math.round((1 - waterTrends.outNh3.avg / waterTrends.inNh3.avg) * 100) : null,
    tn: waterTrends.inTn.avg && waterTrends.outTn.avg ? Math.round((1 - waterTrends.outTn.avg / waterTrends.inTn.avg) * 100) : null,
    tp: waterTrends.inTp.avg && waterTrends.outTp.avg ? Math.round((1 - waterTrends.outTp.avg / waterTrends.inTp.avg) * 100) : null,
  };

  // ===== Step 4: 污泥指标分析 =====
  const sv30Vals = recentLab14.filter(r => r.sv30).map(r => Number(r.sv30));
  const sviVals = recentLab14.filter(r => r.svi).map(r => Number(r.svi));
  const mlssVals = recentLab14.filter(r => r.mlss).map(r => Number(r.mlss));

  const sludgeStatus = {
    sv30: { avg: avg(sv30Vals), trend: trend(sv30Vals), status: (avg(sv30Vals) || 0) > 35 ? '偏高' : (avg(sv30Vals) || 0) < 15 ? '偏低' : '正常', normalRange: '15-35%' },
    svi: { avg: avg(sviVals), trend: trend(sviVals), status: (avg(sviVals) || 0) > 150 ? '偏高-膨胀风险' : (avg(sviVals) || 0) < 50 ? '偏低-矿化' : '正常', normalRange: '50-150mL/g' },
    mlss: { avg: avg(mlssVals), trend: trend(mlssVals), status: (avg(mlssVals) || 0) > 6000 ? '偏高' : (avg(mlssVals) || 0) < 2000 ? '偏低' : '正常', normalRange: '2000-6000mg/L' },
  };

  // ===== Step 5: 历史投加量对比 =====
  const dosingStats = {};
  ['carbonSource', 'glucose', 'pac', 'anionPam', 'cationPam', 'naclo'].forEach(ck => {
    const vals = recentDosing.map(r => Number(r[ck])).filter(v => v > 0);
    dosingStats[ck] = {
      avg7d: avg(vals.slice(-7)),
      avg14d: avg(vals),
      max: vals.length > 0 ? Math.max(...vals) : null,
      min: vals.length > 0 ? Math.min(...vals) : null,
      count: vals.length,
    };
  });

  // ===== Step 6: 核心计算 =====
  const diagnosisLog = [];

  // --- 碳源 ---
  const targetTnEffluent = 15;
  const tnToRemove = Math.max(0, (inTn || 0) - targetTnEffluent);
  let carbonBase = tnToRemove * 5 * (inFlow || 0) / 1000;

  let carbonSludgeAdjust = 1.0;
  if (sludgeStatus.svi.status.includes('偏高')) {
    carbonSludgeAdjust = 1.15;
    diagnosisLog.push('⚠️ SVI偏高(' + (sludgeStatus.svi.avg || '-') + 'mL/g)，污泥沉降性差，碳源投加调增15%以补偿反硝化效率下降');
  }
  if (sludgeStatus.mlss.status === '偏低') {
    carbonSludgeAdjust = Math.max(carbonSludgeAdjust, 1.10);
    diagnosisLog.push('⚠️ MLSS偏低(' + (sludgeStatus.mlss.avg || '-') + 'mg/L)，生化系统污泥浓度不足，碳源调增10%');
  }

  let carbonTrendAdjust = 1.0;
  if (waterTrends.inTn.trend === '上升') {
    carbonTrendAdjust = 1.12;
    diagnosisLog.push('📈 进水TN呈上升趋势，碳源建议调增12%以应对负荷增长');
  } else if (waterTrends.inTn.trend === '下降') {
    carbonTrendAdjust = 0.90;
    diagnosisLog.push('📉 进水TN呈下降趋势，碳源可适度调减10%');
  }

  const carbonSource = Math.round(carbonBase * carbonSludgeAdjust * carbonTrendAdjust * 100) / 100;

  // --- 葡萄糖 ---
  const glucoseBase = carbonBase * 1.2;
  const glucose = Math.round(glucoseBase * carbonSludgeAdjust * carbonTrendAdjust * 100) / 100;

  // --- PAC（除磷） ---
  const targetTpEffluent = 0.5;
  const tpToRemove = Math.max(0, (inTp || 0) - targetTpEffluent);
  let pacBase = tpToRemove * 2.2 * (27 / 31) * (inFlow || 0) / 500;

  let pacSludgeAdjust = 1.0;
  if (sludgeStatus.svi.status.includes('偏高')) {
    pacSludgeAdjust = 1.20;
    diagnosisLog.push('⚠️ SVI偏高，PAC投加调增20%以改善污泥沉降性能（兼除磷+助凝）');
  }
  if (sludgeStatus.mlss.status === '偏高') {
    pacSludgeAdjust = 0.85;
    diagnosisLog.push('ℹ️ MLSS偏高(' + (sludgeStatus.mlss.avg || '-') + 'mg/L)，生化除磷能力较强，PAC可适度调减15%');
  }

  let pacTrendAdjust = 1.0;
  if (waterTrends.inTp.trend === '上升') {
    pacTrendAdjust = 1.15;
    diagnosisLog.push('📈 进水TP呈上升趋势，PAC建议调增15%');
  } else if (waterTrends.inTp.trend === '下降') {
    pacTrendAdjust = 0.85;
    diagnosisLog.push('📉 进水TP呈下降趋势，PAC可调减15%');
  }
  if (waterTrends.outTp.avg && waterTrends.outTp.avg > 0.4) {
    pacTrendAdjust = Math.max(pacTrendAdjust, 1.15);
    diagnosisLog.push('🚨 出水TP均值(' + waterTrends.outTp.avg + 'mg/L)接近限值(0.5mg/L)，PAC紧急调增');
  }

  const pac = Math.round(pacBase * pacSludgeAdjust * pacTrendAdjust * 100) / 100;

  // --- 阴离子PAM ---
  let anionBase = (inFlow || 0) * 0.002;
  if (sludgeStatus.svi.status.includes('偏高')) {
    anionBase *= 1.3;
    diagnosisLog.push('⚠️ SVI偏高，阴离子PAM调增30%以改善污泥脱水性能');
  }
  const anionPam = Math.round(anionBase * 100) / 100;

  // --- 阳离子PAM ---
  let cationBase = (inFlow || 0) * 0.001;
  if (sludgeStatus.svi.status.includes('偏高')) {
    cationBase *= 1.25;
    diagnosisLog.push('⚠️ SVI偏高，阳离子PAM调增25%以辅助污泥调理');
  }
  const cationPam = Math.round(cationBase * 100) / 100;

  // --- 次氯酸钠 ---
  let nacloBase = (inFlow || 0) * 0.005;
  if (waterTrends.outCod.avg && waterTrends.outCod.avg > 40) {
    nacloBase *= 1.15;
    diagnosisLog.push('ℹ️ 出水COD偏高(' + waterTrends.outCod.avg + 'mg/L)，次氯酸钠调增15%');
  }
  const naclo = Math.round(nacloBase * 100) / 100;

  // ===== Step 7: 与历史投加量对比 =====
  const compareWithHistory = (key, value) => {
    const hist = dosingStats[key];
    if (!hist || hist.count < 3) return { comparison: '历史数据不足', deviation: null, suggestion: '' };
    const deviation = hist.avg7d ? Math.round((value - hist.avg7d) / hist.avg7d * 100) : null;
    let comparison, suggestion;
    if (deviation === null) { comparison = '无法对比'; suggestion = ''; }
    else if (Math.abs(deviation) < 15) { comparison = '与近7日均值基本一致'; suggestion = ''; }
    else if (deviation > 0) {
      comparison = '较近7日均值偏高' + deviation + '%';
      suggestion = '📌 请确认水质变化是否合理，如非必要可逐步回调至' + hist.avg7d.toFixed(0) + 'kg/d';
    } else {
      comparison = '较近7日均值偏低' + Math.abs(deviation) + '%';
      suggestion = '📌 需确认处理效果是否达标，避免因药剂不足导致出水超标';
    }
    return { avg7d: hist.avg7d, avg14d: hist.avg14d, comparison, deviation, suggestion };
  };

  // ===== Step 8: 综合诊断 =====
  const waterQualityWarnings = [];
  if (waterTrends.outCod.avg && waterTrends.outCod.avg > 50) waterQualityWarnings.push('出水COD均值' + waterTrends.outCod.avg + 'mg/L超过一级A标准(50mg/L)');
  if (waterTrends.outNh3.avg && waterTrends.outNh3.avg > 5) waterQualityWarnings.push('出水氨氮均值' + waterTrends.outNh3.avg + 'mg/L超过一级A标准(5mg/L)');
  if (waterTrends.outTn.avg && waterTrends.outTn.avg > 15) waterQualityWarnings.push('出水TN均值' + waterTrends.outTn.avg + 'mg/L超过一级A标准(15mg/L)');
  if (waterTrends.outTp.avg && waterTrends.outTp.avg > 0.5) waterQualityWarnings.push('出水TP均值' + waterTrends.outTp.avg + 'mg/L超过一级A标准(0.5mg/L)');

  const sludgeWarnings = [];
  if (sludgeStatus.svi.status.includes('膨胀')) sludgeWarnings.push('SVI偏高，污泥存在膨胀风险，影响处理效率');
  if (sludgeStatus.mlss.status === '偏低') sludgeWarnings.push('MLSS偏低，生化处理能力不足');
  if (sludgeStatus.sv30.status === '偏高' && !sludgeStatus.svi.status.includes('膨胀')) sludgeWarnings.push('SV30偏高但SVI正常，可能为负荷偏高型污泥，非膨胀性');

  // ===== 组装响应 =====
  res.json({
    generatedAt: new Date().toISOString(),
    dataSource,
    mode: autoMode ? 'auto' : 'manual',
    input: { inFlow, inCod, inNh3, inTn, inTp },
    waterQuality: {
      trends: waterTrends,
      removalEfficiency: removalEff,
      warnings: waterQualityWarnings,
    },
    sludgeStatus,
    recommendations: [
      {
        chemical: '碳源', key: 'carbonSource', value: carbonSource, unit: 'kg/d',
        range: [Math.round(carbonSource * 0.85 * 100) / 100, Math.round(carbonSource * 1.15 * 100) / 100],
        baseValue: Math.round(carbonBase * 100) / 100,
        adjustFactors: { sludge: carbonSludgeAdjust, trend: carbonTrendAdjust },
        history: compareWithHistory('carbonSource', carbonSource),
        tip: carbonSource > 100 ? '进水TN负荷较高，建议分次投加并加强反硝化段搅拌' : '在正常范围内',
      },
      {
        chemical: '葡萄糖', key: 'glucose', value: glucose, unit: 'kg/d',
        range: [Math.round(glucose * 0.85 * 100) / 100, Math.round(glucose * 1.15 * 100) / 100],
        baseValue: Math.round(glucoseBase * 100) / 100,
        adjustFactors: { sludge: carbonSludgeAdjust, trend: carbonTrendAdjust },
        history: compareWithHistory('glucose', glucose),
        tip: '可与碳源配合使用，调节C/N比',
      },
      {
        chemical: 'PAC', key: 'pac', value: pac, unit: 'kg/d',
        range: [Math.round(pac * 0.75 * 100) / 100, Math.round(pac * 1.25 * 100) / 100],
        baseValue: Math.round(pacBase * 100) / 100,
        adjustFactors: { sludge: pacSludgeAdjust, trend: pacTrendAdjust },
        history: compareWithHistory('pac', pac),
        tip: pac > 60 ? 'PAC投加量较大，建议检查生物除磷效果并考虑同步化学除磷优化' : '在正常范围内',
      },
      {
        chemical: '阴离子PAM', key: 'anionPam', value: anionPam, unit: 'kg/d',
        range: [Math.round(anionPam * 0.75 * 100) / 100, Math.round(anionPam * 1.3 * 100) / 100],
        baseValue: Math.round((inFlow || 0) * 0.002 * 100) / 100,
        adjustFactors: { sludge: sludgeStatus.svi.status.includes('偏高') ? 1.3 : 1.0 },
        history: compareWithHistory('anionPam', anionPam),
        tip: '根据污泥脱水机运行效果及泥饼含水率调整',
      },
      {
        chemical: '阳离子PAM', key: 'cationPam', value: cationPam, unit: 'kg/d',
        range: [Math.round(cationPam * 0.75 * 100) / 100, Math.round(cationPam * 1.3 * 100) / 100],
        baseValue: Math.round((inFlow || 0) * 0.001 * 100) / 100,
        adjustFactors: { sludge: sludgeStatus.svi.status.includes('偏高') ? 1.25 : 1.0 },
        history: compareWithHistory('cationPam', cationPam),
        tip: '用于污泥调理，根据污泥比阻和脱水性能调整',
      },
      {
        chemical: '次氯酸钠', key: 'naclo', value: naclo, unit: 'kg/d',
        range: [Math.round(naclo * 0.7 * 100) / 100, Math.round(naclo * 1.3 * 100) / 100],
        baseValue: Math.round((inFlow || 0) * 0.005 * 100) / 100,
        adjustFactors: { cod: waterTrends.outCod.avg && waterTrends.outCod.avg > 40 ? 1.15 : 1.0 },
        history: compareWithHistory('naclo', naclo),
        tip: '根据出水粪大肠菌群及余氯指标动态调整',
      },
    ],
    diagnosisLog,
    sludgeWarnings,
    waterQualityWarnings,
    overallAssessment: (waterQualityWarnings.length > 0 || sludgeWarnings.length > 0)
      ? '系统存在需关注的风险点，建议按上述诊断逐项排查并跟踪处理效果'
      : '系统运行状态良好，各项指标在正常范围内',
    charts: {
      waterQuality: dailyWater.slice(-14).map(d => ({
        date: d.date.slice(5),
        inCod: d.inCod, inNh3: d.inNh3, inTn: d.inTn, inTp: d.inTp,
        outCod: d.outCod, outNh3: d.outNh3, outTn: d.outTn,
      })),
      sludge: recentLab14.map(r => ({
        date: r.date.slice(5),
        sv30: r.sv30 ? Number(r.sv30) : null,
        svi: r.svi ? Number(r.svi) : null,
        mlss: r.mlss ? Number(r.mlss) : null,
      })),
      dosingHistory: recentDosing.map(r => ({
        date: r.date.slice(5),
        carbonSource: Number(r.carbonSource) || 0,
        glucose: Number(r.glucose) || 0,
        pac: Number(r.pac) || 0,
      })),
    },
  });
});

// 保留旧接口兼容（手动模式）
app.get('/api/dosing/recommend', authMiddleware, (req, res) => {
  const inFlow = Number(req.query.inFlow) || 0;
  const inCod = Number(req.query.inCod) || 0;
  const inNh3 = Number(req.query.inNh3) || 0;
  const inTn = Number(req.query.inTn) || 0;
  const inTp = Number(req.query.inTp) || 0;

  if (!inFlow && !inCod) {
    // 无参数 → 重定向到自动分析
    req.query.auto = '1';
    req.url = '/api/dosing/analysis?' + new URLSearchParams(req.query).toString();
    return app._router.handle(req, res);
  }

  // 有手动参数 → 用简化公式
  const targetTn = 10;
  const tnToRemove = Math.max(0, inTn - targetTn);
  const carbonSource = Math.round(tnToRemove * 5 * inFlow / 1000 * 100) / 100;
  const glucose = Math.round(carbonSource * 1.2 * 100) / 100;
  const tpToRemove = Math.max(0, inTp - 0.3);
  const pac = Math.round(tpToRemove * 2.2 * (27 / 31) * inFlow / 500 * 100) / 100;
  const anionPam = Math.round(inFlow * 0.002 * 100) / 100;
  const cationPam = Math.round(inFlow * 0.001 * 100) / 100;
  const naclo = Math.round(inFlow * 0.005 * 100) / 100;

  res.json({
    input: { inFlow, inCod, inNh3, inTn, inTp },
    recommendations: [
      { chemical: '碳源', key: 'carbonSource', value: carbonSource, unit: 'kg/d', range: [Math.round(carbonSource * 0.8 * 100) / 100, Math.round(carbonSource * 1.2 * 100) / 100], tip: carbonSource > 100 ? '进水TN负荷较高，建议分次投加' : '在正常范围内' },
      { chemical: '葡萄糖', key: 'glucose', value: glucose, unit: 'kg/d', range: [Math.round(glucose * 0.8 * 100) / 100, Math.round(glucose * 1.2 * 100) / 100], tip: '可与碳源配合使用' },
      { chemical: 'PAC', key: 'pac', value: pac, unit: 'kg/d', range: [Math.round(pac * 0.7 * 100) / 100, Math.round(pac * 1.3 * 100) / 100], tip: pac > 50 ? '进水TP较高，建议配合生物除磷' : '在正常范围内' },
      { chemical: '阴离子PAM', key: 'anionPam', value: anionPam, unit: 'kg/d', range: [Math.round(anionPam * 0.7 * 100) / 100, Math.round(anionPam * 1.5 * 100) / 100], tip: '根据污泥脱水效果调整' },
      { chemical: '阳离子PAM', key: 'cationPam', value: cationPam, unit: 'kg/d', range: [Math.round(cationPam * 0.7 * 100) / 100, Math.round(cationPam * 1.5 * 100) / 100], tip: '用于污泥调理，根据泥质调整' },
      { chemical: '次氯酸钠', key: 'naclo', value: naclo, unit: 'kg/d', range: [Math.round(naclo * 0.6 * 100) / 100, Math.round(naclo * 1.4 * 100) / 100], tip: '根据出水大肠菌群指标调整' },
    ],
    generatedAt: new Date().toISOString(),
  });
});

// ==================== 库存管理 ====================
app.get('/api/inventory/summary', authMiddleware, (req, res) => {
  const typeNames = { carbonSource: '碳源', glucose: '葡萄糖', pac: 'PAC', anionPam: '阴离子PAM', cationPam: '阳离子PAM', naclo: '次氯酸钠' };
  const invRecords = selectAll('chemical_inventory');
  const recentDosing = db.prepare('SELECT * FROM chemical_dosing ORDER BY createTime DESC LIMIT 1').get();
  const summary = ['carbonSource','glucose','pac','anionPam','cationPam','naclo'].map(ck => {
    const records = invRecords.filter(r => r.chemicalType === ck);
    const totalIn = records.filter(r => r.type === 'in').reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const totalOut = records.filter(r => r.type === 'out').reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const totalUse = records.filter(r => r.type === 'use').reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const todayUse = records.filter(r => r.type === 'use' && r.date === new Date().toISOString().slice(0, 10)).reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const balance = totalIn - totalOut - totalUse;
    return {
      key: ck, name: typeNames[ck], totalIn, totalOut, totalUse, balance, todayUse,
      lastDosing: recentDosing ? (recentDosing[ck] || 0) : 0,
      status: balance < 100 ? 'danger' : balance < 500 ? 'warning' : 'normal',
      warningThreshold: 500,
    };
  });
  res.json(summary);
});

app.get('/api/inventory/low-stock', authMiddleware, (req, res) => {
  const typeNames = { carbonSource: '碳源', glucose: '葡萄糖', pac: 'PAC', anionPam: '阴离子PAM', cationPam: '阳离子PAM', naclo: '次氯酸钠' };
  const low = ['carbonSource','glucose','pac','anionPam','cationPam','naclo'].map(ck => {
    const balance = getCurrentStock(ck);
    return { key: ck, name: typeNames[ck], balance, status: balance < 100 ? 'danger' : balance < 500 ? 'warning' : 'normal' };
  }).filter(s => s.balance < 500);
  res.json(low);
});

// ==================== Excel导出 ====================
app.get('/api/export/:table', authMiddleware, async (req, res) => {
  try {
    const exceljs = require('exceljs');
    const table = req.params.table;
    if (!ALL_TABLES.includes(table)) return res.status(404).json({ error: '表不存在' });
    let data = selectAll(table);
    if (req.query.dateFrom && req.query.dateTo) {
      data = data.filter(r => r.date >= req.query.dateFrom && r.date <= req.query.dateTo);
    }
    if (data.length === 0) return res.status(404).json({ error: '无数据可导出' });

    const workbook = new exceljs.Workbook();
    const sheet = workbook.addWorksheet(table);
    if (data.length > 0) {
      const keys = Object.keys(data[0]).filter(k => !k.startsWith('_'));
      sheet.columns = keys.map(k => ({ header: k, key: k, width: 15 }));
      data.forEach(row => sheet.addRow(row));
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    }

    // 记录导出日志
    insertRow('exportLog', { id: 'exp_' + Date.now(), table: table, count: String(data.length), operator: req.user.name, time: new Date().toISOString() });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=' + table + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: '导出失败: ' + err.message });
  }
});

// ==================== 数据分析 ====================
app.get('/api/analysis/fluctuation', authMiddleware, (req, res) => {
  const range = parseInt(req.query.range) || 7;
  const startDate = new Date(); startDate.setDate(startDate.getDate() - range);
  const startStr = startDate.toISOString().slice(0, 10);

  const hourlyData = db.prepare('SELECT * FROM hourly_water WHERE date >= ?').all(startStr);
  const analysis = { waterQuality: { cod: [], nh3: [], tn: [], tp: [] }, alerts: [] };

  if (hourlyData.length >= 2) {
    const outCodVals = hourlyData.filter(r => r.outCod).map(r => Number(r.outCod));
    const outNh3Vals = hourlyData.filter(r => r.outNh3).map(r => Number(r.outNh3));
    const outTnVals = hourlyData.filter(r => r.outTn).map(r => Number(r.outTn));
    const outTpVals = hourlyData.filter(r => r.outTp).map(r => Number(r.outTp));

    const analyzeMetric = (name, vals, limit) => {
      if (vals.length < 3) return { name, avg: vals[0], trend: '数据不足' };
      const avgVal = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) / 100;
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      const recent = vals.slice(-Math.min(5, vals.length));
      const recentAvg = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length * 100) / 100;
      const trendVal = recentAvg > avgVal * 1.1 ? '上升' : recentAvg < avgVal * 0.9 ? '下降' : '稳定';
      let analysisResult = '';
      if (max > limit) analysisResult = '⚠️ 最大值(' + max + 'mg/L)超出标准限值(' + limit + 'mg/L)，需关注';
      else if (trendVal === '上升' && recentAvg > limit * 0.8) analysisResult = '📈 近期呈上升趋势，接近限值，建议排查原因';
      else if (trendVal === '下降') analysisResult = '📉 近期呈下降趋势，处理效果改善';
      else analysisResult = '✅ 指标稳定，在正常范围内';
      return { name, avg: avgVal, max, min, recentAvg, trend: trendVal, analysis: analysisResult, limit };
    };

    analysis.waterQuality.cod = analyzeMetric('COD', outCodVals, 50);
    analysis.waterQuality.nh3 = analyzeMetric('氨氮', outNh3Vals, 5);
    analysis.waterQuality.tn = analyzeMetric('总氮', outTnVals, 15);
    analysis.waterQuality.tp = analyzeMetric('总磷', outTpVals, 0.5);
  }

  res.json(analysis);
});

// ==================== 污泥指标综合分析 ====================
app.get('/api/sludge/analysis', authMiddleware, (req, res) => {
  const range = parseInt(req.query.range) || 30;
  const startDate = new Date(); startDate.setDate(startDate.getDate() - range);
  const startStr = startDate.toISOString().slice(0, 10);

  const labData = db.prepare('SELECT * FROM daily_lab WHERE date >= ? ORDER BY date ASC').all(startStr);

  // SV30 分析
  const sv30Vals = labData.filter(r => r.sv30).map(r => ({ date: r.date, value: Number(r.sv30) }));
  const sv30Avg = sv30Vals.length > 0 ? Math.round(sv30Vals.reduce((s, v) => s + v.value, 0) / sv30Vals.length * 10) / 10 : null;
  const sv30Recent = sv30Vals.slice(-5);
  const sv30Trend = sv30Recent.length >= 3
    ? (sv30Recent[sv30Recent.length - 1].value > sv30Recent[0].value * 1.05 ? '上升' : sv30Recent[sv30Recent.length - 1].value < sv30Recent[0].value * 0.95 ? '下降' : '稳定')
    : '数据不足';
  const sv30AnomalyDays = sv30Vals.filter(v => v.value < 15 || v.value > 35);

  // SVI 分析
  const sviVals = labData.filter(r => r.svi).map(r => ({ date: r.date, value: Number(r.svi) }));
  const sviAvg = sviVals.length > 0 ? Math.round(sviVals.reduce((s, v) => s + v.value, 0) / sviVals.length * 10) / 10 : null;
  const sviRecent = sviVals.slice(-5);
  const sviTrend = sviRecent.length >= 3
    ? (sviRecent[sviRecent.length - 1].value > sviRecent[0].value * 1.05 ? '上升' : sviRecent[sviRecent.length - 1].value < sviRecent[0].value * 0.95 ? '下降' : '稳定')
    : '数据不足';
  const sviAnomalyDays = sviVals.filter(v => v.value < 50 || v.value > 150);

  // MLSS 分析
  const mlssVals = labData.filter(r => r.mlss).map(r => ({ date: r.date, value: Number(r.mlss) }));
  const mlssAvg = mlssVals.length > 0 ? Math.round(mlssVals.reduce((s, v) => s + v.value, 0) / mlssVals.length * 10) / 10 : null;
  const mlssRecent = mlssVals.slice(-5);
  const mlssTrend = mlssRecent.length >= 3
    ? (mlssRecent[mlssRecent.length - 1].value > mlssRecent[0].value * 1.05 ? '上升' : mlssRecent[mlssRecent.length - 1].value < mlssRecent[0].value * 0.95 ? '下降' : '稳定')
    : '数据不足';
  const mlssAnomalyDays = mlssVals.filter(v => v.value < 2000 || v.value > 6000);

  // SVI/SV30/MLSS 关系分析
  const calculatedSVI = labData.filter(r => r.sv30 && r.mlss).map(r => ({
    date: r.date,
    sv30: Number(r.sv30),
    mlss: Number(r.mlss),
    sviCalculated: Math.round(Number(r.sv30) * 10000 / Number(r.mlss)),
    sviReported: r.svi ? Number(r.svi) : null
  }));

  // 污泥膨胀风险评估
  let bulkingRisk = '低风险';
  let bulkingAdvice = '污泥性状良好，继续保持现有运行参数';
  if (sviAvg && sviAvg > 150) {
    bulkingRisk = '高风险';
    bulkingAdvice = 'SVI持续偏高(>150)，存在污泥膨胀风险。建议：1)检查进水水质是否有冲击负荷 2)适当增加排泥量 3)检查曝气量是否合适 4)考虑投加絮凝剂应急';
  } else if (sviAvg && sviAvg > 130) {
    bulkingRisk = '中等风险';
    bulkingAdvice = 'SVI接近警戒值(>130)，需关注。建议：1)密切观察SV30变化趋势 2)检查丝状菌丰度 3)调控曝气量和污泥龄';
  } else if (sv30Trend === '上升' && sv30Avg && sv30Avg > 30) {
    bulkingRisk = '中等风险';
    bulkingAdvice = 'SV30呈上升趋势且接近上限，建议加强镜检频次，关注菌胶团结构变化';
  }

  // 镜检记录汇总
  const microscopeRecords = labData.filter(r => r.microscope).map(r => ({
    date: r.date,
    record: r.microscope,
    sv30: r.sv30,
    svi: r.svi,
    mlss: r.mlss,
  }));

  // 镜检关键词分析
  const keywords = { '良好': 0, '一般': 0, '差': 0, '活跃': 0, '正常': 0, '减少': 0, '丝状菌': 0, '轮虫': 0, '钟虫': 0, '累枝虫': 0, '楯纤虫': 0, '菌胶团': 0 };
  microscopeRecords.forEach(r => {
    Object.keys(keywords).forEach(kw => {
      if (r.record.includes(kw)) keywords[kw]++;
    });
  });

  // 东西系列对比
  const eastSV30 = labData.filter(r => r.sv30East).map(r => Number(r.sv30East));
  const westSV30 = labData.filter(r => r.sv30West).map(r => Number(r.sv30West));
  const eastAvg = eastSV30.length > 0 ? Math.round(eastSV30.reduce((a,b)=>a+b,0)/eastSV30.length*10)/10 : null;
  const westAvg = westSV30.length > 0 ? Math.round(westSV30.reduce((a,b)=>a+b,0)/westSV30.length*10)/10 : null;

  // 生成综合诊断报告
  let diagnosis = [];
  if (sv30Avg !== null) {
    if (sv30Avg < 15) diagnosis.push({ item: 'SV30偏低', level: 'warning', detail: '平均SV30=' + sv30Avg + '%，低于正常下限15%。可能原因：污泥老化、负荷过低或无机质含量高。建议适当降低污泥龄，增加排泥。' });
    else if (sv30Avg > 35) diagnosis.push({ item: 'SV30偏高', level: 'warning', detail: '平均SV30=' + sv30Avg + '%，高于正常上限35%。可能原因：污泥膨胀或负荷过高。建议检查SVI值辅助判断。' });
    else diagnosis.push({ item: 'SV30正常', level: 'normal', detail: '平均SV30=' + sv30Avg + '%，在正常范围(15%-35%)内。' });
  }
  if (sviAvg !== null) {
    if (sviAvg > 150) diagnosis.push({ item: 'SVI过高(污泥膨胀)', level: 'high', detail: '平均SVI=' + sviAvg + 'mL/g，超过150mL/g，存在污泥膨胀风险。需紧急处理。' });
    else if (sviAvg < 50) diagnosis.push({ item: 'SVI偏低', level: 'info', detail: '平均SVI=' + sviAvg + 'mL/g，低于50mL/g，污泥矿化度高，无机质较多，沉降性能好但活性可能不足。' });
    else diagnosis.push({ item: 'SVI正常', level: 'normal', detail: '平均SVI=' + sviAvg + 'mL/g，在正常范围(50-150mL/g)内，污泥沉降性能良好。' });
  }
  if (mlssAvg !== null) {
    if (mlssAvg < 2000) diagnosis.push({ item: 'MLSS偏低', level: 'warning', detail: '平均MLSS=' + mlssAvg + 'mg/L，低于2000mg/L。生化系统污泥浓度不足，处理能力可能下降。建议减少排泥或增加污泥回流。' });
    else if (mlssAvg > 6000) diagnosis.push({ item: 'MLSS偏高', level: 'info', detail: '平均MLSS=' + mlssAvg + 'mg/L，高于6000mg/L。需关注二沉池负荷和曝气效率。' });
    else diagnosis.push({ item: 'MLSS正常', level: 'normal', detail: '平均MLSS=' + mlssAvg + 'mg/L，在正常范围(2000-6000mg/L)内。' });
  }
  // 东西系列对比
  if (eastAvg !== null && westAvg !== null) {
    const diff = Math.abs(eastAvg - westAvg);
    if (diff > 5) diagnosis.push({ item: '系列SV30差异大', level: 'warning', detail: '东系列SV30=' + eastAvg + '%，西系列SV30=' + westAvg + '%，差异' + diff.toFixed(1) + '%。建议检查两系列运行工况是否一致。' });
    else diagnosis.push({ item: '系列运行均衡', level: 'normal', detail: '东西系列SV30差异(' + diff.toFixed(1) + '%)在正常范围内。' });
  }

  res.json({
    generatedAt: new Date().toISOString(),
    range: range,
    dataCount: labData.length,
    sv30: { values: sv30Vals, avg: sv30Avg, trend: sv30Trend, anomalyDays: sv30AnomalyDays.length, normalRange: '15-35%', unit: '%' },
    svi: { values: sviVals, avg: sviAvg, trend: sviTrend, anomalyDays: sviAnomalyDays.length, normalRange: '50-150mL/g', unit: 'mL/g' },
    mlss: { values: mlssVals, avg: mlssAvg, trend: mlssTrend, anomalyDays: mlssAnomalyDays.length, normalRange: '2000-6000mg/L', unit: 'mg/L' },
    calculatedSVI,
    bulkingRisk,
    bulkingAdvice,
    microscope: { records: microscopeRecords.slice(-10), keywordStats: keywords },
    seriesComparison: { eastSV30Avg: eastAvg, westSV30Avg: westAvg, unit: '%' },
    diagnosis,
  });
});

// ==================== 污泥数据智能问答 ====================
app.get('/api/sludge/qa', authMiddleware, (req, res) => {
  const question = (req.query.q || '').trim();
  if (!question) return res.status(400).json({ error: '请输入问题' });

  const labData = db.prepare('SELECT * FROM daily_lab ORDER BY date ASC').all();
  const recent7 = labData.slice(-7);
  const recent30 = labData.slice(-30);

  let answer = '';
  let dataPoints = [];

  // SV30相关
  if (/sv30|沉降比|污泥沉降/i.test(question)) {
    const vals = labData.filter(r => r.sv30).map(r => ({ date: r.date, value: Number(r.sv30) }));
    const avgVal = vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v.value, 0) / vals.length * 10) / 10 : null;
    const max = vals.length > 0 ? Math.max(...vals.map(v => v.value)) : null;
    const min = vals.length > 0 ? Math.min(...vals.map(v => v.value)) : null;
    const recent = vals.slice(-5);
    const trendVal = recent.length >= 3 ? (recent[recent.length-1].value > recent[0].value * 1.05 ? '上升' : recent[recent.length-1].value < recent[0].value * 0.95 ? '下降' : '稳定') : '未知';

    if (/趋势|变化|走向/.test(question)) {
      answer = '近30天SV30呈' + trendVal + '趋势。平均' + avgVal + '%，最高' + max + '%，最低' + min + '%。' + (avgVal > 35 ? '当前均值偏高，需关注污泥膨胀风险。' : avgVal < 15 ? '当前均值偏低，可能存在污泥老化。' : '在正常范围内(15-35%)。');
    } else if (/超标|异常|不正常/.test(question)) {
      const abnormal = vals.filter(v => v.value < 15 || v.value > 35);
      answer = '近30天共有' + abnormal.length + '天SV30异常（正常区间15%-35%）。' + (abnormal.length > 0 ? '异常日期：' + abnormal.map(v => v.date + '(' + v.value + '%)').join('、') : '未发现异常数据。');
    } else if (/最高|最大|最低|最小/.test(question)) {
      answer = '近30天SV30最高' + max + '%（' + (vals.find(v => v.value === max) || {}).date + '），最低' + min + '%（' + (vals.find(v => v.value === min) || {}).date + '），平均值' + avgVal + '%。';
    } else {
      answer = '近30天SV30范围' + min + '% - ' + max + '%，平均值' + avgVal + '%，趋势' + trendVal + '。（正常区间：15%-35%）';
    }
    dataPoints = vals;
  }
  // SVI相关
  else if (/svi|污泥指数|体积指数/i.test(question)) {
    const vals = labData.filter(r => r.svi).map(r => ({ date: r.date, value: Number(r.svi) }));
    const avgVal = vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v.value, 0) / vals.length * 10) / 10 : null;
    const max = vals.length > 0 ? Math.max(...vals.map(v => v.value)) : null;
    const min = vals.length > 0 ? Math.min(...vals.map(v => v.value)) : null;
    const recent = vals.slice(-5);
    const trendVal = recent.length >= 3 ? (recent[recent.length-1].value > recent[0].value * 1.05 ? '上升' : recent[recent.length-1].value < recent[0].value * 0.95 ? '下降' : '稳定') : '未知';

    if (/膨胀/.test(question)) {
      const highDays = vals.filter(v => v.value > 150);
      answer = '近30天SVI超过150mL/g（污泥膨胀风险阈值）共' + highDays.length + '天。' + (highDays.length > 0 ? '具体日期：' + highDays.map(v => v.date + '(' + v.value + 'mL/g)').join('、') + '。建议检查丝状菌丰度、调控污泥龄和曝气量。' : '未检测到污泥膨胀风险。');
    } else if (/趋势|变化/.test(question)) {
      answer = '近30天SVI呈' + trendVal + '趋势，平均' + avgVal + 'mL/g。' + (avgVal > 150 ? '⚠️ 当前SVI偏高(>150)，存在污泥膨胀风险，建议紧急处理。' : avgVal > 130 ? '⚠️ SVI接近警戒值，需加强监控。' : avgVal > 50 ? 'SVI在正常范围(50-150mL/g)内，沉降性能良好。' : 'SVI偏低(<50)，污泥矿化度高。');
    } else {
      answer = '近30天SVI范围' + min + ' - ' + max + 'mL/g，平均值' + avgVal + 'mL/g，趋势' + trendVal + '。（正常区间：50-150mL/g）';
    }
    dataPoints = vals;
  }
  // MLSS相关
  else if (/mlss|污泥浓度|悬浮固体/i.test(question)) {
    const vals = labData.filter(r => r.mlss).map(r => ({ date: r.date, value: Number(r.mlss) }));
    const avgVal = vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v.value, 0) / vals.length * 10) / 10 : null;
    const max = vals.length > 0 ? Math.max(...vals.map(v => v.value)) : null;
    const min = vals.length > 0 ? Math.min(...vals.map(v => v.value)) : null;
    const recent = vals.slice(-5);
    const trendVal = recent.length >= 3 ? (recent[recent.length-1].value > recent[0].value * 1.05 ? '上升' : recent[recent.length-1].value < recent[0].value * 0.95 ? '下降' : '稳定') : '未知';

    if (/偏低|不足|不够/.test(question)) {
      const lowDays = vals.filter(v => v.value < 2000);
      answer = '近30天MLSS低于2000mg/L共' + lowDays.length + '天。建议减少排泥或增加污泥回流量以提高污泥浓度。';
    } else if (/偏高|过高|太多/.test(question)) {
      const highDays = vals.filter(v => v.value > 6000);
      answer = '近30天MLSS超过6000mg/L共' + highDays.length + '天。建议适当增加排泥量，控制污泥龄。';
    } else {
      answer = '近30天MLSS范围' + min + ' - ' + max + 'mg/L，平均值' + avgVal + 'mg/L，趋势' + trendVal + '。（正常区间：2000-6000mg/L）';
    }
    dataPoints = vals;
  }
  // 镜检相关
  else if (/镜检|显微镜|微生物|原生动物|菌胶团|轮虫|钟虫|丝状菌/.test(question)) {
    const records = labData.filter(r => r.microscope).slice(-10);
    if (records.length === 0) {
      answer = '暂无镜检记录数据，请先在每日化验中录入镜检结果。';
    } else if (/丝状菌/.test(question)) {
      const filament = records.filter(r => r.microscope.includes('丝状菌'));
      answer = '近10次镜检中' + filament.length + '次提及丝状菌。' + (filament.length > 3 ? '丝状菌出现频率较高，需关注污泥膨胀风险。' : '丝状菌丰度在可控范围内。') + '最近记录：' + records.slice(-3).map(r => r.date + '：' + r.microscope).join('；');
    } else {
      answer = '近10次镜检记录：' + records.map(r => r.date + '：' + r.microscope).join('；');
    }
    dataPoints = records;
  }
  // 综合/膨胀风险
  else if (/膨胀|风险|综合|诊断|评估/.test(question)) {
    const sv30Vals = labData.filter(r => r.sv30).map(r => Number(r.sv30));
    const sviVals = labData.filter(r => r.svi).map(r => Number(r.svi));
    const mlssVals = labData.filter(r => r.mlss).map(r => Number(r.mlss));
    const sv30Avg = sv30Vals.length > 0 ? Math.round(sv30Vals.reduce((a,b)=>a+b,0)/sv30Vals.length*10)/10 : null;
    const sviAvg = sviVals.length > 0 ? Math.round(sviVals.reduce((a,b)=>a+b,0)/sviVals.length*10)/10 : null;
    const mlssAvg = mlssVals.length > 0 ? Math.round(mlssVals.reduce((a,b)=>a+b,0)/mlssVals.length*10)/10 : null;

    let riskLevel = '低风险';
    let advices = [];
    if (sviAvg && sviAvg > 150) { riskLevel = '高风险'; advices.push('SVI>150mL/g，污泥膨胀风险高，建议：增加排泥、控制曝气、检查进水冲击负荷'); }
    else if (sviAvg && sviAvg > 130) { riskLevel = '中风险'; advices.push('SVI>130mL/g接近警戒值，建议加强镜检和SV30监测频率'); }
    if (sv30Avg && sv30Avg > 35) { riskLevel = riskLevel === '低风险' ? '中风险' : riskLevel; advices.push('SV30>35%偏高，结合SVI判断是否为膨胀性污泥'); }
    if (mlssAvg && mlssAvg > 6000) advices.push('MLSS>6000mg/L偏高，建议适当排泥降低污泥浓度');

    answer = '【污泥综合风险评估】风险等级：' + riskLevel + '\n\n当前指标：SV30=' + (sv30Avg || '-') + '%、SVI=' + (sviAvg || '-') + 'mL/g、MLSS=' + (mlssAvg || '-') + 'mg/L\n\n' + (advices.length > 0 ? '建议措施：\n' + advices.map((a, i) => (i+1) + '. ' + a).join('\n') : '各项指标在正常范围内，继续保持现有运行参数。');
    dataPoints = [];
  }
  // 东西系列对比
  else if (/东西|系列|对比|差异/.test(question)) {
    const eastVals = labData.filter(r => r.sv30East).map(r => Number(r.sv30East));
    const westVals = labData.filter(r => r.sv30West).map(r => Number(r.sv30West));
    const eastAvg = eastVals.length > 0 ? Math.round(eastVals.reduce((a,b)=>a+b,0)/eastVals.length*10)/10 : null;
    const westAvg = westVals.length > 0 ? Math.round(westVals.reduce((a,b)=>a+b,0)/westVals.length*10)/10 : null;
    if (eastAvg && westAvg) {
      const diff = Math.abs(eastAvg - westAvg);
      answer = '东西系列SV30对比：东系列平均' + eastAvg + '%，西系列平均' + westAvg + '%，差异' + diff.toFixed(1) + '%。' + (diff > 5 ? '两系列差异较大，建议排查运行工况是否一致。' : '两系列运行较均衡。');
    } else {
      answer = '东西系列SV30数据不足，无法进行对比分析。';
    }
  }
  // 水温相关
  else if (/水温|温度/.test(question)) {
    const eastTemps = labData.filter(r => r.waterTempEast).map(r => ({ date: r.date, east: Number(r.waterTempEast), west: r.waterTempWest ? Number(r.waterTempWest) : null }));
    const recent = eastTemps.slice(-7);
    answer = '近7天水温记录：' + recent.map(r => r.date + ' 东' + r.east + '°C' + (r.west ? ' 西' + r.west + '°C' : '')).join('；') + '。水温影响微生物活性和氧转移效率，冬季需适当提高MLSS以补偿活性下降。';
    dataPoints = recent;
  }
  // 回流比
  else if (/回流|内回流|外回流/.test(question)) {
    const records = labData.filter(r => r.internalReflux || r.externalReflux).slice(-7);
    answer = '近7天回流比记录：' + records.map(r => r.date + ' 内回流' + (r.internalReflux || '-') + '% 外回流' + (r.externalReflux || '-') + '%').join('；') + '。内回流影响脱氮效率，外回流影响污泥浓度和沉降性能。';
  }
  else {
    // 通用回答
    const sv30Vals = labData.filter(r => r.sv30).map(r => Number(r.sv30));
    const sviVals = labData.filter(r => r.svi).map(r => Number(r.svi));
    const mlssVals = labData.filter(r => r.mlss).map(r => Number(r.mlss));
    const sv30Avg = sv30Vals.length > 0 ? Math.round(sv30Vals.reduce((a,b)=>a+b,0)/sv30Vals.length*10)/10 : null;
    const sviAvg = sviVals.length > 0 ? Math.round(sviVals.reduce((a,b)=>a+b,0)/sviVals.length*10)/10 : null;
    const mlssAvg = mlssVals.length > 0 ? Math.round(mlssVals.reduce((a,b)=>a+b,0)/mlssVals.length*10)/10 : null;

    answer = '📊 污泥指标概览（近30天）：\n• SV30：' + (sv30Avg || '-') + '%（正常15-35%）\n• SVI：' + (sviAvg || '-') + 'mL/g（正常50-150）\n• MLSS：' + (mlssAvg || '-') + 'mg/L（正常2000-6000）\n\n💡 可提问示例：\n- "SV30最近趋势如何？"\n- "SVI有没有超标？"\n- "污泥膨胀风险分析"\n- "镜检中丝状菌情况"\n- "东西系列SV30对比"';
  }

  res.json({ question, answer, dataPoints: dataPoints.slice(-20), answerTime: new Date().toISOString() });
});

// ==================== 演示数据生成 ====================
app.post('/api/seed', authMiddleware, (req, res) => {
  if (!req.userPermissions.canManage && !['厂长', '副厂长', '运营管理部'].includes(req.userRole)) {
    return res.status(403).json({ error: '无权限生成演示数据' });
  }
  const counts = {};

  // 清空现有数据
  const clearTables = ['do_inspection','hourly_water','daily_lab','weekly_lab','sludge_special','dewatering','chemical_dosing','chemical_inventory','alerts','tasks'];
  const clearAll = db.transaction(() => {
    for (const t of clearTables) db.prepare('DELETE FROM [' + t + ']').run();
  });
  clearAll();

  // DO巡检（30天，每天东西两系列）
  const doData = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    ['east', 'west'].forEach(series => {
      ['早班', '中班'].forEach(shift => {
        doData.push({
          id: 'do_' + dateStr + '_' + series + '_' + shift,
          date: dateStr, shift, series, operator: series === 'east' ? '周班组1A' : '吴班组1B',
          anaerobic: round2(0.15 + Math.random() * 0.3),
          anoxic: round2(0.3 + Math.random() * 0.5),
          aerobic1: round2(1.5 + Math.random() * 1.5),
          aerobic2: round2(1.8 + Math.random() * 1.2),
          aerobic3: round2(2.0 + Math.random() * 1.0),
          aerobic4: round2(2.5 + Math.random() * 0.8),
          remark: '', createTime: dateStr + 'T08:00:00.000Z',
        });
      });
    });
  }
  const insertDO = db.transaction((items) => { for (const r of items) insertRow('do_inspection', r); });
  insertDO(doData);
  counts.inspection = doData.length;

  // 小时进出水（30天 × 24小时）
  const hourlyData = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      const baseInCod = 200 + Math.random() * 150;
      hourlyData.push({
        id: 'hw_' + dateStr + '_' + h,
        date: dateStr, hour: h, operator: '周班组1A',
        inCod: round1(baseInCod), inNh3: round2(15 + Math.random() * 20), inTn: round2(25 + Math.random() * 20), inTp: round2(2 + Math.random() * 3), inFlow: round1(800 + Math.random() * 400), inPh: round2(6.5 + Math.random() * 2),
        outCod: round1(8 + Math.random() * 35), outNh3: round2(0.2 + Math.random() * 4), outTn: round2(5 + Math.random() * 9), outTp: round2(0.1 + Math.random() * 0.4), outFlow: round1(750 + Math.random() * 380), outPh: round2(6.8 + Math.random() * 1.2),
        createTime: dateStr + 'T' + String(h).padStart(2, '0') + ':00:00.000Z',
      });
    }
  }
  const insertHourly = db.transaction((items) => { for (const r of items) insertRow('hourly_water', r); });
  insertHourly(hourlyData);
  counts.hourly = hourlyData.length;

  // 每日化验（30天）
  const dailyLabData = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    dailyLabData.push({
      id: 'dl_' + dateStr,
      date: dateStr, operator: '杨化验员1', reviewer: '韩化验主管', reviewStatus: i === 0 ? 'pending' : 'approved',
      ph: round2(6.5 + Math.random() * 2), ss: round1(5 + Math.random() * 10), bod5: round1(3 + Math.random() * 10), cod: round1(10 + Math.random() * 30), nh3: round2(0.1 + Math.random() * 4), tn: round2(5 + Math.random() * 9), tp: round2(0.1 + Math.random() * 0.4), fecalColiform: round1(100 + Math.random() * 900),
      sv30: round1(18 + Math.random() * 16), svi: round1(60 + Math.random() * 60), mlss: round1(2500 + Math.random() * 3000), microscope: '菌胶团结构' + (Math.random() > 0.5 ? '良好' : '一般') + '，原生动物' + (Math.random() > 0.5 ? '活跃' : '正常'),
      sv30East: round1(20 + Math.random() * 12), sv30West: round1(22 + Math.random() * 10), waterTempEast: round2(18 + Math.random() * 8), waterTempWest: round2(18 + Math.random() * 8), internalReflux: round1(100 + Math.random() * 200), externalReflux: round1(50 + Math.random() * 50),
      createTime: dateStr + 'T10:00:00.000Z',
    });
  }
  const insertLab = db.transaction((items) => { for (const r of items) insertRow('daily_lab', r); });
  insertLab(dailyLabData);
  counts.lab = dailyLabData.length;

  // 每周化验（4周）
  const weeklyLabData = [];
  for (let w = 3; w >= 0; w--) {
    const end = new Date(); end.setDate(end.getDate() - w * 7);
    const start = new Date(end); start.setDate(start.getDate() - 6);
    weeklyLabData.push({
      id: 'wl_' + start.toISOString().slice(0, 10),
      weekStart: start.toISOString().slice(0, 10), weekEnd: end.toISOString().slice(0, 10), operator: '朱化验员2',
      chloride: round1(50 + Math.random() * 80), mlvss: round1(1500 + Math.random() * 2000), totalSolid: round1(5000 + Math.random() * 3000), dissolvedSolid: round1(2000 + Math.random() * 2000),
      createTime: end.toISOString().slice(0, 10) + 'T10:00:00.000Z',
    });
  }
  const insertWeekly = db.transaction((items) => { for (const r of items) insertRow('weekly_lab', r); });
  insertWeekly(weeklyLabData);
  counts.weeklyLab = weeklyLabData.length;

  // 污泥专项（10条）
  const sludgeData = [];
  for (let i = 9; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i * 3);
    sludgeData.push({
      id: 'ss_' + i, date: d.toISOString().slice(0, 10), batchNo: 'BN' + (20260500 + i), operator: '秦化验员3',
      waterContent: round1(75 + Math.random() * 10), ph: round2(6.0 + Math.random() * 2), organicMatter: round1(30 + Math.random() * 20),
      createTime: d.toISOString(),
    });
  }
  const insertSludge = db.transaction((items) => { for (const r of items) insertRow('sludge_special', r); });
  insertSludge(sludgeData);
  counts.sludge = sludgeData.length;

  // 脱泥（30天）
  const dewaterData = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const hours = 3 + Math.random() * 5;
    dewaterData.push({
      id: 'dw_' + dateStr,
      date: dateStr, operator: '郑班组2A',
      startTime: '08:00', endTime: String(Math.floor(8 + hours)).padStart(2, '0') + ':' + String(Math.floor(Math.random() * 60)).padStart(2, '0'),
      duration: round2(hours), sludgeOutput: round1(8 + Math.random() * 20),
      abnormality: Math.random() > 0.85 ? '出泥含水率偏高' : '',
      createTime: dateStr + 'T17:00:00.000Z',
    });
  }
  const insertDewater = db.transaction((items) => { for (const r of items) insertRow('dewatering', r); });
  insertDewater(dewaterData);
  counts.dewatering = dewaterData.length;

  // 药剂投加（30天）
  const dosingData = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    ['早班', '中班'].forEach(shift => {
      dosingData.push({
        id: 'cd_' + dateStr + '_' + shift,
        date: dateStr, shift, operator: '褚班组3A',
        carbonSource: round1(50 + Math.random() * 100), glucose: round1(10 + Math.random() * 30),
        pac: round1(5 + Math.random() * 20), anionPam: round1(0.5 + Math.random() * 2),
        cationPam: round1(0.3 + Math.random() * 1), naclo: round1(2 + Math.random() * 8),
        createTime: dateStr + 'T' + (shift === '早班' ? '08' : '20') + ':00:00.000Z',
      });
    });
  }
  const insertDosing = db.transaction((items) => { for (const r of items) insertRow('chemical_dosing', r); });
  insertDosing(dosingData);
  counts.dosing = dosingData.length;

  // 药剂库存（初始入库 + 每日消耗出库）
  const invData = [];
  const chemicals = [
    { key: 'carbonSource', name: '碳源', init: 10000, daily: 120 },
    { key: 'glucose', name: '葡萄糖', init: 3000, daily: 20 },
    { key: 'pac', name: 'PAC', init: 5000, daily: 15 },
    { key: 'anionPam', name: '阴离子PAM', init: 500, daily: 1 },
    { key: 'cationPam', name: '阳离子PAM', init: 300, daily: 0.5 },
    { key: 'naclo', name: '次氯酸钠', init: 2000, daily: 5 },
  ];
  chemicals.forEach(c => {
    invData.push({ id: 'inv_' + c.key + '_init', date: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), operator: '卫班组3B', chemicalType: c.key, type: 'in', quantity: c.init, balance: c.init, supplier: '化工供应商A', batchNo: 'BN20260501', remark: '月初采购入库', createTime: new Date(Date.now() - 30 * 86400000).toISOString() });
    let balance = c.init;
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const used = c.daily * (0.8 + Math.random() * 0.4);
      balance -= used;
      invData.push({ id: 'inv_' + c.key + '_use_' + dateStr, date: dateStr, operator: '褚班组3A', chemicalType: c.key, type: 'use', quantity: round1(used), balance: round1(balance), remark: '日常消耗', createTime: dateStr + 'T18:00:00.000Z' });
    }
    if (balance < 500) {
      const restock = c.init * 0.5;
      balance += restock;
      invData.push({ id: 'inv_' + c.key + '_restock', date: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), operator: '卫班组3B', chemicalType: c.key, type: 'in', quantity: round1(restock), balance: round1(balance), supplier: '化工供应商B', batchNo: 'BN20260528', remark: '补充采购', createTime: new Date(Date.now() - 3 * 86400000).toISOString() });
    }
  });
  const insertInv = db.transaction((items) => { for (const r of items) insertRow('chemical_inventory', r); });
  insertInv(invData);
  counts.inventory = invData.length;

  // 预警（基于生成数据自动检测）
  const alertData = [];
  doData.forEach(r => {
    const checkDO = (val, pool) => { if (val && (Number(val) < 0.5 || Number(val) > 4.0)) { alertData.push({ id: 'alt_' + r.id + '_' + pool, time: r.createTime, type: 'DO异常', level: Number(val) < 0.5 ? 'high' : 'medium', source: 'DO巡检', title: r.series + '系列' + pool + ' DO=' + val + 'mg/L', detail: r.date + ' ' + r.shift + '（正常: 0.5-4.0mg/L）', status: Math.random() > 0.3 ? 'resolved' : 'active', resolvedBy: Math.random() > 0.3 ? '王运营主管' : '', resolvedTime: Math.random() > 0.3 ? new Date(new Date(r.createTime).getTime() + 3600000).toISOString() : '' }); } };
    checkDO(r.anaerobic, '厌氧池'); checkDO(r.anoxic, '缺氧池');
  });
  hourlyData.filter(r => Number(r.outCod) > 50).slice(0, 10).forEach(r => {
    alertData.push({ id: 'alt_cod_' + r.id, time: r.createTime, type: '水质异常', level: 'high', source: '小时进出水', title: '出水COD超标: ' + r.outCod + 'mg/L', detail: r.date + ' ' + r.hour + ':00（标准: ≤50mg/L）', status: 'active' });
  });
  const insertAlerts = db.transaction((items) => { for (const r of items) insertRow('alerts', r); });
  insertAlerts(alertData);
  counts.alerts = alertData.length;

  // 任务
  const taskData = [
    { id: 't1', title: '巡检东西系列曝气池DO', type: '巡检', priority: '高', status: '待处理', assignedTo: '周班组1A', deadline: new Date().toISOString().slice(0, 10), remark: '每日例行巡检', createTime: new Date().toISOString() },
    { id: 't2', title: '完成今日进出水COD化验', type: '化验', priority: '高', status: '待处理', assignedTo: '杨化验员1', deadline: new Date().toISOString().slice(0, 10), remark: '每日检测', createTime: new Date().toISOString() },
    { id: 't3', title: '更换加药间PAC药剂', type: '设备', priority: '中', status: '待处理', assignedTo: '褚班组3A', deadline: new Date().toISOString().slice(0, 10), remark: '药剂量不足', createTime: new Date().toISOString() },
    { id: 't4', title: '审核本周化验数据', type: '审核', priority: '高', status: '待处理', assignedTo: '韩化验主管', deadline: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), remark: '周五前完成', createTime: new Date().toISOString() },
    { id: 't5', title: '清理二沉池出水堰', type: '设备', priority: '中', status: '待处理', assignedTo: '冯班组2B', deadline: new Date(Date.now() + 86400000).toISOString().slice(0, 10), remark: '每周维护', createTime: new Date().toISOString() },
    { id: 't6', title: '校准在线监测仪表', type: '设备', priority: '中', status: '处理中', assignedTo: '赵技术主管', deadline: new Date().toISOString().slice(0, 10), remark: 'COD仪偏差超5%', createTime: new Date().toISOString() },
    { id: 't7', title: '处理格栅间异常噪音', type: '督检', priority: '高', status: '待处理', assignedTo: '郑班组2A', deadline: new Date().toISOString().slice(0, 10), remark: '现场巡检发现', createTime: new Date().toISOString() },
    { id: 't8', title: '总氮出水数据排查', type: '化验', priority: '高', status: '待处理', assignedTo: '杨化验员1', deadline: new Date().toISOString().slice(0, 10), remark: '昨日出水总氮接近限值', createTime: new Date().toISOString() },
  ];
  const insertTasks = db.transaction((items) => { for (const r of items) insertRow('tasks', r); });
  insertTasks(taskData);
  counts.tasks = taskData.length;

  res.json({ success: true, counts });
});

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

// ==================== 启动服务 ====================
  app.listen(PORT, () => {
    console.log('污水处理厂运行管理系统 v4.0 (' + dbType + ')');
    console.log('本地访问: http://localhost:' + PORT);
    console.log('数据库: ' + DB_PATH + ' (' + dbType + ')');
    console.log('登录账号: admin / admin123（厂长）');
    console.log('已启用: SQLite数据库 | ' + (dbType === 'better-sqlite3' ? 'WAL模式' : 'sql.js内存模式') + ' | 13张数据表 | 角色权限 | 智能加药 | 预警引擎 | Excel导出 | 趋势分析');
  });
} // end startServer()
