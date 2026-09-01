# Code Wiki — 身份信息管理平台

> 面向开发 / 维护团队的代码速查手册。基于当前仓库代码整理，覆盖整体架构、模块职责、关键类与函数、依赖关系与运行方式。
>
> 维护提示：如代码发生结构性变化，请同步更新本文档对应章节。

---

## 1. 项目概览

一套面向个人身份档案的管理系统，围绕 `fj_id_card` 身份数据表提供三大能力：

1. **档案管理**：人员姓名、身份证号、手机号、关系、备注的增删改查；身份证号自动推导户籍地区、出生日期、性别等派生信息；支持自定义关系。
2. **关联登记查询**：接入 `cdsgus` 登记表，按身份证号查询该人员多条历史登记信息（地址、学历、单位、联系方式等），标记"是否有记录"。
3. **数据看板**：多维聚合分析（性别、关系、姓氏、出生年份/月份、年龄/年龄阶段、星座、户籍地区分布、手机归属地/运营商），支持全局筛选（是否记录、记录年份）与图表点击下钻查看人员明细；地区分布支持全国 → 省 → 市 → 区逐级下钻。

并内置 **RBAC 权限体系**：登录认证 + 基于角色的访问控制。

### 1.1 技术栈

| 层次 | 技术 | 说明 |
| --- | --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript | 无框架单页应用（SPA），按职责拆分脚本 |
| 图表 | ECharts 5.5.0（CDN 引入） | 柱状图、环形图、折线图、中国省市区地图 |
| 后端 | Node.js + Express 4.19 | REST API 与静态资源托管 |
| 数据库 | MySQL（mysql2 连接池） | 连接失败自动降级为内存演示数据 |
| 认证 | 自研 Token 会话 + RBAC | Token 内存会话（24h）；数据持久化到 `auth-data.json` |

### 1.2 关键设计决策

- **演示模式降级**：MySQL 连接失败时自动回退到 `seed-demo.json` 内存数据，保证前端可离线预览；接口统一返回 `mode` 字段（`mysql` / `demo`）供前端展示。
- **唯一性校验在应用层**：手机号/身份证号唯一性由应用层校验（历史数据存在重复），数据库层不做唯一约束。
- **自定义关系用负整数编码**：自定义关系以 -1、-2… 存储，避免与内置关系 0-5 冲突。
- **看板大表聚合**：针对千万级 `fj_id_card` / `cdsgus`，看板 SQL 采用 GROUP BY + 索引列 + EXISTS 子查询（而非 MIN(LEFT(Version,4))）过滤年份，保证性能。
- **权限只通过角色授予**：禁止直接给用户授权；角色可启停，权限取所有启用角色并集。

---

## 2. 目录结构

```
infocard-id-card-manager/
├── package.json               # 依赖与启动脚本（express / cors / mysql2）
├── package-lock.json
├── .env                       # 数据库连接配置（不纳入版本控制，见 .gitignore）
├── .gitignore                 # 忽略 node_modules / .env / data / *.log / .DS_Store
├── README.md                  # 项目说明与快速开始
├── seed-demo.json             # 演示数据（未连数据库时载入内存，demo 模式增删改会写回）
├── docs/
│   ├── Code-Wiki.md           # 本文档
│   └── 项目文档/               # 历史项目文档（md / docx / 生成脚本）
├── server/                    # 后端（Express）
│   ├── index.js               # 服务入口：中间件、业务路由、参数校验、错误处理、启动
│   ├── db.js                  # 数据访问层：MySQL + 演示数据回退 + 看板聚合 SQL
│   ├── idcard.js              # 身份证号解析工具（15/18 位）+ 关系字典
│   ├── auth.js                # 认证与 RBAC 核心：权限清单、Token、中间件、存储操作
│   ├── rbac.js                # /api/auth 与 /api/system 路由（登录、用户、角色）
│   └── auth-data.json         # 用户 / 角色 / 用户-角色关联 持久化文件
├── public/                    # 前端（静态资源，Express 直接托管）
│   ├── index.html             # 主应用页面（Sidebar + 各视图 + 抽屉/弹窗）
│   ├── login.html             # 登录页（独立极简布局）
│   ├── styles.css             # 全局样式（Design tokens + 布局 + 组件）
│   ├── auth.js                # 会话管理、fetch 拦截、权限导航、用户菜单（先加载）
│   ├── app.js                 # 人员列表视图：分页/搜索/筛选/抽屉表单/详情
│   ├── dashboard.js           # 数据看板视图：Tab/筛选联动/ECharts/地图下钻/明细弹窗
│   ├── sys.js                 # 系统管理视图：用户管理、角色管理
│   └── maps/                  # ECharts 地图数据
│       ├── china.json         # 全国地图
│       ├── province/          # 省级地图（6 位 adcode 命名，如 440000.json）
│       └── district/          # 市辖区地图（6 位 adcode 命名，如 440100.json）
└── scripts/
    └── fetch-district-maps.js # 预下载有数据城市的区级地图（DataV）
```

---

## 3. 系统架构

### 3.1 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ 浏览器 (原生 SPA)                                            │
│  login.html ──▶ index.html                                  │
│     │        ├── auth.js      会话/权限/导航                 │
│     │        ├── app.js       人员列表                       │
│     │        ├── dashboard.js 数据看板 + ECharts + 地图       │
│     │        ├── sys.js       用户/角色管理                  │
│     │        └── styles.css   全局样式                       │
└──────────────┬─────────────────────────────────────────────┘
               │ HTTP / JSON（fetch 自动注入 Bearer Token）
┌──────────────▼─────────────────────────────────────────────┐
│ Express 服务 (server/index.js, 端口 5173)                    │
│  ├─ 静态资源: public/、/maps                                │
│  ├─ /api/auth  登录/登出/改密 (公开仅 login)                 │
│  ├─ requireAuth 中间件 ── 全部 /api 需登录                   │
│  │   └─ /api/id-cards*   人员档案 CRUD + 详情 + stats        │
│  │   └─ /api/dashboard*  看板统计/地图/明细 (requirePerm)    │
│  │   └─ /api/system*     RBAC 用户/角色管理 (requirePerm)    │
│  └─ 统一错误处理                                            │
└──────────────┬─────────────────────────────────────────────┘
               │
