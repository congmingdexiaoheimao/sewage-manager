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
  if (r.canViewAll) return ['do_inspection','hourly_water','daily_lab','weekly_lab','sludge_special','dewatering','chemical_dosing','chemical_inventory','daily_summary','alerts','tasks','exportLog','users','daily','inspect','lab'];
  if (r.fillOps || r.isOps) return ['do_inspection','hourly_water','dewatering','chemical_dosing','chemical_inventory','daily_summary','tasks','alerts'];
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
  daily_summary: { id:'编号', date:'日期', operator:'填报人', electricity:'日用电量(kWh)', inFlowTotal:'日进水量(m³)', outFlowTotal:'日出水量(m³)', sludgeOutput:'日污泥产量(吨)', codRemoval:'COD去除率(%)', nh3Removal:'氨氮去除率(%)', tnRemoval:'总氮去除率(%)', tpRemoval:'总磷去除率(%)', runStatus:'运行状态', remark:'备注', groupId:'班组', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  alerts: { id:'编号', time:'预警时间', type:'预警类型', level:'预警等级', source:'来源', title:'标题', detail:'详情', status:'状态', resolvedBy:'处理人', resolvedTime:'处理时间' },
  tasks: { id:'编号', title:'任务标题', type:'任务类型', priority:'优先级', status:'状态', assignedTo:'负责人', deadline:'截止日期', remark:'备注', createTime:'创建时间' },
  users: { id:'编号', username:'用户名', name:'姓名', role:'角色', phone:'手机号', groupId:'班组', status:'状态', createTime:'创建时间' },
  exportLog: { id:'编号', table:'导出表', count:'导出条数', operator:'操作员', time:'导出时间' },
  equipment: { id:'编号', name:'设备名称', code:'设备编号', type:'设备类型', manufacturer:'生产厂家', model:'型号规格', purchaseDate:'购置日期', installDate:'安装日期', location:'安装位置', status:'运行状态', warrantyExpire:'保修到期', specs:'技术参数', remark:'备注', operator:'录入人', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  equipment_log: { id:'编号', equipmentId:'设备ID', date:'日期', shift:'班次', operationHours:'运行时长(h)', runStatus:'运行状态', temperature:'温度(°C)', pressure:'压力(MPa)', vibration:'振动值', current:'电流(A)', remark:'备注', operator:'操作员', createTime:'创建时间' },
  maintenance: { id:'编号', equipmentId:'设备ID', equipmentName:'设备名称', type:'工单类型', priority:'优先级', status:'状态', faultDesc:'故障描述', repairDesc:'维修内容', assignedTo:'维修人员', reportedBy:'报修人', reportedTime:'报修时间', startTime:'开始维修', finishTime:'完成时间', cost:'维修费用(元)', parts:'更换配件', remark:'备注', createTime:'创建时间', updateTime:'更新时间', updatedBy:'更新人' },
  shift_schedule: { id:'编号', date:'排班日期', shift:'班次', team:'班组', members:'成员', remark:'备注', operator:'制定人', createTime:'创建时间', updateTime:'更新时间' },
  shift_handover: { id:'编号', date:'交班日期', shift:'班次', team:'班组', handoverPerson:'交班人', receivePerson:'接班人', runStatus:'运行状态', doStatus:'DO情况', waterQuality:'水质情况', equipmentStatus:'设备情况', chemicalStatus:'药剂情况', alerts:'预警情况', pendingItems:'待处理事项', remark:'备注', createTime:'创建时间' },
  audit_log: { id:'编号', time:'操作时间', operator:'操作人', operatorRole:'角色', action:'操作类型', targetTable:'操作表', targetId:'记录ID', beforeData:'修改前', afterData:'修改后', ipAddr:'IP地址', userAgent:'终端信息' },
};

// ==================== 建表与迁移 ====================
const ALL_TABLES = ['do_inspection','hourly_water','daily_lab','weekly_lab','sludge_special','dewatering','chemical_dosing','chemical_inventory','daily_summary','alerts','tasks','exportLog','users','daily','inspect','lab','equipment','equipment_log','maintenance','shift_schedule','shift_handover','audit_log'];

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
  daily_summary: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, electricity TEXT, inFlowTotal TEXT, outFlowTotal TEXT, sludgeOutput TEXT, codRemoval TEXT, nh3Removal TEXT, tnRemoval TEXT, tpRemoval TEXT, runStatus TEXT, remark TEXT, groupId TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  alerts: 'id TEXT PRIMARY KEY, time TEXT, type TEXT, level TEXT, source TEXT, title TEXT, detail TEXT, status TEXT, resolvedBy TEXT, resolvedTime TEXT',
  tasks: 'id TEXT PRIMARY KEY, title TEXT, type TEXT, priority TEXT, status TEXT, assignedTo TEXT, deadline TEXT, remark TEXT, createTime TEXT',
  users: 'id TEXT PRIMARY KEY, username TEXT, name TEXT, role TEXT, phone TEXT, groupId TEXT, status TEXT, password TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  exportLog: 'id TEXT PRIMARY KEY, [table] TEXT, count TEXT, operator TEXT, time TEXT',
  // 兼容旧表
  daily: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, remark TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  inspect: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, remark TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  lab: 'id TEXT PRIMARY KEY, date TEXT, operator TEXT, remark TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  // v4.5 新增：设备台账
  equipment: 'id TEXT PRIMARY KEY, name TEXT, code TEXT, type TEXT, manufacturer TEXT, model TEXT, purchaseDate TEXT, installDate TEXT, location TEXT, status TEXT, warrantyExpire TEXT, specs TEXT, remark TEXT, operator TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  equipment_log: 'id TEXT PRIMARY KEY, equipmentId TEXT, date TEXT, shift TEXT, operationHours TEXT, runStatus TEXT, temperature TEXT, pressure TEXT, vibration TEXT, current TEXT, remark TEXT, operator TEXT, createTime TEXT',
  maintenance: 'id TEXT PRIMARY KEY, equipmentId TEXT, equipmentName TEXT, type TEXT, priority TEXT, status TEXT, faultDesc TEXT, repairDesc TEXT, assignedTo TEXT, reportedBy TEXT, reportedTime TEXT, startTime TEXT, finishTime TEXT, cost TEXT, parts TEXT, remark TEXT, createTime TEXT, updateTime TEXT, updatedBy TEXT',
  // v4.5 新增：交班排班
  shift_schedule: 'id TEXT PRIMARY KEY, date TEXT, shift TEXT, team TEXT, members TEXT, remark TEXT, operator TEXT, createTime TEXT, updateTime TEXT',
  shift_handover: 'id TEXT PRIMARY KEY, date TEXT, shift TEXT, team TEXT, handoverPerson TEXT, receivePerson TEXT, runStatus TEXT, doStatus TEXT, waterQuality TEXT, equipmentStatus TEXT, chemicalStatus TEXT, alerts TEXT, pendingItems TEXT, remark TEXT, createTime TEXT',
  // v4.5 新增：运营日志审计
  audit_log: 'id TEXT PRIMARY KEY, time TEXT, operator TEXT, operatorRole TEXT, action TEXT, targetTable TEXT, targetId TEXT, beforeData TEXT, afterData TEXT, ipAddr TEXT, userAgent TEXT',
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

  // 自动生成模拟数据（如果核心表为空且没有JSON文件）
  const doCount = db.prepare('SELECT COUNT(*) as cnt FROM do_inspection').get().cnt;
  if (doCount === 0 && !fs.existsSync(JSON_DB_FILE)) {
    console.log('正在生成模拟数据...');
    const now = new Date().toISOString();
    const today = new Date();
    const rand = (min, max, dec) => { const v = min + Math.random() * (max - min); return dec ? v.toFixed(dec) : Math.round(v).toString(); };

    // 1. DO巡检 - 30天 x 2班次 x 2系列
    const insertDO = db.prepare('INSERT OR IGNORE INTO do_inspection (id,date,shift,series,operator,anaerobic,anoxic,aerobic1,aerobic2,aerobic3,aerobic4,remark,groupId,createTime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertDOMany = db.transaction((items) => { for (const i of items) insertDO.run(...i); });
    const doItems = [];
    for (let day = 29; day >= 0; day--) {
      const d = new Date(today); d.setDate(d.getDate() - day); const ds = d.toISOString().slice(0,10);
      for (const shift of ['白班','夜班']) {
        for (const series of ['east','west']) {
          doItems.push([
            'do_' + ds + '_' + shift + '_' + series, ds, shift, series, '系统', 
            rand(0.05, 0.18, 2), rand(0.1, 0.45, 2), rand(2.5, 4.3, 2), rand(2.5, 4.3, 2), rand(2.5, 4.3, 2), rand(2.5, 4.3, 2),
            '', 'group1', now
          ]);
        }
      }
    }
    insertDOMany(doItems);
    console.log('  生成 do_inspection: ' + doItems.length + ' 条');

    // 2. 小时进出水 - 30天 x 24小时
    const insertHW = db.prepare('INSERT OR IGNORE INTO hourly_water (id,date,hour,operator,inCod,inNh3,inTn,inTp,inFlow,inPh,outCod,outNh3,outTn,outTp,outFlow,outPh,groupId,createTime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertHWMany = db.transaction((items) => { for (const i of items) insertHW.run(...i); });
    const hwItems = [];
    for (let day = 29; day >= 0; day--) {
      const d = new Date(today); d.setDate(d.getDate() - day); const ds = d.toISOString().slice(0,10);
      for (let h = 0; h < 24; h++) {
        hwItems.push([
          'hw_' + ds + '_' + h, ds, h.toString(), '系统',
          rand(180, 350, 1), rand(15, 40, 2), rand(25, 50, 2), rand(2, 6, 2), rand(350, 500, 0), rand(6.5, 7.5, 2),
          rand(20, 50, 1), rand(1, 5, 2), rand(8, 15, 2), rand(0.2, 0.5, 2), rand(340, 480, 0), rand(6.8, 7.5, 2),
          'group1', now
        ]);
      }
    }
    insertHWMany(hwItems);
    console.log('  生成 hourly_water: ' + hwItems.length + ' 条');

    // 3. 每日化验 - 30天
    const insertDL = db.prepare('INSERT OR IGNORE INTO daily_lab (id,date,operator,reviewer,reviewStatus,ph,ss,bod5,cod,nh3,tn,tp,fecalColiform,sv30,svi,mlss,microscope,sv30East,sv30West,waterTempEast,waterTempWest,internalReflux,externalReflux,groupId,createTime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertDLMany = db.transaction((items) => { for (const i of items) insertDL.run(...i); });
    const dlItems = [];
    for (let day = 29; day >= 0; day--) {
      const d = new Date(today); d.setDate(d.getDate() - day); const ds = d.toISOString().slice(0,10);
      dlItems.push([
        'dl_' + ds, ds, '系统', '系统', 'approved',
        rand(6.8, 7.5, 2), rand(10, 30, 1), rand(5, 15, 1), rand(20, 45, 1), rand(0.5, 4, 2), rand(8, 14, 2), rand(0.2, 0.5, 2),
        rand(1000, 5000, 0), rand(18, 32, 1), rand(80, 130, 1), rand(2500, 4000, 0), '菌胶团紧密，钟虫多',
        rand(18, 32, 1), rand(18, 32, 1), rand(15, 25, 1), rand(15, 25, 1), rand(100, 300, 0), rand(50, 100, 0),
        'group1', now
      ]);
    }
    insertDLMany(dlItems);
    console.log('  生成 daily_lab: ' + dlItems.length + ' 条');

    // 4. 药剂投加 - 30天 x 2班次
    const insertCD = db.prepare('INSERT OR IGNORE INTO chemical_dosing (id,date,shift,operator,carbonSource,glucose,pac,anionPam,cationPam,naclo,groupId,createTime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertCDMany = db.transaction((items) => { for (const i of items) insertCD.run(...i); });
    const cdItems = [];
    for (let day = 29; day >= 0; day--) {
      const d = new Date(today); d.setDate(d.getDate() - day); const ds = d.toISOString().slice(0,10);
      for (const shift of ['白班','夜班']) {
        cdItems.push([
          'cd_' + ds + '_' + shift, ds, shift, '系统',
          rand(150, 300, 1), rand(50, 100, 1), rand(80, 200, 1), rand(2, 8, 1), rand(3, 10, 1), rand(20, 60, 1),
          'group1', now
        ]);
      }
    }
    insertCDMany(cdItems);
    console.log('  生成 chemical_dosing: ' + cdItems.length + ' 条');

    // 5. 药剂库存初始化
    const insertCI = db.prepare('INSERT OR IGNORE INTO chemical_inventory (id,date,operator,chemicalType,type,quantity,balance,supplier,batchNo,remark,createTime) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const insertCIMany = db.transaction((items) => { for (const i of items) insertCI.run(...i); });
    const ciItems = [];
    const chems = [
      { key: 'carbonSource', name: '碳源', stock: 5000 },
      { key: 'glucose', name: '葡萄糖', stock: 2000 },
      { key: 'pac', name: 'PAC', stock: 3000 },
      { key: 'anionPam', name: '阴离子PAM', stock: 800 },
      { key: 'cationPam', name: '阳离子PAM', stock: 600 },
      { key: 'naclo', name: '次氯酸钠', stock: 1500 },
    ];
    const initDate = new Date(today); initDate.setDate(initDate.getDate() - 30);
    chems.forEach(c => {
      ciItems.push(['ci_init_' + c.key, initDate.toISOString().slice(0,10), '系统', c.key, 'in', c.stock.toString(), c.stock.toString(), '供应商A', 'B2026001', '初始库存', now]);
    });
    insertCIMany(ciItems);
    console.log('  生成 chemical_inventory: ' + ciItems.length + ' 条');

    // 6. 脱泥生产 - 30天
    const insertDW = db.prepare('INSERT OR IGNORE INTO dewatering (id,date,operator,startTime,endTime,duration,sludgeOutput,abnormality,groupId,createTime) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const insertDWMany = db.transaction((items) => { for (const i of items) insertDW.run(...i); });
    const dwItems = [];
    for (let day = 29; day >= 0; day--) {
      const d = new Date(today); d.setDate(d.getDate() - day); const ds = d.toISOString().slice(0,10);
      dwItems.push(['dw_' + ds, ds, '系统', '08:00', '16:00', rand(6, 10, 1), rand(8, 20, 1), '', 'group1', now]);
    }
    insertDWMany(dwItems);
    console.log('  生成 dewatering: ' + dwItems.length + ' 条');

    // 7. 每日汇总 - 30天
    const insertDS = db.prepare('INSERT OR IGNORE INTO daily_summary (id,date,operator,electricity,inFlowTotal,outFlowTotal,sludgeOutput,codRemoval,nh3Removal,tnRemoval,tpRemoval,runStatus,remark,groupId,createTime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertDSMany = db.transaction((items) => { for (const i of items) insertDS.run(...i); });
    const dsItems = [];
    for (let day = 29; day >= 0; day--) {
      const d = new Date(today); d.setDate(d.getDate() - day); const ds = d.toISOString().slice(0,10);
      dsItems.push([
        'ds_' + ds, ds, '系统',
        rand(2800, 4200, 0),   // 日用电量 kWh
        rand(8000, 12000, 0),  // 日进水量 m³
        rand(7500, 11500, 0),  // 日出水量 m³
        rand(8, 20, 1),        // 日污泥产量 吨
        '正常运行', '', 'group1', now
      ]);
    }
    insertDSMany(dsItems);
    console.log('  生成 daily_summary: ' + dsItems.length + ' 条');

    console.log('模拟数据生成完成');
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
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
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
    // 天津市地方B标准（DB12/599-2015）
    if (record.outCod && Number(record.outCod) > 40) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_cod', time: now, type: '水质异常', level: 'high', source: '小时进出水', title: '出水COD超标: ' + record.outCod + 'mg/L', detail: record.date + ' ' + record.hour + ':00 出水COD=' + record.outCod + 'mg/L（天津B标准: ≤40mg/L）', status: 'active' });
    }
    if (record.outNh3 && Number(record.outNh3) > 5) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_nh3', time: now, type: '水质异常', level: 'high', source: '小时进出水', title: '出水氨氮超标: ' + record.outNh3 + 'mg/L', detail: record.date + ' ' + record.hour + ':00 出水氨氮=' + record.outNh3 + 'mg/L（天津B标准: ≤5mg/L，水温≤12℃时≤8mg/L）', status: 'active' });
    }
    if (record.outTn && Number(record.outTn) > 15) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_tn', time: now, type: '水质异常', level: 'medium', source: '小时进出水', title: '出水总氮超标: ' + record.outTn + 'mg/L', detail: record.date + ' ' + record.hour + ':00 出水总氮=' + record.outTn + 'mg/L（天津B标准: ≤15mg/L）', status: 'active' });
    }
    if (record.outTp && Number(record.outTp) > 0.5) {
      newAlerts.push({ id: 'alt_' + Date.now() + '_tp', time: now, type: '水质异常', level: 'medium', source: '小时进出水', title: '出水总磷超标: ' + record.outTp + 'mg/L', detail: record.date + ' ' + record.hour + ':00 出水总磷=' + record.outTp + 'mg/L（天津B标准: ≤0.5mg/L）', status: 'active' });
    }
  }

  if (table === 'do_inspection') {
    // 不同池的DO下限阈值（mg/L）：厌氧池 < 0.2 预警，缺氧池 < 0.5 预警，好氧池 2.5-4.5
    const doThresholds = {
      '厌氧池': { low: 0, high: 0.2, lowLabel: '<0', normalRange: '<0.2' },
      '缺氧池': { low: 0, high: 0.5, lowLabel: '<0', normalRange: '<0.5' },
      '好氧池1': { low: 2.5, high: 4.5, lowLabel: '<2.5', normalRange: '2.5-4.5' },
      '好氧池2': { low: 2.5, high: 4.5, lowLabel: '<2.5', normalRange: '2.5-4.5' },
      '好氧池3': { low: 2.5, high: 4.5, lowLabel: '<2.5', normalRange: '2.5-4.5' },
      '好氧池4': { low: 2.5, high: 4.5, lowLabel: '<2.5', normalRange: '2.5-4.5' },
    };
    const checkDO = (val, pool) => {
      if (val !== undefined && val !== null && val !== '') {
        const v = Number(val);
        const th = doThresholds[pool] || { low: 2.5, high: 4.5, normalRange: '2.5-4.5' };
        if (v < th.low) newAlerts.push({ id: 'alt_' + Date.now() + '_do_low_' + pool, time: now, type: 'DO异常', level: 'high', source: 'DO巡检', title: pool + '溶解氧过低: ' + v + 'mg/L', detail: record.date + ' ' + record.series + '系列 ' + pool + ' DO=' + v + 'mg/L（正常: ' + th.normalRange + 'mg/L）', status: 'active' });
        if (v > th.high) newAlerts.push({ id: 'alt_' + Date.now() + '_do_high_' + pool, time: now, type: 'DO异常', level: 'medium', source: 'DO巡检', title: pool + '溶解氧过高: ' + v + 'mg/L', detail: record.date + ' ' + record.series + '系列 ' + pool + ' DO=' + v + 'mg/L（正常: ' + th.normalRange + 'mg/L）', status: 'active' });
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
  const seriesFilter = req.query.series || 'east'; // east | west | both
  const startDate = new Date(); startDate.setDate(startDate.getDate() - range + 1);
  const dates = []; for (let i = 0; i < range; i++) { const d = new Date(startDate); d.setDate(d.getDate() + i); dates.push(d.toISOString().slice(0, 10)); }

  let result = { labels: dates.map(d => d.slice(5)), datasets: [], thresholds: [], summary: {} };

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
    result.datasets = [
      { label: '进水COD', data: dates.map(d => dailyAvg[d]?.inCod || null), borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.1)', tension: 0.3, borderWidth: 2 },
      { label: '出水COD', data: dates.map(d => dailyAvg[d]?.outCod || null), borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,0.1)', tension: 0.3, borderWidth: 2 },
      { label: '进水氨氮', data: dates.map(d => dailyAvg[d]?.inNh3 || null), borderColor: '#2ecc71', tension: 0.3, hidden: true, borderWidth: 2 },
      { label: '出水氨氮', data: dates.map(d => dailyAvg[d]?.outNh3 || null), borderColor: '#f39c12', tension: 0.3, hidden: true, borderWidth: 2 },
      { label: '进水总氮', data: dates.map(d => dailyAvg[d]?.inTn || null), borderColor: '#8e44ad', tension: 0.3, hidden: true, borderWidth: 2 },
      { label: '出水总氮', data: dates.map(d => dailyAvg[d]?.outTn || null), borderColor: '#9b59b6', tension: 0.3, hidden: true, borderWidth: 2 },
      { label: '进水总磷', data: dates.map(d => dailyAvg[d]?.inTp || null), borderColor: '#16a085', tension: 0.3, hidden: true, borderWidth: 2 },
      { label: '出水总磷', data: dates.map(d => dailyAvg[d]?.outTp || null), borderColor: '#1abc9c', tension: 0.3, hidden: true, borderWidth: 2 },
    ];
    // 天津B标准限值线
    result.thresholds = [
      { label: 'COD限值(50)', value: 50, color: '#e74c3c', dash: [6,4] },
      { label: '氨氮限值(5)', value: 5, color: '#f39c12', dash: [6,4] },
      { label: '总氮限值(15)', value: 15, color: '#9b59b6', dash: [6,4] },
      { label: '总磷限值(0.5)', value: 0.5, color: '#1abc9c', dash: [6,4] },
    ];
    // 统计摘要
    const outCodArr = dates.map(d => dailyAvg[d]?.outCod).filter(v => v != null);
    const outNh3Arr = dates.map(d => dailyAvg[d]?.outNh3).filter(v => v != null);
    const outTnArr = dates.map(d => dailyAvg[d]?.outTn).filter(v => v != null);
    const outTpArr = dates.map(d => dailyAvg[d]?.outTp).filter(v => v != null);
    result.summary = {
      outCod: calcStats(outCodArr, 50), outNh3: calcStats(outNh3Arr, 5),
      outTn: calcStats(outTnArr, 15), outTp: calcStats(outTpArr, 0.5),
      dataDays: Object.keys(dailyAvg).length, totalDays: dates.length,
    };

  } else if (type === 'do') {
    // 查询东系列和西系列数据
    const eastData = db.prepare("SELECT * FROM do_inspection WHERE date >= ? AND series = 'east'").all(dates[0]);
    const westData = db.prepare("SELECT * FROM do_inspection WHERE date >= ? AND series = 'west'").all(dates[0]);

    const buildDailyDO = (records) => {
      const doMap = {};
      records.forEach(r => { if (!doMap[r.date]) doMap[r.date] = []; doMap[r.date].push(r); });
      const daily = {};
      dates.forEach(d => {
        const recs = doMap[d] || [];
        if (recs.length > 0) {
          daily[d] = {
            anaerobic: avg(recs, 'anaerobic'), anoxic: avg(recs, 'anoxic'),
            aerobic1: avg(recs, 'aerobic1'), aerobic2: avg(recs, 'aerobic2'),
            aerobic3: avg(recs, 'aerobic3'), aerobic4: avg(recs, 'aerobic4'),
          };
        }
      });
      return daily;
    };

    const eastDaily = buildDailyDO(eastData);
    const westDaily = buildDailyDO(westData);

    const pools = ['anaerobic', 'anoxic', 'aerobic1', 'aerobic2', 'aerobic3', 'aerobic4'];
    const poolNames = { anaerobic: '厌氧池', anoxic: '缺氧池', aerobic1: '好氧池1', aerobic2: '好氧池2', aerobic3: '好氧池3', aerobic4: '好氧池4' };
    const poolColors = { anaerobic: '#e74c3c', anoxic: '#3498db', aerobic1: '#2ecc71', aerobic2: '#f39c12', aerobic3: '#9b59b6', aerobic4: '#1abc9c' };
    // 西系列用虚线+透明度区分
    const poolColorsWest = { anaerobic: '#c0392b', anoxic: '#2980b9', aerobic1: '#27ae60', aerobic2: '#e67e22', aerobic3: '#8e44ad', aerobic4: '#16a085' };

    const datasets = [];
    // 东系列
    if (seriesFilter === 'east' || seriesFilter === 'both') {
      pools.forEach(p => {
        datasets.push({
          label: '东·' + poolNames[p], data: dates.map(d => eastDaily[d]?.[p] || null),
          borderColor: poolColors[p], tension: 0.3, borderWidth: 2,
          pointRadius: 3, pointHoverRadius: 5,
        });
      });
    }
    // 西系列
    if (seriesFilter === 'west' || seriesFilter === 'both') {
      pools.forEach(p => {
        datasets.push({
          label: '西·' + poolNames[p], data: dates.map(d => westDaily[d]?.[p] || null),
          borderColor: poolColorsWest[p], tension: 0.3, borderWidth: 2, borderDash: [6, 3],
          pointRadius: 3, pointHoverRadius: 5, pointStyle: 'rectRot',
        });
      });
    }
    result.datasets = datasets;

    // DO预警阈值线
    result.thresholds = [
      { label: '厌氧上限(0.2)', value: 0.2, color: '#e74c3c', dash: [4,4] },
      { label: '缺氧上限(0.5)', value: 0.5, color: '#3498db', dash: [4,4] },
      { label: '好氧下限(2.5)', value: 2.5, color: '#2ecc71', dash: [4,4] },
      { label: '好氧上限(4.5)', value: 4.5, color: '#f39c12', dash: [4,4] },
    ];

    // DO统计摘要 — 基于东系列
    const summary = {};
    const targetDaily = seriesFilter === 'west' ? westDaily : eastDaily;
    pools.forEach(p => {
      const arr = dates.map(d => targetDaily[d]?.[p]).filter(v => v != null);
      const thresholds = { anaerobic: 0.2, anoxic: 0.5, aerobic1: 2.5, aerobic2: 2.5, aerobic3: 2.5, aerobic4: 2.5 };
      const upperLimits = { anaerobic: 0.2, anoxic: 0.5, aerobic1: 4.5, aerobic2: 4.5, aerobic3: 4.5, aerobic4: 4.5 };
      let exceedCount = 0;
      if (p.startsWith('aerobic')) {
        exceedCount = arr.filter(v => v < thresholds[p] || v > upperLimits[p]).length;
      } else {
        // 厌氧池和缺氧池：超过上限即异常（DO应保持低值）
        exceedCount = arr.filter(v => v > upperLimits[p]).length;
      }
      summary[p] = {
        ...calcStats(arr),
        exceedCount, exceedRate: arr.length > 0 ? Math.round(exceedCount / arr.length * 100) : 0,
        threshold: thresholds[p], upperLimit: upperLimits[p],
      };
    });
    result.summary = summary;
    result.summary.dataDays = Object.keys(targetDaily).length;
    result.summary.totalDays = dates.length;
    result.summary.series = seriesFilter;

  } else if (type === 'sludge') {
    const data = db.prepare('SELECT * FROM daily_lab WHERE date >= ?').all(dates[0]);
    const svMap = {}, mlssMap = {};
    data.forEach(r => { svMap[r.date] = Number(r.sv30) || null; mlssMap[r.date] = Number(r.mlss) || null; });
    result.datasets = [
      { label: 'SV30(%)', data: dates.map(d => svMap[d] || null), borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,0.1)', tension: 0.3, yAxisID: 'y', borderWidth: 2, fill: true },
      { label: 'MLSS(mg/L)', data: dates.map(d => mlssMap[d] || null), borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.1)', tension: 0.3, yAxisID: 'y1', borderWidth: 2, fill: true },
    ];
    // SV30和MLSS正常范围
    result.thresholds = [
      { label: 'SV30上限(30%)', value: 30, color: '#e74c3c', dash: [6,4], yAxisID: 'y' },
      { label: 'MLSS下限(2000)', value: 2000, color: '#3498db', dash: [6,4], yAxisID: 'y1' },
      { label: 'MLSS上限(4000)', value: 4000, color: '#3498db', dash: [6,4], yAxisID: 'y1' },
    ];
    const svArr = dates.map(d => svMap[d]).filter(v => v != null);
    const mlssArr = dates.map(d => mlssMap[d]).filter(v => v != null);
    result.summary = {
      sv30: { ...calcStats(svArr), exceedCount: svArr.filter(v => v > 30).length },
      mlss: { ...calcStats(mlssArr), lowCount: mlssArr.filter(v => v < 2000).length, highCount: mlssArr.filter(v => v > 4000).length },
      dataDays: data.length, totalDays: dates.length,
    };

  } else if (type === 'chemical') {
    const data = db.prepare('SELECT * FROM chemical_dosing WHERE date >= ?').all(dates[0]);
    const chemMap = {};
    data.forEach(r => { if (!chemMap[r.date]) chemMap[r.date] = []; chemMap[r.date].push(r); });
    const dailyChem = {};
    dates.forEach(d => { const recs = chemMap[d] || []; if (recs.length > 0) { dailyChem[d] = { carbonSource: avg(recs, 'carbonSource'), glucose: avg(recs, 'glucose'), pac: avg(recs, 'pac'), anionPam: avg(recs, 'anionPam'), cationPam: avg(recs, 'cationPam'), naclo: avg(recs, 'naclo') }; } });
    result.datasets = [
      { label: '碳源(kg)', data: dates.map(d => dailyChem[d]?.carbonSource || null), borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,0.15)', tension: 0.3, borderWidth: 2, fill: true },
      { label: 'PAC(kg)', data: dates.map(d => dailyChem[d]?.pac || null), borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.15)', tension: 0.3, borderWidth: 2, fill: true },
      { label: '葡萄糖(kg)', data: dates.map(d => dailyChem[d]?.glucose || null), borderColor: '#2ecc71', tension: 0.3, hidden: true, borderWidth: 2 },
      { label: '次氯酸钠(kg)', data: dates.map(d => dailyChem[d]?.naclo || null), borderColor: '#9b59b6', tension: 0.3, hidden: true, borderWidth: 2 },
      { label: '阴离子PAM(kg)', data: dates.map(d => dailyChem[d]?.anionPam || null), borderColor: '#f39c12', tension: 0.3, hidden: true, borderWidth: 2 },
      { label: '阳离子PAM(kg)', data: dates.map(d => dailyChem[d]?.cationPam || null), borderColor: '#1abc9c', tension: 0.3, hidden: true, borderWidth: 2 },
    ];
    const csArr = dates.map(d => dailyChem[d]?.carbonSource).filter(v => v != null);
    const pacArr = dates.map(d => dailyChem[d]?.pac).filter(v => v != null);
    const glucArr = dates.map(d => dailyChem[d]?.glucose).filter(v => v != null);
    result.summary = {
      carbonSource: calcStats(csArr), pac: calcStats(pacArr), glucose: calcStats(glucArr),
      dataDays: Object.keys(dailyChem).length, totalDays: dates.length,
    };
  }
  res.json(result);
});

// 统计计算辅助函数：均值、最大、最小、标准差
function calcStats(arr, limit) {
  if (!arr || arr.length === 0) return { avg: null, min: null, max: null, std: null, count: 0 };
  const sum = arr.reduce((a, b) => a + b, 0);
  const mean = sum / arr.length;
  const std = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  const stats = {
    avg: Math.round(mean * 100) / 100,
    min: Math.round(Math.min(...arr) * 100) / 100,
    max: Math.round(Math.max(...arr) * 100) / 100,
    std: Math.round(std * 100) / 100,
    count: arr.length,
  };
  if (limit != null) {
    stats.exceedCount = arr.filter(v => v > limit).length;
    stats.exceedRate = Math.round(stats.exceedCount / arr.length * 100);
    stats.complianceRate = 100 - stats.exceedRate;
  }
  return stats;
}

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

    inCod = avg(sample, 'inCod') || 0;
    inNh3 = avg(sample, 'inNh3') || 0;
    inTn = avg(sample, 'inTn') || 0;
    inTp = avg(sample, 'inTp') || 0;
    inFlow = avg(sample, 'inFlow') || 0;
    outCod = avg(sample, 'outCod') || 0;
    outNh3 = avg(sample, 'outNh3') || 0;
    outTn = avg(sample, 'outTn') || 0;
    outTp = avg(sample, 'outTp') || 0;

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
  const pRemoveKg = Math.round((tpToRemove || 0) * (inFlow || 0) / 1000 * 100) / 100;  // 除磷量(kg/d)
  let pacBase = Math.round(tpToRemove * (inFlow || 0) / 1000 * 1.3 / 0.29 * (102 / 54) * 100) / 100; // 治污者说专业公式：去除1kgP需1.3kgAl，PAC(29%)投加量=总磷去除量×8.48

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

  // --- 三氯化铁（PAC替代选项）---
  const feCl3Base = Math.round(pRemoveKg * 2.7 / 0.40 * 100) / 100;  // Fe:P=2.7:1, FeCl3 40%
  const feCl3 = Math.round(feCl3Base * pacTrendAdjust * 100) / 100;  // 使用趋势调整因子

  

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
      warnings: waterQualityWarnings,
    },
    sludgeStatus,
  const pacAdjust = Math.round(pacSludgeAdjust * pacTrendAdjust * 100) / 100;  // PAC总调整因子
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
      {
        chemical: '三氯化铁', key: 'feCl3', value: feCl3, unit: 'kg/d',
        range: [Math.round(feCl3 * 0.7 * 100) / 100, Math.round(feCl3 * 1.3 * 100) / 100],
        baseValue: Math.round(feCl3Base * 100) / 100,
        adjustFactors: { tp: pacAdjust, trend: pacTrendAdjust },
        history: compareWithHistory('feCl3', feCl3),
        tip: feCl3 > 30 ? "铁盐除磷效率高于PAC，注意设备防腐" : "铁盐腐蚀性较强，操作注意安全防护",
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
      ['白班', '夜班'].forEach(shift => {
        doData.push({
          id: 'do_' + dateStr + '_' + series + '_' + shift,
          date: dateStr, shift, series, operator: series === 'east' ? '周班组1A' : '吴班组1B',
          anaerobic: round2(0.05 + Math.random() * 0.12),
          anoxic: round2(0.1 + Math.random() * 0.35),
          aerobic1: round2(2.5 + Math.random() * 1.8),
          aerobic2: round2(2.5 + Math.random() * 1.8),
          aerobic3: round2(2.5 + Math.random() * 1.8),
          aerobic4: round2(2.5 + Math.random() * 1.8),
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
    ['白班', '夜班'].forEach(shift => {
      dosingData.push({
        id: 'cd_' + dateStr + '_' + shift,
        date: dateStr, shift, operator: '褚班组3A',
        carbonSource: round1(50 + Math.random() * 100), glucose: round1(10 + Math.random() * 30),
        pac: round1(5 + Math.random() * 20), anionPam: round1(0.5 + Math.random() * 2),
        cationPam: round1(0.3 + Math.random() * 1), naclo: round1(2 + Math.random() * 8),
        createTime: dateStr + 'T' + (shift === '白班' ? '08' : '20') + ':00:00.000Z',
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

// ==================== 运营日志审计钩子 ====================
function writeAuditLog(req, action, targetTable, targetId, beforeData, afterData) {
  try {
    const logId = 'audit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const operator = req.userName || (req.user && req.user.name) || 'unknown';
    const operatorRole = req.userRole || '';
    const ipAddr = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
    const userAgent = (req.headers['user-agent'] || '').slice(0, 120);
    insertRow('audit_log', {
      id: logId,
      time: new Date().toISOString(),
      operator,
      operatorRole,
      action,
      targetTable: targetTable || '',
      targetId: targetId || '',
      beforeData: beforeData ? JSON.stringify(beforeData).slice(0, 500) : '',
      afterData: afterData ? JSON.stringify(afterData).slice(0, 500) : '',
      ipAddr,
      userAgent,
    });
  } catch (e) {
    // 审计日志失败不影响主业务
  }
}

// ==================== 设备台账管理 ====================
// 获取设备列表（含故障统计）
app.get('/api/equipment/list', authMiddleware, (req, res) => {
  try {
    const { status, type, keyword } = req.query;
    let sql = 'SELECT * FROM equipment WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (type) { sql += ' AND type=?'; params.push(type); }
    if (keyword) { sql += ' AND (name LIKE ? OR code LIKE ? OR location LIKE ?)'; params.push('%'+keyword+'%', '%'+keyword+'%', '%'+keyword+'%'); }
    sql += ' ORDER BY createTime DESC LIMIT 200';
    const equipList = db.prepare(sql).all(...params);

    // 每台设备统计待处理维修工单数
    const pendingMap = {};
    const pendingRows = db.prepare("SELECT equipmentId, COUNT(*) as cnt FROM maintenance WHERE status IN ('待处理','处理中') GROUP BY equipmentId").all();
    pendingRows.forEach(r => { pendingMap[r.equipmentId] = r.cnt; });

    const result = equipList.map(e => ({
      ...e,
      pendingMaintenance: pendingMap[e.id] || 0,
    }));
    res.json({ data: result, total: result.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 新增/更新设备
app.post('/api/equipment', authMiddleware, (req, res) => {
  if (!req.userPermissions.canManage && !['厂长','副厂长','运营管理部','技术管理部'].includes(req.userRole)) {
    return res.status(403).json({ error: '无权限操作设备台账' });
  }
  try {
    const record = { ...req.body, id: req.body.id || 'equip_' + Date.now(), operator: req.userName, createTime: req.body.createTime || new Date().toISOString(), updateTime: new Date().toISOString(), updatedBy: req.userName };
    insertRow('equipment', record);
    writeAuditLog(req, '新增设备', 'equipment', record.id, null, record);
    res.json({ success: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/equipment/:id', authMiddleware, (req, res) => {
  if (!req.userPermissions.canManage && !['厂长','副厂长','运营管理部','技术管理部'].includes(req.userRole)) {
    return res.status(403).json({ error: '无权限操作设备台账' });
  }
  try {
    const old = db.prepare('SELECT * FROM equipment WHERE id=?').get(req.params.id);
    const update = { ...req.body, updateTime: new Date().toISOString(), updatedBy: req.userName };
    const keys = Object.keys(update).filter(k => k !== 'id');
    if (keys.length === 0) return res.status(400).json({ error: '无更新字段' });
    const setStr = keys.map(k => '[' + k + ']=?').join(',');
    db.prepare('UPDATE equipment SET ' + setStr + ' WHERE id=?').run(...keys.map(k => update[k]), req.params.id);
    writeAuditLog(req, '修改设备', 'equipment', req.params.id, old, update);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 获取单台设备详情（含最近运行记录和维修记录）
app.get('/api/equipment/:id/detail', authMiddleware, (req, res) => {
  try {
    const equip = db.prepare('SELECT * FROM equipment WHERE id=?').get(req.params.id);
    if (!equip) return res.status(404).json({ error: '设备不存在' });
    const logs = db.prepare('SELECT * FROM equipment_log WHERE equipmentId=? ORDER BY date DESC, shift DESC LIMIT 20').all(req.params.id);
    const maintenances = db.prepare('SELECT * FROM maintenance WHERE equipmentId=? ORDER BY createTime DESC LIMIT 20').all(req.params.id);
    res.json({ ...equip, logs, maintenances });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 设备运行记录
app.post('/api/equipment_log', authMiddleware, (req, res) => {
  try {
    const record = { ...req.body, id: req.body.id || 'elog_' + Date.now(), operator: req.userName, createTime: new Date().toISOString() };
    insertRow('equipment_log', record);
    res.json({ success: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 维修工单列表
app.get('/api/maintenance/list', authMiddleware, (req, res) => {
  try {
    const { status, priority, equipmentId } = req.query;
    let sql = 'SELECT * FROM maintenance WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (priority) { sql += ' AND priority=?'; params.push(priority); }
    if (equipmentId) { sql += ' AND equipmentId=?'; params.push(equipmentId); }
    sql += ' ORDER BY createTime DESC LIMIT 100';
    const data = db.prepare(sql).all(...params);
    res.json({ data, total: data.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 新增维修工单
app.post('/api/maintenance', authMiddleware, (req, res) => {
  try {
    const record = { ...req.body, id: req.body.id || 'maint_' + Date.now(), reportedBy: req.userName, reportedTime: new Date().toISOString(), status: req.body.status || '待处理', createTime: new Date().toISOString(), updateTime: new Date().toISOString(), updatedBy: req.userName };
    insertRow('maintenance', record);
    writeAuditLog(req, '新增维修工单', 'maintenance', record.id, null, record);
    // 自动预警
    if (record.priority === '高' || record.priority === '紧急') {
      insertRow('alerts', { id: 'alt_maint_' + record.id, time: new Date().toISOString(), type: '设备故障', level: record.priority === '紧急' ? 'high' : 'medium', source: '维修工单', title: record.equipmentName + '：' + record.faultDesc, detail: '工单优先级：' + record.priority, status: 'active' });
    }
    res.json({ success: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 更新维修工单状态
app.put('/api/maintenance/:id', authMiddleware, (req, res) => {
  try {
    const old = db.prepare('SELECT * FROM maintenance WHERE id=?').get(req.params.id);
    const update = { ...req.body, updateTime: new Date().toISOString(), updatedBy: req.userName };
    const keys = Object.keys(update).filter(k => k !== 'id');
    if (keys.length === 0) return res.status(400).json({ error: '无更新字段' });
    const setStr = keys.map(k => '[' + k + ']=?').join(',');
    db.prepare('UPDATE maintenance SET ' + setStr + ' WHERE id=?').run(...keys.map(k => update[k]), req.params.id);
    writeAuditLog(req, '更新维修工单', 'maintenance', req.params.id, old, update);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 设备统计概览
app.get('/api/equipment/stats', authMiddleware, (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM equipment').get().cnt;
    const normal = db.prepare("SELECT COUNT(*) as cnt FROM equipment WHERE status='正常运行'").get().cnt;
    const fault = db.prepare("SELECT COUNT(*) as cnt FROM equipment WHERE status='故障停机'").get().cnt;
    const maintain = db.prepare("SELECT COUNT(*) as cnt FROM equipment WHERE status='检修中'").get().cnt;
    const pendingWork = db.prepare("SELECT COUNT(*) as cnt FROM maintenance WHERE status IN ('待处理','处理中')").get().cnt;
    const urgentWork = db.prepare("SELECT COUNT(*) as cnt FROM maintenance WHERE status IN ('待处理','处理中') AND priority IN ('高','紧急')").get().cnt;
    res.json({ total, normal, fault, maintain, other: total - normal - fault - maintain, pendingWork, urgentWork });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 交班/排班管理 ====================
// 排班计划
app.get('/api/shift_schedule/list', authMiddleware, (req, res) => {
  try {
    const { dateFrom, dateTo, team } = req.query;
    let sql = 'SELECT * FROM shift_schedule WHERE 1=1';
    const params = [];
    if (dateFrom) { sql += ' AND date>=?'; params.push(dateFrom); }
    if (dateTo) { sql += ' AND date<=?'; params.push(dateTo); }
    if (team) { sql += ' AND team=?'; params.push(team); }
    sql += ' ORDER BY date DESC, shift ASC LIMIT 200';
    const data = db.prepare(sql).all(...params);
    res.json({ data, total: data.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shift_schedule', authMiddleware, (req, res) => {
  if (!req.userPermissions.canManage && !['厂长','副厂长','运营管理部'].includes(req.userRole)) {
    return res.status(403).json({ error: '无权限管理排班' });
  }
  try {
    const record = { ...req.body, id: req.body.id || 'sch_' + Date.now(), operator: req.userName, createTime: new Date().toISOString(), updateTime: new Date().toISOString() };
    insertRow('shift_schedule', record);
    writeAuditLog(req, '新增排班', 'shift_schedule', record.id, null, record);
    res.json({ success: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/shift_schedule/:id', authMiddleware, (req, res) => {
  if (!req.userPermissions.canManage && !['厂长','副厂长','运营管理部'].includes(req.userRole)) {
    return res.status(403).json({ error: '无权限修改排班' });
  }
  try {
    const update = { ...req.body, updateTime: new Date().toISOString() };
    const keys = Object.keys(update).filter(k => k !== 'id');
    const setStr = keys.map(k => '[' + k + ']=?').join(',');
    db.prepare('UPDATE shift_schedule SET ' + setStr + ' WHERE id=?').run(...keys.map(k => update[k]), req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 本周排班概览
app.get('/api/shift_schedule/week', authMiddleware, (req, res) => {
  try {
    const today = new Date();
    const dayOfWeek = today.getDay() || 7;
    const monday = new Date(today); monday.setDate(today.getDate() - dayOfWeek + 1);
    const sunday = new Date(today); sunday.setDate(today.getDate() - dayOfWeek + 7);
    const from = monday.toISOString().slice(0, 10);
    const to = sunday.toISOString().slice(0, 10);
    const data = db.prepare('SELECT * FROM shift_schedule WHERE date>=? AND date<=? ORDER BY date ASC, shift ASC').all(from, to);
    res.json({ data, weekStart: from, weekEnd: to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 交接班记录
app.get('/api/shift_handover/list', authMiddleware, (req, res) => {
  try {
    const { dateFrom, dateTo, team } = req.query;
    let sql = 'SELECT * FROM shift_handover WHERE 1=1';
    const params = [];
    if (dateFrom) { sql += ' AND date>=?'; params.push(dateFrom); }
    if (dateTo) { sql += ' AND date<=?'; params.push(dateTo); }
    if (team) { sql += ' AND team=?'; params.push(team); }
    sql += ' ORDER BY createTime DESC LIMIT 100';
    const data = db.prepare(sql).all(...params);
    res.json({ data, total: data.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shift_handover', authMiddleware, (req, res) => {
  try {
    const record = { ...req.body, id: req.body.id || 'ho_' + Date.now(), handoverPerson: req.body.handoverPerson || req.userName, createTime: new Date().toISOString() };
    insertRow('shift_handover', record);
    writeAuditLog(req, '提交交班记录', 'shift_handover', record.id, null, record);
    res.json({ success: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 今日交班状态
app.get('/api/shift_handover/today', authMiddleware, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const data = db.prepare('SELECT * FROM shift_handover WHERE date=? ORDER BY shift ASC').all(today);
    res.json({ data, date: today });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 运营日志审计 ====================
app.get('/api/audit_log/list', authMiddleware, (req, res) => {
  if (!req.userPermissions.canManage && !['厂长','副厂长','运营管理部','技术管理部'].includes(req.userRole)) {
    return res.status(403).json({ error: '无权限查看审计日志' });
  }
  try {
    const { operator, action, targetTable, dateFrom, dateTo } = req.query;
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];
    if (operator) { sql += ' AND operator LIKE ?'; params.push('%'+operator+'%'); }
    if (action) { sql += ' AND action=?'; params.push(action); }
    if (targetTable) { sql += ' AND targetTable=?'; params.push(targetTable); }
    if (dateFrom) { sql += ' AND time>=?'; params.push(dateFrom); }
    if (dateTo) { sql += ' AND time<=?'; params.push(dateTo + 'T23:59:59'); }
    const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) as cnt')).get(...params).cnt;
    sql += ' ORDER BY time DESC LIMIT 200';
    const data = db.prepare(sql).all(...params);
    res.json({ data, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 审计统计
app.get('/api/audit_log/stats', authMiddleware, (req, res) => {
  if (!req.userPermissions.canManage && !['厂长','副厂长','运营管理部','技术管理部'].includes(req.userRole)) {
    return res.status(403).json({ error: '无权限' });
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const todayCount = db.prepare('SELECT COUNT(*) as cnt FROM audit_log WHERE time>=?').get(today + 'T00:00:00').cnt;
    const weekCount = db.prepare('SELECT COUNT(*) as cnt FROM audit_log WHERE time>=?').get(week + 'T00:00:00').cnt;
    const byAction = db.prepare('SELECT action, COUNT(*) as cnt FROM audit_log WHERE time>=? GROUP BY action ORDER BY cnt DESC LIMIT 10').all(week + 'T00:00:00');
    const byOperator = db.prepare('SELECT operator, operatorRole, COUNT(*) as cnt FROM audit_log WHERE time>=? GROUP BY operator ORDER BY cnt DESC LIMIT 10').all(week + 'T00:00:00');
    res.json({ todayCount, weekCount, byAction, byOperator });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 月报/年报自动生成 ====================
app.get('/api/report/monthly', authMiddleware, (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear().toString();
    const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
    const dateFrom = year + '-' + month + '-01';
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const dateTo = year + '-' + month + '-' + String(lastDay).padStart(2, '0');

    // 每日汇总
    const dailySummaries = db.prepare('SELECT * FROM daily_summary WHERE date>=? AND date<=? ORDER BY date ASC').all(dateFrom, dateTo);

    // 进出水月均值（从小时数据汇总）
    const waterAvg = db.prepare(`
      SELECT AVG(CAST(inCod AS REAL)) as avgInCod, AVG(CAST(outCod AS REAL)) as avgOutCod,
             AVG(CAST(inNh3 AS REAL)) as avgInNh3, AVG(CAST(outNh3 AS REAL)) as avgOutNh3,
             AVG(CAST(inTn AS REAL)) as avgInTn, AVG(CAST(outTn AS REAL)) as avgOutTn,
             AVG(CAST(inTp AS REAL)) as avgInTp, AVG(CAST(outTp AS REAL)) as avgOutTp,
             SUM(CAST(inFlow AS REAL)) as totalInFlow, SUM(CAST(outFlow AS REAL)) as totalOutFlow
      FROM hourly_water WHERE date>=? AND date<=?
    `).get(dateFrom, dateTo);

    // 化验月均值
    const labAvg = db.prepare(`
      SELECT AVG(CAST(cod AS REAL)) as avgCod, AVG(CAST(nh3 AS REAL)) as avgNh3,
             AVG(CAST(tn AS REAL)) as avgTn, AVG(CAST(tp AS REAL)) as avgTp,
             COUNT(*) as testDays
      FROM daily_lab WHERE date>=? AND date<=?
    `).get(dateFrom, dateTo);

    // 出水超标次数
    const codExceed = db.prepare("SELECT COUNT(*) as cnt FROM hourly_water WHERE date>=? AND date<=? AND CAST(outCod AS REAL)>50").get(dateFrom, dateTo).cnt;
    const nh3Exceed = db.prepare("SELECT COUNT(*) as cnt FROM hourly_water WHERE date>=? AND date<=? AND CAST(outNh3 AS REAL)>5").get(dateFrom, dateTo).cnt;
    const tnExceed = db.prepare("SELECT COUNT(*) as cnt FROM hourly_water WHERE date>=? AND date<=? AND CAST(outTn AS REAL)>15").get(dateFrom, dateTo).cnt;

    // 药剂投加月汇总
    const dosingSum = db.prepare(`
      SELECT SUM(CAST(carbonSource AS REAL)) as totalCarbonSource,
             SUM(CAST(pac AS REAL)) as totalPac,
             SUM(CAST(glucose AS REAL)) as totalGlucose,
             SUM(CAST(naclo AS REAL)) as totalNaclo
      FROM chemical_dosing WHERE date>=? AND date<=?
    `).get(dateFrom, dateTo);

    // 脱泥月汇总
    const dewaterSum = db.prepare(`
      SELECT SUM(CAST(sludgeOutput AS REAL)) as totalSludge,
             SUM(CAST(duration AS REAL)) as totalDuration,
             COUNT(*) as days
      FROM dewatering WHERE date>=? AND date<=?
    `).get(dateFrom, dateTo);

    // 运行总水量/用电
    const summarySum = db.prepare(`
      SELECT SUM(CAST(electricity AS REAL)) as totalElec,
             SUM(CAST(inFlowTotal AS REAL)) as totalInFlow,
             SUM(CAST(outFlowTotal AS REAL)) as totalOutFlow,
             COUNT(*) as reportDays,
             SUM(CASE WHEN runStatus='正常运行' THEN 1 ELSE 0 END) as normalDays
      FROM daily_summary WHERE date>=? AND date<=?
    `).get(dateFrom, dateTo);

    // 预警统计
    const alertStats = db.prepare(`
      SELECT COUNT(*) as totalAlerts,
             SUM(CASE WHEN level='high' THEN 1 ELSE 0 END) as highAlerts,
             SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolvedAlerts
      FROM alerts WHERE time>=? AND time<=?
    `).get(dateFrom + 'T00:00:00', dateTo + 'T23:59:59');

    const round2 = v => v !== null && v !== undefined && !isNaN(v) ? Math.round(v * 100) / 100 : null;

    res.json({
      period: { year, month, dateFrom, dateTo, daysInMonth: lastDay },
      waterQuality: {
        avgInCod: round2(waterAvg.avgInCod), avgOutCod: round2(waterAvg.avgOutCod),
        avgInNh3: round2(waterAvg.avgInNh3), avgOutNh3: round2(waterAvg.avgOutNh3),
        avgInTn: round2(waterAvg.avgInTn), avgOutTn: round2(waterAvg.avgOutTn),
        avgInTp: round2(waterAvg.avgInTp), avgOutTp: round2(waterAvg.avgOutTp),
        totalInFlow: round2(waterAvg.totalInFlow), totalOutFlow: round2(waterAvg.totalOutFlow),
        codExceedHours: codExceed, nh3ExceedHours: nh3Exceed, tnExceedHours: tnExceed,
      },
      labQuality: {
        avgCod: round2(labAvg.avgCod), avgNh3: round2(labAvg.avgNh3),
        avgTn: round2(labAvg.avgTn), avgTp: round2(labAvg.avgTp), testDays: labAvg.testDays,
      },
      operation: {
        totalElec: round2(summarySum.totalElec), totalInFlow: round2(summarySum.totalInFlow),
        totalOutFlow: round2(summarySum.totalOutFlow), reportDays: summarySum.reportDays,
        normalDays: summarySum.normalDays, operationRate: summarySum.reportDays > 0 ? round2(summarySum.normalDays / lastDay * 100) : null,
      },
      chemical: {
        totalCarbonSource: round2(dosingSum.totalCarbonSource), totalPac: round2(dosingSum.totalPac),
        totalGlucose: round2(dosingSum.totalGlucose), totalNaclo: round2(dosingSum.totalNaclo),
      },
      dewatering: { totalSludge: round2(dewaterSum.totalSludge), totalDuration: round2(dewaterSum.totalDuration), activeDays: dewaterSum.days },
      alerts: { total: alertStats.totalAlerts, high: alertStats.highAlerts, resolved: alertStats.resolvedAlerts },
      dailySummaries,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/report/yearly', authMiddleware, (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear().toString();

    const monthlyData = [];
    for (let m = 1; m <= 12; m++) {
      const month = String(m).padStart(2, '0');
      const dateFrom = year + '-' + month + '-01';
      const lastDay = new Date(parseInt(year), m, 0).getDate();
      const dateTo = year + '-' + month + '-' + String(lastDay).padStart(2, '0');

      const waterAvg = db.prepare('SELECT AVG(CAST(outCod AS REAL)) as avgOutCod, AVG(CAST(outNh3 AS REAL)) as avgOutNh3, AVG(CAST(outTn AS REAL)) as avgOutTn, AVG(CAST(outTp AS REAL)) as avgOutTp, SUM(CAST(inFlow AS REAL)) as totalInFlow FROM hourly_water WHERE date>=? AND date<=?').get(dateFrom, dateTo);
      const summarySum = db.prepare('SELECT SUM(CAST(electricity AS REAL)) as totalElec, SUM(CAST(outFlowTotal AS REAL)) as totalOutFlow, SUM(CAST(sludgeOutput AS REAL)) as totalSludge FROM daily_summary WHERE date>=? AND date<=?').get(dateFrom, dateTo);
      const dosingSum = db.prepare('SELECT SUM(CAST(carbonSource AS REAL)) as totalCarbonSource, SUM(CAST(pac AS REAL)) as totalPac FROM chemical_dosing WHERE date>=? AND date<=?').get(dateFrom, dateTo);

      const round2 = v => v !== null && v !== undefined && !isNaN(v) ? Math.round(v * 100) / 100 : null;
      monthlyData.push({
        month: m, label: month + '月',
        avgOutCod: round2(waterAvg.avgOutCod), avgOutNh3: round2(waterAvg.avgOutNh3),
        avgOutTn: round2(waterAvg.avgOutTn), avgOutTp: round2(waterAvg.avgOutTp),
        totalInFlow: round2(waterAvg.totalInFlow), totalOutFlow: round2(summarySum.totalOutFlow),
        totalElec: round2(summarySum.totalElec), totalSludge: round2(summarySum.totalSludge),
        totalCarbonSource: round2(dosingSum.totalCarbonSource), totalPac: round2(dosingSum.totalPac),
      });
    }

    // 全年汇总
    const dateFrom = year + '-01-01', dateTo = year + '-12-31';
    const yearTotal = db.prepare('SELECT SUM(CAST(electricity AS REAL)) as totalElec, SUM(CAST(inFlowTotal AS REAL)) as totalInFlow, SUM(CAST(sludgeOutput AS REAL)) as totalSludge FROM daily_summary WHERE date>=? AND date<=?').get(dateFrom, dateTo);
    const yearDosing = db.prepare('SELECT SUM(CAST(carbonSource AS REAL)) as totalCS, SUM(CAST(pac AS REAL)) as totalPac, SUM(CAST(naclo AS REAL)) as totalNaclo FROM chemical_dosing WHERE date>=? AND date<=?').get(dateFrom, dateTo);
    const r2 = v => v !== null && v !== undefined && !isNaN(v) ? Math.round(v * 100) / 100 : null;

    res.json({
      year,
      monthlyData,
      yearSummary: {
        totalElec: r2(yearTotal.totalElec), totalInFlow: r2(yearTotal.totalInFlow),
        totalSludge: r2(yearTotal.totalSludge), totalCarbonSource: r2(yearDosing.totalCS),
        totalPac: r2(yearDosing.totalPac), totalNaclo: r2(yearDosing.totalNaclo),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 月报/年报 Excel 导出
app.get('/api/report/monthly/export', authMiddleware, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const year = req.query.year || new Date().getFullYear().toString();
    const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
    const dateFrom = year + '-' + month + '-01';
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const dateTo = year + '-' + month + '-' + String(lastDay).padStart(2, '0');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = '污水处理厂运行管理系统 v4.5';

    // Sheet1: 月报汇总
    const sheetSummary = workbook.addWorksheet('月报汇总');
    sheetSummary.columns = [{ header: '项目', key: 'item', width: 24 }, { header: '数值', key: 'value', width: 20 }, { header: '单位', key: 'unit', width: 12 }];
    sheetSummary.getRow(1).font = { bold: true, size: 12 };

    // 读取日均水质
    const waterAvg = db.prepare('SELECT AVG(CAST(inCod AS REAL)) as avgInCod, AVG(CAST(outCod AS REAL)) as avgOutCod, AVG(CAST(inNh3 AS REAL)) as avgInNh3, AVG(CAST(outNh3 AS REAL)) as avgOutNh3, AVG(CAST(inTn AS REAL)) as avgInTn, AVG(CAST(outTn AS REAL)) as avgOutTn, AVG(CAST(inTp AS REAL)) as avgInTp, AVG(CAST(outTp AS REAL)) as avgOutTp, SUM(CAST(inFlow AS REAL)) as totalInFlow FROM hourly_water WHERE date>=? AND date<=?').get(dateFrom, dateTo);
    const summarySum = db.prepare('SELECT SUM(CAST(electricity AS REAL)) as totalElec, SUM(CAST(inFlowTotal AS REAL)) as totalInFlow, SUM(CAST(outFlowTotal AS REAL)) as totalOutFlow, SUM(CAST(sludgeOutput AS REAL)) as totalSludge, COUNT(*) as reportDays FROM daily_summary WHERE date>=? AND date<=?').get(dateFrom, dateTo);
    const dosingSum = db.prepare('SELECT SUM(CAST(carbonSource AS REAL)) as totalCS, SUM(CAST(pac AS REAL)) as totalPac, SUM(CAST(naclo AS REAL)) as totalNaclo FROM chemical_dosing WHERE date>=? AND date<=?').get(dateFrom, dateTo);
    const r2 = v => v !== null && v !== undefined && !isNaN(v) ? Math.round(v * 100) / 100 : '-';

    const summaryRows = [
      ['报告期', year + '年' + month + '月', ''],
      ['', '', ''],
      ['【水量】', '', ''],
      ['月累计进水量', r2(summarySum.totalInFlow), 'm³'],
      ['月累计出水量', r2(summarySum.totalOutFlow), 'm³'],
      ['', '', ''],
      ['【进水水质（月均）】', '', ''],
      ['进水COD', r2(waterAvg.avgInCod), 'mg/L'],
      ['进水氨氮', r2(waterAvg.avgInNh3), 'mg/L'],
      ['进水总氮', r2(waterAvg.avgInTn), 'mg/L'],
      ['进水总磷', r2(waterAvg.avgInTp), 'mg/L'],
      ['', '', ''],
      ['【出水水质（月均）】', '', ''],
      ['出水COD', r2(waterAvg.avgOutCod), 'mg/L（限值≤50）'],
      ['出水氨氮', r2(waterAvg.avgOutNh3), 'mg/L（限值≤5）'],
      ['出水总氮', r2(waterAvg.avgOutTn), 'mg/L（限值≤15）'],
      ['出水总磷', r2(waterAvg.avgOutTp), 'mg/L（限值≤0.5）'],
      ['', '', ''],
      ['【运营情况】', '', ''],
      ['月用电量', r2(summarySum.totalElec), 'kWh'],
      ['污泥产量', r2(summarySum.totalSludge), '吨'],
      ['日报记录天数', summarySum.reportDays, '天'],
      ['', '', ''],
      ['【药剂投加（月累计）】', '', ''],
      ['碳源', r2(dosingSum.totalCS), 'kg'],
      ['PAC', r2(dosingSum.totalPac), 'kg'],
      ['次氯酸钠', r2(dosingSum.totalNaclo), 'kg'],
    ];
    summaryRows.forEach(([item, value, unit]) => sheetSummary.addRow({ item, value, unit }));

    // Sheet2: 每日明细
    const dailySummaries = db.prepare('SELECT * FROM daily_summary WHERE date>=? AND date<=? ORDER BY date ASC').all(dateFrom, dateTo);
    if (dailySummaries.length > 0) {
      const sheetDaily = workbook.addWorksheet('每日运行明细');
      const keys = Object.keys(dailySummaries[0]);
      const cols = keys.map(k => ({ header: CHINESE_FIELDS.daily_summary[k] || k, key: k, width: 16 }));
      sheetDaily.columns = cols;
      sheetDaily.getRow(1).font = { bold: true };
      dailySummaries.forEach(r => sheetDaily.addRow(r));
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="monthly_report_' + year + month + '.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 健康检查 + 微信域名校验 ====================
// ==================== 月度数据分析报告 ====================
app.get('/api/report/analysis', authMiddleware, (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear().toString();
    const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');
    const dateFrom = year + '-' + month + '-01';
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const dateTo = year + '-' + month + '-' + String(lastDay).padStart(2, '0');
    const r2 = v => v !== null && v !== undefined && !isNaN(v) ? Math.round(v * 100) / 100 : null;
    const r4 = v => v !== null && v !== undefined && !isNaN(v) ? Math.round(v * 10000) / 10000 : null;

    // ========== 1. 水质分析 ==========
    // 小时进出水数据
    const waterData = db.prepare('SELECT * FROM hourly_water WHERE date>=? AND date<=? ORDER BY date ASC, hour ASC').all(dateFrom, dateTo);
    const inCods = waterData.map(r => Number(r.inCod)).filter(v => v > 0);
    const outCods = waterData.map(r => Number(r.outCod)).filter(v => v > 0);
    const inNh3s = waterData.map(r => Number(r.inNh3)).filter(v => v > 0);
    const outNh3s = waterData.map(r => Number(r.outNh3)).filter(v => v > 0);
    const inTns = waterData.map(r => Number(r.inTn)).filter(v => v > 0);
    const outTns = waterData.map(r => Number(r.outTn)).filter(v => v > 0);
    const inTps = waterData.map(r => Number(r.inTp)).filter(v => v > 0);
    const outTps = waterData.map(r => Number(r.outTp)).filter(v => v > 0);
    const inFlows = waterData.map(r => Number(r.inFlow)).filter(v => v > 0);
    const outFlows = waterData.map(r => Number(r.outFlow)).filter(v => v > 0);
    const inPhs = waterData.map(r => Number(r.inPh)).filter(v => v > 0);

    const stats = arr => {
      if (!arr.length) return { avg: null, min: null, max: null, count: 0, std: null };
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const variance = arr.reduce((sum, v) => sum + (v - avg) ** 2, 0) / arr.length;
      return { avg: r2(avg), min: r2(Math.min(...arr)), max: r2(Math.max(...arr)), count: arr.length, std: r2(Math.sqrt(variance)) };
    };
    const exceedRate = (arr, limit) => arr.length ? r2(arr.filter(v => v > limit).length / arr.length * 100) : null;

    const waterAnalysis = {
      totalRecords: waterData.length,
      inCod: stats(inCods), outCod: stats(outCods), codExceedRate: exceedRate(outCods, 50),
      inNh3: stats(inNh3s), outNh3: stats(outNh3s), nh3ExceedRate: exceedRate(outNh3s, 5),
      inTn: stats(inTns), outTn: stats(outTns), tnExceedRate: exceedRate(outTns, 15),
      inTp: stats(inTps), outTp: stats(outTps), tpExceedRate: exceedRate(outTps, 0.5),
      inFlow: stats(inFlows), outFlow: stats(outFlows), inPh: stats(inPhs),
      totalInFlow: r2(inFlows.reduce((a, b) => a + b, 0)),
      totalOutFlow: r2(outFlows.reduce((a, b) => a + b, 0)),
    };

    // ========== 2. DO溶解氧分析 ==========
    const doData = db.prepare('SELECT * FROM do_inspection WHERE date>=? AND date<=? ORDER BY date ASC').all(dateFrom, dateTo);
    const doAnaerobics = doData.map(r => Number(r.anaerobic)).filter(v => !isNaN(v) && v > 0);
    const doAnoxics = doData.map(r => Number(r.anoxic)).filter(v => !isNaN(v) && v > 0);
    const doAerobics = doData.flatMap(r => [Number(r.aerobic1), Number(r.aerobic2), Number(r.aerobic3), Number(r.aerobic4)]).filter(v => !isNaN(v) && v > 0);
    const doAnalysis = {
      totalRecords: doData.length,
      anaerobic: { ...stats(doAnaerobics), exceedRate: doAnaerobics.length ? r2(doAnaerobics.filter(v => v > 0.2).length / doAnaerobics.length * 100) : null, limit: '<0.2' },
      anoxic: { ...stats(doAnoxics), exceedRate: doAnoxics.length ? r2(doAnoxics.filter(v => v > 0.5).length / doAnoxics.length * 100) : null, limit: '<0.5' },
      aerobic: { ...stats(doAerobics), exceedRate: doAerobics.length ? r2(doAerobics.filter(v => v < 2.5 || v > 4.5).length / doAerobics.length * 100) : null, limit: '2.5-4.5' },
    };

    // ========== 3. 污泥分析 ==========
    const labData = db.prepare('SELECT * FROM daily_lab WHERE date>=? AND date<=? ORDER BY date ASC').all(dateFrom, dateTo);
    const sv30s = labData.map(r => Number(r.sv30)).filter(v => v > 0);
    const svis = labData.map(r => Number(r.svi)).filter(v => v > 0);
    const mlsss = labData.map(r => Number(r.mlss)).filter(v => v > 0);
    const sludgeAnalysis = {
      totalRecords: labData.length,
      sv30: { ...stats(sv30s), normalRange: '15-30%', exceedRate: sv30s.length ? r2(sv30s.filter(v => v > 30).length / sv30s.length * 100) : null },
      svi: { ...stats(svis), normalRange: '80-150', exceedRate: svis.length ? r2(svis.filter(v => v > 150 || v < 80).length / svis.length * 100) : null },
      mlss: { ...stats(mlsss), normalRange: '2000-4000', exceedRate: mlsss.length ? r2(mlsss.filter(v => v > 4000 || v < 2000).length / mlsss.length * 100) : null },
    };

    // ========== 4. 药剂分析 ==========
    const dosingData = db.prepare('SELECT * FROM chemical_dosing WHERE date>=? AND date<=? ORDER BY date ASC').all(dateFrom, dateTo);
    const carbonSources = dosingData.map(r => Number(r.carbonSource)).filter(v => v > 0);
    const pacs = dosingData.map(r => Number(r.pac)).filter(v => v > 0);
    const glucoses = dosingData.map(r => Number(r.glucose)).filter(v => v > 0);
    const naclos = dosingData.map(r => Number(r.naclo)).filter(v => v > 0);
    const anionPams = dosingData.map(r => Number(r.anionPam)).filter(v => v > 0);
    const cationPams = dosingData.map(r => Number(r.cationPam)).filter(v => v > 0);
    const chemicalAnalysis = {
      totalRecords: dosingData.length,
      carbonSource: { ...stats(carbonSources), total: r2(carbonSources.reduce((a, b) => a + b, 0)), unit: 'kg' },
      pac: { ...stats(pacs), total: r2(pacs.reduce((a, b) => a + b, 0)), unit: 'kg' },
      glucose: { ...stats(glucoses), total: r2(glucoses.reduce((a, b) => a + b, 0)), unit: 'kg' },
      naclo: { ...stats(naclos), total: r2(naclos.reduce((a, b) => a + b, 0)), unit: 'kg' },
      anionPam: { ...stats(anionPams), total: r2(anionPams.reduce((a, b) => a + b, 0)), unit: 'kg' },
      cationPam: { ...stats(cationPams), total: r2(cationPams.reduce((a, b) => a + b, 0)), unit: 'kg' },
      // 吨水药耗
      tonsWaterChemical: waterAnalysis.totalInFlow > 0 ? {
        carbonSource: r4(carbonSources.reduce((a, b) => a + b, 0) / waterAnalysis.totalInFlow * 1000),
        pac: r4(pacs.reduce((a, b) => a + b, 0) / waterAnalysis.totalInFlow * 1000),
      } : null,
    };

    // ========== 5. 运营效率 ==========
    const dailySummary = db.prepare('SELECT * FROM daily_summary WHERE date>=? AND date<=? ORDER BY date ASC').all(dateFrom, dateTo);
    const elecs = dailySummary.map(r => Number(r.electricity)).filter(v => v > 0);
    const inFlowTotals = dailySummary.map(r => Number(r.inFlowTotal)).filter(v => v > 0);
    const sludgeOutputs = dailySummary.map(r => Number(r.sludgeOutput)).filter(v => v > 0);
    const normalDays = dailySummary.filter(r => r.runStatus === '正常运行').length;
    const operationAnalysis = {
      totalRecords: dailySummary.length,
      electricity: { ...stats(elecs), total: r2(elecs.reduce((a, b) => a + b, 0)), unit: 'kWh' },
      inFlowTotal: { ...stats(inFlowTotals), total: r2(inFlowTotals.reduce((a, b) => a + b, 0)), unit: 'm³' },
      sludgeOutput: { ...stats(sludgeOutputs), total: r2(sludgeOutputs.reduce((a, b) => a + b, 0)), unit: '吨' },
      normalDays, totalDays: lastDay, operationRate: r2(normalDays / lastDay * 100),
      // 吨水电耗
      tonsWaterElec: inFlowTotals.reduce((a, b) => a + b, 0) > 0 ? r4(elecs.reduce((a, b) => a + b, 0) / inFlowTotals.reduce((a, b) => a + b, 0)) : null,
    };

    // ========== 6. 脱泥分析 ==========
    const dewData = db.prepare('SELECT * FROM dewatering WHERE date>=? AND date<=? ORDER BY date ASC').all(dateFrom, dateTo);
    const dewDurations = dewData.map(r => Number(r.duration)).filter(v => v > 0);
    const dewSludges = dewData.map(r => Number(r.sludgeOutput)).filter(v => v > 0);
    const dewateringAnalysis = {
      totalRecords: dewData.length, activeDays: dewData.length > 0 ? new Set(dewData.map(r => r.date)).size : 0,
      duration: { ...stats(dewDurations), total: r2(dewDurations.reduce((a, b) => a + b, 0)), unit: 'h' },
      sludgeOutput: { ...stats(dewSludges), total: r2(dewSludges.reduce((a, b) => a + b, 0)), unit: '吨' },
    };

    // ========== 7. 预警分析 ==========
    const alertData = db.prepare('SELECT * FROM alerts WHERE time>=? AND time<=? ORDER BY time ASC').all(dateFrom + 'T00:00:00', dateTo + 'T23:59:59');
    const highAlerts = alertData.filter(r => r.level === 'high').length;
    const mediumAlerts = alertData.filter(r => r.level === 'medium').length;
    const lowAlerts = alertData.filter(r => r.level === 'low').length;
    const resolvedAlerts = alertData.filter(r => r.status === 'resolved').length;
    // 预警类型分布
    const alertTypes = {};
    alertData.forEach(a => { alertTypes[a.type || a.source || '其他'] = (alertTypes[a.type || a.source || '其他'] || 0) + 1; });
    const alertAnalysis = {
      total: alertData.length, high: highAlerts, medium: mediumAlerts, low: lowAlerts,
      resolved: resolvedAlerts, resolveRate: alertData.length ? r2(resolvedAlerts / alertData.length * 100) : null,
      types: alertTypes,
    };

    // ========== 8. 综合评估与建议 ==========
    const issues = [];
    if (waterAnalysis.codExceedRate > 5) issues.push('出水COD超标率较高（' + waterAnalysis.codExceedRate + '%），需加强曝气调控和污泥浓度管理');
    if (waterAnalysis.nh3ExceedRate > 5) issues.push('出水氨氮超标率较高（' + waterAnalysis.nh3ExceedRate + '%），建议检查好氧池溶解氧水平及泥龄');
    if (waterAnalysis.tnExceedRate > 5) issues.push('出水总氮超标率较高（' + waterAnalysis.tnExceedRate + '%），建议增加碳源投加量，加强反硝化效果');
    if (waterAnalysis.tpExceedRate > 5) issues.push('出水总磷超标率较高（' + waterAnalysis.tpExceedRate + '%），需优化化学除磷药剂投加量');
    if (doAnalysis.aerobic.exceedRate > 20) issues.push('好氧池DO达标率偏低（超标率' + doAnalysis.aerobic.exceedRate + '%），建议检查曝气系统运行状况');
    if (sludgeAnalysis.sv30.exceedRate > 20) issues.push('SV30超标率较高（' + sludgeAnalysis.sv30.exceedRate + '%），存在污泥膨胀风险，需关注');
    if (sludgeAnalysis.mlss.exceedRate > 30) issues.push('MLSS异常率较高（' + sludgeAnalysis.mlss.exceedRate + '%），建议调整排泥策略');
    if (operationAnalysis.operationRate < 90) issues.push('设备运行率偏低（' + operationAnalysis.operationRate + '%），需加强设备维护');

    const suggestions = [];
    // 智能加药建议
    if (chemicalAnalysis.tonsWaterChemical) {
      if (chemicalAnalysis.tonsWaterChemical.carbonSource > 10) suggestions.push('吨水碳源投加量偏高（' + chemicalAnalysis.tonsWaterChemical.carbonSource + ' kg/千m³），建议优化碳源投加策略');
      else suggestions.push('碳源投加量在合理范围内，继续维持当前投加策略');
    }
    if (operationAnalysis.tonsWaterElec) {
      if (operationAnalysis.tonsWaterElec > 0.4) suggestions.push('吨水电耗偏高（' + operationAnalysis.tonsWaterElec + ' kWh/m³），建议排查曝气系统效率及泵组运行');
      else suggestions.push('吨水电耗在合理范围，继续保持节能运行');
    }
    if (sludgeAnalysis.svi.avg && sludgeAnalysis.svi.avg > 150) suggestions.push('SVI均值偏高（' + sludgeAnalysis.svi.avg + '），存在污泥膨胀趋势，建议增加排泥频次');
    if (alertAnalysis.total > 20) suggestions.push('本月预警数较多（' + alertAnalysis.total + '条），建议系统排查预警来源并优化工艺参数');

    // ========== 图表数据 ==========
    // 生成月内每日标签
    const chartLabels = [];
    for (let d = 1; d <= lastDay; d++) chartLabels.push(month + '-' + String(d).padStart(2, '0'));
    const dayLabel = chartLabels.map(l => l.slice(5)); // "06-01" -> "01"
    const avg = (arr, key) => { const vs = arr.map(r => Number(r[key])).filter(v => !isNaN(v) && v > 0); return vs.length ? r2(vs.reduce((a,b)=>a+b,0)/vs.length) : null; };

    // 水质图表 - 每日进出水均值
    const waterByDay = {};
    waterData.forEach(r => { if (!waterByDay[r.date]) waterByDay[r.date] = []; waterByDay[r.date].push(r); });
    const waterChart = {
      labels: dayLabel,
      datasets: [
        { label: '进水COD', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=waterByDay[d]||[]; return recs.length?avg(recs,'inCod'):null; }), borderColor: '#5b8ff9', tension: 0.3, borderWidth: 2 },
        { label: '出水COD', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=waterByDay[d]||[]; return recs.length?avg(recs,'outCod'):null; }), borderColor: '#e86452', tension: 0.3, borderWidth: 2 },
        { label: '进水氨氮', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=waterByDay[d]||[]; return recs.length?avg(recs,'inNh3'):null; }), borderColor: '#5ad8a6', tension: 0.3, borderWidth: 2 },
        { label: '出水氨氮', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=waterByDay[d]||[]; return recs.length?avg(recs,'outNh3'):null; }), borderColor: '#f6bd16', tension: 0.3, borderWidth: 2 },
        { label: '出水总氮', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=waterByDay[d]||[]; return recs.length?avg(recs,'outTn'):null; }), borderColor: '#9270ca', tension: 0.3, borderWidth: 1.5, hidden: true },
        { label: '出水总磷', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=waterByDay[d]||[]; return recs.length?avg(recs,'outTp'):null; }), borderColor: '#ff9845', tension: 0.3, borderWidth: 1.5, hidden: true },
      ],
      thresholds: [
        { label: 'COD限值(50)', value: 50, color: '#e86452' },
        { label: '氨氮限值(5)', value: 5, color: '#f6bd16' },
      ]
    };

    // DO图表 - 每日各池均值
    const doByDay = {};
    doData.forEach(r => { if (!doByDay[r.date]) doByDay[r.date] = []; doByDay[r.date].push(r); });
    const doChart = {
      labels: dayLabel,
      datasets: [
        { label: '厌氧池', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=doByDay[d]||[]; return recs.length?avg(recs,'anaerobic'):null; }), borderColor: '#e86452', tension: 0.3, borderWidth: 2 },
        { label: '缺氧池', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=doByDay[d]||[]; return recs.length?avg(recs,'anoxic'):null; }), borderColor: '#5b8ff9', tension: 0.3, borderWidth: 2 },
        { label: '好氧池1', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=doByDay[d]||[]; return recs.length?avg(recs,'aerobic1'):null; }), borderColor: '#5ad8a6', tension: 0.3, borderWidth: 2 },
        { label: '好氧池2', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=doByDay[d]||[]; return recs.length?avg(recs,'aerobic2'):null; }), borderColor: '#f6bd16', tension: 0.3, borderWidth: 2 },
        { label: '好氧池3', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=doByDay[d]||[]; return recs.length?avg(recs,'aerobic3'):null; }), borderColor: '#9270ca', tension: 0.3, borderWidth: 1.5, hidden: true },
        { label: '好氧池4', data: chartLabels.map((_,i) => { const d=year+'-'+chartLabels[i]; const recs=doByDay[d]||[]; return recs.length?avg(recs,'aerobic4'):null; }), borderColor: '#ff9845', tension: 0.3, borderWidth: 1.5, hidden: true },
      ],
      thresholds: [
        { label: '厌氧上限(0.2)', value: 0.2, color: '#e86452' },
        { label: '缺氧上限(0.5)', value: 0.5, color: '#5b8ff9' },
        { label: '好氧下限(2.5)', value: 2.5, color: '#5ad8a6' },
        { label: '好氧上限(4.5)', value: 4.5, color: '#f6bd16' },
      ]
    };

    // 污泥图表 - 每日SV30/SVI/MLSS
    const labByDay = {};
    labData.forEach(r => { labByDay[r.date] = r; });
    const sludgeChart = {
      labels: dayLabel,
      datasets: [
        { label: 'SV30(%)', data: chartLabels.map((_,i) => { const r=labByDay[year+'-'+chartLabels[i]]; return r&&Number(r.sv30)>0?r2(Number(r.sv30)):null; }), borderColor: '#5b8ff9', tension: 0.3, borderWidth: 2, yAxisID: 'y' },
        { label: 'SVI(mL/g)', data: chartLabels.map((_,i) => { const r=labByDay[year+'-'+chartLabels[i]]; return r&&Number(r.svi)>0?r2(Number(r.svi)):null; }), borderColor: '#e86452', tension: 0.3, borderWidth: 2, yAxisID: 'y' },
        { label: 'MLSS(mg/L)', data: chartLabels.map((_,i) => { const r=labByDay[year+'-'+chartLabels[i]]; return r&&Number(r.mlss)>0?r2(Number(r.mlss)):null; }), borderColor: '#9270ca', tension: 0.3, borderWidth: 2, yAxisID: 'y1' },
      ],
      thresholds: [
        { label: 'SV30上限(30)', value: 30, color: '#5b8ff9', axis: 'y' },
        { label: 'SVI上限(150)', value: 150, color: '#e86452', axis: 'y' },
      ]
    };

    // 药剂图表 - 每日投加量
    const chemByDay = {};
    dosingData.forEach(r => { if (!chemByDay[r.date]) chemByDay[r.date] = []; chemByDay[r.date].push(r); });
    const chemChart = {
      labels: dayLabel,
      datasets: [
        { label: '碳源(kg)', data: chartLabels.map((_,i) => { const recs=chemByDay[year+'-'+chartLabels[i]]||[]; return recs.length?avg(recs,'carbonSource'):null; }), borderColor: '#e86452', backgroundColor: 'rgba(232,100,82,0.1)', tension: 0.3, borderWidth: 2, fill: true },
        { label: 'PAC(kg)', data: chartLabels.map((_,i) => { const recs=chemByDay[year+'-'+chartLabels[i]]||[]; return recs.length?avg(recs,'pac'):null; }), borderColor: '#5b8ff9', backgroundColor: 'rgba(91,143,249,0.1)', tension: 0.3, borderWidth: 2, fill: true },
        { label: '次氯酸钠(kg)', data: chartLabels.map((_,i) => { const recs=chemByDay[year+'-'+chartLabels[i]]||[]; return recs.length?avg(recs,'naclo'):null; }), borderColor: '#9270ca', tension: 0.3, borderWidth: 1.5 },
        { label: '阳离子PAM(kg)', data: chartLabels.map((_,i) => { const recs=chemByDay[year+'-'+chartLabels[i]]||[]; return recs.length?avg(recs,'cationPam'):null; }), borderColor: '#f6bd16', tension: 0.3, borderWidth: 1.5 },
      ],
    };

    // 运营效率图表 - 每日水量/电耗
    const summaryByDay = {};
    dailySummary.forEach(r => { summaryByDay[r.date] = r; });
    const opsChart = {
      labels: dayLabel,
      datasets: [
        { label: '日进水量(m³)', data: chartLabels.map((_,i) => { const r=summaryByDay[year+'-'+chartLabels[i]]; return r&&Number(r.inFlowTotal)>0?r2(Number(r.inFlowTotal)):null; }), borderColor: '#1890ff', backgroundColor: 'rgba(24,144,255,0.1)', tension: 0.3, borderWidth: 2, fill: true, yAxisID: 'y' },
        { label: '日用电量(kWh)', data: chartLabels.map((_,i) => { const r=summaryByDay[year+'-'+chartLabels[i]]; return r&&Number(r.electricity)>0?r2(Number(r.electricity)):null; }), borderColor: '#fa8c16', tension: 0.3, borderWidth: 2, yAxisID: 'y1' },
        { label: '污泥产量(吨)', data: chartLabels.map((_,i) => { const r=summaryByDay[year+'-'+chartLabels[i]]; return r&&Number(r.sludgeOutput)>0?r2(Number(r.sludgeOutput)):null; }), borderColor: '#722ed1', tension: 0.3, borderWidth: 1.5, yAxisID: 'y1' },
      ],
    };

    // 工艺波动分析
    const fluctuation = {};
    const cv = (s) => s && s.avg > 0 ? r2(s.std / s.avg * 100) : null; // 变异系数
    fluctuation.waterCodCv = cv(waterAnalysis.outCod);
    fluctuation.waterNh3Cv = cv(waterAnalysis.outNh3);
    fluctuation.waterTnCv = cv(waterAnalysis.outTn);
    fluctuation.waterTpCv = cv(waterAnalysis.outTp);
    fluctuation.doAerobicCv = cv(doAnalysis.aerobic);
    fluctuation.sv30Cv = cv(sludgeAnalysis.sv30);
    fluctuation.sviCv = cv(sludgeAnalysis.svi);
    fluctuation.mlssCv = cv(sludgeAnalysis.mlss);
    fluctuation.flowCv = cv(waterAnalysis.inFlow);
    // 综合评价
    const cvs = [fluctuation.waterCodCv, fluctuation.waterNh3Cv, fluctuation.doAerobicCv, fluctuation.sv30Cv, fluctuation.flowCv].filter(v => v !== null);
    fluctuation.overallCv = cvs.length ? r2(cvs.reduce((a,b)=>a+b,0)/cvs.length) : null;
    fluctuation.level = fluctuation.overallCv === null ? '数据不足' : fluctuation.overallCv < 20 ? '稳定' : fluctuation.overallCv < 40 ? '波动' : '剧烈波动';
    // 工艺稳定性评估
    const processEvaluation = [];
    if (fluctuation.waterCodCv !== null && fluctuation.waterCodCv > 30) processEvaluation.push('出水COD波动较大（CV=' + fluctuation.waterCodCv + '%），进水水质变化可能较剧烈，需关注调节池缓冲效果');
    if (fluctuation.waterNh3Cv !== null && fluctuation.waterNh3Cv > 30) processEvaluation.push('出水氨氮波动明显（CV=' + fluctuation.waterNh3Cv + '%），硝化系统可能不够稳定，建议关注好氧池DO和泥龄');
    if (fluctuation.doAerobicCv !== null && fluctuation.doAerobicCv > 25) processEvaluation.push('好氧池DO波动较大（CV=' + fluctuation.doAerobicCv + '%），曝气调控需优化，建议检查鼓风机运行和DO设定值');
    if (fluctuation.sv30Cv !== null && fluctuation.sv30Cv > 25) processEvaluation.push('SV30波动较大（CV=' + fluctuation.sv30Cv + '%），污泥沉降性能不稳定，需关注污泥膨胀风险');
    if (fluctuation.mlssCv !== null && fluctuation.mlssCv > 25) processEvaluation.push('MLSS波动较大（CV=' + fluctuation.mlssCv + '%），排泥策略可能需要调整');
    if (fluctuation.flowCv !== null && fluctuation.flowCv > 30) processEvaluation.push('进水量波动较大（CV=' + fluctuation.flowCv + '%），需关注雨季影响和调节池液位');
    if (processEvaluation.length === 0) processEvaluation.push('各项工艺参数波动在合理范围内，整体运行稳定');

    res.json({
      period: { year, month, dateFrom, dateTo, daysInMonth: lastDay },
      generatedAt: new Date().toISOString(),
      waterAnalysis,
      doAnalysis,
      sludgeAnalysis,
      chemicalAnalysis,
      operationAnalysis,
      dewateringAnalysis,
      alertAnalysis,
      issues,
      suggestions,
      charts: { water: waterChart, do: doChart, sludge: sludgeChart, chemical: chemChart, operation: opsChart },
      fluctuation,
      processEvaluation,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 月度分析报告 Word 文档导出
app.get('/api/report/analysis/export', authMiddleware, async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear().toString();
    const month = req.query.month || String(new Date().getMonth() + 1).padStart(2, '0');

    // 调用同一个分析接口获取数据
    const analysisUrl = 'http://localhost:' + PORT + '/api/report/analysis?year=' + year + '&month=' + month;
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    const analysisRes = await fetch(analysisUrl, { headers: { Authorization: 'Bearer ' + token } });
    const data = await analysisRes.json();

    // 生成 HTML 格式报告（可在浏览器中打印为 PDF）
    const r2 = v => v !== null && v !== undefined && !isNaN(v) ? v : '-';
    const fmtArr = (s) => s ? `均值${r2(s.avg)} | 范围${r2(s.min)}~${r2(s.max)}` : '暂无数据';

    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>月度数据分析报告</title>
<style>
body{font-family:'Microsoft YaHei',sans-serif;padding:40px 60px;color:#333;line-height:1.8;font-size:14px;}
h1{text-align:center;color:#1a1a2e;border-bottom:3px solid #1a1a2e;padding-bottom:12px;margin-bottom:8px;}
.subtitle{text-align:center;color:#666;font-size:13px;margin-bottom:30px;}
h2{color:#16213e;border-left:4px solid #0f3460;padding-left:12px;margin-top:30px;}
h3{color:#1a1a2e;margin-top:20px;}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;}
th{background:#1a1a2e;color:#fff;padding:8px 12px;text-align:left;font-weight:500;}
td{padding:7px 12px;border-bottom:1px solid #e8e8e8;}
tr:nth-child(even) td{background:#f8f9fa;}
.danger{color:#f5222d;font-weight:600;}
.warning{color:#fa8c16;font-weight:600;}
.success{color:#52c41a;font-weight:600;}
.issue{background:#fff2f0;border-left:4px solid #f5222d;padding:10px 14px;margin:8px 0;border-radius:4px;}
.suggestion{background:#f6ffed;border-left:4px solid #52c41a;padding:10px 14px;margin:8px 0;border-radius:4px;}
.summary-box{background:#f0f5ff;border:1px solid #d6e4ff;border-radius:8px;padding:16px;margin:12px 0;}
.footer{text-align:center;color:#999;font-size:12px;margin-top:40px;border-top:1px solid #eee;padding-top:12px;}
@media print{body{padding:20px 30px;}h2{page-break-before:auto;}}
</style></head><body>`;

    html += `<h1>污水处理厂月度数据分析报告</h1>`;
    html += `<div class="subtitle">报告期间：${year}年${month}月 | 生成时间：${new Date().toLocaleString('zh-CN')}</div>`;

    // 概览
    html += `<div class="summary-box">
      <h3 style="margin-top:0;">📊 月度概览</h3>
      <p>📊 水质记录 <strong>${data.waterAnalysis.totalRecords}</strong> 条 | 🔍 DO巡检 <strong>${data.doAnalysis.totalRecords}</strong> 条 | 🧫 化验记录 <strong>${data.sludgeAnalysis.totalRecords}</strong> 条</p>
      <p>💧 月进水总量 <strong>${r2(data.waterAnalysis.totalInFlow)}</strong> m³ | 💡 月用电 <strong>${r2(data.operationAnalysis.electricity?.total)}</strong> kWh | ⚡ 吨水电耗 <strong>${r2(data.operationAnalysis.tonsWaterElec)}</strong> kWh/m³</p>
      <p>🔧 设备运行率 <strong>${r2(data.operationAnalysis.operationRate)}%</strong> | 🚨 预警 <strong>${data.alertAnalysis.total}</strong> 条（已处理${data.alertAnalysis.resolved}条）</p>
    </div>`;

    // 1. 水质分析
    const wa = data.waterAnalysis;
    html += `<h2>一、进出水水质分析</h2>`;
    html += `<table><tr><th>指标</th><th>进水均值</th><th>进水范围</th><th>出水均值</th><th>出水范围</th><th>排放标准</th><th>超标率</th></tr>`;
    const waterRows = [
      ['COD (mg/L)', wa.inCod, wa.outCod, 50, wa.codExceedRate],
      ['氨氮 (mg/L)', wa.inNh3, wa.outNh3, 5, wa.nh3ExceedRate],
      ['总氮 (mg/L)', wa.inTn, wa.outTn, 15, wa.tnExceedRate],
      ['总磷 (mg/L)', wa.inTp, wa.outTp, 0.5, wa.tpExceedRate],
    ];
    waterRows.forEach(([label, inS, outS, limit, er]) => {
      const cls = er > 5 ? 'danger' : er > 0 ? 'warning' : 'success';
      html += `<tr><td>${label}</td><td>${r2(inS?.avg)}</td><td>${r2(inS?.min)}~${r2(inS?.max)}</td><td>${r2(outS?.avg)}</td><td>${r2(outS?.min)}~${r2(outS?.max)}</td><td>≤${limit}</td><td class="${cls}">${r2(er)}%</td></tr>`;
    });
    html += `</table>`;

    // 2. DO分析
    const da = data.doAnalysis;
    html += `<h2>二、溶解氧(DO)分析</h2>`;
    html += `<table><tr><th>池别</th><th>均值(mg/L)</th><th>最小值</th><th>最大值</th><th>标准差</th><th>控制标准</th><th>超标率</th></tr>`;
    const doRows = [
      ['厌氧池', da.anaerobic, '<0.2'],
      ['缺氧池', da.anoxic, '<0.5'],
      ['好氧池(综合)', da.aerobic, '2.5-4.5'],
    ];
    doRows.forEach(([label, s, limit]) => {
      const cls = s?.exceedRate > 20 ? 'danger' : s?.exceedRate > 5 ? 'warning' : 'success';
      html += `<tr><td>${label}</td><td>${r2(s?.avg)}</td><td>${r2(s?.min)}</td><td>${r2(s?.max)}</td><td>${r2(s?.std)}</td><td>${limit} mg/L</td><td class="${cls}">${r2(s?.exceedRate)}%</td></tr>`;
    });
    html += `</table>`;

    // 3. 污泥分析
    const sa = data.sludgeAnalysis;
    html += `<h2>三、污泥指标分析</h2>`;
    html += `<table><tr><th>指标</th><th>均值</th><th>范围</th><th>标准差</th><th>正常范围</th><th>异常率</th></tr>`;
    const sludgeRows = [
      ['SV30 (%)', sa.sv30, '15-30%'],
      ['SVI (mL/g)', sa.svi, '80-150'],
      ['MLSS (mg/L)', sa.mlss, '2000-4000'],
    ];
    sludgeRows.forEach(([label, s, range]) => {
      const cls = s?.exceedRate > 20 ? 'danger' : s?.exceedRate > 5 ? 'warning' : 'success';
      html += `<tr><td>${label}</td><td>${r2(s?.avg)}</td><td>${r2(s?.min)}~${r2(s?.max)}</td><td>${r2(s?.std)}</td><td>${range}</td><td class="${cls}">${r2(s?.exceedRate)}%</td></tr>`;
    });
    html += `</table>`;

    // 4. 药剂分析
    const ca = data.chemicalAnalysis;
    html += `<h2>四、药剂投加分析</h2>`;
    html += `<table><tr><th>药剂</th><th>月投加总量(kg)</th><th>日均(kg)</th><th>日最大(kg)</th><th>日最小(kg)</th></tr>`;
    const chemRows = [
      ['碳源', ca.carbonSource], ['PAC', ca.pac], ['葡萄糖', ca.glucose],
      ['次氯酸钠', ca.naclo], ['阴离子PAM', ca.anionPam], ['阳离子PAM', ca.cationPam],
    ];
    chemRows.forEach(([label, s]) => {
      if (s) html += `<tr><td>${label}</td><td>${r2(s.total)}</td><td>${r2(s.avg)}</td><td>${r2(s.max)}</td><td>${r2(s.min)}</td></tr>`;
    });
    html += `</table>`;
    if (ca.tonsWaterChemical) {
      html += `<p>💡 吨水碳源消耗：<strong>${r2(ca.tonsWaterChemical.carbonSource)}</strong> kg/千m³ | 吨水PAC消耗：<strong>${r2(ca.tonsWaterChemical.pac)}</strong> kg/千m³</p>`;
    }

    // 5. 运营效率
    const oa = data.operationAnalysis;
    html += `<h2>五、运营效率分析</h2>`;
    html += `<table><tr><th>项目</th><th>月总量</th><th>日均值</th><th>日最大</th><th>日最小</th></tr>`;
    html += `<tr><td>用电量 (kWh)</td><td>${r2(oa.electricity?.total)}</td><td>${r2(oa.electricity?.avg)}</td><td>${r2(oa.electricity?.max)}</td><td>${r2(oa.electricity?.min)}</td></tr>`;
    html += `<tr><td>进水量 (m³)</td><td>${r2(oa.inFlowTotal?.total)}</td><td>${r2(oa.inFlowTotal?.avg)}</td><td>${r2(oa.inFlowTotal?.max)}</td><td>${r2(oa.inFlowTotal?.min)}</td></tr>`;
    html += `<tr><td>污泥产量 (吨)</td><td>${r2(oa.sludgeOutput?.total)}</td><td>${r2(oa.sludgeOutput?.avg)}</td><td>${r2(oa.sludgeOutput?.max)}</td><td>${r2(oa.sludgeOutput?.min)}</td></tr>`;
    html += `</table>`;
    html += `<p>💡 吨水电耗：<strong>${r2(oa.tonsWaterElec)}</strong> kWh/m³ | 设备运行率：<strong>${r2(oa.operationRate)}%</strong> (${oa.normalDays}/${oa.totalDays}天)</p>`;

    // 6. 脱泥分析
    const dewa = data.dewateringAnalysis;
    html += `<h2>六、脱泥生产分析</h2>`;
    html += `<p>脱泥运行 <strong>${dewa.activeDays}</strong> 天 | 总运行时长 <strong>${r2(dewa.duration?.total)}</strong> h | 总产泥量 <strong>${r2(dewa.sludgeOutput?.total)}</strong> 吨 | 日均产泥 <strong>${r2(dewa.sludgeOutput?.avg)}</strong> 吨</p>`;

    // 7. 预警分析
    const aa = data.alertAnalysis;
    html += `<h2>七、预警事件分析</h2>`;
    html += `<p>本月预警 <strong>${aa.total}</strong> 条：高级 ${aa.high} | 中级 ${aa.medium} | 低级 ${aa.low} | 处理率 ${r2(aa.resolveRate)}%</p>`;
    if (Object.keys(aa.types || {}).length > 0) {
      html += `<table><tr><th>预警类型</th><th>数量</th></tr>`;
      Object.entries(aa.types).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
        html += `<tr><td>${type}</td><td>${count}</td></tr>`;
      });
      html += `</table>`;
    }

    // 8. 问题与建议
    html += `<h2>八、问题识别与改进建议</h2>`;
    if (data.issues && data.issues.length > 0) {
      html += `<h3>⚠️ 识别的问题</h3>`;
      data.issues.forEach(issue => { html += `<div class="issue">${issue}</div>`; });
    } else {
      html += `<div class="suggestion">✅ 本月各项指标运行正常，未发现明显异常</div>`;
    }
    if (data.suggestions && data.suggestions.length > 0) {
      html += `<h3>💡 改进建议</h3>`;
      data.suggestions.forEach(s => { html += `<div class="suggestion">${s}</div>`; });
    }

    html += `<div class="footer">污水处理厂运行管理系统 v4.5 | 自动生成于 ${new Date().toLocaleString('zh-CN')}</div>`;
    html += `</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="analysis_report_' + year + month + '.html"');
    res.send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '4.5', db: dbType, uptime: process.uptime() });
});

// 微信小程序业务域名校验文件支持
// 将校验文件放在 public/ 目录下即可，如 public/WX_verify_xxx.txt
// 访问 https://域名/WX_verify_xxx.txt 即可通过校验

// ==================== 启动服务 ====================
  app.listen(PORT, () => {
    console.log('污水处理厂运行管理系统 v4.0 (' + dbType + ')');
    console.log('本地访问: http://localhost:' + PORT);
    console.log('数据库: ' + DB_PATH + ' (' + dbType + ')');
    console.log('登录账号: admin / admin123（厂长）');
    console.log('已启用: SQLite数据库 | ' + (dbType === 'better-sqlite3' ? 'WAL模式' : 'sql.js内存模式') + ' | 13张数据表 | 角色权限 | 智能加药 | 预警引擎 | Excel导出 | 趋势分析');
  });
} // end startServer()
