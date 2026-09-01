# 身份信息管理平台（infocard-id-card-manager）

一套面向个人身份档案的管理系统，围绕 `fj_id_card` 身份数据表提供 **档案管理、关联登记查询、数据可视化看板** 三大能力，内置 **RBAC 权限体系**。

## 功能特性

- **档案管理**：人员姓名、身份证号、手机号、关系、备注等字段增删改查；身份证号自动推导户籍地区、出生日期、性别、星座等派生信息；支持自定义关系。
- **关联登记查询**：接入 `cdsgus` 登记表，按身份证号查询该人员的多条历史登记信息（地址、学历、单位、联系方式等），标记「是否有记录」。
- **数据看板**：多维聚合分析（性别、关系、姓氏、出生年份/月份、年龄/年龄阶段、星座、户籍地区分布、手机归属地/运营商），支持全局筛选（是否记录、登记年份）与图表点击下钻查看人员明细；地区分布支持 全国 → 省 → 市 → 区 逐级下钻。
- **权限体系**：登录认证 + 基于角色的访问控制（RBAC），权限只通过角色授予用户，支持多角色并集、角色启停，内置不可删改的超级管理员。

## 技术栈

| 层次 | 技术 | 说明 |
| --- | --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript | 无框架单页应用，模块化脚本按职责拆分 |
| 图表 | ECharts 5.5.0（CDN） | 柱状图、环形图、折线图、中国省市区地图 |
| 后端 | Node.js + Express 4.19 | REST API 与静态资源托管 |
| 数据库 | MySQL（mysql2 连接池） | 业务表 `fj_id_card` 及关联表；**连接失败即退出，不提供演示数据回退** |
| 认证 | 自研 Token 会话 + RBAC | Token 内存会话（24h），用户/角色/权限持久化到 `server/auth-data.json` |

## 项目结构

```
infocard-id-card-manager/
├── server/                      # 后端（Express）
│   ├── index.js                 # 服务入口：中间件、业务路由、错误处理、启动（含 MySQL 连接校验）
│   ├── db.js                    # 数据访问层：.env 加载、MySQL 连接池、看板聚合 SQL、stats 增量维护
│   ├── idcard.js                # 身份证号解析工具（15/18 位）+ 关系字典
│   ├── auth.js                  # 认证与 RBAC 核心：权限清单、Token、requireAuth/requirePerm 中间件
│   ├── rbac.js                  # /api/auth 与 /api/system 路由（登录、用户、角色）
│   └── auth-data.json           # 用户 / 角色 / 用户-角色关联 持久化文件（内置 admin 超级管理员）
├── public/                      # 前端（静态资源）
│   ├── index.html               # 主应用页面（侧边栏 + 各视图 + 弹窗）
│   ├── login.html               # 登录页
│   ├── styles.css               # 全局样式（设计令牌 + 布局 + 组件）
│   ├── auth.js                  # 会话管理、fetch 拦截、权限导航、用户菜单
│   ├── app.js                   # 人员列表视图：分页/搜索/筛选/抽屉表单
│   ├── dashboard.js             # 数据看板视图：Tab/筛选联动/ECharts/地图下钻
│   ├── sys.js                   # 系统管理视图：用户管理、角色管理
│   └── maps/                    # ECharts 地图数据（GeoJSON）
│       ├── china.json           # 全国地图
│       ├── province/            # 省级地图（33 个）
│       └── district/            # 区级地图（130 个城市，按需预下载）
├── scripts/
│   ├── start-services.sh        # 一键启动/停止/重启 测试(5173) 与 生产(5174) 服务
│   ├── sync-comments.js         # 从测试库同步表/字段注释到生产库
│   ├── rebuild-stats.js         # 重建看板预聚合统计表 fj_id_card_stats
│   ├── decrement-stats.js       # 按需扣减看板预聚合统计（数据修正用）
│   └── fetch-district-maps.js   # 预下载有数据城市的区级地图（DataV areas_v3）
├── .env                         # 数据库连接配置（测试库，不纳入版本控制）
├── .env.prod                    # 生产库配置（叠加于 .env，不纳入版本控制）
├── package.json
└── README.md
```

> 说明：早期版本支持「未连数据库时载入演示数据（seed-demo.json）」，当前版本已**移除该回退机制**——MySQL 连接失败时服务会直接退出（见 `server/index.js` 启动逻辑）。因此项目内不再需要 `seed-demo.json`，README 也不再依赖它。

## 环境要求

- Node.js ≥ 18（已在 22.x 验证）
- MySQL ≥ 5.7（已在 8.0 验证），需提前建好业务库与数据表
- 已安装的依赖：`express`、`cors`、`mysql2`（见 `package.json`）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2.（默认）连接测试库，编辑 .env：
#    DB_HOST=127.0.0.1
#    DB_PORT=3306
#    DB_USER=trae
#    DB_PASSWORD=<你的数据库密码>
#    DB_NAME=infocard_test
#    ENV_LABEL=测试库

# 3. 启动（默认即测试库模式，无需额外参数）
npm start            # 或 npm run dev / node server/index.js
```

- 默认服务地址：`http://localhost:5173`
- 访问入口：`http://localhost:5173/login.html`
- 默认账号：`admin / admin123`（内置超级管理员）

启动成功后控制台打印：

```
[db] 已连接 MySQL — 环境[测试库] (test) — 数据库 infocard_test
[server] fj_id_card 身份信息管理已启动: http://localhost:5173
```