┌──────────────▼─────────────────────────────────────────────┐
│ 数据层 (server/db.js)                                        │
│  ├─ MySQL (mysql2 连接池) ── fj_id_card / cdsgus /          │
│  │     fj_admin_region / fj_constellation / fj_mobile_segment│
│  └─ 演示模式回退 (seed-demo.json 内存)                       │
│ 认证数据: server/auth-data.json (users/roles/userRoles)      │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 一次完整请求的链路（示例：打开人员列表）

1. `login.html` 提交登录 → `POST /api/auth/login` → 返回 token，存入 `localStorage['fj_token']`，跳转 `index.html`。
2. `auth.js` 启动 → `fetch('/api/auth/me')` 校验会话 → 得到 user / perms / roles。
3. `bootApp()` 按权限过滤侧边栏导航 → 默认切到"数据看板"或"人员列表"。
4. `app.js` 通过 `APP_VIEW.onShow('list')` 钩子被触发 → `API.list()` 请求 `/api/id-cards`（全局 fetch 拦截器自动附带 `Authorization: Bearer <token>`）。
5. 后端 `requireAuth` 校验 token → `requirePerm('idcard:list')` 校验权限 → `repo.query()` 查 MySQL（或演示数据）。
6. 返回 JSON → 前端渲染表格 + 分页 + 筛选 chips。

---

## 4. 后端模块详解

### 4.1 `server/index.js` — 服务入口与业务路由

职责：装配中间件、定义业务路由、参数校验、统一错误处理、启动服务。

**核心常量 / 函数**

| 名称 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 `5173`，可用 `process.env.PORT` 覆盖 |
| `ok(data, meta)` | 成功响应包装：`{ ok: true, data, mode, ...meta }` |
| `fail(msg, status)` | 生成带状态码的错误对象（默认 400） |
| `validate(body, partial)` | 表单校验：姓名(必填≤20)、身份证号(15/18位，`parseIdCard` 校验)、手机号(`/^1\d{10}$/`)、关系(整数/null)、备注(≤500)。`partial=true`（PUT 时）仅校验传入字段 |
| `asyncWrap(fn)` | 包装 async 路由，自动把异常交给错误中间件 |
| `parseDashScope(qs)` | 看板全局筛选：`hasRecord`（all/yes/no 白名单）、`regYear`（4 位数字/null） |
| `parseDashFilters(qs)` | 看板图表下钻的维度过滤参数白名单解析（gender/surname/birthYear/birthMonth/constellation/age/ageStage/relation/mobileProvince/carrier/hasRec/hasMob），值均做格式校验 |
| `DB_NAME()` | 读取 `DB_NAME` 环境变量，默认 `infocard_test` |
| `start()` | 初始化 MySQL → 测试连接 → 设置运行模式 → `app.listen` |

**中间件装配顺序（重要）**

```
app.use(cors())                          # 跨域
app.use(express.json())                 # JSON body
app.use(express.static(public))         # 静态托管 public/
app.use('/maps', static(maps))          # 静态托管地图 GeoJSON
app.use('/api/auth', authRouter)        # 认证路由（login 公开）
app.use('/api', requireAuth)            # ★ 此后所有 /api 必须登录
app.use('/api/system', rbacRouter)      # 系统管理（RBAC）
...业务路由（requirePerm 控制权限）...
app.use(错误处理)                        # { ok:false, message, mode }
```

**路由清单（文件内）**

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/id-cards` | `idcard:list` | 分页列表（page/pageSize/q/relation/nomobile） |
| GET | `/api/id-cards/stats` | `idcard:list` | 总数 / 无手机号数 / 关系分布 |
| GET | `/api/id-cards/:id` | `idcard:list` | 单条记录（enrich 后） |
| GET | `/api/id-cards/:id/detail` | `idcard:list` | 详情：人员信息 + 推导信息 + cdsgus 登记多条 |
| POST | `/api/id-cards` | `idcard:edit` | 新增档案（唯一性校验） |
| PUT | `/api/id-cards/:id` | `idcard:edit` | 更新档案（partial 校验 + 唯一性排除自身） |
| DELETE | `/api/id-cards/:id` | `idcard:edit` | 删除档案 |
| GET | `/api/dashboard/stats` | `dashboard:view` | 看板统计（person + mobile + regYears 并行） |
| GET | `/api/dashboard/region` | `dashboard:view` | 地区下钻数据（level=province/city/district + parent） |
| GET | `/api/dashboard/people` | `dashboard:view` | 明细人员分页（地区条件 + 维度过滤条件） |

### 4.2 `server/db.js` — 数据访问层（核心）

职责：环境变量加载、MySQL 连接池、演示数据回退、人员 CRUD、cdsgus 关联查询、看板全部聚合 SQL。

**模式控制（双模式）**

| 项目 | 说明 |
| --- | --- |
| `loadEnv()` | 解析项目根 `.env` 中的 `DB_*` 变量（已存在的环境变量优先） |
| `DB` | 连接配置：host/port/user/password/database，均有默认值 |
| `initMysql()` | 创建 `mysql2/promise` 连接池（connectionLimit 5，namedPlaceholders） |
| `testConnection()` | `SELECT 1` 探测；失败则 `mysqlAvailable=false` |
| `MODE` / `getMode()` / `setMode()` | 当前模式（`demo`/`mysql`）与内存演示数据 |
| `persistDemo()` | demo 模式下增删改后写回 `seed-demo.json` |

**派生信息与标记**

| 函数 | 说明 |
| --- | --- |
| `ageStage(age)` | 年龄 → 年龄阶段（幼儿/少儿/少年/青年/中年/老年/高龄 7 档） |
| `enrich(row)` | 把数据库行转换为前端展示对象：解析身份证推导 `card_len/region_code/region_name/birth/gender`，并附 `relation_label`、默认 `hasRecord:false` |
| `markHasRecord(rows)` | 按身份证号批量查询 `cdsgus.CtFId` 分批 IN（每批 ≤500），标记 `hasRecord` |

**SQL 条件构造辅助（看板安全过滤的关键）**

| 函数 | 说明 |
| --- | --- |
| `dashboardWhere(scope)` | 根据 hasRecord/regYear 生成作用于主表别名 `f` 的 WHERE 片段；"是+年份"用 `EXISTS(SELECT 1 FROM cdsgus d WHERE d.ctfid=f.card_no AND LEFT(d.Version,4)=?)`——只对确实有记录的人过滤，而非先 MIN 年份 |
| `baseFrom(where)` | `FROM fj_id_card f <where>` |
| `andCond(where, sql)` | where 为空用 `WHERE`，否则用 `AND` 追加 |
| `condClause(where, sql)` | 已含 where 时仅追加 `AND` |
| `escVal(v)` | SQL 字符串字面量转义（用于下钻维度的字符串值） |
| `STAGE_NAMES` | 年龄阶段白名单 Set（与 CASE 表达式一一对应） |
| `dashboardFilterClause(filters)` | 由图表点击产生的 filters 构造附加 WHERE：gender/surname(LEFT(name,1))/birthYear/birthMonth/constellation(EXISTS 区间匹配当跨年)/age(TIMESTAMPDIFF)/ageStage(CASE 白名单)/relation(含 null)/mobileProvince(EXISTS 或 未知 NOT EXISTS)/carrier/hasRec/hasMob。**所有值均经过白名单或 escVal 转义，防注入** |

**`repo` 对象方法**

| 方法 | 说明 |
| --- | --- |
| `repo.query({page,pageSize,q,relation,nomobile})` | 分页查询；MySQL 分支用 LIKE（转义 `%_\`）+ 参数化，分页 LIMIT/OFFSET，`LEFT JOIN fj_admin_region` 取省市区；demo 分支走 `applyFilters` |
| `repo.list()` | 全部（pageSize 1000） |
| `repo.get(id)` | 单条 |
| `repo.personDetail(id)` | 单条详情：JOIN 三张参考表推导年龄/星座/手机归属/运营商，拼接完整地区；附带 `repo.cdsgusByCard` 的多条登记 |
| `repo.create(v)` / `repo.update(id,v)` | 增改；先做身份证/手机号唯一性校验（`findByCard`/`findByMobile`，update 排除自身） |
| `repo.findByCard(cardNo, excludeId?)` | 身份证唯一性查询 |
| `repo.findByMobile(mobile, excludeId?)` | 手机号唯一性查询 |
| `repo.stats()` | 总数 / 无手机号 / 关系分布 |
| `repo.remove(id)` | 删除 |
| `repo.cdsgusByCard(cardNo)` | 按身份证号查 cdsgus 登记（可能多条）+ 字段改名 |
| `repo.dashboard(scope)` | 人员维度聚合（9 个查询 Promise.all）：counts、性别、姓氏、省份(LEFT 2位)、出生年/月、星座、年龄、年龄阶段、关系 |
| `repo.dashboardMobile(scope)` | 手机维度：counts、手机归属地、运营商（`COALESCE(NULLIF(m.province,''),'未知')`） |
| `repo.dashboardRegionTree(level,parent,scope)` | 地区下钻：province 按 2 位聚合、city 按 4 位、district 按 6 位；`HAVING count>0 ORDER BY count DESC` |
| `repo.dashboardPeople({level,parent,scope,page,pageSize,filters})` | 明细人员分页：地区条件 + `dashboardFilterClause` 维度过滤合并，按 `LEFT(f.name,1) DESC, f.id DESC` 排序 |
| `repo.dashboardRegYears(scope)` | 登记年份枚举；`hasRecord=yes` 时只返回 fj_id_card 有记录的人对应的年份（EXISTS） |

### 4.3 `server/idcard.js` — 身份证解析工具

| 函数 | 说明 |
| --- | --- |
| `REGION_MAP` | 省级/重点省份城市的区划名称映射 |
| `regionName(code)` | 先精确匹配 6 位，再按 2 位省匹配，否则"未知地区" |
| `parseIdCard(raw)` | 解析 15/18 位身份证：返回 `{cardNo, cardLen, regionCode, regionName, birthDateStr, birth, genderCode, genderName}`；非法返回 `{invalid:true}`；空返回 `null`。18 位校验 `^\d{17}[\dX]$`，性别取第 17 位奇偶；15 位补 `19` 前缀 |
| `RELATIONS` / `relationLabel(v)` | 内置关系字典（0 亲属 ~ 5 同事(财税)，null 其他）与标签转换 |

### 4.4 `server/auth.js` — 认证与 RBAC 核心

**权限清单**

`PERMISSIONS` 定义 7 个权限，分"业务"与"系统"两组：

| key | 名称 | 组 |
| --- | --- | --- |
| `idcard:list` | 人员列表 | 业务 |
| `idcard:edit` | 人员列表·维护 | 业务 |
| `dashboard:view` | 数据看板 | 业务 |
| `system:user:view` | 用户管理·查看 | 系统 |
| `system:user:edit` | 用户管理·维护 | 系统 |
| `system:role:view` | 角色管理·查看 | 系统 |
| `system:role:edit` | 角色管理·维护 | 系统 |

`ALL_PERM = '*'`：内置 admin 角色拥有全部权限。

**数据模型（持久化到 `auth-data.json`）**

```jsonc
{
  "users":     [{ "id", "username", "nickname", "salt", "hash", "status" }],
  "roles":     [{ "id", "roleKey", "roleName", "status", "isAdmin", "perms": [], "remark" }],
  "userRoles": [{ "userId", "roleId" }]
}
```

**关键函数**

| 函数 | 说明 |
| --- | --- |
| `load()` / `seed()` | 读取或初始化文件；首次运行自动创建 admin/admin123（scrypt 加盐哈希） |
| `persist(data)` | 写回文件 |
| `nextId(list)` | 自增 id |
| `hashPwd(pwd,salt)` / `verifyPwd(pwd,salt,hash)` | scrypt 哈希与校验 |
| `setPassword(user,pwd)` | 重置密码（更换 salt 重新哈希） |
| `permsForUser(userId)` | 计算用户权限集合：取该用户所有**启用**角色权限的并集；命中 `isAdmin` 角色直接返回 `['*']` |
| `createToken(userId)` / `resolveToken(token)` | 内存 Map 会话，24h 过期，随机 24 字节 hex |
| `publicUser(u)` | 对外暴露用户对象（不含 salt/hash） |
| `requireAuth` | 解析 `Authorization: Bearer` 注入 `req.auth`（含 user/perms/isAdmin/roles）；失效/禁用 → 401 |
| `requirePerm(perm)` | 权限门槛；未登录 401、无权限 403、admin 自动放行 |
| `isAdminRole(r)` | 是否内置管理员角色（保护不可删改禁用） |
| `listRoles()` | 角色列表 + 每个角色的 userCount |
| `listUsers()` | 用户列表 + 绑定角色（含 isAdmin 标记） |
| `setUserRoles(userId, roleIds)` | 重设用户-角色关联（全量替换） |
| `findRole` / `findUser` | 按 key/id 查找 |
| `getUserRolesObj(userId)` | 返回 `{roleIds}` |
| `hasEnabledRoles(userId)` | 用户是否仍有启用角色（用于限制禁用最后一个管理员） |

### 4.5 `server/rbac.js` — 认证与系统管理路由

**authRouter（挂载 `/api/auth`）**

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/login` | 公开 | 校验用户名密码与状态 → 发 token + user + perms |
| GET | `/me` | 登录 | 返回当前会话信息 `req.auth` |
| POST | `/logout` | 登录 | 记录登出（token 仍在内存，前端清除本地即可） |
| POST | `/password` | 登录 | 修改当前用户密码（校验原密码，6-32 位） |