### 连接生产库

```bash
# 方式一：命令行参数
node server/index.js --prod

# 方式二：环境变量
PROFILE=prod node server/index.js
# 或 npm run start:prod
```

生产模式会在 `.env` 基础上叠加 `.env.prod`，连接 `infocard` 生产库，环境标识显示「生产库」。

## 同时运行测试库与生产库（多端口）

项目固定端口-环境映射：**5173 = 测试环境（连接 `infocard_test` 测试库），5174 = 生产环境（连接 `infocard` 正式库）**。

推荐使用 `scripts/start-services.sh` 一键管理两个服务（后台守护运行、日志落盘 `logs/`）：

```bash
# 一键启动两个服务
scripts/start-services.sh start

# 查看状态 / 重启 / 停止
scripts/start-services.sh status
scripts/start-services.sh restart
scripts/start-services.sh stop

# 也支持只操作单个服务
scripts/start-services.sh start:test   # 仅启动测试服务(5173)
scripts/start-services.sh start:prod   # 仅启动生产服务(5174)
scripts/start-services.sh stop:test    # 仅停止测试服务
scripts/start-services.sh stop:prod    # 仅停止生产服务
```

> 脚本为 `start` 默认端口：测试 5173（显式 `PORT=5173`），生产 5174（`PORT=5174` + `--prod`）。
> 日志与 PID 分别记录在 `logs/server-<port>.log` 与 `logs/server-<port>.pid`，服务与终端解耦，关闭终端后仍持续运行。

等价的手动启动命令：

```bash
# 测试库（默认 .env）→ 5173
npm start            # 或 node server/index.js

# 生产库（叠加 .env.prod，--prod 切换）→ 5174
PORT=5174 PROFILE=prod node server/index.js
# 或 npm run start:prod（package.json 已绑定 PORT=5174）
```

> 注意：若目标端口已被占用，启动会报 `EADDRINUSE` 并退出。先用 `lsof -iTCP:5173 -sTCP:LISTEN -n -P` 确认端口占用情况。

## 脚本工具

- `scripts/start-services.sh {start|stop|restart|status|start:test|start:prod|stop:test|stop:prod}`：一键管理测试(5173)与生产(5174)两个服务，后台守护运行。日志落盘 `logs/server-<port>.log`，PID 记录于 `logs/server-<port>.pid`。用法见「同时运行测试库与生产库（多端口）」。
- `node scripts/sync-comments.js [--dry-run] [--table=xxx]`：从测试库(`infocard_test`)读取表/列注释，同步到生产库(`infocard`)，只改元数据注释、不改动列定义/索引/数据。`--dry-run` 仅生成并预览待执行语句而不执行；`--table=xxx` 只看单表。
- `node scripts/fetch-district-maps.js`：扫描有数据的城市，从 DataV 预下载其区级地图到 `public/maps/district/`，文件名即城市 6 位 adcode（如 `440100.json`）。脚本默认请求本机 `http://127.0.0.1:5173/api/dashboard/region` 获取城市列表，请确保对应实例已启动。
- `node scripts/rebuild-stats.js [--prod]`：全表扫描 `fj_id_card` 并关联 `cdsgus` 登记年份，重建看板预聚合统计表 `fj_id_card_stats`，将看板落地页的多个全表 GROUP BY 聚合转为「一次扫描 + 预写统计」，避免千万级大表实时聚合导致的 `ER_RECORD_FILE_FULL` 与超时。可用 `STATS_CHUNK` 环境变量调整每块扫描行数（默认 200000）。

## 注意事项

- **无数据库回退**：未配置或无法连接 MySQL 时，服务启动即退出（不提供内存演示数据）。请确认 `.env` / `.env.prod` 中的 host/port/user/password/database 正确。
- **手机号唯一性**采用应用层校验（库内历史存在重复数据），数据库层不做唯一约束。
- **自定义关系**以负整数存储（-1、-2…），避免与内置关系（0-5）冲突。
- **权限校验**：除登录外所有 `/api` 均需登录（未登录返回 401）；业务接口按 `requirePerm` 校验权限，无权限返回 403。
- **本地代理**：若系统设置了 `http_proxy`，用 `curl` 访问 `localhost` 会被代理拦截（返回 502）。可加 `--noproxy localhost,127.0.0.1` 或 `NO_PROXY=localhost`；浏览器直接访问不受影响。
- **静态资源刷新**：前端页面硬刷新（Cmd+Shift+R）可绕过浏览器缓存获得最新静态资源。

## 数据库表依赖

服务正常运行需在目标库中具备以下对象：

- `fj_id_card` —— 核心身份表
- `cdsgus` —— 历史登记信息表（关联登记查询 / 看板「是否有记录」）
- `fj_constellation` —— 星座区间表（看板星座维度）
- `fj_mobile_segment` —— 手机号号段归属地表（看板手机归属地/运营商维度）
- `fj_id_card_stats` —— 看板预聚合统计表（由 `scripts/rebuild-stats.js` 维护）
- `fj_admin_region` —— 行政区划映射表
- `v_fj_id_card_info` —— 派生信息视图

## 文档

- 详细的产品设计、项目结构与代码说明见 [`docs/项目文档/项目文档.md`](./docs/项目文档/项目文档.md)
- 代码 Wiki 见 [`docs/Code-Wiki.md`](./docs/Code-Wiki.md)