**rbacRouter（挂载 `/api/system`，全部 requireAuth + requirePerm）**

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/perms` | `system:role:view` | 权限清单（角色分配勾选用） |
| GET | `/roles` | `system:role:view` | 角色列表 |
| POST | `/roles` | `system:role:edit` | 新建角色（roleKey 正则 `^[a-zA-Z:_-]+$`、唯一） |
| PUT | `/roles/:id` | `system:role:edit` | 修改角色（admin 角色禁止） |
| PUT | `/roles/:id/status` | `system:role:edit` | 启停角色（admin 角色禁止禁用） |
| DELETE | `/roles/:id` | `system:role:edit` | 删除角色（admin 禁止；仍被用户使用禁止） |
| GET | `/users` | `system:user:view` | 用户列表 |
| POST | `/users` | `system:user:edit` | 新建用户（用户名格式/唯一、密码≥6，可兼绑角色） |
| PUT | `/users/:id` | `system:user:edit` | 修改用户（admin 不可禁用；可选重置密码；admin 不改角色） |
| DELETE | `/users/:id` | `system:user:edit` | 删除用户（admin、当前登录者禁止） |

---

## 5. 前端模块详解

### 5.1 页面骨架 `public/index.html`

- **Layout**：`#sidebar`（品牌 + 分组导航：总览/数据看板、管理/人员列表、系统/用户管理·角色管理）+ `#layout-main`（header + main）。
- **Header**：折叠按钮、页面标题与面包屑、运行模式徽标、刷新按钮、右上角用户菜单（头像下拉：修改密码 / 退出登录）。
- **视图区**（`section.view`，按 `hidden` 切换）：
  - `viewList`：搜索框 + 关系筛选 chips + 新增按钮 + 表格 + 分页 + 每页条数。
  - `viewDash`：Tab（人员信息 / 手机信息 / 地区分布）+ 全局筛选（是否记录、记录年份）+ 三个 pane（`panePerson` / `paneMobile` / `paneRegion`）。
  - `viewSysUsers` / `viewSysRoles`：用户、角色管理表格。
  - `viewNoPerm`：无权限占位。
- **弹层**：新增/编辑抽屉（`#drawer` + 表单）、自定义关系弹窗、人员详情弹窗、人员明细弹窗、删除确认、修改密码、Toast。
- **脚本加载顺序（有依赖关系）**：`auth.js` → `app.js` → ECharts CDN → `dashboard.js` → `sys.js`。

### 5.2 `public/auth.js` — 会话 / 权限 / 导航（最先加载）

| 模块/函数 | 说明 |
| --- | --- |
| fetch 拦截 | 重写 `window.fetch`：自动附加 `Authorization: Bearer <token>`；收到 401（非登录接口）清除 token 并跳转 `login.html`，抛 `__unauthorized` 异常 |
| `TOKEN_KEY` | `localStorage` 键名 `fj_token` |
| `VIEWS` | 视图元数据表：`{ nav, view, perm, title, crumb }`，4 个视图各自权限 |
| `APP_VIEW` | 视图显示钩子注册/通知机制：`onShow(view, fn)` / `notify(view)`；供 app.js / dashboard.js / sys.js 懒加载 |
| `state` | `{ ready, user, isAdmin, roles, perms }` |
| `auth.ensure()` | 调 `/api/auth/me` 拉取会话写入 state（网络异常时降级放行） |
| `auth.whenReady()` | 启动等待窗口 |
| `auth.hasPerm(key)` / `auth.canEditList()` | 权限判断（admin 恒 true） |
| `auth.logout()` | 清 token → 调 logout → 跳登录页 |
| `permittedKeys()` | 当前用户有权限的视图 key 列表 |
| `switchView(key)` | 切换视图：控制各 `view.hidden` / 导航 active、更新标题面包屑、派发 `app:view` 事件并 `APP_VIEW.notify(key)` |
| `bootApp()` | 页面引导：渲染用户徽标 → 按权限隐藏导航项与空分组 → 控制新增身份按钮 → 无权限显示 `viewNoPerm` → 绑定导航点击 → **默认视图优先 dashboard，其次 list，最后第一个有权限的视图** |
| `setupSidebar()` | 折叠状态（localStorage `fj_sidebar_collapsed`），两个折叠按钮 |
| `setupUserMenu()` / `setupPwdDialog()` | 用户下拉菜单与修改密码弹窗逻辑 |
| `renderUserBadges()` | 头像首字、昵称、角色文案（超管标记 A） |

### 5.3 `public/app.js` — 人员列表视图

| 模块/函数 | 说明 |
| --- | --- |
| `API` | REST 封装：list/create/update/remove/detail/stats |
| 关系体系 | `BASE_RELATIONS`（内置 0-5 + null）；自定义关系存 `localStorage['fj_id_card.custom_relations']`（上限 6）；`getCustomRelations()` / `saveCustomRelations()` / `getAllRelations()` / `relationLabel(v)` / `relationIsCustom(v)` / `REL_TAG(v)`（自定义关系标签高亮） |
| `state` | 分页/搜索/筛选状态 `{page, pageSize, total, totalPages, rows, q, filter, stats}` |
| 工具函数 | `parseCard()`(前端二次推导身份证)、`REGION`/`regionName()`、`maskCard()`(打码显示)、`initials()`、`displayBirth()`、`escapeHtml()` |
| `renderPager()` | 分页器（首/末页 + 当前页 ±1 + 省略号） |
| `rowHtml(r)` / `renderTable()` | 行渲染（固定 56px 行高、手机号空显示 —、户籍拼到区）；编辑/删除按钮按 `canEditList()` 控制 |
| `showSkeleton()` | 骨架屏 |
| `load(resetPage)` | 拉列表 + stats，处理越界页码回退 |
| `setMode(mode)` | 顶部模式徽标 |
| `buildFiltersMeta()` / `renderFilters()` | 筛选 chips：全部 + 关系（内置+自定义按名称**升序** localeCompare 'zh'）+ 待补手机号 |
| 表单 | `buildRelationRadios()`、`setRelationChecked()`、`resetRelationToDefault()`(默认"其他")、`updateDerive()`(身份证输入实时推导)、`openCreate()`(**打开时显式清空所有字段 + 派生面板**)、`openEdit(row)` |
| 详情 | `openDetail(row)` / `renderDetail({person, cdsgus})`：英雄卡（年龄/人生阶段/星座）+ 基础信息 + 手机信息 + 备注 + 登记记录多卡片 |
| 校验提交 | `validateForm()` / `submitForm()`：前端校验 + 唯一性后端兜底 |
| 删除 | `openDelete()` / `confirmDelete()` |
| 自定义关系 | `openCustomRelDialog()` / `confirmAddCustomRel()`：查重（内置/自定义）、上限 6、**自动分配负整数编号**（从 -1 递减避让） |
| `bindEvents()` | 全部事件绑定（搜索防抖 220ms、事件委托） |
| 启动 | 立即 buildRelationRadios/renderFilters/bindEvents；通过 `APP_VIEW.onShow('list')` 首次进入才加载数据 |

### 5.4 `public/dashboard.js` — 数据看板视图（核心交互层）

**全局状态**：`state.scope`（hasRecord/regYear）、`state.activeTab`、`state.regionCtx`（地图下钻上下文）、`state.echarts`（**ECharts 实例缓存，key 用元素 id 不带 `#`**）。

| 模块/函数 | 说明 |
| --- | --- |
| `getChart(el)` | 获取/创建 ECharts 实例：缓存未失效则复用；已 dispose 则重建；init 前清空容器 |
| 全局筛选 | `dashHasRecord` 变更：disabled 年份下拉、**立即清空年份选项再加载**（避免闪现旧列表）；`dashRegYear` 变更触发重载 |
| `loadDashboard()` | 拉 `/api/dashboard/stats`，`dashReqSeq` 请求序号**丢弃过期响应**防竞态；渲染 count 卡 + 图表 + 填充年份 + resize |
| `fillRegYears(years)` | 填充记录年份下拉（保持已选项） |
| 统计卡 | `renderCountsPerson/Mobile`、`renderStatCard()`、`bindStatClicks()`：3 张卡（总数/已记录/未记录 或 手机维度），可点击下钻明细 |
| Tab 切换 | 三个 pane 显隐 + `resizeAll()` |
| 图表配置 | `barOption`（柱状，label 顶部+tooltip 人）、`pieOption`（环形图，图例含人数占比、扇区内嵌 ≥6% 占比）、`top3LineOption`（折线图，Top3 高亮 markPoint+橙标）、`renderSurname`（Top10 横条）、`renderAgeStage`（按固定顺序排序）、`CONST_START` 星座时序、`safeRender(id, fn, click)`（**单个图表异常不拖垮整链，click 前先 off 防重复**） |
| 维度下钻绑定 | 性别/关系/星座/运营商环形图与姓氏/出生年/月份/年龄/年龄阶段/归属地/运营商图表均绑定 click → `openPeopleDialog({label, filters})` |
| 地图下钻 | `PROV_ADCODE`(省份→6 位 adcode)、`loadMap()`、`stripNansha(geo)`（**移除"南海诸岛"feature 并裁剪纬度 <17° 的坐标**）、`makeMapOption`（中国图 zoom 1.2、标签"名称+人数"两行、visualMap 蓝阶）、`registerMap` 动态注册 china-dash / dash-{ad} / dash-dist-{ad} |
| 全国→省→市→区 | `renderRegionProvince()`（全国）→ `drillCity()`（点省加载 `/maps/province/{ad}.json`+市排名）→ `drillDistrict()`（点市加载 `/maps/district/{ad4}00.json`+区排名）→ 点区弹明细；支持面包屑返回 `renderNational()` |
| 排名条联动 | `renderRegionRank()`、`bindMapRank()`（地图与排名条互相 highlight/downplay） |
| 明细弹窗 | `openPeopleDialog()` / `loadPeople()`：合并 `{level, parent, page, pageSize:100} + scope + filters` 请求 `/api/dashboard/people`；`pageLinks()` 分页 |
| 生命周期 | `resizeAll()`（window resize + 每次渲染后 / Tab 切换后）、`drawLoading()`（**清空 12 个图表位并 dispose 旧实例**，key 用 el.id）、首次进入看板视图 `loadDashboard()` |

### 5.5 `public/sys.js` — 系统管理视图（用户/角色）

| 模块/函数 | 说明 |
| --- | --- |
| `api(path, opts)` | fetch 封装，401/错误统一抛异常 |
| `loadUsers()` / `renderUsers()` | 用户列表渲染（状态可点击启停、编辑/删除按钮、admin 徽标、当前用户徽标） |
| `loadRoles()` / `renderRoles()` | 角色列表（用户数、权限标签、内置角色灰显、启停 toggle） |
| `groupPerms()` | 权限按分组归档（业务/系统） |
| 事件委托 | userBody/roleBody 统一 click：状态 toggle / edit / del |
| `setUserStatus(uid)` | 启停用户（admin 白名单保护） |
| `openUserDialog(uid?)` | 新增/编辑用户弹窗（动态挂载，含角色勾选、状态分段按钮；admin 不可改角色） |
| `setRoleStatus(rid)` | 启停角色（禁用前 confirm 提示影响面） |
| `openRoleDialog(rid?)` | 新增/编辑角色弹窗（权限按分组勾选；admin 只读） |
| 确认弹窗 | `confirmDelUser` / `confirmDelRole` / `buildConfirm` |
| 动态弹窗机制 | `mountDialog()`：把 HTML 字符串挂到 body（**id 前缀改为 `__`**），可以重复创建；保存逻辑通过查询 `#__sysXxxDialog` 定位（**注意复用旧 id 会有 bug 隐患**）；`unmountDialog`/`clearDialogs` 负责清理 |
| `setSeg(kind, on)` | 启停分段按钮样式 |
| 视图钩子 | `onShow('users'/'roles')` 加载数据 + 兜底 notify 补触发 |

### 5.6 `public/login.html` — 登录页

- 独立极简布局（内联样式，不污染主应用）；已登录直接跳 `index.html`。
- 提交 `POST /api/auth/login` → 成功写 `fj_token` → 跳转 `index.html`；失败显示错误。

### 5.7 `public/styles.css` — 样式体系

- **Design tokens**（`:root`）：颜色 `--accent:#4353f7`、`--male/--female`、语义色、圆角、阴影、字体栈。
- 布局：Sidebar（216px，折叠态 68px）、Header（sticky）、Main。
- 组件：按钮、搜索、筛选 chip、表格（固定 56px 行高、`table-layout:fixed` + `overflow-x:auto` 保完整显示）、头像、关系标签（tag-0~5 / custom）、性别标签、分页器。
- 弹层：overlay、drawer（右侧抽屉动画）、dialog（居中）、详情弹窗、明细弹窗。
- 看板：dash-tabs、统计卡（可点击悬浮高亮）、3 列 dash-grid、`dash-pair`/`dash-card-wide`（跨行）、地图 500px 高。
- 系统管理：rel-tag、启停标签、seg 分段、chk 复选、权限分组。
- 响应式断点 980px / 900px / 760px。
- **注意**：`.overlay[hidden], .drawer[hidden], .dialog[hidden] { display:none !important }`——保证 hidden 属性始终生效。

---

## 6. 数据模型

### 6.1 业务表（MySQL，`infocard_test` 库）

| 表 | 用途 | 关键字段 |
| --- | --- | --- |
| `fj_id_card` | 人员档案主表 | `id, name, card_no, mobile, relation(int, null/0-5/负整数自定义), remark, region_code, birth_date_str, birth_mmdd, gender_code, card_len`。主要由前端/解析器写入派生字段 |
| `cdsgus` | 历史登记表（按证号关联，一人可多条） | `CtfId(身份证), Name, Gender, Birthday, Address, Nation, Education, Company, EMail, Mobile, Tel, Duty, Version(含年份)` 等 |
| `fj_admin_region` | 行政区划参考表 | `region_code(6位), province, city, district` |
| `fj_constellation` | 星座区间参考表 | `name, start_mmdd, end_mmdd`（支持跨年区间） |
| `fj_mobile_segment` | 手机号段归属表 | `segment(7位), province, city, carrier, carrier_type` |

> 看板筛选"是否记录"的 JOIN 关系：`fj_id_card.card_no` ↔ `cdsgus.CtFId`；地区维度使用 `region_code` 前缀截位（2 位省 / 4 位市 / 6 位区）与 `fj_admin_region` 关联；手机维度 `LEFT(f.mobile,7)=segment`。

### 6.2 认证数据（`server/auth-data.json`）

```jsonc
{
  "users":     [{ "id": 1, "username": "admin", "nickname": "管理员", "salt": "...", "hash": "...", "status": "1" }],
  "roles":     [{ "id": 1, "roleKey": "admin", "roleName": "超级管理员", "status": "1", "isAdmin": true, "perms": ["*"] }],
  "userRoles": [{ "userId": 1, "roleId": 1 }]
}
```

### 6.3 演示数据（`seed-demo.json`）

- 数组结构：`{ id, name, card_no, mobile, relation }`，供 demo 模式加载；demo 模式的增删改会**写回该文件**。

---

## 7. 权限体系（RBAC）详解

```
用户 (users)  ──多对多──▶  角色 (roles)  ──持有──▶  权限 (perms[])
   每个用户可绑多个角色             ─ 启用状态 status='1' 才生效
   权限 = 所有启用角色权限的并集  ─ 内置 admin 角色 isAdmin=true → 权限 ['*'] 全部
```

**设计规则**

1. 权限**只通过角色**授予用户，禁止直接授用户（`setUserRoles` 全量替换用户-角色关联）。
2. 内置 admin 角色与 admin 用户**不可删除、禁用、修改**（`isAdminRole` 保护）。
3. 角色可启停：禁用后该角色下所有用户立即失去对应权限。
4. 多角色并集；`permsForUser()` 中命中 admin 角色直接短路返回 `['*']`。
5. 业务接口用 `requirePerm('xxx')` 门控；`dashboard:view` 等权限同时控制前端菜单显隐与后端接口。
6. 管理员账号不可被禁用/删除/改角色（`rbac.js` 中多处 `username==='admin'` 判定）。

**权限 ↔ 页面/接口映射**

| 权限 | 菜单 | 接口 |
| --- | --- | --- |
| `idcard:list` | 人员列表（查看） | `/api/id-cards*`（GET） |
| `idcard:edit` | 人员列表·维护（新增/编辑/删除按钮） | POST/PUT/DELETE `/api/id-cards*` |
| `dashboard:view` | 数据看板 | `/api/dashboard/*` |
| `system:user:view` / `system:user:edit` | 用户管理 | `/api/system/users`（GET / 写） |
| `system:role:view` / `system:role:edit` | 角色管理 | `/api/system/roles`、`/perms`（GET / 写） |

---

## 8. API 接口速查

> 除 `POST /api/auth/login` 外，全部接口需要请求头 `Authorization: Bearer <token>`。未登录 401、无权限 403；统一响应结构 `{ ok, mode, data?, message? }`。

### 8.1 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | body `{username,password}` → `{token, user, perms}` |
| GET | `/api/auth/me` | 当前会话（user/perms/isAdmin/roles） |
| POST | `/api/auth/logout` | 登出（前端清 token 即可） |
| POST | `/api/auth/password` | body `{oldPassword,newPassword}`，改当前用户密码 |

### 8.2 人员档案

| 方法 | 路径 | 参数/body | 说明 |
| --- | --- | --- | --- |
| GET | `/api/id-cards` | `page,pageSize,q,relation,nomobile` | 分页列表；`data`=rows、`total/totalPages` |
| GET | `/api/id-cards/stats` | - | `total/noMobile/byRelation` |
| GET | `/api/id-cards/:id` | - | enrich 后单条 |
| GET | `/api/id-cards/:id/detail` | - | `{person(含推导), cdsgus[]}` |
| POST | `/api/id-cards` | `{name,card_no,mobile?,relation?,remark?}` | 201 创建；重复身份证/手机号 400 |
| PUT | `/api/id-cards/:id` | 同 POST（可选字段） | 更新；唯一性排除自身 |
| DELETE | `/api/id-cards/:id` | - | 删除 |

### 8.3 数据看板

| 方法 | 路径 | 参数 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/dashboard/stats` | `hasRecord(scope),regYear` | `{person:{counts,gender,surname,regionProvince,birthYear,birthMonth,constellation,age,ageStage,relation}, mobile:{counts,mobileProvince,carrier}, regYears[]}` |
| GET | `/api/dashboard/region` | `level=province\|city\|district, parent, hasRecord, regYear` | 地区下钻行（province/city/count/code） |
| GET | `/api/dashboard/people` | `level,parent,page,pageSize,hasRecord,regYear` + 12 个维度过滤参数 | 分页明细；数据按姓名首字倒序 |

### 8.4 系统管理（RBAC）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/perms` | 权限清单 |
| GET/POST | `/api/system/roles` | 角色列表 / 新建 |
| PUT | `/api/system/roles/:id` | 修改角色 |
| PUT | `/api/system/roles/:id/status` | 启停角色 |
| DELETE | `/api/system/roles/:id` | 删除角色 |
| GET/POST | `/api/system/users` | 用户列表 / 新建 |
| PUT | `/api/system/users/:id` | 修改用户 |
| DELETE | `/api/system/users/:id` | 删除用户 |

---

## 9. 关键业务流程

### 9.1 登录与会话

```
login.html 提交 ─▶ POST /api/auth/login ─▶ 校验密码/状态 ─▶ 生成 token(内存24h)
     │                                                        │
     └── localStorage 存 fj_token ─▶ index.html ─▶ /api/auth/me ─▶ state(user/perms/roles)
                                                                      │
                    bootApp: 权限过滤导航 → 默认视图(dashboard>list>首个) → 懒加载视图数据
401 任意接口 → fetch 拦截器自动清 token 并跳转 login
```

### 9.2 档案增删改（唯一性约束）

```
POST/PUT /api/id-cards
  → validate() 字段校验（姓名/身份证/手机/关系/备注）
  → repo.create/update
       ├─ findByCard(card_no, excludeId?)  → 重复身份证拦截
       └─ findByMobile(mobile, excludeId?) → 非空手机号重复拦截（应用层，库层无唯一约束）
  → MySQL 或 demo 双分支写入 → 返回 enrich 后记录
```

### 9.3 看板联动筛选与下钻

```
看板 Tab(人员信息/手机信息/地区分布)
  └─ 全局筛选: 是否记录(all/yes/no) + 记录年份(仅 yes 可用)
       └─ dashboardWhere(scope) → 用 EXISTS(cdsgus) 过滤主表
  ├─ 统计卡点击 / 图表点击 ─▶ openPeopleDialog({filters})
  │     └─ /api/dashboard/people: 地区条件 + dashboardFilterClause(filters) 合并
  │           —— filters 各值过白名单/escVal 转义 ——
  └─ 地区Tab: 全国 → 点省 drillCity → 点市 drillDistrict → 点区 明细
       每级: fetch /api/dashboard/region?level&parent ─▶ 同名地图 GeoJSON(registerMap) + 右侧排名条(联动高亮)
```

### 9.4 地区编码聚合规则（重要）

- province：`LEFT(region_code, 2)` 匹配省份，并 `LEFT JOIN fj_admin_region` 取省名。
- city：`LEFT(region_code, 4)` 聚合，parent 取前 2 位组省。
- district：`LEFT(region_code, 6)` 精确区级；4 位 parent 表示"该市下所有区"。
- 下钻明细：district 层 `parent.length>=6` 精确匹配区，否则前 4 位市码匹配。

---

## 10. 依赖关系

### 10.1 npm 依赖（`package.json`）

| 包 | 用途 |
| --- | --- |
| `express ^4.19.2` | Web 框架（路由/中间件/静态托管） |
| `cors ^2.8.5` | 跨域中间件 |
| `mysql2 ^3.11.0` | MySQL 驱动（`mysql2/promise` 连接池） |

脚本：`npm start` / `npm run dev` → `node server/index.js`。

### 10.2 模块依赖图（后端）

```
index.js ──▶ db.js ──▶ idcard.js
    │         │
    ├──▶ auth.js（rbac.js 依赖它）
    ├──▶ rbac.js ──▶ auth.js
    └──▶ 业务路由
```

### 10.3 模块依赖图（前端）

```
login.html ──▶ styles.css（内联 + 全局变量）
index.html ──▶ styles.css
              ├── auth.js（全局：window.APP_AUTH / window.APP_VIEW）
              ├── app.js（依赖 APP_AUTH → APP_VIEW.onShow('list')）
              ├── echarts (CDN, window.echarts)
              ├── dashboard.js（依赖 echarts + APP_VIEW.onShow('dashboard')）
              └── sys.js（依赖 APP_AUTH / APP_VIEW.onShow('users','roles')）
```

**加载顺序敏感**：`auth.js` 必须先于其它脚本；`dashboard.js` 依赖 ECharts 全局对象。

### 10.4 静态资源依赖

- 图表：`public/maps/china.json`、`province/{adcode}.json`、`district/{adcode}.json`（前台按需 fetch，缺失时显示占位并可用右侧排名交互）。
- 地图新城市补充：运行 `node scripts/fetch-district-maps.js`（依赖本地 5173 服务在线，从 DataV 下载有数据的城市区地图）。

---

## 11. 运行方式

### 11.1 快速开始

```bash
# 1. 安装依赖
npm install

# 2.（可选）配置数据库：项目根创建 .env
#    DB_HOST=127.0.0.1
#    DB_PORT=3306
#    DB_USER=xxx
#    DB_PASSWORD=***
#    DB_NAME=infocard_test
#    不配置则自动进入"演示模式"（内存加载 seed-demo.json）

# 3. 启动
npm start          # 或 npm run dev / node server/index.js
```

- 服务地址：`http://localhost:5173`
- 访问入口：`http://localhost:5173/login.html`
- 默认账号：`admin / admin123`（内置超级管理员，首次启动自动 seed 到 `auth-data.json`）

### 11.2 运行模式

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| `mysql` | `.env` 配置正确且连接成功 | 使用真实表（fj_id_card/cdsgus/参考表）；列表/看板/明细全部走 SQL |
| `demo` | 未配置或连接失败 | 使用 `seed-demo.json` 内存数据；支持增删改（写回文件）与列表 CRUD；**看板统计/地图返回空（`dashboard*` 在 `!mysqlAvailable` 时返回 null/[]）** |

启动日志会打印当前模式与连接信息；页面顶部徽标同步显示。

### 11.3 常用运维

- 看板地图数据：`public/maps/` 已内置全国/省级地图；市区地图缺失时执行 `node scripts/fetch-district-maps.js`（先启动服务）。
- 重置认证数据：删除 `server/auth-data.json` 后重启服务，自动重新 seed（admin/admin123）。
- 浏览器缓存：前端无构建，修改后硬刷新 `Cmd+Shift+R` 生效。

---

## 12. 关键实现细节与约定

1. **新增身份清空表单**：`openCreate()` 显式清空全部输入 + 派生面板（属性 + DOM 双重清），防止残留上次数据。
2. **自定义关系编码**：负整数（-1、-2…），避免与内置 0-5 冲突；最多 6 个，存 localStorage；前端 `REL_TAG` 用 `tag-custom` 高亮。
3. **手机号唯一性应用层校验**：库内存在历史重复数据，数据库不做唯一约束（见 `repo.create/update`）。
4. **表格行高固定 56px**，空手机号显示 `—` 占位以维持行高不变（`styles.css` + `rowHtml`）。
5. **看板表行默认 pageSize=100**（`dashboard.js loadPeople`），按省市区/性别等维度点击下钻。
6. **ECharts 实例管理**：`state.echarts` 以元素 id（不带 `#`）为 key；`drawLoading()` 与 `getChart()` key 必须一致，渲染前 dispose 旧实例防止泄漏/不更新（历史上曾因 `#` 前缀不一致导致筛选切换后图表不刷新）。
7. **南海诸岛隐藏**：`stripNansha()` 移除 `南海诸岛` feature 并裁剪纬度 <17° 坐标；中国地图 `zoom:1.2` 提升可见性。
8. **看板年份过滤**：`hasRecord=yes` + 某年份 → 用 `EXISTS(SELECT 1 FROM cdsgus d WHERE d.ctfid=f.card_no AND LEFT(d.Version,4)=?)`；年份下拉选项仅在 `yes` 时可用且直接来自 `dashboardRegYears`（不闪旧列表，先清空再加载）。
9. **SQL 注入防护**：所有维度过滤值经 `parseDashFilters` 白名单 + `escVal` 转义；主查询使用参数化占位；常量 SQL 拼接处（parent 截位）只取数字前缀。
10. **hidden 属性**：弹层使用 `display:none !important` 覆盖其他 display 规则（避免 CSS 覆盖导致 hidden 失效）。
11. **demo 模式的看板限制**：看板聚合依赖 MySQL 表，demo 模式不返回聚合数据（页面无图表数据属预期行为）。
12. **动态弹窗 id 变换**：sys.js 挂载弹窗后 id 前缀为 `__`（`__sysRoleDialog`），脚本内保存逻辑需用 `__` 前缀选择器（历史踩坑：仍用 `#sysRoleDialog` 导致权限保存为空）。

---

## 13. 常见问题（Troubleshooting）

| 现象 | 排查方向 |
| --- | --- |
| 一直跳登录页 | token 失效/过期（24h）；服务重启后内存 token 失效；检查 `localStorage.fj_token` |
| 页面显示"演示数据模式" | `.env` 未配置或 MySQL 无法连接；检查连接配置与服务状态 |
| 看板无数据/图空白 | 演示模式下看板禁用；或检查 `cdsgus`/参考表数据；硬刷新 Cmd+Shift+R |
| 角色权限保存后不生效 | 检查是否仍用旧 id 选择器（应 `#__sysRoleDialog`）；检查角色是否启用 |
| 切换筛选后图表不刷新 | ECharts 实例 key 是否带 `#` 前缀不一致；重启服务 + 硬刷新 |
| 自定义关系丢失 | 仅存 localStorage，换浏览器/清缓存即丢失，为设计预期 |
| 地图下钻某省无数据 | 缺少 `public/maps/province/{adcode}.json`；用排名条交互或补下载地图 |